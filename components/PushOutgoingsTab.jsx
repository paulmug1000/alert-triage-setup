import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";

export default function PushOutgoingsTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  isAdmin = false
}) {
  const [selectedClient, setSelectedClient] = useState(initialClient || managedClient?.clientName || "");
  const [plData, setPlData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Toggle for including unreconciled items (default: true)
  const [includeUnreconciled, setIncludeUnreconciled] = useState(true);

  // Independent checkbox states for both modes
  // With adds: columns T..Y (including unreconciled)
  // Standard: columns F..K (not including unreconciled)
  const [checkedMonthsWithAdds, setCheckedMonthsWithAdds] = useState({});
  const [checkedMonthsStandard, setCheckedMonthsStandard] = useState({});

  // Action states
  const [pullingPl, setPullingPl] = useState(false);
  const [pushingOutgoings, setPushingOutgoings] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success' | 'error' | 'warning', text: string }

  // Sync initialClient / managedClient prop if changed externally
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
      setPlData(null);
      if (onClearInitialClient) onClearInitialClient();
    }
  };

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
        throw new Error(data.error || (isAdmin ? "Failed to load PLComp data" : "Failed to load P&L data"));
      }
      setPlData(data);

      // Initialize checked months for both modes from sheet
      const initialCheckedAdds = {};
      const addsMonths = data.includingUnreconciled?.months || data.months || [];
      addsMonths.forEach(m => {
        initialCheckedAdds[m.colLetter] = !!m.checked;
      });
      setCheckedMonthsWithAdds(initialCheckedAdds);

      const initialCheckedStd = {};
      const stdMonths = data.notIncludingUnreconciled?.months || [];
      stdMonths.forEach(m => {
        initialCheckedStd[m.colLetter] = !!m.checked;
      });
      setCheckedMonthsStandard(initialCheckedStd);
    } catch (err) {
      console.error("Error loading PLComp data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId, selectedClient, isAdmin]);

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

  // Active dataset based on includeUnreconciled toggle
  const activeData = useMemo(() => {
    if (!plData) return { months: [], sections: [] };
    if (includeUnreconciled) {
      return plData.includingUnreconciled || { months: plData.months || [], sections: plData.sections || [] };
    } else {
      return plData.notIncludingUnreconciled || { months: [], sections: [] };
    }
  }, [plData, includeUnreconciled]);

  // Current checked state based on includeUnreconciled toggle
  const currentChecked = includeUnreconciled ? checkedMonthsWithAdds : checkedMonthsStandard;

  // Toggle checkbox for a specific month
  const toggleMonth = (colLetter) => {
    if (includeUnreconciled) {
      setCheckedMonthsWithAdds(prev => ({
        ...prev,
        [colLetter]: !prev[colLetter]
      }));
    } else {
      setCheckedMonthsStandard(prev => ({
        ...prev,
        [colLetter]: !prev[colLetter]
      }));
    }
  };

  const selectedColCount = useMemo(() => {
    return Object.values(currentChecked).filter(Boolean).length;
  }, [currentChecked]);

  const handleSelectAll = (select) => {
    const updated = {};
    (activeData.months || []).forEach(m => {
      updated[m.colLetter] = !!select;
    });
    if (includeUnreconciled) {
      setCheckedMonthsWithAdds(updated);
    } else {
      setCheckedMonthsStandard(updated);
    }
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
    const selectedCols = Object.entries(currentChecked)
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
          includeUnreconciled,
          automationCommanderSheetId,
          workMonthKey: eomMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to push outgoings");
      }

      let successText = `✓ Outgoings successfully pushed (${includeUnreconciled ? "including unreconciled items" : "not including unreconciled items"}) for ${selectedCols.length} month${selectedCols.length !== 1 ? "s" : ""}.`;
      if (data.markedTaskDone) {
        successText += isAdmin
          ? ` Task "Use PLComp..." automatically marked Done for ${data.targetMonthLabel || "the current month"}!`
          : ` Push outgoings task automatically marked Done for ${data.targetMonthLabel || "the current month"}!`;
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
    <div style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      {/* Top Header Card */}
      {/* Top Header Card */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "20px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
      }}>
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
              <span>Push outgoings</span>
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to push outgoings
              </p>
            )}
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
            {/* Last Updated Timestamp & Mode Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
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
                <span>P&amp;L last updated: <strong>{plData?.lastUpdated || "-"}</strong>{isAdmin ? " (cell C1)" : ""}</span>
              </div>

              {/* Mode Toggle: Including vs Not including unreconciled items */}
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                background: "#f1f5f9",
                borderRadius: "8px",
                padding: "3px",
                border: "1px solid #e2e8f0",
                gap: "2px"
              }}>
                <button
                  type="button"
                  onClick={() => setIncludeUnreconciled(true)}
                  title={isAdmin ? "Pull actuals including unreconciled items from PLComp columns T-Y and run pushOutgoingsWithPLAddsToClientSheet" : "Include unreconciled items when pushing P&L actuals"}
                  style={{
                    padding: "5px 11px",
                    fontSize: "12px",
                    fontWeight: includeUnreconciled ? "700" : "500",
                    color: includeUnreconciled ? "#0369a1" : "#64748b",
                    background: includeUnreconciled ? "#ffffff" : "transparent",
                    border: includeUnreconciled ? "1px solid #bae6fd" : "1px solid transparent",
                    borderRadius: "6px",
                    cursor: "pointer",
                    boxShadow: includeUnreconciled ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
                    transition: "all 0.15s ease"
                  }}
                >
                  Including unreconciled items
                </button>
                <button
                  type="button"
                  onClick={() => setIncludeUnreconciled(false)}
                  title={isAdmin ? "Pull standard actuals from PLComp columns F-K and run pushOutgoingsToClientSheet" : "Push reconciled P&L actuals only"}
                  style={{
                    padding: "5px 11px",
                    fontSize: "12px",
                    fontWeight: !includeUnreconciled ? "700" : "500",
                    color: !includeUnreconciled ? "#0f172a" : "#64748b",
                    background: !includeUnreconciled ? "#ffffff" : "transparent",
                    border: !includeUnreconciled ? "1px solid #cbd5e1" : "1px solid transparent",
                    borderRadius: "6px",
                    cursor: "pointer",
                    boxShadow: !includeUnreconciled ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
                    transition: "all 0.15s ease"
                  }}
                >
                  Not including unreconciled items
                </button>
              </div>
            </div>

            {/* Top Action Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button
                onClick={handlePullFreshPl}
                disabled={pullingPl || pushingOutgoings || loading}
                title={isAdmin ? "Runs the PullPLBasedOn GAS function on the client's master sheet" : "Pull latest P&L figures from the accounting software"}
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
                title={isAdmin
                  ? (includeUnreconciled
                    ? "Saves selected checkboxes to PLComp!T87:Y87 and runs pushOutgoingsWithPLAddsToClientSheet"
                    : "Saves selected checkboxes to PLComp!F87:K87 and runs pushOutgoingsToClientSheet")
                  : "Pushes the selected months' P&L figures to Outgoings"
                }
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
        <EditClientSelector
          clients={allOutgoingsClients || []}
          onSelectClient={(c) => {
            const name = c.clientName || c.name || c;
            setSelectedClient(name);
          }}
          loading={loading}
          title="Select a client to push outgoings:"
        />
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
            {isAdmin ? `Loading PLComp data for ${selectedClient}...` : `Loading P&L data for ${selectedClient}...`}
          </div>
          <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>
            {isAdmin ? "Reading C1, F1:J1, and expense sections from master spreadsheet" : "Retrieving latest P&L expense sections"}
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
            {isAdmin ? "Failed to Load PLComp" : "Failed to load P&L data"}
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
      ) : !activeData || !activeData.sections || activeData.sections.length === 0 ? (
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
            {isAdmin ? "No Expense Sections Found in PLComp" : "No expense sections found"}
          </h4>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
            {isAdmin
              ? `No labeled accounts were found under Costs of sale, Overheads, or Non-operating sections on ${selectedClient}'s PLComp sheet.`
              : `No labeled accounts were found under Costs of sale, Overheads, or Non-operating sections for ${selectedClient}.`}
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
              Showing <strong>{activeData.sections.reduce((acc, s) => acc + s.rows.length, 0)}</strong> accounts across <strong>{activeData.sections.length}</strong> sections
              {" • "}<span style={{ color: includeUnreconciled ? "#0369a1" : "#475569", fontWeight: "600" }}>{includeUnreconciled ? `Including unreconciled items${isAdmin ? " (cols T–Y)" : ""}` : `Not including unreconciled items${isAdmin ? " (cols F–K)" : ""}`}</span>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => handleSelectAll(true)}
                style={{ background: "none", border: "none", color: "#0284c7", cursor: "pointer", fontSize: "12px", fontWeight: "600", padding: 0 }}
              >
                Select all {(activeData.months || []).length} months
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
                    width: "34%"
                  }}>
                    Push Checkbox
                  </th>
                  {(activeData.months || []).map(m => {
                    const isChecked = !!currentChecked[m.colLetter];
                    const colWidth = `${66 / Math.max(1, (activeData.months || []).length)}%`;
                    return (
                      <th key={m.colLetter} style={{
                        padding: "8px 12px",
                        textAlign: "right",
                        width: colWidth
                      }}>
                        <label style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          cursor: "pointer",
                          background: isChecked ? "#e0f2fe" : "#ffffff",
                          padding: "4px 8px",
                          borderRadius: "6px",
                          border: `1px solid ${isChecked ? "#0284c7" : "#cbd5e1"}`,
                          transition: "all 0.15s ease"
                        }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleMonth(m.colLetter)}
                            style={{ cursor: "pointer", accentColor: "#0284c7" }}
                          />
                          <span style={{
                            fontSize: "11px",
                            fontWeight: "700",
                            color: isChecked ? "#0369a1" : "#475569"
                          }}>
                            Push
                          </span>
                        </label>
                      </th>
                    );
                  })}
                </tr>

                {/* 2. Month Labels Header Row */}
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
                  {(activeData.months || []).map(m => {
                    const isChecked = !!currentChecked[m.colLetter];
                    return (
                      <th key={m.colLetter} style={{
                        padding: "10px 16px",
                        textAlign: "right",
                        color: isChecked ? "#0369a1" : "#0f172a",
                        fontWeight: "700",
                        fontSize: "13px"
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                          <span>{m.header}</span>
                          {isAdmin && (
                            <span style={{ fontSize: "10px", fontWeight: "500", color: "#94a3b8" }}>
                              Col {m.colLetter}
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>

              <tbody>
                {activeData.sections.map((section, sIdx) => (
                  <React.Fragment key={section.title}>
                    {/* Section Header Row */}
                    <tr style={{
                      background: "#f1f5f9",
                      borderTop: sIdx > 0 ? "2px solid #e2e8f0" : "none",
                      borderBottom: "1px solid #cbd5e1"
                    }}>
                      <td colSpan={(activeData.months?.length || 6) + 1} style={{
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
                          const m = (activeData.months || [])[vIdx];
                          const colLetter = m ? m.colLetter : "";
                          const isColChecked = !!currentChecked[colLetter];
                          const isZero = val === "0.00" || val === "0" || !val;
                          return (
                            <td
                              key={colLetter || vIdx}
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
              Selected <strong>{selectedColCount} of {(activeData.months || []).length}</strong> months to push to {isAdmin ? "client sheet Outgoings" : "Outgoings"} ({includeUnreconciled ? "including unreconciled items" : "not including unreconciled items"}).
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={handlePullFreshPl}
                disabled={pullingPl || pushingOutgoings || loading}
                title={isAdmin ? "Runs the PullPLBasedOn GAS function on the client's master sheet" : "Pull latest P&L figures from the accounting software"}
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
                {pullingPl ? "Pulling..." : "Pull fresh P&L"}
              </button>

              <button
                onClick={handlePushOutgoings}
                disabled={pushingOutgoings || pullingPl || loading || selectedColCount === 0}
                title={isAdmin
                  ? (includeUnreconciled
                    ? "Saves selected checkboxes to PLComp!T87:Y87 and runs pushOutgoingsWithPLAddsToClientSheet"
                    : "Saves selected checkboxes to PLComp!F87:K87 and runs pushOutgoingsToClientSheet")
                  : "Pushes the selected months' P&L figures to Outgoings"
                }
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
