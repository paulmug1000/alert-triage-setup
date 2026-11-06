import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";
import { useAuth } from "../hooks/useAuth";
import { eomWorkMonthToTargetMonth } from "../utils/helpers";

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
  { value: "Accrual", label: "Accrual" },
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

  // Default monthKey should be the TARGET month (e.g. October 2026 when eomMonthKey is November 2026)
  const defaultTargetMonth = useMemo(() => {
    return eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey || "";
  }, [eomMonthKey]);

  const [selectedClient, setSelectedClient] = useState(() =>
    normalizeClientName(initialClient) || normalizeClientName(managedClient) || ""
  );
  const [selectedMonthKey, setSelectedMonthKey] = useState(defaultTargetMonth);
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [runningSync, setRunningSync] = useState(false);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success'|'error', text: string }

  // Filter state
  const [filterMode, setFilterMode] = useState("all"); // 'all' | 'discrepancies' | 'matched'
  const [searchQuery, setSearchQuery] = useState("");

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

  // Sync default target month if eomMonthKey changes
  useEffect(() => {
    if (!selectedMonthKey && eomMonthKey) {
      setSelectedMonthKey(eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey);
    }
  }, [eomMonthKey, selectedMonthKey]);

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
    setComparison(null);
    setError("");
    setStatusMsg(null);
  };

  // Load Revenue Check data from Store only (Does NOT auto-trigger sync)
  const loadRevenueCheck = useCallback(async (clientToLoad, monthToLoad, forceRefresh = false) => {
    const c = normalizeClientName(clientToLoad || selectedClient);
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
    const c = normalizeClientName(selectedClient);
    if (!c || !selectedMonthKey || runningSync) return;

    setRunningSync(true);
    setError("");
    setStatusMsg(null);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_run_revenue_comparison",
          clientName: c,
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
        text: `Revenue comparison updated for ${c} (${targetMonthLabel}).`
      });

      if (onTaskMarkedDone) {
        onTaskMarkedDone(c, "revenue_check", selectedMonthKey);
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

  // Local note field changes
  const handleEditField = (itemKey, field, value) => {
    setNotesEdits(prev => ({
      ...prev,
      [itemKey]: {
        ...(prev[itemKey] || {}),
        [field]: value,
        dirty: true
      }
    }));
  };

  // Save note / reason changes to store
  const handleSaveNote = async (itemKey, reasonTag, noteText) => {
    const c = normalizeClientName(selectedClient);
    if (!c || !selectedMonthKey) return;

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
          clientName: c,
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

  // Unified 4-Column Table Rows
  const tableRows = useMemo(() => {
    if (!comparison) return [];
    const rows = [];

    // 1. Client Variances (Discrepancies)
    (comparison?.comparisonData?.clientVariances || []).forEach((v) => {
      const itemKey = v.itemKey || `var-${v.clientName}`;
      const localEdit = notesEdits[itemKey] || {};
      rows.push({
        id: itemKey,
        itemKey,
        type: "variance",
        clientName: v.clientName,
        accountingItems: v.accounting || [],
        accountingTotal: v.appTotal || 0,
        pulseItems: v.pulse || [],
        pulseTotal: v.dashTotal || 0,
        difference: v.difference != null ? v.difference : (v.dashTotal - v.appTotal),
        isMatched: false,
        reasonTag: localEdit.reasonTag !== undefined ? localEdit.reasonTag : (v.reasonTag || ""),
        noteText: localEdit.noteText !== undefined ? localEdit.noteText : (v.noteText || "")
      });
    });

    // 2. Unmatched Accounting Invoices (In Accounting, missing from Pulse)
    (comparison?.comparisonData?.unmatchedAccounting || []).forEach((a) => {
      const itemKey = a.itemKey || `unrec-acct-${a.id}`;
      const localEdit = notesEdits[itemKey] || {};
      rows.push({
        id: itemKey,
        itemKey,
        type: "unmatched_accounting",
        clientName: a.clientName,
        accountingItems: [a],
        accountingTotal: a.amount || 0,
        pulseItems: [],
        pulseTotal: 0,
        difference: -(a.amount || 0), // Negative because in accounting but missing from Pulse
        isMatched: false,
        reasonTag: localEdit.reasonTag !== undefined ? localEdit.reasonTag : (a.reasonTag || ""),
        noteText: localEdit.noteText !== undefined ? localEdit.noteText : (a.noteText || "")
      });
    });

    // 3. Unmatched Pulse Jobs (In Pulse, missing from Accounting)
    (comparison?.comparisonData?.unmatchedPulse || []).forEach((p) => {
      const itemKey = p.itemKey || `unrec-pulse-${p.id}`;
      const localEdit = notesEdits[itemKey] || {};
      rows.push({
        id: itemKey,
        itemKey,
        type: "unmatched_pulse",
        clientName: p.clientName,
        accountingItems: [],
        accountingTotal: 0,
        pulseItems: [p],
        pulseTotal: p.amount || 0,
        difference: p.amount || 0, // Positive because in Pulse but missing from accounting
        isMatched: false,
        reasonTag: localEdit.reasonTag !== undefined ? localEdit.reasonTag : (p.reasonTag || ""),
        noteText: localEdit.noteText !== undefined ? localEdit.noteText : (p.noteText || "")
      });
    });

    // 4. Matched Pairs
    (comparison?.comparisonData?.matchedPairs || []).forEach((m, idx) => {
      const itemKey = m.itemKey || `matched-${m.clientName}-${idx}`;
      const localEdit = notesEdits[itemKey] || {};
      const acctTot = m.totalAmount || (m.accounting || []).reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
      const pulseTot = m.totalAmount || (m.pulse || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      rows.push({
        id: itemKey,
        itemKey,
        type: "matched",
        clientName: m.clientName,
        accountingItems: m.accounting || [],
        accountingTotal: acctTot,
        pulseItems: m.pulse || [],
        pulseTotal: pulseTot,
        difference: 0,
        isMatched: true,
        reasonTag: localEdit.reasonTag !== undefined ? localEdit.reasonTag : (m.reasonTag || ""),
        noteText: localEdit.noteText !== undefined ? localEdit.noteText : (m.noteText || "")
      });
    });

    return rows;
  }, [comparison, notesEdits]);

  // Search query filter
  const q = searchQuery.trim().toLowerCase();

  const filteredRows = useMemo(() => {
    return tableRows.filter(r => {
      // 1. Mode filter
      if (filterMode === "discrepancies" && r.isMatched) return false;
      if (filterMode === "matched" && !r.isMatched) return false;

      // 2. Query filter
      if (!q) return true;
      if (String(r.clientName || "").toLowerCase().includes(q)) return true;
      if (r.accountingItems.some(a =>
        String(a.invoiceNumber || "").toLowerCase().includes(q) ||
        String(a.description || "").toLowerCase().includes(q)
      )) return true;
      if (r.pulseItems.some(p =>
        String(p.jobName || "").toLowerCase().includes(q)
      )) return true;
      return false;
    });
  }, [tableRows, filterMode, q]);

  const discrepancyCount = useMemo(() => tableRows.filter(r => !r.isMatched).length, [tableRows]);
  const matchedCount = useMemo(() => tableRows.filter(r => r.isMatched).length, [tableRows]);
  const isNetBalanced = Math.abs(comparison?.totalVariance || 0) <= 0.05;

  // When no client is selected, render the standardized full-width client selector
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

            {/* Refresh from store */}
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
            background: "#ffffff",
            borderRadius: "10px",
            border: "1px solid #e2e8f0",
            padding: "48px 24px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
          }}
        >
          <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: "600", color: "#0f172a" }}>
            No revenue comparison found for {targetMonthLabel}
          </h3>
          <p style={{ margin: "0 auto 20px", fontSize: "13px", color: "#64748b", maxWidth: "480px" }}>
            Click below to fetch the latest revenue transactions from your accounting tool and match them against Pulse recognised revenue for {targetMonthLabel}.
          </p>
          <button
            type="button"
            onClick={handleRunRevenueComparison}
            disabled={runningSync}
            style={{
              padding: "9px 20px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#ffffff",
              backgroundColor: "#2563eb",
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
        </div>
      ) : (
        <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflow: "hidden" }}>
          {/* Compact Summary Strip & Filter Bar */}
          <div
            style={{
              padding: "12px 16px",
              background: "#f8fafc",
              borderBottom: "1px solid #e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "12px"
            }}
          >
            {/* KPI Totals */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
              <div style={{ fontSize: "12.5px", color: "#475569" }}>
                <span>Accounting total: </span>
                <strong style={{ color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>
                  {formatGBP(comparison.totalAccountingRevenue)}
                </strong>
              </div>
              <div style={{ fontSize: "12.5px", color: "#475569" }}>
                <span>Pulse total: </span>
                <strong style={{ color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>
                  {formatGBP(comparison.totalPulseRevenue)}
                </strong>
              </div>
              <div style={{ fontSize: "12.5px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <span style={{ color: "#475569" }}>Net variance: </span>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "10px",
                    fontSize: "12px",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    background: isNetBalanced ? "#dcfce7" : "#fee2e2",
                    color: isNetBalanced ? "#166534" : "#991b1b"
                  }}
                >
                  {isNetBalanced ? "✓ Balanced (£0.00)" : `${comparison.totalVariance > 0 ? "+" : ""}${formatGBP(comparison.totalVariance)}`}
                </span>
              </div>
            </div>

            {/* Filter Pills & Search */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <div style={{ display: "inline-flex", background: "#e2e8f0", padding: "2px", borderRadius: "6px" }}>
                <button
                  type="button"
                  onClick={() => setFilterMode("all")}
                  style={{
                    padding: "3px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    background: filterMode === "all" ? "#ffffff" : "transparent",
                    color: filterMode === "all" ? "#0f172a" : "#64748b",
                    cursor: "pointer",
                    boxShadow: filterMode === "all" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                  }}
                >
                  All ({tableRows.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode("discrepancies")}
                  style={{
                    padding: "3px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    background: filterMode === "discrepancies" ? "#ffffff" : "transparent",
                    color: filterMode === "discrepancies" ? "#991b1b" : "#64748b",
                    cursor: "pointer",
                    boxShadow: filterMode === "discrepancies" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                  }}
                >
                  ⚠️ Discrepancies ({discrepancyCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode("matched")}
                  style={{
                    padding: "3px 10px",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    background: filterMode === "matched" ? "#ffffff" : "transparent",
                    color: filterMode === "matched" ? "#166534" : "#64748b",
                    cursor: "pointer",
                    boxShadow: filterMode === "matched" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                  }}
                >
                  ✓ Matched ({matchedCount})
                </button>
              </div>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                style={{
                  fontSize: "12px",
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  width: "140px"
                }}
              />
            </div>
          </div>

          {/* 4-Column Table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", tableLayout: "fixed" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1.5px solid #e2e8f0" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", width: "32%", fontWeight: 600, color: "#475569", fontSize: "12px" }}>
                    Accounting tool
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 14px", width: "32%", fontWeight: 600, color: "#475569", fontSize: "12px" }}>
                    Pulse
                  </th>
                  <th style={{ textAlign: "center", padding: "10px 14px", width: "14%", fontWeight: 600, color: "#475569", fontSize: "12px" }}>
                    Difference
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 14px", width: "22%", fontWeight: 600, color: "#475569", fontSize: "12px" }}>
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", padding: "36px 14px", color: "#64748b", fontSize: "13px" }}>
                      No items found matching the selected filter.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => {
                    const local = notesEdits[row.itemKey] || {};
                    const currentReason = local.reasonTag !== undefined ? local.reasonTag : row.reasonTag;
                    const currentNote = local.noteText !== undefined ? local.noteText : row.noteText;
                    const isDirty = Boolean(local.dirty);
                    const isSaving = Boolean(local.saving);

                    return (
                      <tr
                        key={row.id}
                        style={{
                          borderBottom: "1px solid #f1f5f9",
                          backgroundColor: row.isMatched ? "#ffffff" : "#fffdfb",
                          borderLeft: row.isMatched ? "3px solid #22c55e" : "3px solid #ef4444"
                        }}
                      >
                        {/* Column 1: Accounting tool */}
                        <td style={{ padding: "8px 14px", verticalAlign: "top" }}>
                          {row.accountingItems.length > 0 ? (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
                                <span style={{ fontWeight: 600, color: "#0f172a", fontSize: "13px" }}>
                                  {row.clientName}
                                </span>
                                <span style={{ fontWeight: 600, color: "#0f172a", fontSize: "13px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                                  {formatGBP(row.accountingTotal)}
                                </span>
                              </div>
                              <div style={{ marginTop: "2px" }}>
                                {row.accountingItems.map((a, i) => (
                                  <div key={i} style={{ fontSize: "11.5px", color: "#64748b", lineHeight: 1.35 }}>
                                    <span style={{ fontWeight: 500, color: "#334155" }}>{a.invoiceNumber || "Invoice"}</span>
                                    {a.date ? <span> • {a.date.split(" ")[0]}</span> : null}
                                    {a.description ? <span> • {a.description}</span> : null}
                                    {row.accountingItems.length > 1 && (
                                      <span style={{ fontWeight: 600, color: "#0f172a", marginLeft: "4px" }}>
                                        ({formatGBP(a.amount)})
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", paddingTop: "2px" }}>
                              — No invoice in accounting —
                            </div>
                          )}
                        </td>

                        {/* Column 2: Pulse */}
                        <td style={{ padding: "8px 14px", verticalAlign: "top" }}>
                          {row.pulseItems.length > 0 ? (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
                                <span style={{ fontWeight: 600, color: "#0f172a", fontSize: "13px" }}>
                                  {row.clientName}
                                </span>
                                <span style={{ fontWeight: 600, color: "#0f172a", fontSize: "13px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                                  {formatGBP(row.pulseTotal)}
                                </span>
                              </div>
                              <div style={{ marginTop: "2px" }}>
                                {row.pulseItems.map((p, i) => (
                                  <div key={i} style={{ fontSize: "11.5px", color: "#64748b", lineHeight: 1.35 }}>
                                    <span>{p.jobName || "Recognised revenue"}</span>
                                    {row.pulseItems.length > 1 && (
                                      <span style={{ fontWeight: 600, color: "#0f172a", marginLeft: "4px" }}>
                                        ({formatGBP(p.amount)})
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", paddingTop: "2px" }}>
                              — No recognised job in Pulse —
                            </div>
                          )}
                        </td>

                        {/* Column 3: Difference */}
                        <td style={{ padding: "8px 14px", verticalAlign: "top", textAlign: "center" }}>
                          {row.isMatched ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: "10px",
                                background: "#dcfce7",
                                color: "#166534",
                                fontSize: "11.5px",
                                fontWeight: 600,
                                fontVariantNumeric: "tabular-nums"
                              }}
                            >
                              ✓ £0.00
                            </span>
                          ) : (
                            <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: "10px",
                                  background: "#fee2e2",
                                  color: "#991b1b",
                                  fontSize: "12px",
                                  fontWeight: 700,
                                  fontVariantNumeric: "tabular-nums"
                                }}
                              >
                                {row.difference > 0 ? "+" : ""}{formatGBP(row.difference)}
                              </span>
                              <span style={{ fontSize: "10px", color: "#64748b", marginTop: "2px" }}>
                                {row.difference > 0 ? "Pulse higher" : "Accounting higher"}
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Column 4: Notes */}
                        <td style={{ padding: "8px 14px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <select
                              value={currentReason}
                              onChange={(e) => handleEditField(row.itemKey, "reasonTag", e.target.value)}
                              style={{
                                fontSize: "11.5px",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                border: "1px solid #cbd5e1",
                                background: "#ffffff",
                                color: currentReason ? "#0f172a" : "#64748b",
                                width: "100%"
                              }}
                            >
                              {REASON_TAG_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                            <div style={{ display: "flex", gap: "4px" }}>
                              <input
                                type="text"
                                value={currentNote}
                                onChange={(e) => handleEditField(row.itemKey, "noteText", e.target.value)}
                                placeholder="Add note..."
                                style={{
                                  fontSize: "11.5px",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  border: "1px solid #cbd5e1",
                                  flex: 1
                                }}
                              />
                              {isDirty && (
                                <button
                                  type="button"
                                  onClick={() => handleSaveNote(row.itemKey, currentReason, currentNote)}
                                  disabled={isSaving}
                                  style={{
                                    padding: "2px 8px",
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    background: "#2563eb",
                                    color: "#ffffff",
                                    border: "none",
                                    borderRadius: "4px",
                                    cursor: isSaving ? "wait" : "pointer",
                                    whiteSpace: "nowrap"
                                  }}
                                >
                                  {isSaving ? "..." : "Save"}
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
