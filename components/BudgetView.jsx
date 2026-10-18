import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function formatCurrency(val) {
  if (val === "" || val === null || val === undefined) return "";
  const str = String(val).trim();
  if (str === "-" || str === "£-") return "-";
  const clean = str.replace(/[£,\s]/g, "");
  if (!isNaN(clean) && clean !== "") {
    const num = Math.round(Number(clean));
    if (num < 0) {
      return `-£${Math.abs(num).toLocaleString("en-GB")}`;
    }
    return `£${num.toLocaleString("en-GB")}`;
  }
  return str;
}

export function isBudgetCellEditable(sheetRow, colIdx) {
  const isMonthCol =
    (colIdx >= 6 && colIdx <= 17) ||
    (colIdx >= 21 && colIdx <= 32) ||
    (colIdx >= 36 && colIdx <= 47);

  // Rows 5-7: months
  if (sheetRow >= 5 && sheetRow <= 7) return isMonthCol;
  // Rows 13-15: months
  if (sheetRow >= 13 && sheetRow <= 15) return isMonthCol;
  // Employees: A59:E111
  if (sheetRow >= 59 && sheetRow <= 111) return colIdx >= 0 && colIdx <= 4;
  // Dividends: Row 119, Col E (4) + months
  if (sheetRow === 119) return colIdx === 4 || isMonthCol;
  // Contractors: Rows 127-140, Cols A (0) & E (4) + months
  if (sheetRow >= 127 && sheetRow <= 140) return colIdx === 0 || colIdx === 4 || isMonthCol;
  // Making up CoS: B142 (Col B = 1)
  if (sheetRow === 142) return colIdx === 1;
  // Other expenses: Rows 150-250, Cols A (0) & E (4) + months
  if (sheetRow >= 150 && sheetRow <= 250) return colIdx === 0 || colIdx === 4 || isMonthCol;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET VIEW MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function BudgetView({
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
  const [budgetData, setBudgetData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // FY Navigation & Filters
  const [selectedFyIdx, setSelectedFyIdx] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");

  // Cell Editing State
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [savingKey, setSavingKey] = useState(null); // `${sheetRow}_${colIdx}`
  const committingRef = useRef(false);

  // Synchronize client selection
  useEffect(() => {
    if (managedClient) {
      const match =
        (allOutgoingsClients || []).find(
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
    if (!selectedClient && allOutgoingsClients.length > 0) {
      const saved = typeof window !== "undefined" ? sessionStorage.getItem("pma_budget_client") : null;
      const found = saved ? allOutgoingsClients.find((c) => c.clientName === saved) : null;
      setSelectedClient(found || allOutgoingsClients[0]);
    }
  }, [managedClient, initialClient, allOutgoingsClients, selectedClient]);

  // Fetch Budget Data
  const fetchBudgetData = useCallback(async (client, bypassCache = false) => {
    if (!client || (!client.clientSheetId && !client.masterSheetId)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_client_view_data",
          clientSheetId: client.clientSheetId,
          masterSheetId: client.masterSheetId,
          clientName: client.clientName,
          tab: "budget",
          bypassCache,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load budget data from Master Sheet");
      }
      setBudgetData(data);
      if (data.defaultFyIndex !== undefined) {
        setSelectedFyIdx(data.defaultFyIndex);
      }
    } catch (err) {
      console.error("fetchBudgetData error:", err);
      setError(err.message || "Failed to load budget data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_budget_client", selectedClient.clientName);
      }
      fetchBudgetData(selectedClient);
    }
  }, [selectedClient, fetchBudgetData]);

  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return allOutgoingsClients;
    const q = clientSearch.toLowerCase().trim();
    return allOutgoingsClients.filter((c) => c.clientName?.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  // Handle cell edit commit
  const handleUpdateCell = async (sheetRow, colIdx, newValue) => {
    if (!selectedClient) return;
    const clientKey = selectedClient.clientSheetId;
    const masterKey = selectedClient.masterSheetId;
    const colLetter = colIndexToLetter(colIdx + 1);

    let displayVal = newValue;
    if (colIdx >= 6 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (sheetRow >= 59 && sheetRow <= 111 && colIdx === 1 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (
      (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) &&
      newValue !== ""
    ) {
      const clean = String(newValue).replace(/%/g, "").trim();
      const num = parseFloat(clean);
      if (!isNaN(num)) {
        displayVal = `${num}%`;
      }
    }

    // Optimistically update local matrix
    setBudgetData((prev) => {
      if (!prev || !prev.matrix) return prev;
      const newMatrix = [...prev.matrix];
      const rIdx = sheetRow - 1;
      if (newMatrix[rIdx]) {
        const newRow = [...newMatrix[rIdx]];
        newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
        newMatrix[rIdx] = newRow;
      }
      return { ...prev, matrix: newMatrix };
    });

    try {
      const rowDesc = budgetData?.matrix?.[sheetRow - 1]?.[0]?.v || `Row ${sheetRow}`;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_view_cell",
          clientSheetId: clientKey,
          masterSheetId: masterKey,
          tab: "budget",
          screenTab: "budget",
          sheetRow,
          colLetter,
          colIdx,
          value: newValue,
          rowDescription: rowDesc,
          clientName: selectedClient.clientName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Failed to update cell (status ${res.status})`);
      }

      if (data.formattedValue !== undefined && data.formattedValue !== displayVal) {
        setBudgetData((prev) => {
          if (!prev || !prev.matrix) return prev;
          const newMatrix = [...prev.matrix];
          const rIdx = sheetRow - 1;
          if (newMatrix[rIdx]) {
            const newRow = [...newMatrix[rIdx]];
            newRow[colIdx] = { ...(newRow[colIdx] || {}), v: data.formattedValue };
            newMatrix[rIdx] = newRow;
          }
          return { ...prev, matrix: newMatrix };
        });
      }
      setSaveSuccessMsg(`Updated Row ${sheetRow} (${colLetter})`);
      setTimeout(() => setSaveSuccessMsg(""), 3000);
    } catch (err) {
      console.error("update_view_cell error:", err);
      setError(err.message || "Failed to update cell");
      fetchBudgetData(selectedClient, true);
    }
  };

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isBudgetCellEditable(sheetRow, colIdx);
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    let initialEditVal = cellValue ?? "";
    if (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6 || (sheetRow >= 59 && sheetRow <= 111 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType: "text",
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell((prev) => (prev ? { ...prev, editValue: val } : null)),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => {
          committingRef.current = false;
        }, 100);
        if (!cur && overrideVal === undefined) return;

        const rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
        setSavingKey(`${sheetRow}_${colIdx}`);
        try {
          await handleUpdateCell(sheetRow, colIdx, rawVal);
        } finally {
          setSavingKey(null);
        }
      },
      onStartEdit: () => {
        setEditingCell({ sheetRow, colIdx, editValue: initialEditVal });
      },
      onCancelEdit: () => setEditingCell(null),
    };
  };

  const matrix = useMemo(() => budgetData?.matrix || [], [budgetData?.matrix]);
  const fyConfigs = budgetData?.fyConfigs || [];
  const currentFy = fyConfigs[selectedFyIdx] || fyConfigs[0] || null;
  const maxFyIdx = fyConfigs.length > 0 ? fyConfigs.length - 1 : 0;

  const fyCols = currentFy?.monthCols || [];
  const totalCol = currentFy?.totalCol || 19;
  const THEME_HEADER_BG = "#1e1b4b";

  const headerRow0 = matrix[0] || [];
  const headerRow1 = matrix[1] || [];

  // Filter matrix rows based on search term
  const filteredMatrixRows = useMemo(() => {
    const dataRows = matrix.slice(2);
    if (!searchTerm.trim()) {
      return dataRows.map((row, idx) => ({ row, sheetRow: 3 + idx }));
    }
    const q = searchTerm.toLowerCase().trim();
    return dataRows
      .map((row, idx) => ({ row, sheetRow: 3 + idx }))
      .filter(({ row }) => {
        const desc = String(row?.[0]?.v || "").toLowerCase();
        const type = String(row?.[1]?.v || "").toLowerCase();
        return desc.includes(q) || type.includes(q);
      });
  }, [matrix, searchTerm]);

  const targetSheetId = selectedClient?.masterSheetId || selectedClient?.clientSheetId;

  return (
    <div style={{ padding: "24px 32px", maxWidth: "1600px", margin: "0 auto", boxSizing: "border-box" }}>
      {/* Top Header Card */}
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
            <span>Budget</span>
            {budgetData?.isIncomeMode !== undefined && (
              <span
                style={{
                  fontSize: "12px",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  fontWeight: 600,
                }}
              >
                {budgetData.isIncomeMode ? "Income Mode" : "Revenue Mode"}
              </span>
            )}
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
            Master Sheet Budget model (rows 1–253) across 3 financial years
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Client Selector (if not managed) */}
          {!managedClient && (
            <div style={{ position: "relative" }}>
              <select
                value={selectedClient?.clientName || ""}
                onChange={(e) => {
                  const match = allOutgoingsClients.find((c) => c.clientName === e.target.value);
                  if (match) setSelectedClient(match);
                }}
                style={{
                  padding: "7px 12px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#1e293b",
                  fontWeight: 600,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                {filteredClients.map((c) => (
                  <option key={c.clientName} value={c.clientName}>
                    {c.clientName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {managedClient && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#1d4ed8",
              }}
            >
              <span>Managing: {managedClient.clientName}</span>
              <button
                type="button"
                onClick={onClearManagedClient}
                style={{
                  background: "none",
                  border: "none",
                  color: "#dc2626",
                  cursor: "pointer",
                  fontSize: "13px",
                  padding: "0 2px",
                }}
                title="Clear managed client"
              >
                ✕
              </button>
            </div>
          )}

          {/* FY Navigator */}
          {fyConfigs.length > 0 && (
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
                title="Previous Financial Year"
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
                {fyConfigs.map((fy, idx) => (
                  <option key={idx} value={idx}>
                    {fy.label || `FY${idx + 1}`}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setSelectedFyIdx((prev) => Math.min(maxFyIdx, prev + 1))}
                disabled={selectedFyIdx >= maxFyIdx}
                style={{
                  background: "#fff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  padding: "5px 8px",
                  cursor: selectedFyIdx >= maxFyIdx ? "not-allowed" : "pointer",
                  fontSize: "12px",
                  color: selectedFyIdx >= maxFyIdx ? "#cbd5e1" : "#1e293b",
                  fontWeight: 700,
                }}
                title="Next Financial Year"
              >
                ▶
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => selectedClient && fetchBudgetData(selectedClient, true)}
            disabled={loading}
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

          {isAdmin && targetSheetId && (
            <a
              href={`https://docs.google.com/spreadsheets/d/${targetSheetId}/edit#gid=0`}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: "7px 14px",
                borderRadius: "6px",
                border: "1px solid #166534",
                background: "#15803d",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              title="Open spreadsheet in Google Sheets"
            >
              <span>📊</span>
              <span>Open in Sheets</span>
            </a>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
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

      {saveSuccessMsg && (
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

      {/* Search / Filter Bar */}
      {budgetData && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            marginBottom: "14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <input
              type="text"
              placeholder="Search budget line items..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                width: "260px",
                outline: "none",
              }}
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                style={{
                  background: "none",
                  border: "none",
                  color: "#64748b",
                  fontSize: "12px",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={{ fontSize: "12px", color: "#64748b" }}>
            Showing {filteredMatrixRows.length} rows · Click on highlighted cells to edit
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {loading && !budgetData && (
        <div style={{ textAlign: "center", padding: "80px 20px", background: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
          <Spinner size={32} color="#0047AB" />
          <div style={{ marginTop: "14px", color: "#64748b", fontSize: "14px", fontWeight: 600 }}>
            Loading budget from Master Sheet...
          </div>
        </div>
      )}

      {budgetData && currentFy && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            overflow: "hidden",
          }}
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
              <thead>
                <tr style={{ background: THEME_HEADER_BG, color: "#ffffff" }}>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", width: "45px", textAlign: "center" }}>Row</th>
                  <th style={{ padding: "8px 10px", border: "1px solid #312e81", textAlign: "left", minWidth: "240px" }}>
                    {headerRow0?.[0]?.v || "Description"}
                  </th>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "75px", textAlign: "center" }}>Type</th>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "50px", textAlign: "center" }}>VAT</th>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "50px", textAlign: "center" }}>Pay</th>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "55px", textAlign: "center" }}>Del</th>
                  <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "55px", textAlign: "center" }}>Likl</th>
                  {fyCols.map((cIdx) => (
                    <th key={cIdx} style={{ padding: "8px 8px", border: "1px solid #312e81", minWidth: "85px", textAlign: "right" }}>
                      {headerRow1?.[cIdx]?.v || headerRow0?.[cIdx]?.v || `M${cIdx}`}
                    </th>
                  ))}
                  <th style={{ padding: "8px 8px", border: "1px solid #312e81", minWidth: "95px", textAlign: "right", background: "#312e81" }}>
                    {headerRow0?.[totalCol]?.v || "FY Total"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredMatrixRows.map(({ row, sheetRow }) => {
                  const isSectionHeader =
                    sheetRow === 4 ||
                    sheetRow === 12 ||
                    sheetRow === 19 ||
                    sheetRow === 58 ||
                    sheetRow === 118 ||
                    sheetRow === 126 ||
                    sheetRow === 149;

                  return (
                    <tr
                      key={sheetRow}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: isSectionHeader ? "#e0e7ff" : "#ffffff",
                        fontWeight: isSectionHeader ? "700" : "normal",
                      }}
                    >
                      <td style={{ padding: "5px 4px", textAlign: "center", color: "#94a3b8", background: isSectionHeader ? "#c7d2fe" : "#f8fafc", borderRight: "1px solid #e2e8f0" }}>
                        {sheetRow}
                      </td>
                      <td style={{ padding: "5px 10px", borderRight: "1px solid #f1f5f9", color: isSectionHeader ? "#1e1b4b" : "inherit" }}>
                        {row?.[0]?.v || ""}
                      </td>
                      <td style={{ padding: "5px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[1]?.v || ""}</td>
                      <td style={{ padding: "5px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[2]?.v || ""}</td>
                      <td style={{ padding: "5px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[3]?.v || ""}</td>
                      <td style={{ padding: "5px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[4]?.v || ""}</td>
                      <td style={{ padding: "5px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[5]?.v || ""}</td>
                      {fyCols.map((cIdx) => {
                        const cell = row?.[cIdx];
                        const opts = getEditableOpts(sheetRow, cIdx, cell?.v);
                        return (
                          <EditableCell
                            key={cIdx}
                            cell={cell}
                            editableOpts={opts}
                            align="right"
                            isAmount={true}
                          />
                        );
                      })}
                      <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: "700", background: isSectionHeader ? "#c7d2fe" : "#f8fafc" }}>
                        {row?.[totalCol]?.v || ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC EDITABLE CELL COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function EditableCell({ cell, editableOpts, align = "left", fontSize = "12px", isAmount = false }) {
  if (!editableOpts || !editableOpts.isEditable) {
    return (
      <td
        style={{
          padding: "5px 8px",
          textAlign: align,
          fontSize,
          borderRight: "1px solid #f1f5f9",
          whiteSpace: "nowrap",
        }}
      >
        {cell?.v ?? ""}
      </td>
    );
  }

  const { isEditing, isSaving, editValue, onChangeEditValue, onCommitEdit, onStartEdit, onCancelEdit } = editableOpts;

  if (isSaving) {
    return (
      <td style={{ padding: "5px 8px", textAlign: align, background: "#fef9c3", borderRight: "1px solid #fde047" }}>
        <Spinner size={12} color="#ca8a04" />
      </td>
    );
  }

  if (isEditing) {
    return (
      <td style={{ padding: "2px", textAlign: align, background: "#eff6ff" }}>
        <input
          type="text"
          value={editValue}
          autoFocus
          onChange={(e) => onChangeEditValue(e.target.value)}
          onBlur={() => onCommitEdit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
            if (e.key === "Enter") onCommitEdit();
          }}
          style={{
            width: "100%",
            fontSize,
            padding: "3px 5px",
            border: "1px solid #3b82f6",
            borderRadius: "3px",
            textAlign: align,
            boxSizing: "border-box",
            outline: "none",
          }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={onStartEdit}
      title="Click to edit cell"
      style={{
        padding: "5px 8px",
        textAlign: align,
        fontSize,
        borderRight: "1px solid #f1f5f9",
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: cell?.v ? "transparent" : "#fafafa",
        transition: "background 0.1s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#eff6ff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = cell?.v ? "transparent" : "#fafafa";
      }}
    >
      {cell?.v ?? ""}
    </td>
  );
}
