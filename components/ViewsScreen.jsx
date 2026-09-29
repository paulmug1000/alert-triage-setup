import React, { useState, useEffect, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";

// Columns checked to determine if a row is blank:
// Column A (0), G:R (6..17), V:AG (21..32), and AK:AV (36..47)
const BLANK_CHECK_COLS = [
  0,
  ...Array.from({ length: 12 }, (_, i) => 6 + i),  // G:R (6..17)
  ...Array.from({ length: 12 }, (_, i) => 21 + i), // V:AG (21..32)
  ...Array.from({ length: 12 }, (_, i) => 36 + i), // AK:AV (36..47)
];

function isRowBlank(row) {
  if (!row || row.length === 0) return true;
  for (const colIdx of BLANK_CHECK_COLS) {
    const val = row[colIdx]?.v;
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return false;
    }
  }
  return true;
}

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

function isBudgetCellEditable(sheetRow, colIdx) {
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

function isCellEditable(sheetRow, colIdx, screenTab) {
  const isAllowedCol =
    (colIdx >= 0 && colIdx <= 5) ||   // A:F
    (colIdx >= 6 && colIdx <= 17) ||  // G:R
    (colIdx >= 21 && colIdx <= 32) || // V:AG
    (colIdx >= 36 && colIdx <= 47);   // AK:AV

  if (screenTab === "contractors") {
    return sheetRow >= 13 && sheetRow <= 110 && isAllowedCol;
  }
  if (screenTab === "outgoings") {
    return sheetRow >= 126 && sheetRow <= 225 && isAllowedCol;
  }
  if (screenTab === "budget") {
    return isBudgetCellEditable(sheetRow, colIdx);
  }
  return false;
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

export default function ViewsScreen({ allClients, styles, isAdmin: propIsAdmin }) {
  const { user } = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : !!(user?.isAdmin || user?.role === "Admin" || user?.assignedClients === "*");
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientSearch, setClientSearch] = useState("");
  const [activeTab, setActiveTab] = useState("dashboard"); // 'dashboard' | 'cash' | 'contractors' | 'outgoings' | 'budget'
  
  // Data caches: { [clientSheetId]: { dashboard: data, cash: data, contractors: data, outgoings: data, budget: data } }
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // FY indices for tabs that support FY switching
  const [dashboardFyIdx, setDashboardFyIdx] = useState(0);
  const [contractorsFyIdx, setContractorsFyIdx] = useState(0);
  const [outgoingsFyIdx, setOutgoingsFyIdx] = useState(0);
  const [budgetFyIdx, setBudgetFyIdx] = useState(0);

  // Optional filter: show blank rows (default false = hidden)
  const [showBlankRows, setShowBlankRows] = useState(false);

  // Container refs for horizontal scrolling
  const cashContainerRef = useRef(null);

  // Auto-select first client if none selected and clients are available, or restore from sessionStorage
  useEffect(() => {
    if (!selectedClient && allClients && allClients.length > 0) {
      const saved = sessionStorage.getItem("pma_views_client");
      const found = saved ? allClients.find(c => c.clientName === saved) : null;
      if (found) {
        setSelectedClient(found);
      }
    }
  }, [allClients, selectedClient]);

  const handleSelectClient = (client) => {
    setSelectedClient(client);
    if (client) {
      sessionStorage.setItem("pma_views_client", client.clientName);
    }
  };

  // Fetch data for current client & tab
  const fetchData = async (client, tab, forceRefresh = false) => {
    if (!client || !client.clientSheetId) return;
    const clientKey = client.clientSheetId;

    if (!forceRefresh && cache[clientKey] && cache[clientKey][tab]) {
      return; // already cached
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_client_view_data",
          clientSheetId: client.clientSheetId,
          masterSheetId: client.masterSheetId,
          tab,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to load sheet data");
      }

      setCache(prev => ({
        ...prev,
        [clientKey]: {
          ...(prev[clientKey] || {}),
          [tab]: data,
        }
      }));

      // Initialize default FY indices
      if (tab === "dashboard" && data.defaultFyIndex !== undefined) {
        setDashboardFyIdx(data.defaultFyIndex);
      }
      if (tab === "contractors" && data.defaultFyIndex !== undefined) {
        setContractorsFyIdx(data.defaultFyIndex);
      }
      if (tab === "outgoings" && data.defaultFyIndex !== undefined) {
        setOutgoingsFyIdx(data.defaultFyIndex);
      }
      if (tab === "budget" && data.defaultFyIndex !== undefined) {
        setBudgetFyIdx(data.defaultFyIndex);
      }
    } catch (err) {
      console.error(`Error loading view [${tab}]:`, err);
      setError(err.message || "Failed to load sheet data");
    } finally {
      setLoading(false);
    }
  };

  // Whenever client or activeTab changes, fetch data if not in cache
  useEffect(() => {
    if (selectedClient) {
      fetchData(selectedClient, activeTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient, activeTab]);

  const handleRefresh = () => {
    if (selectedClient) {
      fetchData(selectedClient, activeTab, true);
    }
  };

  const handleUpdateCell = async (tabName, sheetRow, colIdx, newValue) => {
    if (!selectedClient || !selectedClient.clientSheetId) return;
    const clientKey = selectedClient.clientSheetId;
    const colLetter = colIndexToLetter(colIdx + 1);

    // Format newValue optimistically if amount or percentage
    let displayVal = newValue;
    if (colIdx >= 6 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (tabName === "budget" && sheetRow >= 59 && sheetRow <= 111 && colIdx === 1 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (((tabName === "budget" && (colIdx === 4 || (sheetRow === 142 && colIdx === 1))) ||
                ((tabName === "contractors" || tabName === "outgoings") && (colIdx === 4 || colIdx === 5))) && newValue !== "") {
      const clean = String(newValue).replace(/%/g, "").trim();
      const num = parseFloat(clean);
      if (!isNaN(num)) {
        displayVal = `${num}%`;
      }
    }

    // Optimistically update cache
    setCache(prev => {
      const clientData = prev[clientKey];
      if (!clientData || !clientData[tabName]) return prev;
      const tabData = clientData[tabName];

      const updateRowList = (rows, startRow) => {
        return (rows || []).map((row, idx) => {
          if (startRow + idx !== sheetRow) return row;
          const newRow = [...(row || [])];
          newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
          return newRow;
        });
      };

      const updatedTabData = { ...tabData };
      if (tabName === "contractors") {
        if (updatedTabData.contractorRows) {
          updatedTabData.contractorRows = updateRowList(updatedTabData.contractorRows, 13);
        }
        if (updatedTabData.mainRows) {
          updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 13);
        }
      } else if (tabName === "outgoings") {
        if (updatedTabData.outgoingRows) {
          updatedTabData.outgoingRows = updateRowList(updatedTabData.outgoingRows, 126);
        }
        if (updatedTabData.mainRows) {
          updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 126);
        }
      } else if (tabName === "budget") {
        if (updatedTabData.matrix) {
          const newMatrix = [...updatedTabData.matrix];
          const rIdx = sheetRow - 1;
          if (newMatrix[rIdx]) {
            const newRow = [...newMatrix[rIdx]];
            newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
            newMatrix[rIdx] = newRow;
            updatedTabData.matrix = newMatrix;
          }
        }
      }

      return {
        ...prev,
        [clientKey]: {
          ...clientData,
          [tabName]: updatedTabData,
        }
      };
    });

    try {
      const currentTab = cache[clientKey]?.[tabName];
      let rowDesc = "";
      if (tabName === "contractors") {
        const r = currentTab?.contractorRows?.[sheetRow - 13] || currentTab?.mainRows?.[sheetRow - 13];
        rowDesc = r?.[0]?.v || "";
      } else if (tabName === "outgoings") {
        const r = currentTab?.outgoingRows?.[sheetRow - 126] || currentTab?.mainRows?.[sheetRow - 126];
        rowDesc = r?.[0]?.v || "";
      } else if (tabName === "budget") {
        const r = currentTab?.matrix?.[sheetRow - 1];
        rowDesc = r?.[0]?.v || `Row ${sheetRow}`;
      }
      const headerLabel = tabName === "budget"
        ? (currentTab?.matrix?.[0]?.[colIdx]?.v || "")
        : (currentTab?.headerRow?.[colIdx]?.v || "");

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_view_cell",
          clientSheetId: selectedClient.clientSheetId,
          masterSheetId: selectedClient.masterSheetId,
          clientName: selectedClient.clientName,
          tab: tabName === "budget" ? "Budget" : "Outgoings",
          screenTab: tabName,
          sheetRow,
          colLetter,
          colIdx,
          value: displayVal,
          contractorName: tabName === "contractors" ? (colIdx === 0 ? displayVal : rowDesc) : undefined,
          rowDescription: (tabName === "outgoings" || tabName === "budget") ? (colIdx === 0 ? displayVal : rowDesc) : undefined,
          headerLabel,
          monthLabel: headerLabel,
        })
      });

      let data;
      const rawText = await res.text();
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error(`Server error (${res.status}): ${rawText.slice(0, 100) || res.statusText}`);
      }
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Failed to update cell (status ${res.status})`);
      }

      // If backend returns updatedMatrix for budget, update entire matrix immediately
      if (tabName === "budget" && data.updatedMatrix) {
        setCache(prev => {
          const clientData = prev[clientKey];
          if (!clientData || !clientData.budget) return prev;
          return {
            ...prev,
            [clientKey]: {
              ...clientData,
              budget: {
                ...clientData.budget,
                matrix: data.updatedMatrix,
              }
            }
          };
        });
      } else if (data.value !== undefined && data.value !== displayVal) {
        setCache(prev => {
          const clientData = prev[clientKey];
          if (!clientData || !clientData[tabName]) return prev;
          const tabData = clientData[tabName];
          const updateRowList = (rows, startRow) => {
            return (rows || []).map((row, idx) => {
              if (startRow + idx !== sheetRow) return row;
              const newRow = [...(row || [])];
              newRow[colIdx] = { ...(newRow[colIdx] || {}), v: data.value };
              return newRow;
            });
          };
          const updatedTabData = { ...tabData };
          if (tabName === "contractors") {
            if (updatedTabData.contractorRows) updatedTabData.contractorRows = updateRowList(updatedTabData.contractorRows, 13);
            if (updatedTabData.mainRows) updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 13);
          } else if (tabName === "outgoings") {
            if (updatedTabData.outgoingRows) updatedTabData.outgoingRows = updateRowList(updatedTabData.outgoingRows, 126);
            if (updatedTabData.mainRows) updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 126);
          }
          return {
            ...prev,
            [clientKey]: { ...clientData, [tabName]: updatedTabData }
          };
        });
      }
    } catch (err) {
      console.error("Error updating cell:", err);
      fetchData(selectedClient, tabName, true);
      alert(`Could not save change: ${err.message}`);
    }
  };

  // Cash horizontal scroll effect
  const cashData = selectedClient ? cache[selectedClient.clientSheetId]?.cash : null;
  useEffect(() => {
    if (activeTab === "cash" && cashData && cashContainerRef.current) {
      const targetColIdx = cashData.prevMonthColIdx || 1;
      const targetCell = cashContainerRef.current.querySelector(`[data-cash-col="${targetColIdx}"]`);
      if (targetCell) {
        const stickyWidth = 260; // approximate Col A sticky width
        const scrollTarget = Math.max(0, targetCell.offsetLeft - stickyWidth);
        cashContainerRef.current.scrollTo({ left: scrollTarget, behavior: "smooth" });
      }
    }
  }, [activeTab, cashData]);

  // Filter clients for dropdown
  const filteredClients = (allClients || []).filter(c =>
    c.clientName.toLowerCase().includes(clientSearch.toLowerCase())
  );

  const currentClientData = selectedClient ? cache[selectedClient.clientSheetId] : null;
  const currentTabData = currentClientData ? currentClientData[activeTab] : null;

  return (
    <div style={{ padding: "20px 24px", minHeight: "calc(100vh - 60px)", background: "#f8fafc" }}>
      <style>{`
        .editable-view-cell:hover {
          background-color: #eff6ff !important;
          outline: 1.5px dashed #3b82f6;
          outline-offset: -1.5px;
        }
      `}</style>
      {/* Top Header Bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "16px",
        marginBottom: "20px",
        background: "#ffffff",
        padding: "16px 20px",
        borderRadius: "10px",
        border: "1px solid #e2e8f0",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        {/* Left: Title & Client Selector */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: "700", color: "#0f172a" }}>Views</h1>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "600", color: "#475569" }}>Client:</span>
            <select
              value={selectedClient ? selectedClient.clientName : ""}
              onChange={(e) => {
                const found = (allClients || []).find(c => c.clientName === e.target.value);
                handleSelectClient(found || null);
              }}
              style={{
                padding: "8px 14px",
                fontSize: "14px",
                fontWeight: "600",
                color: "#1e293b",
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                cursor: "pointer",
                outline: "none",
                minWidth: "220px",
              }}
            >
              <option value="" disabled>-- Select a Client --</option>
              {(allClients || []).map(c => (
                <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Right: Actions (Refresh, Open Sheets) */}
        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="triage-btn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#0284c7",
                background: "#e0f2fe",
                border: "1px solid #bae6fd",
                borderRadius: "6px",
                cursor: loading ? "not-allowed" : "pointer",
              }}
              title="Pull fresh data from Google Sheet"
            >
              <span style={{ display: "inline-block", transform: loading ? "rotate(180deg)" : "none", transition: "transform 0.5s" }}>🔄</span>
              {loading ? "Refreshing..." : "Refresh Live Data"}
            </button>

            {isAdmin && (selectedClient.clientSheetId || selectedClient.masterSheetId) && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${(activeTab === "budget" && selectedClient.masterSheetId) ? selectedClient.masterSheetId : selectedClient.clientSheetId}/edit`}
                target="_blank"
                rel="noreferrer"
                className="triage-btn"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#15803d",
                  background: "#dcfce7",
                  border: "1px solid #bbf7d0",
                  borderRadius: "6px",
                  textDecoration: "none",
                }}
                title={activeTab === "budget" ? "Open Master Sheet in Google Sheets" : "Open Client Sheet in Google Sheets"}
              >
                📊 Open in Sheets
              </a>
            )}
          </div>
        )}
      </div>

      {/* Main Content Area */}
      {selectedClient && (
        <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 2px 6px rgba(0,0,0,0.03)", overflow: "hidden" }}>
          {/* Tabs Navigation */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            padding: "0 16px",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            <div style={{ display: "flex", alignItems: "stretch", gap: "4px" }}>
              {[
                { id: "dashboard", label: "Dashboard" },
                { id: "cash", label: "Cash" },
                { id: "contractors", label: "Contractors" },
                { id: "outgoings", label: "Outgoings" },
                { id: "budget", label: "Budget" },
              ].map(tab => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      background: isActive ? "#ffffff" : "transparent",
                      border: "none",
                      borderTop: isActive ? "3px solid #0066cc" : "3px solid transparent",
                      borderLeft: isActive ? "1px solid #e2e8f0" : "1px solid transparent",
                      borderRight: isActive ? "1px solid #e2e8f0" : "1px solid transparent",
                      borderBottom: isActive ? "1px solid #ffffff" : "none",
                      color: isActive ? "#0066cc" : "#64748b",
                      fontWeight: isActive ? "700" : "500",
                      fontSize: "14px",
                      padding: "12px 20px",
                      cursor: "pointer",
                      marginBottom: "-1px",
                      borderRadius: isActive ? "6px 6px 0 0" : "0",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      transition: "all 0.15s ease"
                    }}
                  >
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Optional Controls on Right (Show blank rows toggle) */}
            {(activeTab === "contractors" || activeTab === "outgoings") && (
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#475569", cursor: "pointer", userSelect: "none", fontWeight: "500" }}>
                <input
                  type="checkbox"
                  checked={showBlankRows}
                  onChange={(e) => setShowBlankRows(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                Show blank rows
              </label>
            )}
          </div>

          {/* Tab Content Display */}
          <div style={{ padding: "16px" }}>
            {loading && !currentTabData ? (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <Spinner size={32} color="#0066cc" />
                <div style={{ marginTop: "14px", fontSize: "14px", color: "#64748b" }}>Loading live sheet data...</div>
              </div>
            ) : error ? (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "16px", color: "#991b1b", fontSize: "14px" }}>
                <strong>Error:</strong> {error}
                <div style={{ marginTop: "10px" }}>
                  <button onClick={handleRefresh} style={{ padding: "6px 14px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <>
                {activeTab === "dashboard" && (
                  <DashboardView
                    data={currentTabData}
                    fyIdx={dashboardFyIdx}
                    onFyChange={setDashboardFyIdx}
                  />
                )}

                {activeTab === "cash" && (
                  <CashView
                    data={currentTabData}
                    containerRef={cashContainerRef}
                  />
                )}

                {activeTab === "contractors" && (
                  <ContractorsView
                    data={currentTabData}
                    fyIdx={contractorsFyIdx}
                    onFyChange={setContractorsFyIdx}
                    showBlankRows={showBlankRows}
                    onUpdateCell={handleUpdateCell}
                  />
                )}

                {activeTab === "outgoings" && (
                  <OutgoingsTableView
                    data={currentTabData}
                    fyIdx={outgoingsFyIdx}
                    onFyChange={setOutgoingsFyIdx}
                    showBlankRows={showBlankRows}
                    onUpdateCell={handleUpdateCell}
                  />
                )}

                {activeTab === "budget" && (
                  <BudgetView
                    data={currentTabData}
                    fyIdx={budgetFyIdx}
                    onFyChange={setBudgetFyIdx}
                    onUpdateCell={handleUpdateCell}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SPREADSHEET CELL HELPER
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// SPREADSHEET CELL HELPER
// ─────────────────────────────────────────────────────────────────────────────
function renderCell(cell, isSticky = false, stickyLeft = 0, isHeader = false, customStyle = {}, editableOpts = null) {
  const v = cell?.v ?? "";
  const bg = customStyle.backgroundColor || cell?.bg;
  const fg = customStyle.color || cell?.c;
  const isBold = customStyle.fontWeight 
    ? (customStyle.fontWeight === "700" || customStyle.fontWeight === "bold") 
    : (!!cell?.b || isHeader);
  const isItalic = !!cell?.i;
  const align = customStyle.textAlign || cell?.a || (v && (v.startsWith("£") || v.startsWith("-") || !isNaN(v.replace(/[£,%\s-]/g, ""))) ? "right" : "left");

  const isEditable = !!editableOpts?.isEditable;
  const isEditing = !!editableOpts?.isEditing;
  const isSaving = !!editableOpts?.isSaving;

  if (isEditing) {
    if (editableOpts.inputType === "select") {
      return (
        <td
          style={{
            padding: "0",
            fontSize: "11px",
            fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
            backgroundColor: "#ffffff",
            textAlign: "center",
            verticalAlign: "middle",
            boxSizing: "border-box",
            ...(isSticky ? {
              position: "sticky",
              left: stickyLeft,
              zIndex: 5,
              boxShadow: stickyLeft === 0 ? "2px 0 4px -1px rgba(0,0,0,0.12)" : undefined,
            } : {}),
            ...customStyle,
            border: "2px solid #2563eb",
          }}
        >
          <select
            autoFocus
            value={editableOpts.editValue ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              editableOpts.onChangeEditValue?.(val);
              editableOpts.onCommitEdit?.(val);
            }}
            onBlur={() => editableOpts.onCommitEdit?.()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                editableOpts.onCancelEdit?.();
              }
            }}
            style={{
              width: "100%",
              height: "100%",
              minHeight: "24px",
              border: "none",
              outline: "none",
              padding: "1px 2px",
              fontSize: "10.5px",
              fontWeight: "600",
              fontFamily: "inherit",
              textAlign: "center",
              backgroundColor: "#ffffff",
              color: "#0f172a",
              cursor: "pointer",
            }}
          >
            <option value="">—</option>
            {(editableOpts.options || []).map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </td>
      );
    }

    return (
      <td
        style={{
          padding: "0",
          fontSize: "11px",
          fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
          border: "2px solid #2563eb",
          backgroundColor: "#ffffff",
          textAlign: align,
          verticalAlign: "middle",
          boxSizing: "border-box",
          ...(isSticky ? {
            position: "sticky",
            left: stickyLeft,
            zIndex: 5,
            boxShadow: stickyLeft === 0 ? "2px 0 4px -1px rgba(0,0,0,0.12)" : undefined,
          } : {}),
          ...customStyle,
        }}
      >
        <input
          type="text"
          autoFocus
          value={editableOpts.editValue ?? ""}
          onChange={(e) => editableOpts.onChangeEditValue?.(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => editableOpts.onCommitEdit?.()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              editableOpts.onCommitEdit?.();
            } else if (e.key === "Escape") {
              e.preventDefault();
              editableOpts.onCancelEdit?.();
            }
          }}
          style={{
            width: "100%",
            height: "100%",
            minHeight: "24px",
            border: "none",
            outline: "none",
            padding: "2px 5px",
            fontSize: "inherit",
            fontFamily: "inherit",
            fontWeight: isBold ? "700" : "400",
            textAlign: align,
            backgroundColor: "#ffffff",
            color: "#0f172a",
            boxSizing: "border-box",
          }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={isEditable && !isSaving ? editableOpts.onStartEdit : undefined}
      title={isEditable ? "Click to edit cell" : undefined}
      className={isEditable ? "editable-view-cell" : undefined}
      style={{
        padding: "4px 6px",
        fontSize: "11px",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
        borderBottom: cell?.bb || "1px solid #e5e7eb",
        borderTop: cell?.bt || "none",
        borderLeft: cell?.bl || "none",
        borderRight: cell?.br || "1px solid #e5e7eb",
        textAlign: align,
        fontWeight: isBold ? "700" : "400",
        fontStyle: isItalic ? "italic" : "normal",
        backgroundColor: bg || (isSticky ? (isHeader ? "#f1f5f9" : "#ffffff") : "inherit"),
        color: fg || (isHeader ? "#0f172a" : "#1e293b"),
        cursor: isEditable ? "pointer" : "default",
        position: isSticky ? "sticky" : "relative",
        transition: "background-color 0.15s ease",
        ...(isSticky ? {
          left: stickyLeft,
          zIndex: isHeader ? 5 : 2,
          boxShadow: stickyLeft === 0 ? "2px 0 4px -1px rgba(0,0,0,0.08)" : undefined,
        } : {}),
        ...customStyle,
      }}
    >
      {isSaving ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", opacity: 0.7 }}>
          <Spinner size={10} color="#2563eb" />
          <span>{v}</span>
        </span>
      ) : (
        v !== "" ? v : (isEditable ? <span style={{ opacity: 0.25 }}>—</span> : "")
      )}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DASHBOARD VIEW (Down to row 54, 3 FYs, compact to fit desktop)
// ─────────────────────────────────────────────────────────────────────────────
function DashboardView({ data, fyIdx, onFyChange }) {
  if (!data || !data.matrix || !data.fyConfigs) return null;

  const { matrix, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY columns: Month columns (12) + Total column
  const activeMonthCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;

  const DARK_BLUE = "#002060";

  return (
    <div>
      {/* FY Switcher Bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#f1f5f9",
        padding: "6px 14px",
        borderRadius: "8px",
        marginBottom: "10px",
        border: "1px solid #e2e8f0"
      }}>
        <button
          onClick={() => onFyChange(Math.max(0, fyIdx - 1))}
          disabled={fyIdx === 0}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === 0 ? "#e2e8f0" : "#ffffff",
            color: fyIdx === 0 ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === 0 ? "not-allowed" : "pointer",
          }}
        >
          ◀ Previous FY
        </button>

        <div style={{ textAlign: "center" }}>
          <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
            {currentFy.label || `Financial Year ${fyIdx + 1}`}
          </span>
          <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "8px" }}>
            ({currentFy.months?.[0]?.label || ""} – {currentFy.months?.[11]?.label || ""})
          </span>
        </div>

        <button
          onClick={() => onFyChange(Math.min(maxFyIdx, fyIdx + 1))}
          disabled={fyIdx === maxFyIdx}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === maxFyIdx ? "#e2e8f0" : "#ffffff",
            color: fyIdx === maxFyIdx ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === maxFyIdx ? "not-allowed" : "pointer",
          }}
        >
          Next FY ▶
        </button>
      </div>

      {/* Spreadsheet Table: Compact widths so the whole FY fits on desktop */}
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
          <thead>
            {/* Header Row 1: Month names + FY Total (Dark Blue Background, White Text) */}
            <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
              {renderCell(matrix[0]?.[0] || { v: "" }, true, 0, true, {
                width: "180px", minWidth: "160px", maxWidth: "200px",
                backgroundColor: DARK_BLUE, color: "#ffffff", fontWeight: "700",
                borderBottom: "1px solid #001744"
              })}
              {activeMonthCols.map((colIdx) => (
                <React.Fragment key={colIdx}>
                  {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                    width: "58px", minWidth: "52px", maxWidth: "68px",
                    padding: "4px 2px", textAlign: "right",
                    backgroundColor: DARK_BLUE, color: "#ffffff", fontWeight: "700",
                    borderBottom: "1px solid #001744"
                  })}
                </React.Fragment>
              ))}
              {renderCell(matrix[0]?.[totalCol] || { v: "" }, false, 0, true, {
                width: "75px", minWidth: "70px", maxWidth: "85px",
                padding: "4px 6px", textAlign: "right",
                backgroundColor: DARK_BLUE, color: "#ffffff", fontWeight: "700",
                borderBottom: "1px solid #001744"
              })}
            </tr>

            {/* Header Row 2: Status ("Actual" / "Forecast") */}
            <tr style={{ background: "#f1f5f9", position: "sticky", top: "27px", zIndex: 6 }}>
              {renderCell(matrix[1]?.[0] || { v: "" }, true, 0, true, {
                width: "180px", minWidth: "160px", maxWidth: "200px",
                borderBottom: "2px solid #64748b", fontSize: "10.5px", background: "#f1f5f9"
              })}
              {activeMonthCols.map((colIdx) => (
                <React.Fragment key={colIdx}>
                  {renderCell(matrix[1]?.[colIdx] || { v: "" }, false, 0, true, {
                    width: "58px", minWidth: "52px", maxWidth: "68px",
                    padding: "2px 2px", textAlign: "right",
                    borderBottom: "2px solid #64748b", fontSize: "10px", color: "#475569"
                  })}
                </React.Fragment>
              ))}
              {renderCell(matrix[1]?.[totalCol] || { v: "" }, false, 0, true, {
                width: "75px", minWidth: "70px", maxWidth: "85px",
                padding: "2px 6px", textAlign: "right",
                borderBottom: "2px solid #64748b", fontSize: "10px", color: "#475569"
              })}
            </tr>
          </thead>
          <tbody>
            {/* Data Rows 3 to 54 (indices 2 to 53) */}
            {matrix.slice(2, 54).map((row, rIdx) => {
              const labelCell = row?.[0];
              const labelText = labelCell?.v || "";
              const isSectionHeader = labelText && !row.slice(1).some(c => c?.v);
              const isSpacerRow = !labelText && !row.slice(1).some(c => c?.v);

              const prevRowLabel = (rIdx > 0 ? matrix.slice(2, 54)[rIdx - 1]?.[0]?.v : "") || "";
              const nextRowLabel = (rIdx + 1 < 52 ? matrix.slice(2, 54)[rIdx + 1]?.[0]?.v : "") || "";

              const isStaffCostRow = labelText.toLowerCase().startsWith("staff costs to");
              const isOperatingToStaffSpacer = isSpacerRow && (
                prevRowLabel.toLowerCase().includes("operating profit %") || 
                nextRowLabel.toLowerCase().startsWith("staff costs to")
              );

              // If this is the spacer row between Operating Profit % and Staff costs to revenue/income
              if (isOperatingToStaffSpacer) {
                return (
                  <tr key={rIdx} style={{ height: "24px" }}>
                    <td
                      colSpan={activeMonthCols.length + 2}
                      style={{
                        height: "24px",
                        background: "#ffffff",
                        border: "none",
                        padding: 0,
                        lineHeight: "24px",
                        userSelect: "none"
                      }}
                    >
                      &nbsp;
                    </td>
                  </tr>
                );
              }

              const labelLower = labelText.trim().toLowerCase();

              // 1. If label is "Hide", hide the row entirely
              if (labelLower === "hide") {
                return null;
              }

              // 2. Primary headline metrics (slightly bigger than everything else: 13px bold)
              const isPrimaryHeadline = 
                labelLower === "total income" ||
                labelLower === "total revenue" ||
                labelLower === "gross profit" ||
                labelLower === "operating profit";

              // 3. Margin rows (slightly smaller than everything else and NOT bold: 9.5px, normal weight)
              const isMarginRow = 
                labelLower.includes("gross profit margin") ||
                labelLower === "operating profit %" ||
                labelLower.includes("operating profit margin");

              // 4. Staff costs ratio row (NOT bold: 10.5px, normal weight)
              const isStaffCostRatioRow = labelLower.startsWith("staff costs to");

              // 5. Subtotal rows (11.5px bold)
              const isSubtotalRow = !isPrimaryHeadline && !isMarginRow && !isStaffCostRatioRow && (
                !!labelCell?.b || 
                labelLower.startsWith("total") || 
                labelLower.includes("net profit") ||
                row.some(c => c?.bb && c.bb.includes("double"))
              );

              let rowFontSize = "10.5px";
              let rowFontWeight = "400";
              let rowPadding = "2.5px 3px";

              if (isPrimaryHeadline) {
                rowFontSize = "13px";
                rowFontWeight = "700";
                rowPadding = "3.5px 4px";
              } else if (isMarginRow) {
                rowFontSize = "9.5px";
                rowFontWeight = "400";
                rowPadding = "2px 3px";
              } else if (isStaffCostRatioRow) {
                rowFontSize = "10.5px";
                rowFontWeight = "400";
                rowPadding = "2.5px 3px";
              } else if (isSubtotalRow) {
                rowFontSize = "11.5px";
                rowFontWeight = "700";
                rowPadding = "3px 4px";
              }

              // If for any client there is no blank row between Operating Profit % and Staff costs, insert one
              const needsPrecedingOpSpacer = isStaffCostRow && prevRowLabel.toLowerCase().includes("operating profit %");

              return (
                <React.Fragment key={rIdx}>
                  {needsPrecedingOpSpacer && (
                    <tr key={`spacer-before-${rIdx}`} style={{ height: "24px" }}>
                      <td
                        colSpan={activeMonthCols.length + 2}
                        style={{
                          height: "24px",
                          background: "#ffffff",
                          border: "none",
                          padding: 0,
                          lineHeight: "24px",
                          userSelect: "none"
                        }}
                      >
                        &nbsp;
                      </td>
                    </tr>
                  )}
                  <tr style={{ background: undefined }}>
                    {renderCell(labelCell, true, 0, false, {
                      width: "180px", minWidth: "160px", maxWidth: "200px",
                      fontSize: rowFontSize, padding: isPrimaryHeadline ? "3.5px 6px" : (isSubtotalRow ? "3px 6px" : "2.5px 6px"),
                      fontWeight: rowFontWeight,
                      borderBottom: isSpacerRow ? "none" : undefined
                    })}
                    {activeMonthCols.map((colIdx) => (
                      <React.Fragment key={colIdx}>
                        {renderCell(row?.[colIdx], false, 0, false, {
                          width: "58px", minWidth: "52px", maxWidth: "68px",
                          fontSize: rowFontSize, padding: rowPadding,
                          fontWeight: rowFontWeight,
                          borderBottom: isSpacerRow ? "none" : undefined
                        })}
                      </React.Fragment>
                    ))}
                    {renderCell(row?.[totalCol], false, 0, false, {
                      width: "75px", minWidth: "70px", maxWidth: "85px",
                      fontSize: rowFontSize, padding: isPrimaryHeadline ? "3.5px 6px" : (isSubtotalRow ? "3px 6px" : "2.5px 6px"),
                      fontWeight: rowFontWeight,
                      borderBottom: isSpacerRow ? "none" : undefined
                    })}
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CASH VIEW (Down to row 76, dark green header, white text, no "PREV MO")
// ─────────────────────────────────────────────────────────────────────────────
function CashView({ data, containerRef }) {
  if (!data || !data.matrix) return null;

  const { matrix, monthCols, prevMonthColIdx } = data;
  const allDataCols = monthCols.map(m => m.colIdx);
  const DARK_GREEN = "#14532d";

  const scrollToPrevMonth = () => {
    if (containerRef.current) {
      const targetCell = containerRef.current.querySelector(`[data-cash-col="${prevMonthColIdx}"]`);
      if (targetCell) {
        const stickyWidth = 240;
        const scrollTarget = Math.max(0, targetCell.offsetLeft - stickyWidth);
        containerRef.current.scrollTo({ left: scrollTarget, behavior: "smooth" });
      }
    }
  };

  const scrollToStart = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ left: 0, behavior: "smooth" });
    }
  };

  const prevMonthLabel = monthCols.find(m => m.colIdx === prevMonthColIdx)?.label || "Previous Month";

  return (
    <div>
      {/* Scroll Navigation Quick Jump */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#f1f5f9",
        padding: "6px 14px",
        borderRadius: "8px",
        marginBottom: "10px",
        border: "1px solid #e2e8f0"
      }}>
        <span style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
          Showing 36 Rolling Months (Col B to AK)
        </span>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={scrollToStart}
            className="triage-btn"
            style={{
              padding: "4px 10px",
              fontSize: "12px",
              fontWeight: "600",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "4px",
              cursor: "pointer",
              color: "#475569"
            }}
          >
            ⏮ Scroll to First Month
          </button>
          <button
            onClick={scrollToPrevMonth}
            className="triage-btn"
            style={{
              padding: "4px 12px",
              fontSize: "12px",
              fontWeight: "600",
              background: "#0284c7",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              color: "#ffffff"
            }}
          >
            🎯 Jump to {prevMonthLabel}
          </button>
        </div>
      </div>

      {/* Spreadsheet Table */}
      <div ref={containerRef} style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "11px", background: "#ffffff" }}>
          <thead>
            {/* Row 1: Month Headers (Whole row has dark green background, all text white, NO "PREV MO") */}
            <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
              {renderCell(matrix[0]?.[0] || { v: "" }, true, 0, true, {
                width: "240px", minWidth: "220px", maxWidth: "260px",
                backgroundColor: DARK_GREEN, color: "#ffffff", fontWeight: "700",
                borderBottom: "2px solid #0b381e"
              })}
              {allDataCols.map((colIdx) => (
                <th
                  key={colIdx}
                  data-cash-col={colIdx}
                  style={{
                    padding: "5px 8px",
                    fontSize: "11px",
                    whiteSpace: "nowrap",
                    fontWeight: "700",
                    backgroundColor: DARK_GREEN,
                    color: "#ffffff",
                    borderBottom: "2px solid #0b381e",
                    borderRight: "1px solid rgba(255,255,255,0.15)",
                    textAlign: "right",
                    minWidth: "78px",
                  }}
                >
                  {matrix[0]?.[colIdx]?.v || ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.slice(1, 76).map((row, rIdx) => {
              const labelCell = row?.[0];
              const isSectionHeader = labelCell?.v && !row.slice(1).some(c => c?.v);
              return (
                <tr key={rIdx} style={{ background: isSectionHeader ? "#f1f5f9" : undefined }}>
                  {renderCell(labelCell, true, 0, false, {
                    width: "240px", minWidth: "220px", maxWidth: "260px",
                    padding: "3px 6px"
                  })}
                  {allDataCols.map((colIdx) => (
                    <React.Fragment key={colIdx}>
                      {renderCell(row?.[colIdx], false, 0, false, {
                        minWidth: "78px",
                        padding: "3px 5px",
                      })}
                    </React.Fragment>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CONTRACTORS VIEW (Dark red header, white text, 50% narrower info cols)
// ─────────────────────────────────────────────────────────────────────────────
function ContractorsView({ data, fyIdx, onFyChange, showBlankRows, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [savingKey, setSavingKey] = useState(null); // `${sheetRow}_${colIdx}`
  const committingRef = useRef(false);

  if (!data || !data.fyConfigs) return null;

  const { headerRow, contractorRows, totalRows, mainRows, section1Rows, section2Rows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY columns: Month columns (12) + Total column
  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];

  const DARK_RED = "#7f1d1d";

  // Rows 13 to 110 (Contractor data rows)
  const rawContractors = (contractorRows || (mainRows ? mainRows.slice(0, 98) : [])).map((row, idx) => ({
    row,
    sheetRow: 13 + idx,
  }));

  const visibleContractors = showBlankRows
    ? rawContractors
    : rawContractors.filter(item => !isRowBlank(item.row));

  // Summary / totals rows (Rows 111 to 114)
  const contractorTotals = totalRows || (mainRows ? mainRows.slice(98, 102) : []);

  // 5 info columns made MUCH narrower (at least 50% narrower) with smaller text
  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Contractor Name", width: "170px", minWidth: "150px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isCellEditable(sheetRow, colIdx, "contractors");
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    // Determine input type and options based on column index
    let inputType = "text";
    let options = null;
    let initialEditVal = cellValue ?? "";

    if (colIdx === 1) { // VAT?
      inputType = "select";
      options = ["Yes", "No"];
    } else if (colIdx === 2 || colIdx === 3) { // Inv? or Pay?
      inputType = "select";
      options = ["Curr", "Next"];
    } else if (colIdx === 4 || colIdx === 5) { // Del or Likl. %
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6) { // Month amount columns
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType,
      options,
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell(prev => prev ? { ...prev, editValue: val } : null),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
        let finalVal = String(rawVal ?? "").trim();

        // Validation for Del & Likl. % (colIdx 4 & 5)
        if (colIdx === 4 || colIdx === 5) {
          if (finalVal !== "") {
            const clean = finalVal.replace(/%/g, "").trim();
            const num = parseFloat(clean);
            if (isNaN(num) || num < 0 || num > 100) {
              alert("Percentage must be a number between 0 and 100 (e.g. 50% or 100).");
              return;
            }
            finalVal = `${num}%`;
          }
        }

        // Formatting for month currency columns (colIdx >= 6)
        if (colIdx >= 6) {
          if (finalVal !== "") {
            const clean = finalVal.replace(/[£,\s]/g, "");
            if (!isNaN(clean) && clean !== "") {
              finalVal = formatCurrency(clean);
            }
          }
        }

        const oldVal = cellValue ?? "";
        if (String(finalVal).trim() === String(oldVal).trim()) return;

        const key = `${sheetRow}_${colIdx}`;
        setSavingKey(key);
        try {
          if (onUpdateCell) {
            await onUpdateCell("contractors", sheetRow, colIdx, finalVal);
          }
        } finally {
          setSavingKey(null);
        }
      },
      onCancelEdit: () => setEditingCell(null),
      onStartEdit: () => setEditingCell({ sheetRow, colIdx, editValue: initialEditVal }),
    };
  };

  return (
    <div>
      {/* FY Switcher Bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#f1f5f9",
        padding: "6px 14px",
        borderRadius: "8px",
        marginBottom: "10px",
        border: "1px solid #e2e8f0"
      }}>
        <button
          onClick={() => onFyChange(Math.max(0, fyIdx - 1))}
          disabled={fyIdx === 0}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === 0 ? "#e2e8f0" : "#ffffff",
            color: fyIdx === 0 ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === 0 ? "not-allowed" : "pointer",
          }}
        >
          ◀ Previous FY
        </button>

        <div style={{ textAlign: "center" }}>
          <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
            {currentFy.label || `Financial Year ${fyIdx + 1}`}
          </span>
          <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "8px" }}>
            ({currentFy.months?.[0]?.label || ""} – {currentFy.months?.[11]?.label || ""})
          </span>
        </div>

        <button
          onClick={() => onFyChange(Math.min(maxFyIdx, fyIdx + 1))}
          disabled={fyIdx === maxFyIdx}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === maxFyIdx ? "#e2e8f0" : "#ffffff",
            color: fyIdx === maxFyIdx ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === maxFyIdx ? "not-allowed" : "pointer",
          }}
        >
          Next FY ▶
        </button>
      </div>

      {/* Spreadsheet Table: Fits full FY on desktop */}
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
          <thead>
            {/* Header Row: Dark Red Background, White Text */}
            <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
              {metaCols.map((c, i) => (
                <React.Fragment key={c.idx}>
                  {renderCell(headerRow?.[c.idx] || { v: c.label }, i === 0, 0, true, {
                    width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth,
                    fontSize: c.isName ? "11px" : "9px",
                    padding: c.isName ? "4px 6px" : "3px 1px",
                    textAlign: c.isName ? "left" : "center",
                    backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                    borderBottom: "2px solid #5a1414"
                  })}
                </React.Fragment>
              ))}
              {fyCols.map((colIdx) => (
                <React.Fragment key={colIdx}>
                  {renderCell(headerRow?.[colIdx] || { v: "" }, false, 0, true, {
                    width: "56px", minWidth: "50px", maxWidth: "66px",
                    padding: "4px 2px", textAlign: "right",
                    fontSize: "11px",
                    backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                    borderBottom: "2px solid #5a1414"
                  })}
                </React.Fragment>
              ))}
              {renderCell(headerRow?.[totalCol] || { v: "" }, false, 0, true, {
                width: "72px", minWidth: "65px", maxWidth: "80px",
                padding: "4px 6px", textAlign: "right",
                fontSize: "11px",
                backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                borderBottom: "2px solid #5a1414"
              })}
            </tr>
          </thead>
          <tbody>
            {/* Main Contractors Table (Rows 13 to 110) */}
            {visibleContractors.map(({ row, sheetRow }) => (
              <tr key={`contractor-${sheetRow}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(
                      row?.[c.idx],
                      i === 0,
                      0,
                      false,
                      {
                        width: c.width,
                        minWidth: c.minWidth,
                        maxWidth: c.maxWidth,
                        fontSize: c.isName ? "11px" : "9.5px",
                        padding: c.isName ? "2.5px 6px" : "2px 1px",
                        textAlign: c.isName ? "left" : "center"
                      },
                      getEditableOpts(sheetRow, c.idx, row?.[c.idx]?.v)
                    )}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(
                      row?.[colIdx],
                      false,
                      0,
                      false,
                      {
                        width: "56px",
                        minWidth: "50px",
                        maxWidth: "66px",
                        fontSize: "10.5px",
                        padding: "2.5px 3px"
                      },
                      getEditableOpts(sheetRow, colIdx, row?.[colIdx]?.v)
                    )}
                  </React.Fragment>
                ))}
                {renderCell(
                  row?.[totalCol],
                  false,
                  0,
                  false,
                  {
                    width: "72px",
                    minWidth: "65px",
                    maxWidth: "80px",
                    fontSize: "11px",
                    padding: "2.5px 6px",
                    fontWeight: "700"
                  },
                  null
                )}
              </tr>
            ))}

            {/* Contractor Summary / Totals (Rows 111 to 114) */}
            {contractorTotals.map((row, idx) => (
              <tr key={`total-${idx}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(
                      row?.[c.idx],
                      i === 0,
                      0,
                      false,
                      {
                        width: c.width,
                        minWidth: c.minWidth,
                        maxWidth: c.maxWidth,
                        fontSize: c.isName ? "11px" : "9.5px",
                        padding: c.isName ? "2.5px 6px" : "2px 1px",
                        textAlign: c.isName ? "left" : "center",
                        fontWeight: "700"
                      },
                      null
                    )}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(
                      row?.[colIdx],
                      false,
                      0,
                      false,
                      {
                        width: "56px",
                        minWidth: "50px",
                        maxWidth: "66px",
                        fontSize: "10.5px",
                        padding: "2.5px 3px",
                        fontWeight: "700"
                      },
                      null
                    )}
                  </React.Fragment>
                ))}
                {renderCell(
                  row?.[totalCol],
                  false,
                  0,
                  false,
                  {
                    width: "72px",
                    minWidth: "65px",
                    maxWidth: "80px",
                    fontSize: "11px",
                    padding: "2.5px 6px",
                    fontWeight: "700"
                  },
                  null
                )}
              </tr>
            ))}

            {/* Section 1 Header & Rows (Rows 118 to 123) */}
            <tr>
              <td colSpan={metaCols.length + allActiveFyCols.length} style={{
                background: "#f1f5f9", padding: "6px 10px", fontWeight: "700",
                color: "#1e293b", fontSize: "11.5px", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1"
              }}>
                Div in Lieu of Salary & Staff Costs (Rows 118–123)
              </td>
            </tr>
            {(section1Rows || []).map((row, rIdx) => (
              <tr key={`sec1-${rIdx}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(row?.[c.idx], i === 0, 0, false, {
                      width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth,
                      fontSize: c.isName ? "11px" : "9.5px",
                      padding: c.isName ? "2.5px 6px" : "2px 1px",
                      textAlign: c.isName ? "left" : "center"
                    })}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(row?.[colIdx], false, 0, false, {
                      width: "56px", minWidth: "50px", maxWidth: "66px",
                      fontSize: "10.5px", padding: "2.5px 3px"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(row?.[totalCol], false, 0, false, {
                  width: "72px", minWidth: "65px", maxWidth: "80px",
                  fontSize: "11px", padding: "2.5px 6px", fontWeight: "700"
                })}
              </tr>
            ))}

            {/* Section 2 Header & Rows (Rows 231 to 237) */}
            <tr>
              <td colSpan={metaCols.length + allActiveFyCols.length} style={{
                background: "#f1f5f9", padding: "6px 10px", fontWeight: "700",
                color: "#1e293b", fontSize: "11.5px", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1"
              }}>
                Profit Share Calculations (Rows 231–237)
              </td>
            </tr>
            {(section2Rows || []).map((row, rIdx) => (
              <tr key={`sec2-${rIdx}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(row?.[c.idx], i === 0, 0, false, {
                      width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth,
                      fontSize: c.isName ? "11px" : "9.5px",
                      padding: c.isName ? "2.5px 6px" : "2px 1px",
                      textAlign: c.isName ? "left" : "center"
                    })}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(row?.[colIdx], false, 0, false, {
                      width: "56px", minWidth: "50px", maxWidth: "66px",
                      fontSize: "10.5px", padding: "2.5px 3px"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(row?.[totalCol], false, 0, false, {
                  width: "72px", minWidth: "65px", maxWidth: "80px",
                  fontSize: "11px", padding: "2.5px 6px", fontWeight: "700"
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OUTGOINGS VIEW (Dark red header, white text, 50% narrower info cols)
// ─────────────────────────────────────────────────────────────────────────────
function OutgoingsTableView({ data, fyIdx, onFyChange, showBlankRows, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [savingKey, setSavingKey] = useState(null); // `${sheetRow}_${colIdx}`
  const committingRef = useRef(false);

  if (!data || !data.fyConfigs) return null;

  const { headerRow, outgoingRows, totalRows, mainRows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY columns: Month columns (12) + Total column
  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];

  const DARK_RED = "#7f1d1d";

  // Rows 126 to 225 (Outgoing data rows)
  const rawOutgoings = (outgoingRows || (mainRows ? mainRows.slice(0, 100) : [])).map((row, idx) => ({
    row,
    sheetRow: 126 + idx,
  }));

  const visibleOutgoings = showBlankRows
    ? rawOutgoings
    : rawOutgoings.filter(item => !isRowBlank(item.row));

  // Summary / totals rows (Rows 226 to 228)
  const outgoingTotals = totalRows || (mainRows ? mainRows.slice(100, 103) : []);

  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Description", width: "180px", minWidth: "160px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isCellEditable(sheetRow, colIdx, "outgoings");
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    // Determine input type and options based on column index
    let inputType = "text";
    let options = null;
    let initialEditVal = cellValue ?? "";

    if (colIdx === 1) { // VAT?
      inputType = "select";
      options = ["Yes", "No"];
    } else if (colIdx === 2 || colIdx === 3) { // Inv? or Pay?
      inputType = "select";
      options = ["Curr", "Next"];
    } else if (colIdx === 4 || colIdx === 5) { // Del or Likl. %
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6) { // Month amount columns
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType,
      options,
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell(prev => prev ? { ...prev, editValue: val } : null),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
        let finalVal = String(rawVal ?? "").trim();

        // Validation for Del & Likl. % (colIdx 4 & 5)
        if (colIdx === 4 || colIdx === 5) {
          if (finalVal !== "") {
            const clean = finalVal.replace(/%/g, "").trim();
            const num = parseFloat(clean);
            if (isNaN(num) || num < 0 || num > 100) {
              alert("Percentage must be a number between 0 and 100 (e.g. 50% or 100).");
              return;
            }
            finalVal = `${num}%`;
          }
        }

        // Formatting for month currency columns (colIdx >= 6)
        if (colIdx >= 6) {
          if (finalVal !== "") {
            const clean = finalVal.replace(/[£,\s]/g, "");
            if (!isNaN(clean) && clean !== "") {
              finalVal = formatCurrency(clean);
            }
          }
        }

        const oldVal = cellValue ?? "";
        if (String(finalVal).trim() === String(oldVal).trim()) return;

        const key = `${sheetRow}_${colIdx}`;
        setSavingKey(key);
        try {
          if (onUpdateCell) {
            await onUpdateCell("outgoings", sheetRow, colIdx, finalVal);
          }
        } finally {
          setSavingKey(null);
        }
      },
      onCancelEdit: () => setEditingCell(null),
      onStartEdit: () => setEditingCell({ sheetRow, colIdx, editValue: initialEditVal }),
    };
  };

  return (
    <div>
      {/* FY Switcher Bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#f1f5f9",
        padding: "6px 14px",
        borderRadius: "8px",
        marginBottom: "10px",
        border: "1px solid #e2e8f0"
      }}>
        <button
          onClick={() => onFyChange(Math.max(0, fyIdx - 1))}
          disabled={fyIdx === 0}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === 0 ? "#e2e8f0" : "#ffffff",
            color: fyIdx === 0 ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === 0 ? "not-allowed" : "pointer",
          }}
        >
          ◀ Previous FY
        </button>

        <div style={{ textAlign: "center" }}>
          <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
            {currentFy.label || `Financial Year ${fyIdx + 1}`}
          </span>
          <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "8px" }}>
            ({currentFy.months?.[0]?.label || ""} – {currentFy.months?.[11]?.label || ""})
          </span>
        </div>

        <button
          onClick={() => onFyChange(Math.min(maxFyIdx, fyIdx + 1))}
          disabled={fyIdx === maxFyIdx}
          className="triage-btn"
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: "600",
            background: fyIdx === maxFyIdx ? "#e2e8f0" : "#ffffff",
            color: fyIdx === maxFyIdx ? "#94a3b8" : "#0f172a",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: fyIdx === maxFyIdx ? "not-allowed" : "pointer",
          }}
        >
          Next FY ▶
        </button>
      </div>

      {/* Spreadsheet Table: Fits full FY on desktop */}
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
          <thead>
            {/* Header Row: Dark Red Background, White Text */}
            <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
              {metaCols.map((c, i) => (
                <React.Fragment key={c.idx}>
                  {renderCell(headerRow?.[c.idx] || { v: c.label }, i === 0, 0, true, {
                    width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth,
                    fontSize: c.isName ? "11px" : "9px",
                    padding: c.isName ? "4px 6px" : "3px 1px",
                    textAlign: c.isName ? "left" : "center",
                    backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                    borderBottom: "2px solid #5a1414"
                  })}
                </React.Fragment>
              ))}
              {fyCols.map((colIdx) => (
                <React.Fragment key={colIdx}>
                  {renderCell(headerRow?.[colIdx] || { v: "" }, false, 0, true, {
                    width: "56px", minWidth: "50px", maxWidth: "66px",
                    padding: "4px 2px", textAlign: "right",
                    fontSize: "11px",
                    backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                    borderBottom: "2px solid #5a1414"
                  })}
                </React.Fragment>
              ))}
              {renderCell(headerRow?.[totalCol] || { v: "" }, false, 0, true, {
                width: "72px", minWidth: "65px", maxWidth: "80px",
                padding: "4px 6px", textAlign: "right",
                fontSize: "11px",
                backgroundColor: DARK_RED, color: "#ffffff", fontWeight: "700",
                borderBottom: "2px solid #5a1414"
              })}
            </tr>
          </thead>
          <tbody>
            {/* Main Outgoings (Rows 126 to 225) */}
            {visibleOutgoings.map(({ row, sheetRow }) => (
              <tr key={`outgoing-${sheetRow}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(
                      row?.[c.idx],
                      i === 0,
                      0,
                      false,
                      {
                        width: c.width,
                        minWidth: c.minWidth,
                        maxWidth: c.maxWidth,
                        fontSize: c.isName ? "11px" : "9.5px",
                        padding: c.isName ? "2.5px 6px" : "2px 1px",
                        textAlign: c.isName ? "left" : "center"
                      },
                      getEditableOpts(sheetRow, c.idx, row?.[c.idx]?.v)
                    )}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(
                      row?.[colIdx],
                      false,
                      0,
                      false,
                      {
                        width: "56px",
                        minWidth: "50px",
                        maxWidth: "66px",
                        fontSize: "10.5px",
                        padding: "2.5px 3px"
                      },
                      getEditableOpts(sheetRow, colIdx, row?.[colIdx]?.v)
                    )}
                  </React.Fragment>
                ))}
                {renderCell(
                  row?.[totalCol],
                  false,
                  0,
                  false,
                  {
                    width: "72px",
                    minWidth: "65px",
                    maxWidth: "80px",
                    fontSize: "11px",
                    padding: "2.5px 6px",
                    fontWeight: "700"
                  },
                  null
                )}
              </tr>
            ))}

            {/* Outgoing Totals (Rows 226 to 228) */}
            {outgoingTotals.map((row, idx) => (
              <tr key={`total-${idx}`}>
                {metaCols.map((c, i) => (
                  <React.Fragment key={c.idx}>
                    {renderCell(
                      row?.[c.idx],
                      i === 0,
                      0,
                      false,
                      {
                        width: c.width,
                        minWidth: c.minWidth,
                        maxWidth: c.maxWidth,
                        fontSize: c.isName ? "11px" : "9.5px",
                        padding: c.isName ? "2.5px 6px" : "2px 1px",
                        textAlign: c.isName ? "left" : "center",
                        fontWeight: "700"
                      },
                      null
                    )}
                  </React.Fragment>
                ))}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(
                      row?.[colIdx],
                      false,
                      0,
                      false,
                      {
                        width: "56px",
                        minWidth: "50px",
                        maxWidth: "66px",
                        fontSize: "10.5px",
                        padding: "2.5px 3px",
                        fontWeight: "700"
                      },
                      null
                    )}
                  </React.Fragment>
                ))}
                {renderCell(
                  row?.[totalCol],
                  false,
                  0,
                  false,
                  {
                    width: "72px",
                    minWidth: "65px",
                    maxWidth: "80px",
                    fontSize: "11px",
                    padding: "2.5px 6px",
                    fontWeight: "700"
                  },
                  null
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. BUDGET VIEW (Master Sheet Budget Tab, FY breakdown, live edit & recalc)
// ─────────────────────────────────────────────────────────────────────────────
function BudgetView({ data, fyIdx, onFyChange, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [savingKey, setSavingKey] = useState(null); // `${sheetRow}_${colIdx}`
  const committingRef = useRef(false);

  if (!data || !data.matrix || !data.fyConfigs) return null;

  const { matrix, fyConfigs, isIncomeMode } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY month columns (12) + Total column
  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;

  const THEME_HEADER_BG = "#1e1b4b"; // Midnight Indigo

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
      onChangeEditValue: (val) => setEditingCell(prev => prev ? { ...prev, editValue: val } : null),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
        let finalVal = String(rawVal ?? "").trim();

        // Validation for Del % & Des. CoS %
        if (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) {
          if (finalVal !== "") {
            const clean = finalVal.replace(/%/g, "").trim();
            const num = parseFloat(clean);
            if (isNaN(num) || num < 0 || num > 100) {
              alert("Percentage must be a number between 0 and 100 (e.g. 50% or 50).");
              return;
            }
            finalVal = `${num}%`;
          }
        }

        const originalClean = String(cellValue ?? "").trim();
        if (finalVal === originalClean && !savingKey) return;

        setSavingKey(`${sheetRow}_${colIdx}`);
        try {
          await onUpdateCell("budget", sheetRow, colIdx, finalVal);
        } finally {
          setSavingKey(null);
        }
      },
      onCancelEdit: () => setEditingCell(null),
      onStartEdit: () => setEditingCell({ sheetRow, colIdx, editValue: initialEditVal }),
    };
  };

  // Helper: check if a row has meaningful month data across any FY
  const allMonthCols = [
    ...Array.from({ length: 12 }, (_, i) => 6 + i),  // FY1 (6..17)
    ...Array.from({ length: 12 }, (_, i) => 21 + i), // FY2 (21..32)
    ...Array.from({ length: 12 }, (_, i) => 36 + i), // FY3 (36..47)
  ];

  const hasMonthData = (r) => {
    return allMonthCols.some(c => {
      const v = r?.[c]?.v;
      if (!v) return false;
      const str = String(v).trim();
      return str !== "" && str !== "£0" && str !== "0" && str !== "-" && str !== "£-";
    });
  };

  // Helper: return all populated items + exactly ONE blank item beneath all existing content
  const getPopulatedWithOneBlank = (rawRows, isBlankFn) => {
    // 1. Find the index of the last populated row in rawRows
    let lastPopulatedIdx = -1;
    for (let i = 0; i < rawRows.length; i++) {
      if (!isBlankFn(rawRows[i].row)) {
        lastPopulatedIdx = i;
      }
    }

    const result = [];

    // 2. Add all populated items
    for (let i = 0; i < rawRows.length; i++) {
      const item = rawRows[i];
      if (!isBlankFn(item.row)) {
        result.push({ ...item, isBlank: false });
      }
    }

    // 3. Add exactly ONE blank item at the first blank row beneath all existing content
    let nextBlankItem = null;
    const searchStart = lastPopulatedIdx === -1 ? 0 : lastPopulatedIdx + 1;
    for (let i = searchStart; i < rawRows.length; i++) {
      if (isBlankFn(rawRows[i].row)) {
        nextBlankItem = rawRows[i];
        break;
      }
    }

    if (nextBlankItem) {
      result.push({ ...nextBlankItem, isBlank: true });
    }

    return result;
  };

  // 1. Salaries & Staff Costs (Rows 59 to 111)
  const rawSalaries = Array.from({ length: 53 }, (_, i) => ({
    row: matrix[58 + i],
    sheetRow: 59 + i,
  }));
  const visibleSalaries = getPopulatedWithOneBlank(rawSalaries, (r) => {
    const name = r?.[0]?.v;
    const equiv = r?.[1]?.v;
    if ((name && String(name).trim() !== "") || (equiv && String(equiv).trim() !== "")) return false;
    return !hasMonthData(r);
  });
  const salaryTotals = [
    { row: matrix[112], sheetRow: 113, label: matrix[112]?.[0]?.v || "Total salary cost - delivery" },
    { row: matrix[113], sheetRow: 114, label: matrix[113]?.[0]?.v || "Total salary cost - non-delivery" },
  ];

  // 2. Dividends in Lieu of Salary (Row 119)
  const dividendRow = { row: matrix[118], sheetRow: 119 };
  const dividendTotals = [
    { row: matrix[120], sheetRow: 121, label: matrix[120]?.[0]?.v || "Total dividends - delivery" },
    { row: matrix[121], sheetRow: 122, label: matrix[121]?.[0]?.v || "Total dividends - non-delivery" },
  ];

  // 3. Contractors (Rows 127 to 140) & Making up CoS (Row 142)
  const rawContractors = Array.from({ length: 14 }, (_, i) => ({
    row: matrix[126 + i],
    sheetRow: 127 + i,
  }));
  const visibleContractors = getPopulatedWithOneBlank(rawContractors, (r) => {
    const name = r?.[0]?.v;
    if (name && String(name).trim() !== "") return false;
    return !hasMonthData(r);
  });
  const makingUpCosRow = { row: matrix[141], sheetRow: 142 };
  const contractorTotals = [
    { row: matrix[143], sheetRow: 144, label: matrix[143]?.[0]?.v || "Total contractor cost - delivery" },
    { row: matrix[144], sheetRow: 145, label: matrix[144]?.[0]?.v || "Total contractor cost - non-delivery" },
  ];

  // 4. Other Expenses (Rows 150 to 250)
  const rawExpenses = Array.from({ length: 101 }, (_, i) => ({
    row: matrix[149 + i],
    sheetRow: 150 + i,
  }));
  const visibleExpenses = getPopulatedWithOneBlank(rawExpenses, (r) => {
    const desc = r?.[0]?.v;
    if (desc && String(desc).trim() !== "") return false;
    return !hasMonthData(r);
  });
  const expenseTotals = [
    { row: matrix[251], sheetRow: 252, label: matrix[251]?.[0]?.v || "Total other expenses - delivery" },
    { row: matrix[252], sheetRow: 253, label: matrix[252]?.[0]?.v || "Total other expenses - non-del" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Top FY Switcher & Mode Indicator Bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#f8fafc",
        padding: "8px 16px",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
        flexWrap: "wrap",
        gap: "10px"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            onClick={() => onFyChange(Math.max(0, fyIdx - 1))}
            disabled={fyIdx === 0}
            className="triage-btn"
            style={{
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: "600",
              background: fyIdx === 0 ? "#e2e8f0" : "#ffffff",
              color: fyIdx === 0 ? "#94a3b8" : "#0f172a",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: fyIdx === 0 ? "not-allowed" : "pointer",
            }}
          >
            ◀ Previous FY
          </button>

          <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
            {currentFy.label || `Financial Year ${fyIdx + 1}`}
          </span>
          <span style={{ fontSize: "12px", color: "#64748b" }}>
            ({currentFy.months?.[0]?.label || ""} – {currentFy.months?.[11]?.label || ""})
          </span>

          <button
            onClick={() => onFyChange(Math.min(maxFyIdx, fyIdx + 1))}
            disabled={fyIdx === maxFyIdx}
            className="triage-btn"
            style={{
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: "600",
              background: fyIdx === maxFyIdx ? "#e2e8f0" : "#ffffff",
              color: fyIdx === maxFyIdx ? "#94a3b8" : "#0f172a",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: fyIdx === maxFyIdx ? "not-allowed" : "pointer",
            }}
          >
            Next FY ▶
          </button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION 1: BUDGET P&L SUMMARY TABLE (Rows 3 to 49)
      ───────────────────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden"
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#f1f5f9",
          borderBottom: "1px solid #cbd5e1"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>
              1. Budget Summary (P&amp;L)
            </span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
            <thead>
              {/* Header Row: Month Names + FY Total */}
              <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
                {renderCell(matrix[0]?.[0] || { v: "Description" }, true, 0, true, {
                  width: "190px", minWidth: "170px", maxWidth: "220px",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700",
                  borderBottom: "1px solid #0f0d26"
                })}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      padding: "4px 2px", textAlign: "right",
                      backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700",
                      borderBottom: "1px solid #0f0d26"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(matrix[0]?.[totalCol] || { v: currentFy.label ? `${currentFy.label} total` : "Total" }, false, 0, true, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  padding: "4px 6px", textAlign: "right",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700",
                  borderBottom: "1px solid #0f0d26"
                })}
              </tr>
            </thead>
            <tbody>
              {matrix.slice(2, 49).map((row, rIdx) => {
                const sheetRow = 3 + rIdx;
                const labelCell = row?.[0];
                const labelText = labelCell?.v || "";
                const labelLower = labelText.trim().toLowerCase();

                // 1. If sheet is in revenue mode, hide rows 20 to 25 entirely
                if (!isIncomeMode && sheetRow >= 20 && sheetRow <= 25) {
                  return null;
                }

                // 2. Hide row if label is "hide" or "hide from here"
                if (labelLower === "hide" || labelLower === "hide from here") {
                  return null;
                }

                const isSpacerRow = !labelText && !row.slice(1).some(c => c?.v);
                const isSectionHeader = labelText && !row.slice(1).some(c => c?.v);

                // Styling tiers
                const isPrimaryHeadline =
                  labelLower === "total income" ||
                  labelLower === "total revenue" ||
                  labelLower === "gross profit" ||
                  labelLower === "operating profit";

                const isMarginRow =
                  labelLower.includes("gross profit margin") ||
                  labelLower === "operating profit %" ||
                  labelLower.includes("operating profit margin") ||
                  labelLower.includes("overheads as %");

                const isSubtotalRow = !isPrimaryHeadline && !isMarginRow && (
                  !!labelCell?.b ||
                  labelLower.startsWith("total") ||
                  labelLower.includes("net profit") ||
                  row.some(c => c?.bb && c.bb.includes("double"))
                );

                let rowFontSize = "10.5px";
                let rowFontWeight = "400";
                let rowPadding = "2.5px 3px";

                if (isPrimaryHeadline) {
                  rowFontSize = "13px";
                  rowFontWeight = "700";
                  rowPadding = "3.5px 4px";
                } else if (isMarginRow) {
                  rowFontSize = "9.5px";
                  rowFontWeight = "400";
                  rowPadding = "2px 3px";
                } else if (isSubtotalRow) {
                  rowFontSize = "11.5px";
                  rowFontWeight = "700";
                  rowPadding = "3px 4px";
                }

                const rowBg = undefined;

                return (
                  <tr key={`pl-${sheetRow}`} style={{ background: rowBg }}>
                    {renderCell(labelCell, true, 0, false, {
                      width: "190px", minWidth: "170px", maxWidth: "220px",
                      fontSize: rowFontSize,
                      padding: isPrimaryHeadline ? "3.5px 6px" : "2.5px 6px",
                      fontWeight: rowFontWeight,
                      borderBottom: isSpacerRow ? "none" : undefined,
                      color: isPrimaryHeadline ? "#0f172a" : undefined
                    })}
                    {fyCols.map((colIdx) => {
                      const cell = row?.[colIdx];
                      const editableOpts = getEditableOpts(sheetRow, colIdx, cell?.v);
                      return (
                        <React.Fragment key={colIdx}>
                          {renderCell(cell, false, 0, false, {
                            width: "58px", minWidth: "52px", maxWidth: "68px",
                            fontSize: rowFontSize,
                            padding: rowPadding,
                            fontWeight: rowFontWeight,
                            borderBottom: isSpacerRow ? "none" : undefined,
                            color: isPrimaryHeadline ? "#0f172a" : undefined
                          }, editableOpts)}
                        </React.Fragment>
                      );
                    })}
                    {renderCell(row?.[totalCol], false, 0, false, {
                      width: "75px", minWidth: "70px", maxWidth: "85px",
                      fontSize: rowFontSize,
                      padding: isPrimaryHeadline ? "3.5px 6px" : "2.5px 6px",
                      fontWeight: rowFontWeight,
                      borderBottom: isSpacerRow ? "none" : undefined,
                      color: isPrimaryHeadline ? "#0f172a" : undefined
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION 2: SALARIES & STAFF COSTS (Rows 57 to 114)
      ───────────────────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden"
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#f1f5f9",
          borderBottom: "1px solid #cbd5e1"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>
              2. Salaries &amp; Staff Costs
            </span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
                {renderCell({ v: "Employee Name" }, true, 0, true, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "Equiv Salary" }, false, 0, true, {
                  width: "90px", minWidth: "80px", maxWidth: "100px",
                  textAlign: "right", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "St. Mth" }, false, 0, true, {
                  width: "80px", minWidth: "75px", maxWidth: "90px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "End Mth" }, false, 0, true, {
                  width: "80px", minWidth: "75px", maxWidth: "90px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "Del %" }, false, 0, true, {
                  width: "55px", minWidth: "48px", maxWidth: "60px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      padding: "4px 2px", textAlign: "right",
                      backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(matrix[0]?.[totalCol] || { v: "Total" }, false, 0, true, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  textAlign: "right", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
              </tr>
            </thead>
            <tbody>
              {visibleSalaries.map(({ row, sheetRow, isBlank }) => {
                const nameCell = row?.[0];
                const equivCell = row?.[1];
                const stCell = row?.[2];
                const endCell = row?.[3];
                const delCell = row?.[4];

                return (
                  <tr key={`sal-${sheetRow}`} style={{ background: isBlank ? "#f8fafc" : undefined }}>
                    {renderCell(
                      isBlank && !nameCell?.v ? { v: "+ Add employee..." } : nameCell,
                      true,
                      0,
                      false,
                      {
                        width: "180px", minWidth: "160px", maxWidth: "200px",
                        fontSize: "11px", padding: "3px 6px",
                        fontStyle: isBlank && !nameCell?.v ? "italic" : "normal",
                        color: isBlank && !nameCell?.v ? "#94a3b8" : undefined
                      },
                      getEditableOpts(sheetRow, 0, nameCell?.v)
                    )}
                    {renderCell(equivCell, false, 0, false, {
                      width: "90px", minWidth: "80px", maxWidth: "100px",
                      fontSize: "10.5px", padding: "3px 6px", textAlign: "right"
                    }, getEditableOpts(sheetRow, 1, equivCell?.v))}
                    {renderCell(stCell, false, 0, false, {
                      width: "80px", minWidth: "75px", maxWidth: "90px",
                      fontSize: "10px", padding: "3px 4px", textAlign: "center"
                    }, getEditableOpts(sheetRow, 2, stCell?.v))}
                    {renderCell(endCell, false, 0, false, {
                      width: "80px", minWidth: "75px", maxWidth: "90px",
                      fontSize: "10px", padding: "3px 4px", textAlign: "center"
                    }, getEditableOpts(sheetRow, 3, endCell?.v))}
                    {renderCell(delCell, false, 0, false, {
                      width: "55px", minWidth: "48px", maxWidth: "60px",
                      fontSize: "10.5px", padding: "3px 4px", textAlign: "center"
                    }, getEditableOpts(sheetRow, 4, delCell?.v))}

                    {/* Month columns: calculated by sheet formula (non-editable) */}
                    {fyCols.map((colIdx) => (
                      <React.Fragment key={colIdx}>
                        {renderCell(row?.[colIdx], false, 0, false, {
                          width: "58px", minWidth: "52px", maxWidth: "68px",
                          fontSize: "10.5px", padding: "3px 3px"
                        })}
                      </React.Fragment>
                    ))}
                    {renderCell(row?.[totalCol], false, 0, false, {
                      width: "75px", minWidth: "70px", maxWidth: "85px",
                      fontSize: "11px", padding: "3px 6px", fontWeight: "600"
                    })}
                  </tr>
                );
              })}

              {/* Total salary cost rows (Rows 113 & 114) */}
              {salaryTotals.map(({ row, sheetRow, label }) => (
                <tr key={`sal-tot-${sheetRow}`} style={{ background: "#f8fafc", borderTop: sheetRow === 113 ? "2px solid #cbd5e1" : "none" }}>
                  <td
                    colSpan={5}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
                      fontWeight: "700",
                      color: "#1e293b",
                      borderRight: "1px solid #e5e7eb",
                      borderBottom: "1px solid #e5e7eb",
                      position: "sticky",
                      left: 0,
                      backgroundColor: "#f8fafc",
                      zIndex: 2
                    }}
                  >
                    {label}
                  </td>
                  {fyCols.map((colIdx) => (
                    <React.Fragment key={colIdx}>
                      {renderCell(row?.[colIdx], false, 0, false, {
                        width: "58px", minWidth: "52px", maxWidth: "68px",
                        fontSize: "10.5px", padding: "3px 3px", fontWeight: "700"
                      })}
                    </React.Fragment>
                  ))}
                  {renderCell(row?.[totalCol], false, 0, false, {
                    width: "75px", minWidth: "70px", maxWidth: "85px",
                    fontSize: "11px", padding: "3px 6px", fontWeight: "700"
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION 3: DIVIDENDS IN LIEU OF SALARY (Rows 117 to 123)
      ───────────────────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden"
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#f1f5f9",
          borderBottom: "1px solid #cbd5e1"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>
              3. Dividends in Lieu of Salary
            </span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
                {renderCell({ v: "Description" }, true, 0, true, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "Del %" }, false, 0, true, {
                  width: "55px", minWidth: "48px", maxWidth: "60px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      padding: "4px 2px", textAlign: "right",
                      backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(matrix[0]?.[totalCol] || { v: "Total" }, false, 0, true, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  textAlign: "right", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
              </tr>
            </thead>
            <tbody>
              {/* Row 119: Div in lieu of salary */}
              <tr>
                {renderCell(dividendRow.row?.[0] || { v: "Div in lieu of salary" }, true, 0, false, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  fontSize: "11px", padding: "3px 6px", fontWeight: "600"
                })}
                {renderCell(dividendRow.row?.[4], false, 0, false, {
                  width: "55px", minWidth: "48px", maxWidth: "60px",
                  fontSize: "10.5px", padding: "3px 4px", textAlign: "center"
                }, getEditableOpts(119, 4, dividendRow.row?.[4]?.v))}

                {/* Months: editable */}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(dividendRow.row?.[colIdx], false, 0, false, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      fontSize: "10.5px", padding: "3px 3px"
                    }, getEditableOpts(119, colIdx, dividendRow.row?.[colIdx]?.v))}
                  </React.Fragment>
                ))}
                {renderCell(dividendRow.row?.[totalCol], false, 0, false, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  fontSize: "11px", padding: "3px 6px", fontWeight: "600"
                })}
              </tr>

              {/* Total dividends rows (Rows 121 & 122) */}
              {dividendTotals.map(({ row, sheetRow, label }) => (
                <tr key={`div-tot-${sheetRow}`} style={{ background: "#f8fafc", borderTop: sheetRow === 121 ? "2px solid #cbd5e1" : "none" }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
                      fontWeight: "700",
                      color: "#1e293b",
                      borderRight: "1px solid #e5e7eb",
                      borderBottom: "1px solid #e5e7eb",
                      position: "sticky",
                      left: 0,
                      backgroundColor: "#f8fafc",
                      zIndex: 2
                    }}
                  >
                    {label}
                  </td>
                  {fyCols.map((colIdx) => (
                    <React.Fragment key={colIdx}>
                      {renderCell(row?.[colIdx], false, 0, false, {
                        width: "58px", minWidth: "52px", maxWidth: "68px",
                        fontSize: "10.5px", padding: "3px 3px", fontWeight: "700"
                      })}
                    </React.Fragment>
                  ))}
                  {renderCell(row?.[totalCol], false, 0, false, {
                    width: "75px", minWidth: "70px", maxWidth: "85px",
                    fontSize: "11px", padding: "3px 6px", fontWeight: "700"
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION 4: CONTRACTORS & MAKING UP COS (Rows 125 to 145)
      ───────────────────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden"
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#f1f5f9",
          borderBottom: "1px solid #cbd5e1"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>
              4. Contractors &amp; Making up CoS
            </span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
                {renderCell({ v: "Contractor Name" }, true, 0, true, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "Del % / Des. %" }, false, 0, true, {
                  width: "75px", minWidth: "65px", maxWidth: "85px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      padding: "4px 2px", textAlign: "right",
                      backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(matrix[0]?.[totalCol] || { v: "Total" }, false, 0, true, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  textAlign: "right", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
              </tr>
            </thead>
            <tbody>
              {visibleContractors.map(({ row, sheetRow, isBlank }) => {
                const nameCell = row?.[0];
                const delCell = row?.[4];

                return (
                  <tr key={`cont-${sheetRow}`} style={{ background: isBlank ? "#f8fafc" : undefined }}>
                    {renderCell(
                      isBlank && !nameCell?.v ? { v: "+ Add contractor..." } : nameCell,
                      true,
                      0,
                      false,
                      {
                        width: "180px", minWidth: "160px", maxWidth: "200px",
                        fontSize: "11px", padding: "3px 6px",
                        fontStyle: isBlank && !nameCell?.v ? "italic" : "normal",
                        color: isBlank && !nameCell?.v ? "#94a3b8" : undefined
                      },
                      getEditableOpts(sheetRow, 0, nameCell?.v)
                    )}
                    {renderCell(delCell, false, 0, false, {
                      width: "75px", minWidth: "65px", maxWidth: "85px",
                      fontSize: "10.5px", padding: "3px 4px", textAlign: "center"
                    }, getEditableOpts(sheetRow, 4, delCell?.v))}

                    {/* Months: editable */}
                    {fyCols.map((colIdx) => (
                      <React.Fragment key={colIdx}>
                        {renderCell(row?.[colIdx], false, 0, false, {
                          width: "58px", minWidth: "52px", maxWidth: "68px",
                          fontSize: "10.5px", padding: "3px 3px"
                        }, getEditableOpts(sheetRow, colIdx, row?.[colIdx]?.v))}
                      </React.Fragment>
                    ))}
                    {renderCell(row?.[totalCol], false, 0, false, {
                      width: "75px", minWidth: "70px", maxWidth: "85px",
                      fontSize: "11px", padding: "3px 6px", fontWeight: "600"
                    })}
                  </tr>
                );
              })}

              {/* Row 142: Making up CoS */}
              <tr style={{ background: "#fefce8", borderTop: "1px dashed #facc15" }}>
                {renderCell(makingUpCosRow.row?.[0] || { v: "Making up CoS" }, true, 0, false, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  fontSize: "11px", padding: "3px 6px", fontWeight: "700", color: "#854d0e"
                })}
                {renderCell(makingUpCosRow.row?.[1], false, 0, false, {
                  width: "75px", minWidth: "65px", maxWidth: "85px",
                  fontSize: "10.5px", padding: "3px 4px", textAlign: "center", fontWeight: "700", color: "#854d0e"
                }, getEditableOpts(142, 1, makingUpCosRow.row?.[1]?.v))}

                {/* Months for Making up CoS: calculated formula (non-editable) */}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(makingUpCosRow.row?.[colIdx], false, 0, false, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      fontSize: "10.5px", padding: "3px 3px", color: "#854d0e"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(makingUpCosRow.row?.[totalCol], false, 0, false, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  fontSize: "11px", padding: "3px 6px", fontWeight: "700", color: "#854d0e"
                })}
              </tr>

              {/* Total contractor cost rows (Rows 144 & 145) */}
              {contractorTotals.map(({ row, sheetRow, label }) => (
                <tr key={`cont-tot-${sheetRow}`} style={{ background: "#f8fafc", borderTop: sheetRow === 144 ? "2px solid #cbd5e1" : "none" }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
                      fontWeight: "700",
                      color: "#1e293b",
                      borderRight: "1px solid #e5e7eb",
                      borderBottom: "1px solid #e5e7eb",
                      position: "sticky",
                      left: 0,
                      backgroundColor: "#f8fafc",
                      zIndex: 2
                    }}
                  >
                    {label}
                  </td>
                  {fyCols.map((colIdx) => (
                    <React.Fragment key={colIdx}>
                      {renderCell(row?.[colIdx], false, 0, false, {
                        width: "58px", minWidth: "52px", maxWidth: "68px",
                        fontSize: "10.5px", padding: "3px 3px", fontWeight: "700"
                      })}
                    </React.Fragment>
                  ))}
                  {renderCell(row?.[totalCol], false, 0, false, {
                    width: "75px", minWidth: "70px", maxWidth: "85px",
                    fontSize: "11px", padding: "3px 6px", fontWeight: "700"
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION 5: OTHER EXPENSES (Rows 150 to 250)
      ───────────────────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        overflow: "hidden"
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          background: "#f1f5f9",
          borderBottom: "1px solid #cbd5e1"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>
              5. Other Expenses
            </span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#ffffff" }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
                {renderCell({ v: "Expense Description" }, true, 0, true, {
                  width: "180px", minWidth: "160px", maxWidth: "200px",
                  backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {renderCell({ v: "Del %" }, false, 0, true, {
                  width: "55px", minWidth: "48px", maxWidth: "60px",
                  textAlign: "center", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
                {fyCols.map((colIdx) => (
                  <React.Fragment key={colIdx}>
                    {renderCell(matrix[0]?.[colIdx] || { v: "" }, false, 0, true, {
                      width: "58px", minWidth: "52px", maxWidth: "68px",
                      padding: "4px 2px", textAlign: "right",
                      backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                    })}
                  </React.Fragment>
                ))}
                {renderCell(matrix[0]?.[totalCol] || { v: "Total" }, false, 0, true, {
                  width: "75px", minWidth: "70px", maxWidth: "85px",
                  textAlign: "right", backgroundColor: THEME_HEADER_BG, color: "#ffffff", fontWeight: "700"
                })}
              </tr>
            </thead>
            <tbody>
              {visibleExpenses.map(({ row, sheetRow, isBlank }) => {
                const descCell = row?.[0];
                const delCell = row?.[4];

                return (
                  <tr key={`exp-${sheetRow}`} style={{ background: isBlank ? "#f8fafc" : undefined }}>
                    {renderCell(
                      isBlank && !descCell?.v ? { v: "+ Add expense..." } : descCell,
                      true,
                      0,
                      false,
                      {
                        width: "180px", minWidth: "160px", maxWidth: "200px",
                        fontSize: "11px", padding: "3px 6px",
                        fontStyle: isBlank && !descCell?.v ? "italic" : "normal",
                        color: isBlank && !descCell?.v ? "#94a3b8" : undefined
                      },
                      getEditableOpts(sheetRow, 0, descCell?.v)
                    )}
                    {renderCell(delCell, false, 0, false, {
                      width: "55px", minWidth: "48px", maxWidth: "60px",
                      fontSize: "10.5px", padding: "3px 4px", textAlign: "center"
                    }, getEditableOpts(sheetRow, 4, delCell?.v))}

                    {/* Months: editable */}
                    {fyCols.map((colIdx) => (
                      <React.Fragment key={colIdx}>
                        {renderCell(row?.[colIdx], false, 0, false, {
                          width: "58px", minWidth: "52px", maxWidth: "68px",
                          fontSize: "10.5px", padding: "3px 3px"
                        }, getEditableOpts(sheetRow, colIdx, row?.[colIdx]?.v))}
                      </React.Fragment>
                    ))}
                    {renderCell(row?.[totalCol], false, 0, false, {
                      width: "75px", minWidth: "70px", maxWidth: "85px",
                      fontSize: "11px", padding: "3px 6px", fontWeight: "600"
                    })}
                  </tr>
                );
              })}

              {/* Total other expenses rows (Rows 252 & 253) */}
              {expenseTotals.map(({ row, sheetRow, label }) => (
                <tr key={`exp-tot-${sheetRow}`} style={{ background: "#f8fafc", borderTop: sheetRow === 252 ? "2px solid #cbd5e1" : "none" }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
                      fontWeight: "700",
                      color: "#1e293b",
                      borderRight: "1px solid #e5e7eb",
                      borderBottom: "1px solid #e5e7eb",
                      position: "sticky",
                      left: 0,
                      backgroundColor: "#f8fafc",
                      zIndex: 2
                    }}
                  >
                    {label}
                  </td>
                  {fyCols.map((colIdx) => (
                    <React.Fragment key={colIdx}>
                      {renderCell(row?.[colIdx], false, 0, false, {
                        width: "58px", minWidth: "52px", maxWidth: "68px",
                        fontSize: "10.5px", padding: "3px 3px", fontWeight: "700"
                      })}
                    </React.Fragment>
                  ))}
                  {renderCell(row?.[totalCol], false, 0, false, {
                    width: "75px", minWidth: "70px", maxWidth: "85px",
                    fontSize: "11px", padding: "3px 6px", fontWeight: "700"
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
