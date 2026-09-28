import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";

export default function PushOutgoingsTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  styles = {}
}) {
  const [selectedClient, setSelectedClient] = useState(initialClient || "");
  const [clientSearch, setClientSearch] = useState("");
  const [plData, setPlData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Checkbox state for columns F..J (array of 5 booleans or column letters)
  const [checkedMonths, setCheckedMonths] = useState({
    F: false,
    G: false,
    H: false,
    I: false,
    J: false
  });

  // Action states
  const [pullingPl, setPullingPl] = useState(false);
  const [pushingOutgoings, setPushingOutgoings] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success' | 'error' | 'warning', text: string }

  // Sync initialClient prop if changed externally
  useEffect(() => {
    if (initialClient && initialClient !== selectedClient) {
      setSelectedClient(initialClient);
      if (onClearInitialClient) onClearInitialClient();
    }
  }, [initialClient, onClearInitialClient, selectedClient]);

  // Load PLComp data when client changes
  const loadPlCompData = useCallback(async (clientNameToLoad) => {
    const target = clientNameToLoad || selectedClient;
    if (!target || !automationCommanderSheetId) {
      setPlData(null);
      return;
    }
    setLoading(true);
    setError("");
    setStatusMsg(null);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_get_plcomp_data",
          clientName: target,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load PLComp data");
      }
      setPlData(data);

      // Initialize checked months from sheet
      const initialChecked = {};
      (data.months || []).forEach(m => {
        initialChecked[m.colLetter] = !!m.checked;
      });
      setCheckedMonths(initialChecked);
    } catch (err) {
      console.error("Error loading PLComp data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId, selectedClient]);

  useEffect(() => {
    if (selectedClient) {
      loadPlCompData(selectedClient);
    } else {
      setPlData(null);
    }
  }, [selectedClient, loadPlCompData]);

  // Client info from allOutgoingsClients
  const currentClientInfo = useMemo(() => {
    return (allOutgoingsClients || []).find(c => c.clientName === selectedClient) || null;
  }, [allOutgoingsClients, selectedClient]);

  const filteredClients = useMemo(() => {
    const list = allOutgoingsClients || [];
    if (!clientSearch.trim()) return list;
    const q = clientSearch.toLowerCase();
    return list.filter(c => c.clientName.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  // Toggle checkbox for a specific month
  const toggleMonth = (colLetter) => {
    setCheckedMonths(prev => ({
      ...prev,
      [colLetter]: !prev[colLetter]
    }));
  };

  const selectedColCount = useMemo(() => {
    return Object.values(checkedMonths).filter(Boolean).length;
  }, [checkedMonths]);

  const handleSelectAll = (select) => {
    const updated = {};
    ["F", "G", "H", "I", "J"].forEach(col => {
      updated[col] = !!select;
    });
    setCheckedMonths(updated);
  };

  // Pull fresh P&L handler
  const handlePullFreshPl = async () => {
    if (!selectedClient) return;
    setPullingPl(true);
    setStatusMsg(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_pull_fresh_pl",
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to pull fresh P&L data");
      }
      setStatusMsg({
        type: "success",
        text: `✓ ${data.message || "Fresh P&L pulled successfully."}`
      });
      // Refresh table data and C1 timestamp
      await loadPlCompData(selectedClient);
    } catch (err) {
      console.error("Pull P&L error:", err);
      setStatusMsg({ type: "error", text: err.message });
    } finally {
      setPullingPl(false);
    }
  };

  // Push outgoings handler
  const handlePushOutgoings = async () => {
    if (!selectedClient) return;
    const selectedCols = Object.entries(checkedMonths)
      .filter(([, checked]) => checked)
      .map(([col]) => col);

    if (selectedCols.length === 0) {
      setStatusMsg({ type: "warning", text: "Please select at least one month checkbox to push." });
      return;
    }

    setPushingOutgoings(true);
    setStatusMsg(null);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_push_outgoings",
          clientName: selectedClient,
          selectedMonths: selectedCols,
          automationCommanderSheetId,
          workMonthKey: eomMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to push outgoings");
      }

      let successText = `✓ Outgoings successfully pushed for ${selectedCols.length} month${selectedCols.length !== 1 ? "s" : ""}.`;
      if (data.markedTaskDone) {
        successText += ` Task "Use PLComp..." automatically marked Done for ${data.targetMonthLabel || "the current month"}!`;
        if (onTaskMarkedDone) {
          // Find task id for this client
          const clientTask = (eomAllTasks || []).find(t =>
            t.clientName === selectedClient &&
            (t.linkedFunction === "push_outgoings" || String(t.name || "").toLowerCase().includes("plcomp"))
          );
          if (clientTask) {
            onTaskMarkedDone(selectedClient, clientTask.taskId);
          }
        }
      }

      if (data.warnings && data.warnings.length > 0) {
        successText += ` Warnings: ${data.warnings.join("; ")}`;
      }

      setStatusMsg({ type: "success", text: successText });

      // Refresh PLComp data
      await loadPlCompData(selectedClient);
    } catch (err) {
      console.error("Push outgoings error:", err);
      setStatusMsg({ type: "error", text: err.message });
    } finally {
      setPushingOutgoings(false);
    }
  };

  return (
    <div style={{ maxWidth: "1050px" }}>
      {/* Top Header Card */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "18px 22px",
        marginBottom: "20px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ flex: "1 1 320px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
              Push Outgoings
            </h3>
            <p style={{ margin: 0, fontSize: "13px", color: "#64748b", lineHeight: "1.4" }}>
              Pull fresh profit &amp; loss figures from accounting and push actual expenses from <strong>PLComp</strong> into the client&apos;s Outgoings sheet.
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

        {/* Selected Client Status & Actions Toolbar */}
        {selectedClient && (
          <div style={{
            marginTop: "18px",
            paddingTop: "16px",
            borderTop: "1px solid #f1f5f9",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            {/* Last Updated Timestamp & Metadata */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <div style={{
                fontSize: "12px",
                background: "#f1f5f9",
                color: "#334155",
                padding: "5px 10px",
                borderRadius: "6px",
                fontWeight: "600"
              }}>
                Client: {selectedClient}
              </div>
              <div style={{
                fontSize: "12px",
                color: plData?.lastUpdated ? "#0369a1" : "#64748b",
                background: plData?.lastUpdated ? "#e0f2fe" : "#f8fafc",
                padding: "5px 10px",
                borderRadius: "6px",
                border: `1px solid ${plData?.lastUpdated ? "#bae6fd" : "#e2e8f0"}`,
                display: "inline-flex",
                alignItems: "center",
                gap: "5px"
              }}>
                <span>🕒</span>
                <span>P&amp;L last updated: <strong>{plData?.lastUpdated || "—"}</strong> (cell C1)</span>
              </div>
            </div>

            {/* Top Action Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button
                onClick={handlePullFreshPl}
                disabled={pullingPl || pushingOutgoings || loading}
                title="Runs the PullPLBasedOn GAS function on the client's master sheet"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                  padding: "8px 16px",
                  background: "#ffffff",
                  border: "1px solid #0284c7",
                  color: "#0284c7",
                  borderRadius: "7px",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: (pullingPl || pushingOutgoings || loading) ? "not-allowed" : "pointer",
                  opacity: (pullingPl || pushingOutgoings || loading) ? 0.6 : 1,
                  transition: "all 0.15s ease"
                }}
              >
                {pullingPl ? <Spinner size={14} color="#0284c7" /> : <span>🔄</span>}
                <span>{pullingPl ? "Pulling P&L..." : "Pull fresh P&L"}</span>
              </button>

              <button
                onClick={handlePushOutgoings}
                disabled={pushingOutgoings || pullingPl || loading || selectedColCount === 0}
                title="Saves selected checkboxes to PLComp!F87:K87 and runs pushOutgoingsToClientSheet"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                  padding: "8px 18px",
                  background: selectedColCount === 0 ? "#94a3b8" : "#0284c7",
                  border: "none",
                  color: "#ffffff",
                  borderRadius: "7px",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: (pushingOutgoings || pullingPl || loading || selectedColCount === 0) ? "not-allowed" : "pointer",
                  boxShadow: selectedColCount > 0 ? "0 2px 4px rgba(2, 132, 199, 0.25)" : "none",
                  transition: "all 0.15s ease"
                }}
              >
                {pushingOutgoings ? <Spinner size={14} color="#ffffff" /> : <span>🚀</span>}
                <span>{pushingOutgoings ? "Pushing outgoings..." : `Push selected month(s)${selectedColCount > 0 ? ` (${selectedColCount})` : ""}`}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Status Toast / Alert Banner */}
      {statusMsg && (
        <div style={{
          marginBottom: "18px",
          padding: "12px 16px",
          borderRadius: "8px",
          fontSize: "13px",
          lineHeight: "1.4",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: statusMsg.type === "success" ? "#f0fdf4" : statusMsg.type === "warning" ? "#fffbeb" : "#fef2f2",
          border: `1px solid ${statusMsg.type === "success" ? "#bbf7d0" : statusMsg.type === "warning" ? "#fde68a" : "#fecaca"}`,
          color: statusMsg.type === "success" ? "#166534" : statusMsg.type === "warning" ? "#92400e" : "#991b1b"
        }}>
          <div>{statusMsg.text}</div>
          <button
            onClick={() => setStatusMsg(null)}
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "16px", padding: "0 4px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {!selectedClient ? (
        /* Empty State when no client is selected */
        <div style={{
          background: "#ffffff",
          border: "1px dashed #cbd5e1",
          borderRadius: "12px",
          padding: "48px 24px",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📊</div>
          <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
            No Client Selected
          </h4>
          <p style={{ margin: "0 0 20px", fontSize: "13px", color: "#64748b", maxWidth: "420px", marginLeft: "auto", marginRight: "auto" }}>
            Choose a client from the dropdown above to load the comparison data from their master <strong>PLComp</strong> tab.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", maxWidth: "600px", margin: "0 auto" }}>
            {allOutgoingsClients.slice(0, 10).map(c => (
              <button
                key={c.clientName}
                onClick={() => setSelectedClient(c.clientName)}
                style={{
                  padding: "6px 12px",
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "#334155",
                  fontWeight: "500",
                  cursor: "pointer"
                }}
              >
                {c.clientName}
              </button>
            ))}
          </div>
        </div>
      ) : loading ? (
        /* Loading Spinner */
        <div style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "60px 20px",
          textAlign: "center"
        }}>
          <Spinner size={32} color="#0284c7" />
          <div style={{ marginTop: "14px", fontSize: "14px", fontWeight: "600", color: "#475569" }}>
            Loading PLComp data for {selectedClient}...
          </div>
          <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>
            Reading C1, F1:J1, and expense sections from master spreadsheet
          </div>
        </div>
      ) : error ? (
        /* Error Display */
        <div style={{
          background: "#ffffff",
          border: "1px solid #fecaca",
          borderRadius: "12px",
          padding: "32px 24px",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "28px", color: "#dc2626", marginBottom: "8px" }}>⚠️</div>
          <h4 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700", color: "#991b1b" }}>
            Failed to Load PLComp
          </h4>
          <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#b91c1c" }}>{error}</p>
          <button
            onClick={() => loadPlCompData(selectedClient)}
            style={{
              padding: "7px 16px",
              background: "#0284c7",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer"
            }}
          >
            Retry
          </button>
        </div>
      ) : !plData || !plData.sections || plData.sections.length === 0 ? (
        /* No sections found */
        <div style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "40px 20px",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "28px", marginBottom: "8px" }}>ℹ️</div>
          <h4 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700", color: "#1e293b" }}>
            No Expense Sections Found in PLComp
          </h4>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            No labeled accounts were found under Costs of sale, Overheads, or Non-operating sections on {selectedClient}&apos;s PLComp sheet.
          </p>
        </div>
      ) : (
        /* Data Table */
        <div style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
        }}>
          {/* Table Controls Bar */}
          <div style={{
            padding: "10px 18px",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px"
          }}>
            <div style={{ color: "#64748b" }}>
              Showing <strong>{plData.sections.reduce((acc, s) => acc + s.rows.length, 0)}</strong> accounts across <strong>{plData.sections.length}</strong> sections
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => handleSelectAll(true)}
                style={{ background: "none", border: "none", color: "#0284c7", cursor: "pointer", fontSize: "12px", fontWeight: "600", padding: 0 }}
              >
                Select all 5 months
              </button>
              <span style={{ color: "#cbd5e1" }}>|</span>
              <button
                onClick={() => handleSelectAll(false)}
                style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "12px", fontWeight: "500", padding: 0 }}
              >
                Clear all
              </button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                {/* 1. Push Checkbox Header Row */}
                <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    color: "#475569",
                    fontWeight: "700",
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    width: "38%"
                  }}>
                    Push Checkbox
                  </th>
                  {(plData.months || []).map(m => (
                    <th key={m.colLetter} style={{
                      padding: "8px 12px",
                      textAlign: "right",
                      width: "12.4%"
                    }}>
                      <label style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        cursor: "pointer",
                        background: checkedMonths[m.colLetter] ? "#e0f2fe" : "#ffffff",
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: `1px solid ${checkedMonths[m.colLetter] ? "#0284c7" : "#cbd5e1"}`,
                        transition: "all 0.15s ease"
                      }}>
                        <input
                          type="checkbox"
                          checked={!!checkedMonths[m.colLetter]}
                          onChange={() => toggleMonth(m.colLetter)}
                          style={{ cursor: "pointer", accentColor: "#0284c7" }}
                        />
                        <span style={{
                          fontSize: "11px",
                          fontWeight: "700",
                          color: checkedMonths[m.colLetter] ? "#0369a1" : "#475569"
                        }}>
                          Push
                        </span>
                      </label>
                    </th>
                  ))}
                </tr>

                {/* 2. Month Labels Header Row (from F1:J1) */}
                <tr style={{ background: "#f8fafc", borderBottom: "2px solid #cbd5e1" }}>
                  <th style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    color: "#1e293b",
                    fontWeight: "700",
                    fontSize: "12px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px"
                  }}>
                    Account / Category
                  </th>
                  {(plData.months || []).map(m => (
                    <th key={m.colLetter} style={{
                      padding: "10px 16px",
                      textAlign: "right",
                      color: checkedMonths[m.colLetter] ? "#0369a1" : "#0f172a",
                      fontWeight: "700",
                      fontSize: "13px"
                    }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <span>{m.header}</span>
                        <span style={{ fontSize: "10px", fontWeight: "500", color: "#94a3b8" }}>
                          Col {m.colLetter}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {plData.sections.map((section, sIdx) => (
                  <React.Fragment key={section.title}>
                    {/* Section Header Row */}
                    <tr style={{
                      background: "#f1f5f9",
                      borderTop: sIdx > 0 ? "2px solid #e2e8f0" : "none",
                      borderBottom: "1px solid #cbd5e1"
                    }}>
                      <td colSpan={(plData.months?.length || 5) + 1} style={{
                        padding: "8px 16px",
                        fontSize: "12px",
                        fontWeight: "700",
                        color: "#0f172a",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px"
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span>{section.title}</span>
                          <span style={{
                            fontSize: "11px",
                            fontWeight: "600",
                            background: "#e2e8f0",
                            color: "#475569",
                            padding: "2px 7px",
                            borderRadius: "10px"
                          }}>
                            {section.rows.length} {section.rows.length === 1 ? "account" : "accounts"}
                          </span>
                        </div>
                      </td>
                    </tr>

                    {/* Section Account Rows */}
                    {section.rows.map((row, rIdx) => (
                      <tr
                        key={`${section.title}-${row.label}-${rIdx}`}
                        style={{
                          borderBottom: "1px solid #f1f5f9",
                          background: rIdx % 2 === 1 ? "#fafbfc" : "#ffffff",
                          transition: "background-color 0.1s"
                        }}
                        onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#f0f9ff"; }}
                        onMouseLeave={e => { e.currentTarget.style.backgroundColor = rIdx % 2 === 1 ? "#fafbfc" : "#ffffff"; }}
                      >
                        <td style={{
                          padding: "8px 16px",
                          color: "#1e293b",
                          fontWeight: "500"
                        }}>
                          {row.label}
                        </td>
                        {row.values.map((val, vIdx) => {
                          const colLetter = ["F", "G", "H", "I", "J"][vIdx];
                          const isColChecked = !!checkedMonths[colLetter];
                          const isZero = val === "0.00" || val === "0" || !val;
                          return (
                            <td
                              key={vIdx}
                              style={{
                                padding: "8px 16px",
                                textAlign: "right",
                                fontFamily: "monospace",
                                fontSize: "13px",
                                color: isZero ? "#94a3b8" : "#0f172a",
                                background: isColChecked ? (isZero ? "rgba(224, 242, 254, 0.25)" : "rgba(224, 242, 254, 0.45)") : "transparent",
                                fontWeight: !isZero ? "600" : "400"
                              }}
                            >
                              {val || "0.00"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bottom Action Footer */}
          <div style={{
            padding: "14px 18px",
            background: "#f8fafc",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            <div style={{ fontSize: "12px", color: "#64748b" }}>
              Selected <strong>{selectedColCount} of 5</strong> months to push to client sheet Outgoings.
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={handlePullFreshPl}
                disabled={pullingPl || pushingOutgoings || loading}
                style={{
                  padding: "7px 14px",
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  color: "#334155",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: (pullingPl || pushingOutgoings || loading) ? "not-allowed" : "pointer"
                }}
              >
                {pullingPl ? "Pulling..." : "Pull Fresh P&L"}
              </button>

              <button
                onClick={handlePushOutgoings}
                disabled={pushingOutgoings || pullingPl || loading || selectedColCount === 0}
                style={{
                  padding: "7px 16px",
                  background: selectedColCount === 0 ? "#94a3b8" : "#0284c7",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: (pushingOutgoings || pullingPl || loading || selectedColCount === 0) ? "not-allowed" : "pointer"
                }}
              >
                {pushingOutgoings ? "Pushing..." : `Push selected month(s)${selectedColCount > 0 ? ` (${selectedColCount})` : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
