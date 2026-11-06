import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";
import { useAuth } from "../hooks/useAuth";

function formatGBP(num) {
  if (num == null || isNaN(num)) return "£0.00";
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const REASON_TAG_OPTIONS = [
  { value: "", label: "Select reason..." },
  { value: "Revenue phasing", label: "Revenue phasing" },
  { value: "Commission", label: "Commission" },
  { value: "Currency / FX difference", label: "Currency / FX difference" },
  { value: "Missing invoice in accounting", label: "Missing invoice in accounting" },
  { value: "Unbilled retainer", label: "Unbilled retainer" },
  { value: "Cancelled / removed job", label: "Cancelled / removed job" },
  { value: "Deposit / milestone timing", label: "Deposit / milestone timing" },
  { value: "Other", label: "Other" }
];

function normalizeClientName(val) {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  return (val.clientName || val.name || "").trim();
}

export default function RevenueCheckTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  styles = {},
  managedClient,
  onClearManagedClient
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));

  const [selectedClient, setSelectedClient] = useState(() =>
    normalizeClientName(initialClient) || normalizeClientName(managedClient) || ""
  );
  const [selectedMonthKey, setSelectedMonthKey] = useState(eomMonthKey || "");
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [runningSync, setRunningSync] = useState(false);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success'|'error', text: string }

  // Filter state
  const [filterMode, setFilterMode] = useState("all"); // 'all' | 'matched' | 'discrepancies'
  const [searchQuery, setSearchQuery] = useState("");
  const [matchedOpen, setMatchedOpen] = useState(true);

  // Local notes edits state: { [key]: { reasonTag, noteText, dirty, saving } }
  const [notesEdits, setNotesEdits] = useState({});

  // Sync initialClient / managedClient prop if changed externally
  useEffect(() => {
    const managedName = normalizeClientName(managedClient);
    const initName = normalizeClientName(initialClient);
    if (managedName && managedName !== selectedClient) {
      setSelectedClient(managedName);
    } else if (initName && initName !== selectedClient) {
      setSelectedClient(initName);
      if (onClearInitialClient) onClearInitialClient();
    }
  }, [initialClient, onClearInitialClient, managedClient, selectedClient]);

  // Linked EoM task status
  const linkedTask = useMemo(() => {
    if (!selectedClient) return null;
    return (eomAllTasks || []).find(t =>
      t.clientName === selectedClient &&
      (t.linkedFunction === "revenue_check" ||
        (t.name && (t.name.toLowerCase().includes("compare dashboard month to xero month") || t.name.toLowerCase().includes("compare dashboard month"))))
    );
  }, [eomAllTasks, selectedClient]);

  const isLinkedTaskDone = useMemo(() => {
    if (!linkedTask) return false;
    return linkedTask.status === "done";
  }, [linkedTask]);

  const handleSelectClient = (c) => {
    const name = normalizeClientName(c);
    setSelectedClient(name);
    setComparison(null);
    setError("");
    setStatusMsg(null);
  };

  // Sync eomMonthKey default if not set
  useEffect(() => {
    if (!selectedMonthKey && eomMonthKey) {
      setSelectedMonthKey(eomMonthKey);
    }
  }, [eomMonthKey, selectedMonthKey]);

  // Target month display label
  const targetMonthLabel = useMemo(() => {
    if (!selectedMonthKey) return "";
    const [y, m] = selectedMonthKey.split("-").map(Number);
    if (isNaN(y) || isNaN(m)) return selectedMonthKey;
    return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }, [selectedMonthKey]);

  // Month navigation
  const shiftMonth = (delta) => {
    if (!selectedMonthKey) return;
    const [y, m] = selectedMonthKey.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const nextKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    setSelectedMonthKey(nextKey);
  };

  // Load Revenue Check data
  const loadRevenueCheck = useCallback(async (clientToLoad, monthToLoad, forceRefresh = false) => {
    const c = clientToLoad || selectedClient;
    const m = monthToLoad || selectedMonthKey;
    if (!c || !m) {
      setComparison(null);
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
          action: "eom_get_revenue_check",
          clientName: c,
          monthKey: m,
          forceRefresh
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load revenue comparison");
      }
      setComparison(data.comparison || null);
    } catch (err) {
      console.error("Error loading revenue check:", err);
      setError(err.message || "Failed to load revenue comparison");
      setComparison(null);
    } finally {
      setLoading(false);
    }
  }, [selectedClient, selectedMonthKey]);

  useEffect(() => {
    if (selectedClient && selectedMonthKey) {
      loadRevenueCheck(selectedClient, selectedMonthKey, false);
    } else {
      setComparison(null);
    }
  }, [selectedClient, selectedMonthKey, loadRevenueCheck]);

  // Run Revenue Comparison (Triggers live accounting sync via GAS & PMA matching)
  const handleRunRevenueComparison = async () => {
    if (!selectedClient || !selectedMonthKey || runningSync) return;

    setRunningSync(true);
    setError("");
    setStatusMsg(null);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_run_revenue_comparison",
          clientName: selectedClient,
          monthKey: selectedMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Revenue comparison failed");
      }

      setComparison(data.comparison || null);
      setStatusMsg({
        type: "success",
        text: `Revenue comparison updated for ${selectedClient} (${targetMonthLabel}).`
      });

      if (onTaskMarkedDone) {
        onTaskMarkedDone(selectedClient, "revenue_check", selectedMonthKey);
      }
    } catch (err) {
      console.error("Error running revenue comparison:", err);
      setStatusMsg({
        type: "error",
        text: err.message || "Failed to run revenue comparison"
      });
    } finally {
      setRunningSync(false);
    }
  };

  // Save note / reason changes
  const handleSaveNote = async (itemKey, reasonTag, noteText) => {
    if (!selectedClient || !selectedMonthKey) return;

    setNotesEdits(prev => ({
      ...prev,
      [itemKey]: { ...(prev[itemKey] || {}), saving: true }
    }));

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_revenue_check_notes",
          clientName: selectedClient,
          monthKey: selectedMonthKey,
          notes: {
            [itemKey]: { reasonTag, noteText }
          }
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save note");
      }

      setComparison(data.comparison);
      setNotesEdits(prev => ({
        ...prev,
        [itemKey]: { reasonTag, noteText, dirty: false, saving: false }
      }));
    } catch (err) {
      console.error("Error saving note:", err);
      setNotesEdits(prev => ({
        ...prev,
        [itemKey]: { ...(prev[itemKey] || {}), saving: false }
      }));
    }
  };

  // Filtered lists
  const matchedPairs = useMemo(() => comparison?.comparisonData?.matchedPairs || [], [comparison]);
  const clientVariances = useMemo(() => comparison?.comparisonData?.clientVariances || [], [comparison]);
  const unmatchedAccounting = useMemo(() => comparison?.comparisonData?.unmatchedAccounting || [], [comparison]);
  const unmatchedPulse = useMemo(() => comparison?.comparisonData?.unmatchedPulse || [], [comparison]);

  const q = searchQuery.trim().toLowerCase();

  const filteredMatchedPairs = useMemo(() => {
    if (!q) return matchedPairs;
    return matchedPairs.filter(p =>
      String(p.clientName || "").toLowerCase().includes(q) ||
      (p.accounting || []).some(a =>
        String(a.invoiceNumber || "").toLowerCase().includes(q) ||
        String(a.description || "").toLowerCase().includes(q)
      ) ||
      (p.pulse || []).some(job =>
        String(job.jobName || "").toLowerCase().includes(q)
      )
    );
  }, [matchedPairs, q]);

  const filteredVariances = useMemo(() => {
    if (!q) return clientVariances;
    return clientVariances.filter(v =>
      String(v.clientName || "").toLowerCase().includes(q) ||
      (v.accounting || []).some(a =>
        String(a.invoiceNumber || "").toLowerCase().includes(q) ||
        String(a.description || "").toLowerCase().includes(q)
      ) ||
      (v.pulse || []).some(job =>
        String(job.jobName || "").toLowerCase().includes(q)
      )
    );
  }, [clientVariances, q]);

  const filteredUnmatchedAccounting = useMemo(() => {
    if (!q) return unmatchedAccounting;
    return unmatchedAccounting.filter(a =>
      String(a.clientName || "").toLowerCase().includes(q) ||
      String(a.invoiceNumber || "").toLowerCase().includes(q) ||
      String(a.description || "").toLowerCase().includes(q)
    );
  }, [unmatchedAccounting, q]);

  const filteredUnmatchedPulse = useMemo(() => {
    if (!q) return unmatchedPulse;
    return unmatchedPulse.filter(p =>
      String(p.clientName || "").toLowerCase().includes(q) ||
      String(p.jobName || "").toLowerCase().includes(q)
    );
  }, [unmatchedPulse, q]);

  const totalDiscrepancies = clientVariances.length + unmatchedAccounting.length + unmatchedPulse.length;
  const isBalanced = Math.abs(comparison?.totalVariance || 0) <= 0.05;

  // When no client is selected, render the standardized full-width client selector (identical to CashflowReconTab & SalariesView)
  if (!selectedClient) {
    return (
      <div style={{ padding: "16px 0" }}>
        <EditClientSelector
          clients={allOutgoingsClients || []}
          onSelectClient={handleSelectClient}
          loading={loading}
          title="Select a client to check revenue:"
        />
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 0" }}>
      {/* Top Header Card */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "10px",
          border: "1px solid #e2e8f0",
          padding: "16px 20px",
          marginBottom: "16px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          {/* Left: Back button + Title + Client Name badge + Selector dropdown */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {!managedClient && (allOutgoingsClients || []).length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedClient("");
                  setComparison(null);
                  setError("");
                  setStatusMsg(null);
                  if (onClearInitialClient) onClearInitialClient();
                }}
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
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)"
                }}
                title="Back to client list"
              >
                ←
              </button>
            )}
            <div>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>Revenue check</span>
              </h1>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" }}>
                <span style={{ fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {selectedClient}
                </span>
                {!managedClient && (allOutgoingsClients || []).length > 1 && (
                  <select
                    value={selectedClient}
                    onChange={(e) => handleSelectClient(e.target.value)}
                    style={{
                      fontSize: "12px",
                      padding: "2px 8px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#f8fafc",
                      color: "#475569",
                      cursor: "pointer"
                    }}
                    title="Switch client"
                  >
                    {allOutgoingsClients.map((c) => {
                      const name = normalizeClientName(c);
                      return <option key={name} value={name}>{name}</option>;
                    })}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Right: Target Month stepper + Run revenue comparison + Refresh + EoM task button */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* Target month stepper */}
            <div style={{ display: "flex", alignItems: "center", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "2px 4px", gap: "2px" }}>
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                title="Previous month"
              >
                ◀
              </button>
              <span style={{ padding: "4px 8px", fontSize: "13px", fontWeight: "600", color: "#1e293b" }}>
                {targetMonthLabel || selectedMonthKey}
              </span>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                title="Next month"
              >
                ▶
              </button>
            </div>

            {/* Run comparison button */}
            <button
              type="button"
              onClick={handleRunRevenueComparison}
              disabled={runningSync || loading}
              style={{
                padding: "7px 14px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#ffffff",
                background: runningSync ? "#94a3b8" : "#2563eb",
                border: "none",
                borderRadius: "6px",
                cursor: runningSync ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(37,99,235,0.2)"
              }}
            >
              {runningSync ? <Spinner size={14} color="#fff" /> : null}
              <span>{runningSync ? "Running comparison..." : "Run revenue comparison"}</span>
            </button>

            {/* Refresh */}
            <button
              type="button"
              onClick={() => loadRevenueCheck(selectedClient, selectedMonthKey, true)}
              disabled={loading || runningSync}
              style={{
                padding: "6px 12px",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                color: "#334155",
                fontSize: "12px",
                fontWeight: 600,
                cursor: (loading || runningSync) ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px"
              }}
              title="Refresh revenue comparison data"
            >
              {loading && !runningSync ? <Spinner size={12} /> : null}
              <span>Refresh</span>
            </button>

            {/* Linked EoM task button */}
            {linkedTask && onTaskMarkedDone && (
              <button
                type="button"
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
          </div>
        </div>
      </div>

      {/* Notifications */}
      {statusMsg && (
        <div
          style={{
            padding: "10px 14px",
            marginBottom: "16px",
            borderRadius: "6px",
            fontSize: "13px",
            background: statusMsg.type === "success" ? "#f0fdf4" : "#fef2f2",
            color: statusMsg.type === "success" ? "#166534" : "#991b1b",
            border: `1px solid ${statusMsg.type === "success" ? "#bbf7d0" : "#fecaca"}`
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "12px 14px",
            marginBottom: "16px",
            borderRadius: "6px",
            fontSize: "13px",
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca"
          }}
        >
          {error}
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <Spinner size={32} color="#2563eb" />
          <p style={{ marginTop: "12px", fontSize: "14px", color: "#64748b" }}>
            Loading revenue comparison...
          </p>
        </div>
      ) : !comparison ? (
        <div
          style={{
            padding: "48px 24px",
            textAlign: "center",
            background: "#fff",
            borderRadius: "8px",
            border: "1px solid #e2e8f0"
          }}
        >
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: "600", color: "#0f172a" }}>
            No revenue comparison found for {targetMonthLabel}
          </h3>
          <p style={{ margin: "0 0 20px 0", fontSize: "13px", color: "#64748b" }}>
            Click below to fetch the latest revenue transactions from your accounting tool and match them against Pulse.
          </p>
          <button
            type="button"
            onClick={handleRunRevenueComparison}
            disabled={runningSync}
            style={{
              padding: "10px 20px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#fff",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: "6px",
              cursor: runningSync ? "default" : "pointer"
            }}
          >
            {runningSync ? "Running comparison..." : "Run revenue comparison now"}
          </button>
        </div>
      ) : (
        <div>
          {/* KPI Summary Cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "12px",
              marginBottom: "20px"
            }}
          >
            <div style={{ padding: "14px 16px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Pulse revenue
              </div>
              <div style={{ fontSize: "20px", fontWeight: "700", color: "#0f172a", marginTop: "4px" }}>
                {formatGBP(comparison.totalPulseRevenue)}
              </div>
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Recognised in {targetMonthLabel}
              </div>
            </div>

            <div style={{ padding: "14px 16px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Accounting revenue
              </div>
              <div style={{ fontSize: "20px", fontWeight: "700", color: "#0f172a", marginTop: "4px" }}>
                {formatGBP(comparison.totalAccountingRevenue)}
              </div>
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Invoiced in accounting
              </div>
            </div>

            <div
              style={{
                padding: "14px 16px",
                background: isBalanced ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${isBalanced ? "#bbf7d0" : "#fecaca"}`,
                borderRadius: "8px"
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  color: isBalanced ? "#166534" : "#991b1b",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px"
                }}
              >
                Variance
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: "700",
                  color: isBalanced ? "#166534" : "#991b1b",
                  marginTop: "4px"
                }}
              >
                {formatGBP(comparison.totalVariance)}
              </div>
              <div style={{ fontSize: "12px", color: isBalanced ? "#166534" : "#991b1b", marginTop: "2px" }}>
                {isBalanced ? "Pulse matches accounting" : "Discrepancy detected"}
              </div>
            </div>

            <div style={{ padding: "14px 16px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Match status
              </div>
              <div style={{ fontSize: "20px", fontWeight: "700", color: "#0f172a", marginTop: "4px" }}>
                {matchedPairs.length} matched
              </div>
              <div style={{ fontSize: "12px", color: totalDiscrepancies > 0 ? "#b45309" : "#166534", marginTop: "2px", fontWeight: "500" }}>
                {totalDiscrepancies > 0 ? `${totalDiscrepancies} items to review` : "All items reconciled"}
              </div>
            </div>
          </div>

          {/* Filter Bar */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
              padding: "10px 14px",
              background: "#f8fafc",
              borderRadius: "8px",
              border: "1px solid #e2e8f0"
            }}
          >
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {[
                ["all", `All items (${matchedPairs.length + totalDiscrepancies})`],
                ["matched", `✓ Matched (${matchedPairs.length})`],
                ["discrepancies", `⚠️ Discrepancies & unmatched (${totalDiscrepancies})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilterMode(key)}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    fontWeight: filterMode === key ? "600" : "400",
                    color: filterMode === key ? "#2563eb" : "#475569",
                    background: filterMode === key ? "#eff6ff" : "#fff",
                    border: filterMode === key ? "1px solid #93c5fd" : "1px solid #cbd5e1",
                    borderRadius: "20px",
                    cursor: "pointer"
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ minWidth: "220px" }}>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter by client or invoice..."
                style={{
                  width: "100%",
                  padding: "6px 12px",
                  fontSize: "12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  outline: "none"
                }}
              />
            </div>
          </div>

          {/* Section: Side-by-Side Header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              padding: "8px 14px",
              background: "#f1f5f9",
              borderRadius: "6px",
              marginBottom: "12px",
              fontSize: "12px",
              fontWeight: "700",
              color: "#334155"
            }}
          >
            <div>Accounting tool (Xero / QuickBooks)</div>
            <div>Pulse (recognised jobs in month)</div>
          </div>

          {/* SECTION 1: Client Variances / Discrepancies */}
          {(filterMode === "all" || filterMode === "discrepancies") && filteredVariances.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "#991b1b",
                  marginBottom: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                <span>⚠️ Client variances ({filteredVariances.length})</span>
                <div style={{ flex: 1, height: "1px", background: "#fecaca" }} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {filteredVariances.map(v => {
                  const currentDraft = notesEdits[v.id] || {
                    reasonTag: v.reasonTag || "",
                    noteText: v.noteText || "",
                    dirty: false,
                    saving: false
                  };

                  return (
                    <div
                      key={v.id}
                      style={{
                        background: "#fff",
                        border: "1px solid #fecaca",
                        borderRadius: "8px",
                        padding: "14px",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
                      }}
                    >
                      {/* Client Header & Variance pill */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "12px",
                          paddingBottom: "8px",
                          borderBottom: "1px solid #f1f5f9"
                        }}
                      >
                        <div style={{ fontWeight: "700", fontSize: "14px", color: "#0f172a" }}>
                          {v.clientName}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span
                            style={{
                              padding: "4px 10px",
                              borderRadius: "12px",
                              fontSize: "12px",
                              fontWeight: "700",
                              background: v.difference > 0 ? "#eff6ff" : "#fef2f2",
                              color: v.difference > 0 ? "#1e40af" : "#991b1b",
                              border: `1px solid ${v.difference > 0 ? "#bfdbfe" : "#fecaca"}`
                            }}
                          >
                            Difference: {formatGBP(v.difference)} ({v.difference > 0 ? "Pulse higher" : "Accounting higher"})
                          </span>
                        </div>
                      </div>

                      {/* Side-by-Side Breakdown for this client */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "12px" }}>
                        {/* Left: Accounting Invoices */}
                        <div style={{ background: "#f8fafc", padding: "10px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "6px" }}>
                            Accounting invoices ({formatGBP(v.totalAccounting)} total)
                          </div>
                          {v.accounting.length === 0 ? (
                            <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic" }}>
                              No invoices found in accounting for this month
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {v.accounting.map(a => (
                                <div
                                  key={a.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    fontSize: "12px",
                                    padding: "4px 0",
                                    borderBottom: "1px dashed #e2e8f0"
                                  }}
                                >
                                  <div>
                                    <span style={{ fontWeight: "600", color: "#1e40af", marginRight: "6px" }}>
                                      {a.invoiceNumber || "Invoice"}
                                    </span>
                                    <span style={{ color: "#475569" }}>{a.description || "Revenue"}</span>
                                    {a.date && <span style={{ color: "#94a3b8", marginLeft: "6px", fontSize: "11px" }}>({a.date})</span>}
                                  </div>
                                  <div style={{ fontWeight: "600", color: "#0f172a" }}>
                                    {formatGBP(a.amount)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Right: Pulse Jobs */}
                        <div style={{ background: "#f8fafc", padding: "10px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "6px" }}>
                            Pulse recognised revenue ({formatGBP(v.totalPulse)} total)
                          </div>
                          {v.pulse.length === 0 ? (
                            <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic" }}>
                              No jobs recognised in Pulse for this month
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {v.pulse.map(p => (
                                <div
                                  key={p.id}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    fontSize: "12px",
                                    padding: "4px 0",
                                    borderBottom: "1px dashed #e2e8f0"
                                  }}
                                >
                                  <div>
                                    <span style={{ fontWeight: "600", color: "#0f172a", marginRight: "6px" }}>
                                      {p.jobName}
                                    </span>
                                    {p.type && (
                                      <span
                                        style={{
                                          padding: "1px 6px",
                                          background: "#e2e8f0",
                                          color: "#475569",
                                          borderRadius: "4px",
                                          fontSize: "10px"
                                        }}
                                      >
                                        {p.type}
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontWeight: "600", color: "#0f172a" }}>
                                    {formatGBP(p.amount)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Reason & Notes Row */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          paddingTop: "8px",
                          borderTop: "1px solid #f1f5f9",
                          flexWrap: "wrap"
                        }}
                      >
                        <div style={{ minWidth: "180px" }}>
                          <select
                            value={currentDraft.reasonTag}
                            onChange={e => {
                              const newTag = e.target.value;
                              setNotesEdits(prev => ({
                                ...prev,
                                [v.id]: { ...currentDraft, reasonTag: newTag, dirty: true }
                              }));
                              handleSaveNote(v.id, newTag, currentDraft.noteText);
                            }}
                            style={{
                              width: "100%",
                              padding: "6px 8px",
                              fontSize: "12px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "6px",
                              background: "#fff"
                            }}
                          >
                            {REASON_TAG_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>

                        <div style={{ flex: 1, minWidth: "220px" }}>
                          <input
                            type="text"
                            value={currentDraft.noteText}
                            onChange={e => {
                              const newText = e.target.value;
                              setNotesEdits(prev => ({
                                ...prev,
                                [v.id]: { ...currentDraft, noteText: newText, dirty: true }
                              }));
                            }}
                            onBlur={() => {
                              if (currentDraft.dirty) {
                                handleSaveNote(v.id, currentDraft.reasonTag, currentDraft.noteText);
                              }
                            }}
                            placeholder="Add explanation note..."
                            style={{
                              width: "100%",
                              padding: "6px 10px",
                              fontSize: "12px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "6px",
                              outline: "none"
                            }}
                          />
                        </div>

                        {currentDraft.saving ? (
                          <span style={{ fontSize: "11px", color: "#64748b" }}>Saving...</span>
                        ) : currentDraft.dirty ? (
                          <button
                            type="button"
                            onClick={() => handleSaveNote(v.id, currentDraft.reasonTag, currentDraft.noteText)}
                            style={{
                              padding: "5px 10px",
                              fontSize: "12px",
                              background: "#2563eb",
                              color: "#fff",
                              border: "none",
                              borderRadius: "4px",
                              cursor: "pointer"
                            }}
                          >
                            Save
                          </button>
                        ) : currentDraft.reasonTag || currentDraft.noteText ? (
                          <span style={{ fontSize: "11px", color: "#166534", fontWeight: "600" }}>✓ Saved</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 2: Unmatched Invoices in Accounting */}
          {(filterMode === "all" || filterMode === "discrepancies") && filteredUnmatchedAccounting.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "#c2410c",
                  marginBottom: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                <span>⚠️ Invoices in accounting with no Pulse match ({filteredUnmatchedAccounting.length})</span>
                <div style={{ flex: 1, height: "1px", background: "#fed7aa" }} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {filteredUnmatchedAccounting.map(a => {
                  const currentDraft = notesEdits[a.itemKey] || {
                    reasonTag: a.reasonTag || "",
                    noteText: a.noteText || "",
                    dirty: false,
                    saving: false
                  };

                  return (
                    <div
                      key={a.itemKey}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "16px",
                        background: "#fff",
                        border: "1px solid #fed7aa",
                        borderRadius: "6px",
                        padding: "10px 14px",
                        alignItems: "center"
                      }}
                    >
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <span style={{ fontWeight: "700", color: "#0f172a", marginRight: "6px" }}>
                              {a.clientName}
                            </span>
                            <span style={{ fontWeight: "600", color: "#1e40af", marginRight: "6px" }}>
                              {a.invoiceNumber}
                            </span>
                            <span style={{ color: "#475569", fontSize: "12px" }}>{a.description}</span>
                          </div>
                          <span style={{ fontWeight: "700", color: "#0f172a" }}>
                            {formatGBP(a.amount)}
                          </span>
                        </div>
                        {a.date && <div style={{ fontSize: "11px", color: "#94a3b8" }}>Date: {a.date}</div>}
                      </div>

                      {/* Reason tag & note input */}
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <select
                          value={currentDraft.reasonTag}
                          onChange={e => {
                            const newTag = e.target.value;
                            setNotesEdits(prev => ({ ...prev, [a.itemKey]: { ...currentDraft, reasonTag: newTag, dirty: true } }));
                            handleSaveNote(a.itemKey, newTag, currentDraft.noteText);
                          }}
                          style={{
                            padding: "4px 8px",
                            fontSize: "11px",
                            border: "1px solid #cbd5e1",
                            borderRadius: "4px",
                            background: "#fff"
                          }}
                        >
                          {REASON_TAG_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={currentDraft.noteText}
                          onChange={e => setNotesEdits(prev => ({ ...prev, [a.itemKey]: { ...currentDraft, noteText: e.target.value, dirty: true } }))}
                          onBlur={() => { if (currentDraft.dirty) handleSaveNote(a.itemKey, currentDraft.reasonTag, currentDraft.noteText); }}
                          placeholder="Note..."
                          style={{ flex: 1, padding: "4px 8px", fontSize: "11px", border: "1px solid #cbd5e1", borderRadius: "4px" }}
                        />
                        {currentDraft.dirty && (
                          <button
                            type="button"
                            onClick={() => handleSaveNote(a.itemKey, currentDraft.reasonTag, currentDraft.noteText)}
                            style={{ padding: "4px 8px", fontSize: "11px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "4px" }}
                          >
                            Save
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 3: Unmatched Jobs in Pulse */}
          {(filterMode === "all" || filterMode === "discrepancies") && filteredUnmatchedPulse.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "#a16207",
                  marginBottom: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                <span>⚠️ Jobs in Pulse with no accounting invoice ({filteredUnmatchedPulse.length})</span>
                <div style={{ flex: 1, height: "1px", background: "#fef08a" }} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {filteredUnmatchedPulse.map(p => {
                  const currentDraft = notesEdits[p.itemKey] || {
                    reasonTag: p.reasonTag || "",
                    noteText: p.noteText || "",
                    dirty: false,
                    saving: false
                  };

                  return (
                    <div
                      key={p.itemKey}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "16px",
                        background: "#fff",
                        border: "1px solid #fef08a",
                        borderRadius: "6px",
                        padding: "10px 14px",
                        alignItems: "center"
                      }}
                    >
                      <div style={{ color: "#94a3b8", fontSize: "12px", fontStyle: "italic" }}>
                        (No corresponding invoice found in accounting)
                      </div>

                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                          <div>
                            <span style={{ fontWeight: "700", color: "#0f172a", marginRight: "6px" }}>
                              {p.clientName}
                            </span>
                            <span style={{ color: "#334155", fontSize: "12px" }}>{p.jobName}</span>
                            {p.type && (
                              <span style={{ marginLeft: "6px", padding: "1px 6px", background: "#e2e8f0", borderRadius: "4px", fontSize: "10px", color: "#475569" }}>
                                {p.type}
                              </span>
                            )}
                          </div>
                          <span style={{ fontWeight: "700", color: "#0f172a" }}>
                            {formatGBP(p.amount)}
                          </span>
                        </div>

                        {/* Reason & note input */}
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <select
                            value={currentDraft.reasonTag}
                            onChange={e => {
                              const newTag = e.target.value;
                              setNotesEdits(prev => ({ ...prev, [p.itemKey]: { ...currentDraft, reasonTag: newTag, dirty: true } }));
                              handleSaveNote(p.itemKey, newTag, currentDraft.noteText);
                            }}
                            style={{
                              padding: "4px 8px",
                              fontSize: "11px",
                              border: "1px solid #cbd5e1",
                              borderRadius: "4px",
                              background: "#fff"
                            }}
                          >
                            {REASON_TAG_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={currentDraft.noteText}
                            onChange={e => setNotesEdits(prev => ({ ...prev, [p.itemKey]: { ...currentDraft, noteText: e.target.value, dirty: true } }))}
                            onBlur={() => { if (currentDraft.dirty) handleSaveNote(p.itemKey, currentDraft.reasonTag, currentDraft.noteText); }}
                            placeholder="Note..."
                            style={{ flex: 1, padding: "4px 8px", fontSize: "11px", border: "1px solid #cbd5e1", borderRadius: "4px" }}
                          />
                          {currentDraft.dirty && (
                            <button
                              type="button"
                              onClick={() => handleSaveNote(p.itemKey, currentDraft.reasonTag, currentDraft.noteText)}
                              style={{ padding: "4px 8px", fontSize: "11px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "4px" }}
                            >
                              Save
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SECTION 4: Matched Pairs */}
          {(filterMode === "all" || filterMode === "matched") && (
            <div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "#166534",
                  marginBottom: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer"
                }}
                onClick={() => setMatchedOpen(!matchedOpen)}
              >
                <span>{matchedOpen ? "▼" : "▶"} ✓ Matched pairs ({filteredMatchedPairs.length})</span>
                <div style={{ flex: 1, height: "1px", background: "#bbf7d0" }} />
              </div>

              {matchedOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {filteredMatchedPairs.length === 0 ? (
                    <div style={{ padding: "16px", textAlign: "center", color: "#64748b", fontSize: "13px", background: "#f8fafc", borderRadius: "6px" }}>
                      No matched pairs found for current search.
                    </div>
                  ) : (
                    filteredMatchedPairs.map(pair => (
                      <div
                        key={pair.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "16px",
                          background: "#fff",
                          border: "1px solid #bbf7d0",
                          borderRadius: "6px",
                          padding: "10px 14px",
                          alignItems: "center"
                        }}
                      >
                        {/* Left: Accounting */}
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontWeight: "700", color: "#0f172a", marginRight: "6px" }}>
                                {pair.clientName}
                              </span>
                              {pair.accounting.map((a, i) => (
                                <span key={i} style={{ color: "#475569", fontSize: "12px", marginRight: "6px" }}>
                                  <strong style={{ color: "#1e40af" }}>{a.invoiceNumber}</strong> {a.description}
                                </span>
                              ))}
                            </div>
                            <span style={{ fontWeight: "700", color: "#166534" }}>
                              {formatGBP(pair.totalAmount)}
                            </span>
                          </div>
                          {pair.accounting[0]?.date && (
                            <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                              Date: {pair.accounting[0].date}
                            </div>
                          )}
                        </div>

                        {/* Right: Pulse */}
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontWeight: "700", color: "#0f172a", marginRight: "6px" }}>
                                {pair.clientName}
                              </span>
                              {pair.pulse.map((p, i) => (
                                <span key={i} style={{ color: "#334155", fontSize: "12px", marginRight: "6px" }}>
                                  {p.jobName}
                                  {p.type && (
                                    <span style={{ marginLeft: "4px", padding: "1px 5px", background: "#e2e8f0", borderRadius: "3px", fontSize: "10px" }}>
                                      {p.type}
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                            <span style={{ fontWeight: "700", color: "#166534" }}>
                              {formatGBP(pair.totalAmount)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
