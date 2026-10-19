import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import CellNoteIndicator from "./CellNoteIndicator";
import EditClientSelector from "./EditClientSelector";
import { useAuth } from "../hooks/useAuth";

const formatCurrency = (val) => {
  if (val === null || val === undefined || val === "") return "£0";
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return "£0";
  if (s.startsWith("£") || s.startsWith("$") || s.startsWith("€")) return s;
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return "£" + Math.round(num).toLocaleString("en-GB");
};

export default function ExpensesView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");

  // Client State
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientSearch, setClientSearch] = useState("");

  // Data State
  const [expensesData, setExpensesData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // FY Navigation & Filters
  const [selectedFyIdx, setSelectedFyIdx] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all"); // "all" | "delivery" | "non-delivery"
  const [draggingRow, setDraggingRow] = useState(null); // { sheetRow, isDelivery }
  const [dragOverSection, setDragOverSection] = useState(null); // "delivery" | "nonDelivery"

  // Quick Inline/Modal Amount Editing
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colLetter, label, value, category, note }
  const [cellInputValue, setCellInputValue] = useState("");
  const [cellNoteValue, setCellNoteValue] = useState("");

  // Category Edit State
  const [editingCategory, setEditingCategory] = useState(null); // { sheetRow, category, vat, deliveryPct }
  const [categoryNameInput, setCategoryNameInput] = useState("");

  // New Expense Input State (Always visible at bottom)
  const [newExpName, setNewExpName] = useState("");
  const [newExpVat, setNewExpVat] = useState("No");
  const [newExpDelivery, setNewExpDelivery] = useState("0%"); // "0%" | "100%"

  // Resolve active client
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient(match);
      return;
    }
    if (initialClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === initialClient.toLowerCase()
      );
      if (match) {
        setSelectedClient(match);
        return;
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setExpensesData(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_expenses_client");
      }
    }
  };

  // Fetch Expenses Data
  const fetchExpenses = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/pma/expenses?clientName=${encodeURIComponent(client.clientName)}&clientSheetId=${encodeURIComponent(
          client.clientSheetId
        )}${bypassCache ? "&bypassCache=true" : ""}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load expenses data");
      }
      setExpensesData(data);
      setSelectedFyIdx(data.defaultFyIndex ?? 0);
    } catch (err) {
      console.error("Failed to fetch expenses:", err);
      setError(err.message || "Failed to load expenses data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_expenses_client", selectedClient.clientName);
      }
      fetchExpenses(selectedClient);
    }
  }, [selectedClient, fetchExpenses]);

  const showSuccess = (msg) => {
    setSaveSuccessMsg(msg);
    setTimeout(() => setSaveSuccessMsg(""), 4000);
  };

  // Filtered clients list
  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return allOutgoingsClients;
    const q = clientSearch.toLowerCase().trim();
    return allOutgoingsClients.filter((c) => c.clientName?.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  const currentFy = expensesData?.fyConfigs?.[selectedFyIdx] || null;
  const currentTotals = expensesData?.totals?.[currentFy?.id] || null;

  // Split populated expenses into Delivery and Non-Delivery
  const { deliveryExpenses, nonDeliveryExpenses } = useMemo(() => {
    const list = (expensesData?.expenses || []).filter((e) => e.isPopulated);
    const q = searchTerm.toLowerCase().trim();

    const del = [];
    const nonDel = [];

    list.forEach((e) => {
      const matches = !q || e.category.toLowerCase().includes(q) || String(e.sheetRow).includes(q);
      if (!matches) return;

      if (e.isDelivery) {
        del.push(e);
      } else {
        nonDel.push(e);
      }
    });

    return { deliveryExpenses: del, nonDeliveryExpenses: nonDel };
  }, [expensesData?.expenses, searchTerm]);

  // ── HANDLER: TOGGLE VAT (Col B) ──────────────────────────────────────────
  const handleToggleVat = async (exp, newVat) => {
    if (!selectedClient || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_metadata",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: exp.sheetRow,
          category: exp.category,
          vat: newVat,
          deliveryPct: exp.deliveryPct,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to update VAT");
      showSuccess(`Updated VAT for "${exp.category}" to ${newVat}.`);
      await fetchExpenses(selectedClient, true);
    } catch (err) {
      console.error("Update VAT error:", err);
      setError(err.message || "Failed to update VAT");
    } finally {
      setSaving(false);
    }
  };

  // ── HANDLER: MOVE EXPENSE (Delivery vs Non-Delivery) ─────────────────────
  const handleMoveDelivery = async (exp, targetIsDelivery) => {
    if (!selectedClient || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_delivery",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: exp.sheetRow,
          targetDelivery: targetIsDelivery,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to move expense");
      showSuccess(`Moved "${exp.category}" to ${targetIsDelivery ? "Delivery" : "Non-delivery"}.`);
      await fetchExpenses(selectedClient, true);
    } catch (err) {
      console.error("Move expense error:", err);
      setError(err.message || "Failed to move expense");
    } finally {
      setSaving(false);
      setDraggingRow(null);
      setDragOverSection(null);
    }
  };

  // ── HANDLER: SAVE CATEGORY NAME ──────────────────────────────────────────
  const handleSaveCategoryName = async () => {
    if (!selectedClient || !editingCategory || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_metadata",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: editingCategory.sheetRow,
          category: categoryNameInput,
          vat: editingCategory.vat,
          deliveryPct: editingCategory.deliveryPct,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to update category name");
      setEditingCategory(null);
      showSuccess(`Updated category to "${categoryNameInput}".`);
      await fetchExpenses(selectedClient, true);
    } catch (err) {
      console.error("Save category name error:", err);
      setError(err.message || "Failed to update category name");
    } finally {
      setSaving(false);
    }
  };

  // ── HANDLER: SAVE SINGLE MONTH AMOUNT ─────────────────────────────────────
  const handleSaveAmount = async () => {
    if (!selectedClient || !editingCell || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_amounts",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: editingCell.sheetRow,
          monthlyAmounts: {
            [editingCell.colLetter]: cellInputValue,
          },
          cellNotes: {
            [editingCell.colLetter]: cellNoteValue,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to update amount");
      setEditingCell(null);
      showSuccess(`Updated ${editingCell.label} amount for "${editingCell.category}".`);
      await fetchExpenses(selectedClient, true);
    } catch (err) {
      console.error("Save amount error:", err);
      setError(err.message || "Failed to update amount");
    } finally {
      setSaving(false);
    }
  };

  // ── HANDLER: ADD NEW EXPENSE (writes to next empty row) ──────────────────
  const handleAddNewExpense = async (e) => {
    e?.preventDefault();
    if (!selectedClient || !isAdmin || !newExpName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_expense",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          category: newExpName.trim(),
          vat: newExpVat,
          deliveryPct: newExpDelivery,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to add expense");
      setNewExpName("");
      showSuccess(`Added new expense "${newExpName.trim()}" successfully.`);
      await fetchExpenses(selectedClient, true);
    } catch (err) {
      console.error("Add expense error:", err);
      setError(err.message || "Failed to add expense");
    } finally {
      setSaving(false);
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e, exp) => {
    setDraggingRow(exp);
    e.dataTransfer.setData("text/plain", String(exp.sheetRow));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e, section) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverSection !== section) setDragOverSection(section);
  };

  const handleDrop = (e, targetSection) => {
    e.preventDefault();
    if (!draggingRow) return;
    const targetIsDelivery = targetSection === "delivery";
    if (draggingRow.isDelivery !== targetIsDelivery) {
      handleMoveDelivery(draggingRow, targetIsDelivery);
    }
    setDraggingRow(null);
    setDragOverSection(null);
  };

  // Render an expense table row
  const renderExpenseRow = (exp) => {
    const months = exp.fyData?.[currentFy?.id]?.months || [];
    const fyTotal = exp.fyData?.[currentFy?.id]?.total || "£0";

    return (
      <tr
        key={exp.sheetRow}
        draggable={isAdmin}
        onDragStart={(e) => handleDragStart(e, exp)}
        onDragEnd={() => {
          setDraggingRow(null);
          setDragOverSection(null);
        }}
        style={{
          background: "#ffffff",
          borderBottom: "1px solid #f1f5f9",
          transition: "background 0.1s",
          cursor: isAdmin ? "grab" : "default",
          opacity: draggingRow?.sheetRow === exp.sheetRow ? 0.4 : 1,
        }}
      >
        {/* Drag / Move Control */}
        <td style={{ padding: "8px 10px", width: "40px", textAlign: "center" }}>
          {isAdmin && (
            <button
              type="button"
              onClick={() => handleMoveDelivery(exp, !exp.isDelivery)}
              disabled={saving}
              style={{
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: "4px",
                padding: "2px 6px",
                fontSize: "11px",
                cursor: "pointer",
                color: exp.isDelivery ? "#475569" : "#166534",
                fontWeight: 700,
              }}
              title={exp.isDelivery ? "Click to move to non-delivery" : "Click to move to Delivery"}
            >
              {exp.isDelivery ? "↓" : "↑"}
            </button>
          )}
        </td>

        {/* Category Name (Col A) */}
        <td style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#1e293b", minWidth: "220px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span
              onClick={() => {
                if (isAdmin) {
                  setEditingCategory(exp);
                  setCategoryNameInput(exp.category);
                }
              }}
              style={{ cursor: isAdmin ? "pointer" : "default" }}
              title={isAdmin ? "Click to edit category name" : undefined}
            >
              {exp.category}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setEditingCategory(exp);
                  setCategoryNameInput(exp.category);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: "12px",
                  padding: 0,
                }}
                title="Edit category name"
              >
                ✎
              </button>
            )}
          </div>
        </td>

        {/* VAT? Chooser (Col B) */}
        <td style={{ padding: "8px 10px", textAlign: "center", width: "80px" }}>
          {isAdmin ? (
            <select
              value={exp.vat}
              onChange={(e) => handleToggleVat(exp, e.target.value)}
              disabled={saving}
              style={{
                padding: "2px 6px",
                fontSize: "11px",
                fontWeight: 700,
                borderRadius: "4px",
                border: "1px solid #cbd5e1",
                background: exp.vat === "Yes" ? "#eff6ff" : "#f8fafc",
                color: exp.vat === "Yes" ? "#1d4ed8" : "#475569",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="No">No</option>
              <option value="Yes">Yes</option>
            </select>
          ) : (
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: exp.vat === "Yes" ? "#1d4ed8" : "#64748b",
              }}
            >
              {exp.vat}
            </span>
          )}
        </td>

        {/* 12 Months Columns */}
        {months.map((m) => (
          <td
            key={m.colLetter}
            onClick={() => {
              if (isAdmin) {
                setEditingCell({
                  sheetRow: exp.sheetRow,
                  colLetter: m.colLetter,
                  label: m.monthLabel,
                  value: m.value,
                  category: exp.category,
                  note: m.note || "",
                });
                setCellInputValue(m.value);
                setCellNoteValue(m.note || "");
              }
            }}
            style={{
              position: "relative",
              padding: "8px 10px",
              textAlign: "right",
              color: "#0f172a",
              fontWeight: 500,
              cursor: isAdmin ? "pointer" : "default",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => {
              if (isAdmin) e.currentTarget.style.background = "#eff6ff";
            }}
            onMouseLeave={(e) => {
              if (isAdmin) e.currentTarget.style.background = "transparent";
            }}
            title={isAdmin ? `Click to edit ${m.monthLabel} amount & note` : undefined}
          >
            <CellNoteIndicator note={m.note} />
            {m.value || "£0"}
          </td>
        ))}

        {/* FY Total */}
        <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 800, color: "#0047AB", background: "#f8fafc" }}>
          {fyTotal}
        </td>
      </tr>
    );
  };

  return (
    <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
      {/* ── TOP TOOLBAR / HEADER ── */}
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
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {selectedClient && (
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
              <span>Expenses</span>
              {selectedClient && expensesData && (
                <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>
                  {deliveryExpenses.length} Delivery · {nonDeliveryExpenses.length} Non-delivery
                </span>
              )}
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to view and edit expenses
              </p>
            )}
          </div>
        </div>

        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {/* FY Navigator */}
            {expensesData?.fyConfigs && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.max(0, prev - 1))}
                  disabled={selectedFyIdx <= 0}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx <= 0 ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx <= 0 ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Previous financial year"
                >
                  ◀
                </button>

                <select
                  value={selectedFyIdx}
                  onChange={(e) => setSelectedFyIdx(parseInt(e.target.value, 10))}
                  style={{
                    padding: "6px 10px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#fff",
                    fontSize: "13px",
                    fontWeight: 700,
                    color: "#0047AB",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {expensesData.fyConfigs.map((fy, idx) => (
                    <option key={fy.id} value={idx}>
                      {fy.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() =>
                    setSelectedFyIdx((prev) => Math.min(expensesData.fyConfigs.length - 1, prev + 1))
                  }
                  disabled={selectedFyIdx >= expensesData.fyConfigs.length - 1}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor:
                      selectedFyIdx >= expensesData.fyConfigs.length - 1 ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx >= expensesData.fyConfigs.length - 1 ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Next financial year"
                >
                  ▶
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => selectedClient && fetchExpenses(selectedClient, true)}
              disabled={loading || saving}
              style={{
                padding: "7px 14px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: loading ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {loading ? <Spinner size={14} color="#0066cc" /> : "↻"} Refresh
            </button>
          </div>
        )}
      </div>

      {/* ── CLIENT SELECTOR SCREEN (WHEN NO CLIENT SELECTED) ── */}
      {!selectedClient && (
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => setSelectedClient(c)}
          loading={loading}
          title="Select a client to view and edit expenses:"
        />
      )}

      {/* Notifications */}
      {selectedClient && error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {selectedClient && saveSuccessMsg && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#15803d",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          ✓ {saveSuccessMsg}
        </div>
      )}

      {selectedClient && loading && !expensesData && (
        <div style={{ textAlign: "center", padding: "80px 20px" }}>
          <Spinner size={32} color="#0047AB" />
          <div style={{ marginTop: "14px", color: "#64748b", fontSize: "14px" }}>
            Loading expenses from Client Sheet...
          </div>
        </div>
      )}

      {selectedClient && expensesData && currentFy && (
        <>
          {/* Filter Bar & Search */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
            }}
          >
            <div style={{ display: "inline-flex", background: "#e2e8f0", padding: "2px", borderRadius: "6px", gap: "2px" }}>
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: activeTab === "all" ? 700 : 500,
                  border: "none",
                  cursor: "pointer",
                  background: activeTab === "all" ? "#ffffff" : "transparent",
                  color: activeTab === "all" ? "#0047AB" : "#475569",
                  boxShadow: activeTab === "all" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                All ({deliveryExpenses.length + nonDeliveryExpenses.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("delivery")}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: activeTab === "delivery" ? 700 : 500,
                  border: "none",
                  cursor: "pointer",
                  background: activeTab === "delivery" ? "#ffffff" : "transparent",
                  color: activeTab === "delivery" ? "#166534" : "#475569",
                  boxShadow: activeTab === "delivery" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                Delivery ({deliveryExpenses.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("non-delivery")}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: activeTab === "non-delivery" ? 700 : 500,
                  border: "none",
                  cursor: "pointer",
                  background: activeTab === "non-delivery" ? "#ffffff" : "transparent",
                  color: activeTab === "non-delivery" ? "#475569" : "#475569",
                  boxShadow: activeTab === "non-delivery" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                Non-delivery ({nonDeliveryExpenses.length})
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="text"
                placeholder="Search category..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  padding: "5px 10px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  width: "180px",
                }}
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm("")}
                  style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "12px" }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* ── EXPENSES MAIN CONTAINER ── */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              overflow: "hidden",
              marginBottom: "24px",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "right" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                    <th style={{ padding: "8px 10px", textAlign: "center", width: "40px", color: "#475569" }}>Move</th>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 700, color: "#475569", minWidth: "220px" }}>Category</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, color: "#475569", width: "80px" }}>VAT?</th>
                    {currentFy.monthCols.map((m) => (
                      <th key={m.colLetter} style={{ padding: "8px 10px", fontWeight: 700, color: "#475569", minWidth: "75px" }}>
                        {m.label}
                      </th>
                    ))}
                    <th style={{ padding: "8px 12px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff", minWidth: "90px" }}>
                      {currentFy.label} Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* ── SECTION 1: DELIVERY EXPENSES ── */}
                  {(activeTab === "all" || activeTab === "delivery") && (
                    <>
                      <tr
                        onDragOver={(e) => handleDragOver(e, "delivery")}
                        onDrop={(e) => handleDrop(e, "delivery")}
                        style={{
                          background: dragOverSection === "delivery" ? "#dcfce7" : "#f0fdf4",
                          borderBottom: "2px solid #bbf7d0",
                        }}
                      >
                        <td
                          colSpan={currentFy.monthCols.length + 4}
                          style={{
                            padding: "8px 12px",
                            fontSize: "12px",
                            fontWeight: 700,
                            color: "#166534",
                            letterSpacing: "0.3px",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#16a34a" }} />
                              <span>Delivery Expenses ({deliveryExpenses.length})</span>
                            </div>
                            <span style={{ fontSize: "11px", fontWeight: 500, color: "#15803d" }}>
                              (Column E = 100% · Drag rows or use arrow button to move)
                            </span>
                          </div>
                        </td>
                      </tr>
                      {deliveryExpenses.length === 0 ? (
                        <tr>
                          <td colSpan={currentFy.monthCols.length + 4} style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                            No delivery expenses
                          </td>
                        </tr>
                      ) : (
                        deliveryExpenses.map((exp) => renderExpenseRow(exp))
                      )}

                      {/* Spacer between sections */}
                      <tr style={{ height: "18px", background: "#ffffff" }}>
                        <td colSpan={currentFy.monthCols.length + 4} style={{ height: "18px", border: "none", background: "#ffffff", padding: 0 }} />
                      </tr>
                    </>
                  )}

                  {/* ── SECTION 2: NON-DELIVERY EXPENSES ── */}
                  {(activeTab === "all" || activeTab === "non-delivery") && (
                    <>
                      <tr
                        onDragOver={(e) => handleDragOver(e, "nonDelivery")}
                        onDrop={(e) => handleDrop(e, "nonDelivery")}
                        style={{
                          background: dragOverSection === "nonDelivery" ? "#f1f5f9" : "#f8fafc",
                          borderTop: "1px solid #cbd5e1",
                          borderBottom: "2px solid #cbd5e1",
                        }}
                      >
                        <td
                          colSpan={currentFy.monthCols.length + 4}
                          style={{
                            padding: "8px 12px",
                            fontSize: "12px",
                            fontWeight: 700,
                            color: "#475569",
                            letterSpacing: "0.3px",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#94a3b8" }} />
                              <span>Non-delivery expenses ({nonDeliveryExpenses.length})</span>
                            </div>
                            <span style={{ fontSize: "11px", fontWeight: 500, color: "#64748b" }}>
                              (Column E = 0% · Drag rows or use arrow button to move)
                            </span>
                          </div>
                        </td>
                      </tr>
                      {nonDeliveryExpenses.length === 0 ? (
                        <tr>
                          <td colSpan={currentFy.monthCols.length + 4} style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                            No non-delivery expenses
                          </td>
                        </tr>
                      ) : (
                        nonDeliveryExpenses.map((exp) => renderExpenseRow(exp))
                      )}

                      {/* Spacer between expenses and totals */}
                      <tr style={{ height: "24px", background: "#ffffff" }}>
                        <td colSpan={currentFy.monthCols.length + 4} style={{ height: "24px", border: "none", background: "#ffffff", padding: 0 }} />
                      </tr>
                    </>
                  )}

                  {/* ── TOTALS ROWS (ROW 227 & ROW 228) ── */}
                  {currentTotals && (
                    <>
                      {/* Row 227: Total Delivery Expenses */}
                      <tr
                        style={{
                          background: "#f8fafc",
                          borderTop: "1px solid #e2e8f0",
                          borderBottom: "1px solid #e2e8f0",
                          color: "#166534",
                          fontSize: "11px",
                          fontWeight: 600,
                        }}
                      >
                        <td style={{ background: "#f8fafc" }}></td>
                        <td style={{ padding: "7px 12px", textAlign: "left", background: "#f8fafc", fontWeight: 700 }}>
                          {currentTotals.delivery.label}
                        </td>
                        <td style={{ background: "#f8fafc" }}></td>
                        {currentTotals.delivery.months.map((val, idx) => (
                          <td key={"tot_del_" + idx} style={{ padding: "7px 10px", background: "#f8fafc" }}>
                            {val}
                          </td>
                        ))}
                        <td style={{ padding: "7px 12px", fontWeight: 700, background: "#f8fafc", color: "#166534" }}>
                          {currentTotals.delivery.total}
                        </td>
                      </tr>

                      {/* Row 228: Total Non-Delivery Expenses */}
                      <tr
                        style={{
                          background: "#f8fafc",
                          borderBottom: "1px solid #e2e8f0",
                          color: "#475569",
                          fontSize: "11px",
                          fontWeight: 600,
                        }}
                      >
                        <td style={{ background: "#f8fafc" }}></td>
                        <td style={{ padding: "7px 12px", textAlign: "left", background: "#f8fafc", fontWeight: 700 }}>
                          {currentTotals.nonDelivery.label}
                        </td>
                        <td style={{ background: "#f8fafc" }}></td>
                        {currentTotals.nonDelivery.months.map((val, idx) => (
                          <td key={"tot_nondel_" + idx} style={{ padding: "7px 10px", background: "#f8fafc" }}>
                            {val}
                          </td>
                        ))}
                        <td style={{ padding: "7px 12px", fontWeight: 700, background: "#f8fafc", color: "#334155" }}>
                          {currentTotals.nonDelivery.total}
                        </td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {/* ── ALWAYS-VISIBLE BLANK ROW TO ADD EXPENSES ── */}
            {isAdmin && (
              <form
                onSubmit={handleAddNewExpense}
                style={{
                  padding: "14px 18px",
                  background: "#f8fafc",
                  borderTop: "2px solid #e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b" }}>+ Add New Expense:</span>
                <input
                  type="text"
                  placeholder="Enter expense category name..."
                  value={newExpName}
                  onChange={(e) => setNewExpName(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    fontSize: "13px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    minWidth: "240px",
                    outline: "none",
                  }}
                  required
                />

                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>VAT?:</span>
                  <select
                    value={newExpVat}
                    onChange={(e) => setNewExpVat(e.target.value)}
                    style={{
                      padding: "5px 8px",
                      fontSize: "12px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>Classification:</span>
                  <select
                    value={newExpDelivery}
                    onChange={(e) => setNewExpDelivery(e.target.value)}
                    style={{
                      padding: "5px 8px",
                      fontSize: "12px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    <option value="0%">Non-Delivery (0%)</option>
                    <option value="100%">Delivery (100%)</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={saving || !newExpName.trim()}
                  style={{
                    padding: "6px 14px",
                    background: "#0047AB",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: saving || !newExpName.trim() ? "not-allowed" : "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  }}
                >
                  {saving ? "Saving..." : "Add Expense"}
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {/* ── MODAL: EDIT MONTHLY AMOUNT ── */}
      {editingCell && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              padding: "20px 24px",
              borderRadius: "8px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: "360px",
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
              Edit Amount: {editingCell.category}
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Month: <strong>{editingCell.label}</strong> (Row {editingCell.sheetRow}, Col {editingCell.colLetter})
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                Amount (£)
              </label>
              <input
                type="text"
                value={cellInputValue}
                onChange={(e) => setCellInputValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) handleSaveAmount();
                  if (e.key === "Escape") setEditingCell(null);
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                Cell note
              </label>
              <textarea
                value={cellNoteValue}
                onChange={(e) => setCellNoteValue(e.target.value)}
                placeholder="Add note..."
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setEditingCell(null)}
                style={{
                  padding: "6px 12px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAmount}
                disabled={saving}
                style={{
                  padding: "6px 14px",
                  background: "#0047AB",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: EDIT CATEGORY NAME ── */}
      {editingCategory && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              padding: "20px 24px",
              borderRadius: "8px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: "400px",
            }}
          >
            <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
              Rename Expense Category
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Row {editingCategory.sheetRow} in Outgoings tab
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                Category Name
              </label>
              <input
                type="text"
                value={categoryNameInput}
                onChange={(e) => setCategoryNameInput(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveCategoryName();
                  if (e.key === "Escape") setEditingCategory(null);
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setEditingCategory(null)}
                style={{
                  padding: "6px 12px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveCategoryName}
                disabled={saving || !categoryNameInput.trim()}
                style={{
                  padding: "6px 14px",
                  background: "#0047AB",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
