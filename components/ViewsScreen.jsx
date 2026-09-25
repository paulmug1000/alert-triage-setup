import React, { useState, useEffect, useRef } from "react";
import Spinner from "./Spinner";

export default function ViewsScreen({ allClients, styles }) {
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientSearch, setClientSearch] = useState("");
  const [activeTab, setActiveTab] = useState("dashboard"); // 'dashboard' | 'cash' | 'contractors' | 'outgoings'
  
  // Data caches: { [clientSheetId]: { dashboard: data, cash: data, contractors: data, outgoings: data } }
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // FY indices for tabs that support FY switching
  const [dashboardFyIdx, setDashboardFyIdx] = useState(0);
  const [contractorsFyIdx, setContractorsFyIdx] = useState(0);
  const [outgoingsFyIdx, setOutgoingsFyIdx] = useState(0);

  // Optional filter: hide blank rows
  const [hideBlankRows, setHideBlankRows] = useState(false);

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
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>Live mirror of client spreadsheet</p>
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

            {selectedClient.clientSheetId && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`}
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
              >
                📊 Open in Sheets
              </a>
            )}
          </div>
        )}
      </div>

      {/* Main Content Area */}
      {!selectedClient ? (
        <div style={{
          background: "#ffffff",
          borderRadius: "10px",
          border: "1px solid #e2e8f0",
          padding: "48px 24px",
          textAlign: "center",
          maxWidth: "600px",
          margin: "40px auto",
          boxShadow: "0 2px 8px rgba(0,0,0,0.04)"
        }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>📑</div>
          <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#1e293b", margin: "0 0 8px" }}>Select a Client to View</h2>
          <p style={{ fontSize: "14px", color: "#64748b", margin: "0 0 24px" }}>
            Choose a client from the dropdown above to view their live Dashboard, Cash, Contractors, and Outgoings tabs.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", maxHeight: "240px", overflowY: "auto" }}>
            {(allClients || []).map(c => (
              <button
                key={c.clientName}
                onClick={() => handleSelectClient(c)}
                className="triage-btn"
                style={{
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: "500",
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: "#334155"
                }}
              >
                {c.clientName}
              </button>
            ))}
          </div>
        </div>
      ) : (
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

            {/* Optional Controls on Right (Hide blank rows toggle) */}
            {(activeTab === "contractors" || activeTab === "outgoings") && (
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#64748b", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={hideBlankRows}
                  onChange={(e) => setHideBlankRows(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                Hide empty rows
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
                    hideBlankRows={hideBlankRows}
                  />
                )}

                {activeTab === "outgoings" && (
                  <OutgoingsTableView
                    data={currentTabData}
                    fyIdx={outgoingsFyIdx}
                    onFyChange={setOutgoingsFyIdx}
                    hideBlankRows={hideBlankRows}
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
function renderCell(cell, isSticky = false, stickyLeft = 0, isHeader = false, customStyle = {}) {
  const v = cell?.v ?? "";
  const bg = customStyle.backgroundColor || cell?.bg;
  const fg = customStyle.color || cell?.c;
  const isBold = customStyle.fontWeight 
    ? (customStyle.fontWeight === "700" || customStyle.fontWeight === "bold") 
    : (!!cell?.b || isHeader);
  const isItalic = !!cell?.i;
  const align = customStyle.textAlign || cell?.a || (v && (v.startsWith("£") || v.startsWith("-") || !isNaN(v.replace(/[£,%\s-]/g, ""))) ? "right" : "left");

  return (
    <td
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
        ...(isSticky ? {
          position: "sticky",
          left: stickyLeft,
          zIndex: isHeader ? 5 : 2,
          boxShadow: stickyLeft === 0 ? "2px 0 4px -1px rgba(0,0,0,0.08)" : undefined,
        } : {}),
        ...customStyle,
      }}
    >
      {v}
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
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px", maxHeight: "74vh" }}>
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
                  <tr style={{ background: isSectionHeader ? "#f8fafc" : undefined }}>
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
      <div ref={containerRef} style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px", maxHeight: "74vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "11px", background: "#ffffff" }}>
          <thead>
            {/* Row 1: Month Headers (Whole row has dark green background, all text white, NO "PREV MO") */}
            <tr style={{ position: "sticky", top: 0, zIndex: 6 }}>
              {renderCell(matrix[0]?.[0] || { v: "" }, true, 0, true, {
                width: "240px", minWidth: "220px", maxWidth: "260px",
                backgroundColor: DARK_GREEN, color: "#ffffff", fontWeight: "700",
                borderBottom: "2px solid #0b381e"
              })}
              {allDataCols.map((colIdx) => {
                const isTarget = colIdx === prevMonthColIdx;
                return (
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
                      boxShadow: isTarget ? "inset 0 -3px 0 #86efac" : undefined
                    }}
                  >
                    {matrix[0]?.[colIdx]?.v || ""}
                  </th>
                );
              })}
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
                  {allDataCols.map((colIdx) => {
                    const isTarget = colIdx === prevMonthColIdx;
                    return (
                      <React.Fragment key={colIdx}>
                        {renderCell(row?.[colIdx], false, 0, false, {
                          minWidth: "78px",
                          padding: "3px 5px",
                          backgroundColor: isTarget ? (row?.[colIdx]?.bg || "#f8faff") : undefined
                        })}
                      </React.Fragment>
                    );
                  })}
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
function ContractorsView({ data, fyIdx, onFyChange, hideBlankRows }) {
  if (!data || !data.fyConfigs) return null;

  const { headerRow, mainRows, section1Rows, section2Rows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY columns: Month columns (12) + Total column
  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];

  const DARK_RED = "#7f1d1d";

  // Helper to filter blank rows if toggle enabled
  const filterRows = (rows) => {
    if (!hideBlankRows) return rows;
    return rows.filter(r => (r?.[0]?.v && r[0].v.trim() !== "") || allActiveFyCols.some(c => r?.[c]?.v));
  };

  const filteredMain = filterRows(mainRows || []);
  const filteredSec1 = filterRows(section1Rows || []);
  const filteredSec2 = filterRows(section2Rows || []);

  // 5 info columns made MUCH narrower (at least 50% narrower) with smaller text
  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Contractor Name", width: "170px", minWidth: "150px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

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
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px", maxHeight: "74vh" }}>
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
            {/* Main Contractors Table (Rows 13 to 114) */}
            {filteredMain.map((row, rIdx) => (
              <tr key={`main-${rIdx}`}>
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

            {/* Section 1 Header & Rows (Rows 118 to 123) */}
            <tr>
              <td colSpan={metaCols.length + allActiveFyCols.length} style={{
                background: "#f1f5f9", padding: "6px 10px", fontWeight: "700",
                color: "#1e293b", fontSize: "11.5px", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1"
              }}>
                Div in Lieu of Salary & Staff Costs (Rows 118–123)
              </td>
            </tr>
            {filteredSec1.map((row, rIdx) => (
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
            {filteredSec2.map((row, rIdx) => (
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
function OutgoingsTableView({ data, fyIdx, onFyChange, hideBlankRows }) {
  if (!data || !data.fyConfigs) return null;

  const { headerRow, mainRows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  // Selected FY columns: Month columns (12) + Total column
  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];

  const DARK_RED = "#7f1d1d";

  // Helper to filter blank rows if toggle enabled
  const filteredRows = (!hideBlankRows ? (mainRows || []) : (mainRows || []).filter(r => {
    return (r?.[0]?.v && r[0].v.trim() !== "") || allActiveFyCols.some(c => r?.[c]?.v);
  }));

  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Description", width: "180px", minWidth: "160px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

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
      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: "8px", maxHeight: "74vh" }}>
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
            {filteredRows.map((row, rIdx) => (
              <tr key={rIdx}>
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
