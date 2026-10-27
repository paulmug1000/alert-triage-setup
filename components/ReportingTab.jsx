import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { eomWorkMonthToTargetMonth } from "../utils/helpers";

/**
 * Shifts a YYYY-MM month key by delta months (+1 or -1)
 */
function shiftMonthKey(monthKey, delta) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    const d = new Date();
    d.setMonth(d.getMonth() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Formats a YYYY-MM string to "Month YYYY" (e.g. "September 2026")
 */
function formatMonthKey(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return "";
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default function ReportingTab({
  automationCommanderSheetId = "",
  eomMonthKey = "",
  isAdmin = false,
  styles = {}
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success' | 'error' | 'info', text: string }

  // Clients & configuration
  const [clients, setClients] = useState([]);
  const [systemWebAppUrl, setSystemWebAppUrl] = useState("");
  const [chartRefs, setChartRefs] = useState([]);

  // Checkbox selections for batch actions
  const [selectedClients, setSelectedClients] = useState(new Set());

  // Action states
  const [actionInProgress, setActionInProgress] = useState(null); // 'GENERATE' | 'UPDATE' | 'EMAIL' | null
  const [clientStatuses, setClientStatuses] = useState({}); // { [clientName]: { status, message, reportUrl } }

  // Modals state
  const [emailModalClient, setEmailModalClient] = useState(null);
  const [emailForm, setEmailForm] = useState({ to: "", subj: "", body: "" });
  const [emailSaving, setEmailSaving] = useState(false);

  const [showLogModal, setShowLogModal] = useState(false);
  const [showChartRefsModal, setShowChartRefsModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsUrlInput, setSettingsUrlInput] = useState("");
  const [settingsTesting, setSettingsTesting] = useState(false);
  const [settingsTestResult, setSettingsTestResult] = useState(null);

  // Default report covered month is 1 month prior to the EoM work cycle (e.g. 2026-10 cycle reports on 2026-09)
  const defaultReportMonthKey = useMemo(() => {
    return eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey;
  }, [eomMonthKey]);

  const [selectedReportMonthKey, setSelectedReportMonthKey] = useState(defaultReportMonthKey);
  const prevEomMonthRef = useRef(eomMonthKey);

  // When parent EoM cycle changes, synchronize the default report month
  useEffect(() => {
    if (prevEomMonthRef.current !== eomMonthKey) {
      prevEomMonthRef.current = eomMonthKey;
      setSelectedReportMonthKey(eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey);
    }
  }, [eomMonthKey]);

  const reportMonthLabel = useMemo(() => {
    return formatMonthKey(selectedReportMonthKey);
  }, [selectedReportMonthKey]);

  const cycleMonthLabel = useMemo(() => {
    return formatMonthKey(eomMonthKey);
  }, [eomMonthKey]);

  const isOverridden = selectedReportMonthKey !== defaultReportMonthKey;

  // Load reporting data
  const loadReportingData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_get_reporting_data",
          automationCommanderSheetId,
          eomMonthKey,
          reportMonthKey: selectedReportMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load reporting data");
      }
      setClients(data.clients || []);
      setSystemWebAppUrl(data.systemWebAppUrl || "");
      setSettingsUrlInput(data.systemWebAppUrl || "");
      setChartRefs(data.chartRefs || []);

      // Auto-select clients that have decks configured by default
      const defaultSelected = new Set(
        (data.clients || []).filter(c => c.hasDeckConfigured).map(c => c.clientName)
      );
      setSelectedClients(defaultSelected);
    } catch (err) {
      console.error("Error loading reporting data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId, eomMonthKey, selectedReportMonthKey]);

  useEffect(() => {
    loadReportingData();
  }, [loadReportingData]);

  // Toggle single client selection
  const toggleClientSelection = (clientName) => {
    setSelectedClients(prev => {
      const next = new Set(prev);
      if (next.has(clientName)) {
        next.delete(clientName);
      } else {
        next.add(clientName);
      }
      return next;
    });
  };

  // Toggle select all
  const toggleSelectAll = () => {
    if (selectedClients.size === clients.length) {
      setSelectedClients(new Set());
    } else {
      setSelectedClients(new Set(clients.map(c => c.clientName)));
    }
  };

  // Run Batch Reporting Action (GENERATE | UPDATE | EMAIL)
  const handleRunBatchAction = async (mode) => {
    if (!selectedClients || selectedClients.size === 0) {
      setStatusMsg({ type: "error", text: "Please select at least one client to process." });
      return;
    }

    const targetClients = clients.filter(c => selectedClients.has(c.clientName));
    if (mode !== "EMAIL" && targetClients.some(c => !c.folderUrl)) {
      const missing = targetClients.filter(c => !c.folderUrl).map(c => c.clientName);
      if (!window.confirm(`Warning: The following client(s) do not have a Management Reports folder configured:\n- ${missing.join("\n- ")}\n\nDo you want to continue for the remaining clients?`)) {
        return;
      }
    }

    setActionInProgress(mode);
    setStatusMsg(null);

    // Set initial client statuses
    const newStatuses = { ...clientStatuses };
    targetClients.forEach(c => {
      newStatuses[c.clientName] = {
        status: "running",
        message: mode === "GENERATE" ? "Generating report..." : (mode === "UPDATE" ? "Updating deck..." : "Drafting email...")
      };
    });
    setClientStatuses(newStatuses);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_run_reporting_action",
          mode,
          clients: targetClients,
          eomMonthKey,
          reportMonthKey: selectedReportMonthKey,
          webAppUrlOverride: systemWebAppUrl,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();

      if (!data.success) {
        throw new Error(data.error || "Action execution failed");
      }

      // Update per-client statuses from results
      const finalStatuses = { ...newStatuses };
      (data.results || []).forEach(res => {
        finalStatuses[res.clientName] = {
          status: res.success ? "success" : "error",
          message: res.message || res.error || (res.success ? "Completed" : "Failed"),
          reportUrl: res.reportUrl || null
        };
      });
      setClientStatuses(finalStatuses);

      setStatusMsg({
        type: "success",
        text: data.message || `Action ${mode} completed successfully.`
      });

      // Reload fresh state to pull new report URLs and logs
      loadReportingData();
    } catch (err) {
      console.error("Batch reporting action error:", err);
      setStatusMsg({ type: "error", text: err.message });

      const errorStatuses = { ...newStatuses };
      targetClients.forEach(c => {
        errorStatuses[c.clientName] = { status: "error", message: err.message };
      });
      setClientStatuses(errorStatuses);
    } finally {
      setActionInProgress(null);
    }
  };

  // Open Email Template Modal
  const openEmailModal = (client) => {
    setEmailModalClient(client);
    setEmailForm({
      to: client.emailTo || "",
      subj: client.emailSubj || "End of month queries",
      body: client.emailBody || ""
    });
  };

  // Save Email Template
  const handleSaveEmailTemplate = async () => {
    if (!emailModalClient) return;
    setEmailSaving(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_reporting_config",
          clientName: emailModalClient.clientName,
          emailTo: emailForm.to,
          emailSubj: emailForm.subj,
          emailBody: emailForm.body,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to save template");

      // Update local client object
      setClients(prev => prev.map(c => c.clientName === emailModalClient.clientName ? {
        ...c,
        emailTo: emailForm.to,
        emailSubj: emailForm.subj,
        emailBody: emailForm.body
      } : c));

      setEmailModalClient(null);
      setStatusMsg({ type: "success", text: `Email template for ${emailModalClient.clientName} saved.` });
    } catch (err) {
      alert(`Error saving email template: ${err.message}`);
    } finally {
      setEmailSaving(false);
    }
  };

  // Test Web App Connection (proxied via backend to avoid browser CORS restrictions)
  const handleTestWebAppConnection = async () => {
    const cleanUrl = settingsUrlInput.trim();
    if (!cleanUrl) {
      alert("Please enter a Web App URL first.");
      return;
    }
    setSettingsTesting(true);
    setSettingsTestResult(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_test_reporting_webapp",
          webAppUrl: cleanUrl
        })
      });
      let data = null;
      try {
        data = await resp.json();
      } catch (parseErr) {
        setSettingsTestResult({
          success: false,
          message: `Server returned HTTP ${resp.status}. Please verify the Next.js server is running.`
        });
        return;
      }
      if (data && data.success) {
        setSettingsTestResult({ success: true, message: data.message || "Connection successful!" });
      } else {
        setSettingsTestResult({ success: false, message: data?.error || "Server returned error." });
      }
    } catch (err) {
      setSettingsTestResult({ success: false, message: `Connection failed: ${err.message}` });
    } finally {
      setSettingsTesting(false);
    }
  };

  // Save Web App URL
  const handleSaveSettings = async () => {
    const cleanUrl = settingsUrlInput.trim();
    try {
      await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_reporting_config",
          clientName: "__SYSTEM__",
          webAppUrl: cleanUrl,
          automationCommanderSheetId
        })
      });
      setSystemWebAppUrl(cleanUrl);
      setShowSettingsModal(false);
      setStatusMsg({ type: "success", text: "Reporting Web App URL updated." });
    } catch (err) {
      alert(`Error saving settings: ${err.message}`);
    }
  };

  if (!isAdmin) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b" }}>
        <p style={{ fontSize: "16px", fontWeight: "600", color: "#0f172a" }}>Admin access required</p>
        <p style={{ fontSize: "13px" }}>The reporting control section is restricted to administrators.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 0 40px" }}>
      {/* ── HEADER CARD ────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "20px 24px",
        marginBottom: "20px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "4px" }}>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                Reporting
              </h1>

              {/* Month selector pill */}
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                background: "#f8fafc",
                padding: "2px 6px",
                borderRadius: "8px",
                border: "1px solid #e2e8f0"
              }}>
                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(prev => shiftMonthKey(prev, -1))}
                  title="Previous report month"
                  aria-label="Previous report month"
                  style={{
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    width: "24px",
                    height: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: "#475569",
                    padding: 0
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#e2e8f0"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap" }}>
                    Report covers: {reportMonthLabel}
                  </span>
                  {cycleMonthLabel && (
                    <span style={{ fontSize: "11px", fontWeight: 500, color: "#64748b", whiteSpace: "nowrap" }}>
                      ({cycleMonthLabel} EoM cycle)
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(prev => shiftMonthKey(prev, 1))}
                  title="Next report month"
                  aria-label="Next report month"
                  style={{
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    width: "24px",
                    height: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: "#475569",
                    padding: 0
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#e2e8f0"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </button>
              </div>

              {isOverridden && (
                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(defaultReportMonthKey)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#2563eb",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: "2px 4px"
                  }}
                >
                  Reset to cycle default ({formatMonthKey(defaultReportMonthKey)})
                </button>
              )}
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
              Automated Google Slides management reporting decks and month-end email drafting.
            </p>
          </div>

          {/* Quick auxiliary controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <button
              onClick={() => setShowLogModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
            >
              Reports log
            </button>
            <button
              onClick={() => setShowChartRefsModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
            >
              Chart references
            </button>
            <button
              onClick={() => setShowSettingsModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
              title="Configure Web App deployment URL"
            >
              Settings
            </button>
          </div>
        </div>

        {/* Action Toolbar */}
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
          {/* Main Action Buttons (strictly Sentence Case) */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("GENERATE")}
              style={{
                padding: "8px 16px",
                background: actionInProgress === "GENERATE" ? "#93c5fd" : "#0066cc",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
              }}
            >
              {actionInProgress === "GENERATE" && <Spinner size="14px" color="#ffffff" />}
              <span>Generate new reports</span>
            </button>

            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("UPDATE")}
              style={{
                padding: "8px 16px",
                background: "#ffffff",
                color: "#0369a1",
                border: "1px solid #0284c7",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              {actionInProgress === "UPDATE" && <Spinner size="14px" color="#0369a1" />}
              <span>Update existing decks</span>
            </button>

            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("EMAIL")}
              style={{
                padding: "8px 16px",
                background: "#ffffff",
                color: "#334155",
                border: "1px solid #94a3b8",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              {actionInProgress === "EMAIL" && <Spinner size="14px" color="#334155" />}
              <span>Draft emails</span>
            </button>
          </div>

          {/* Selection controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", color: "#64748b" }}>
              {selectedClients.size} of {clients.length} selected
            </span>
            <button
              onClick={toggleSelectAll}
              style={{
                padding: "6px 10px",
                background: "none",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "12px",
                color: "#334155",
                cursor: "pointer"
              }}
            >
              {selectedClients.size === clients.length ? "Deselect all" : "Select all"}
            </button>
          </div>
        </div>
      </div>

      {/* ── NOTIFICATION STATUS BANNER ─────────────────────────────────────────── */}
      {statusMsg && (
        <div style={{
          marginBottom: "16px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "13px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: statusMsg.type === "error" ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${statusMsg.type === "error" ? "#fecaca" : "#bbf7d0"}`,
          color: statusMsg.type === "error" ? "#991b1b" : "#166534"
        }}>
          <div>{statusMsg.text}</div>
          <button
            onClick={() => setStatusMsg(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "bold" }}
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: "16px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "13px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          color: "#991b1b"
        }}>
          {error}
        </div>
      )}

      {/* ── CLIENT TABLE ───────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        {loading ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
            <Spinner size="24px" />
            <div style={{ marginTop: "10px", fontSize: "13px" }}>Loading reporting clients and configurations...</div>
          </div>
        ) : clients.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
            No clients found.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontWeight: 600 }}>
                  <th style={{ padding: "12px 16px", width: "40px" }}>
                    <input
                      type="checkbox"
                      checked={selectedClients.size === clients.length && clients.length > 0}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th style={{ padding: "12px 16px" }}>Client</th>
                  <th style={{ padding: "12px 16px" }}>Deck status</th>
                  <th style={{ padding: "12px 16px" }}>Latest report</th>
                  <th style={{ padding: "12px 16px" }}>Quick links</th>
                  <th style={{ padding: "12px 16px" }}>Email template</th>
                  <th style={{ padding: "12px 16px" }}>Execution status</th>
                </tr>
              </thead>
              <tbody>
                {clients.map(client => {
                  const isChecked = selectedClients.has(client.clientName);
                  const statusInfo = clientStatuses[client.clientName];
                  const latestReport = client.latestReport;

                  return (
                    <tr
                      key={client.clientName}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        backgroundColor: isChecked ? "#f0fdf4" : "transparent",
                        transition: "background-color 0.15s ease"
                      }}
                    >
                      {/* Checkbox */}
                      <td style={{ padding: "12px 16px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleClientSelection(client.clientName)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>

                      {/* Client Name */}
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: 600, color: "#0f172a" }}>
                          {client.clientName}
                        </div>
                      </td>

                      {/* Deck Setup Badge */}
                      <td style={{ padding: "12px 16px" }}>
                        {client.hasDeckConfigured ? (
                          <span style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            background: "#e0f2fe",
                            color: "#0369a1"
                          }}>
                            Deck configured
                          </span>
                        ) : (
                          <span style={{
                            fontSize: "11px",
                            fontWeight: 500,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            background: "#f1f5f9",
                            color: "#64748b"
                          }}>
                            No deck folder
                          </span>
                        )}
                      </td>

                      {/* Latest Report */}
                      <td style={{ padding: "12px 16px" }}>
                        {statusInfo?.reportUrl || latestReport?.reportUrl ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                            <a
                              href={statusInfo?.reportUrl || latestReport?.reportUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "3px 8px",
                                background: "#f0fdf4",
                                color: "#15803d",
                                border: "1px solid #bbf7d0",
                                borderRadius: "4px",
                                fontSize: "12px",
                                fontWeight: 600,
                                textDecoration: "none",
                                width: "fit-content"
                              }}
                            >
                              <span>Open deck</span>
                              <span style={{ fontSize: "10px" }}>↗</span>
                            </a>
                            {latestReport?.month && (
                              <span style={{
                                fontSize: "11px",
                                color: latestReport.month === selectedReportMonthKey ? "#16a34a" : "#64748b",
                                fontWeight: latestReport.month === selectedReportMonthKey ? 600 : 400
                              }}>
                                {latestReport.month === selectedReportMonthKey
                                  ? `${formatMonthKey(latestReport.month)}`
                                  : `Last run: ${formatMonthKey(latestReport.month)}`}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "#94a3b8", fontSize: "12px" }}>None yet</span>
                        )}
                      </td>

                      {/* Quick Links */}
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                          {client.masterSheetUrl && (
                            <a
                              href={client.masterSheetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#0284c7", textDecoration: "none" }}
                            >
                              Master
                            </a>
                          )}
                          {client.folderUrl && (
                            <a
                              href={client.folderUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#0284c7", textDecoration: "none" }}
                            >
                              Folder
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Email Template Preview / Edit Trigger */}
                      <td style={{ padding: "12px 16px" }}>
                        <button
                          onClick={() => openEmailModal(client)}
                          style={{
                            background: "none",
                            border: "1px solid #e2e8f0",
                            borderRadius: "4px",
                            padding: "4px 8px",
                            fontSize: "12px",
                            color: client.emailTo ? "#0f172a" : "#94a3b8",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px"
                          }}
                        >
                          <span>{client.emailTo ? "Edit email" : "Configure"}</span>
                        </button>
                      </td>

                      {/* Execution Status */}
                      <td style={{ padding: "12px 16px" }}>
                        {statusInfo ? (
                          <div style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            fontSize: "12px",
                            fontWeight: 600,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            background: statusInfo.status === "success" ? "#f0fdf4" : (statusInfo.status === "error" ? "#fef2f2" : "#f1f5f9"),
                            color: statusInfo.status === "success" ? "#15803d" : (statusInfo.status === "error" ? "#b91c1c" : "#0284c7")
                          }}>
                            {statusInfo.status === "running" && <Spinner size="12px" />}
                            <span>{statusInfo.message}</span>
                          </div>
                        ) : (
                          <span style={{ color: "#94a3b8", fontSize: "12px" }}>Ready</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── EMAIL TEMPLATE MODAL ──────────────────────────────────────────────── */}
      {emailModalClient && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "560px",
            padding: "24px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)"
          }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
              Email template: {emailModalClient.clientName}
            </h2>

            <div style={{ marginBottom: "12px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Send to (comma-separated email addresses):
              </label>
              <input
                type="text"
                value={emailForm.to}
                onChange={(e) => setEmailForm({ ...emailForm, to: e.target.value })}
                placeholder="name@example.com"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            <div style={{ marginBottom: "12px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Subject line:
              </label>
              <input
                type="text"
                value={emailForm.subj}
                onChange={(e) => setEmailForm({ ...emailForm, subj: e.target.value })}
                placeholder="End of month queries"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Email body:
              </label>
              <textarea
                rows={7}
                value={emailForm.body}
                onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })}
                placeholder="Hi..."
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  resize: "vertical"
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                onClick={() => setEmailModalClient(null)}
                style={{
                  padding: "8px 16px",
                  background: "none",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                disabled={emailSaving}
                onClick={handleSaveEmailTemplate}
                style={{
                  padding: "8px 16px",
                  background: "#0066cc",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: emailSaving ? "default" : "pointer"
                }}
              >
                {emailSaving ? "Saving..." : "Save template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── REPORTS LOG MODAL ─────────────────────────────────────────────────── */}
      {showLogModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "760px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            overflow: "hidden"
          }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                Historical reports log
              </h2>
              <button
                onClick={() => setShowLogModal(false)}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                    <th style={{ padding: "10px 12px" }}>Client</th>
                    <th style={{ padding: "10px 12px" }}>Month</th>
                    <th style={{ padding: "10px 12px" }}>Report presentation</th>
                    <th style={{ padding: "10px 12px" }}>Logged date</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.flatMap(c => (c.reportHistory || []).map(h => ({ clientName: c.clientName, ...h }))).length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "24px", textAlign: "center", color: "#94a3b8" }}>
                        No generated reports recorded in log yet.
                      </td>
                    </tr>
                  ) : (
                    clients.flatMap(c => (c.reportHistory || []).map(h => ({ clientName: c.clientName, ...h }))).map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "10px 12px", fontWeight: 600 }}>{item.clientName}</td>
                        <td style={{ padding: "10px 12px" }}>{item.month}</td>
                        <td style={{ padding: "10px 12px" }}>
                          <a href={item.reportUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#0066cc", textDecoration: "none" }}>
                            {item.reportName || "Open presentation"} ↗
                          </a>
                        </td>
                        <td style={{ padding: "10px 12px", color: "#64748b", fontSize: "12px" }}>
                          {item.createdAt ? new Date(item.createdAt).toLocaleDateString("en-GB") : "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "14px 24px", borderTop: "1px solid #e2e8f0", textAlign: "right" }}>
              <button
                onClick={() => setShowLogModal(false)}
                style={{ padding: "7px 16px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CHART REFERENCES MODAL ────────────────────────────────────────────── */}
      {showChartRefsModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "680px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            overflow: "hidden"
          }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ margin: "0 0 2px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                  Chart &amp; table references
                </h2>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                  Mapped slide speaker notes codes to Master Sheet cell ranges (tab: MgmtRep).
                </p>
              </div>
              <button
                onClick={() => setShowChartRefsModal(false)}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                    <th style={{ padding: "8px 12px" }}>Speaker notes code</th>
                    <th style={{ padding: "8px 12px" }}>MgmtRep cell range</th>
                    <th style={{ padding: "8px 12px" }}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {chartRefs.map((ref, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "8px 12px", fontWeight: 600, color: "#0066cc", fontFamily: "monospace" }}>{ref.code}</td>
                      <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{ref.range}</td>
                      <td style={{ padding: "8px 12px", color: "#64748b" }}>{ref.label || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "14px 24px", borderTop: "1px solid #e2e8f0", textAlign: "right" }}>
              <button
                onClick={() => setShowChartRefsModal(false)}
                style={{ padding: "7px 16px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SETTINGS MODAL ────────────────────────────────────────────────────── */}
      {showSettingsModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "540px",
            padding: "24px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)"
          }}>
            <h2 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
              Reporting integration settings
            </h2>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#64748b" }}>
              Deployed Google Apps Script Web App URL for generating slides and drafting emails.
            </p>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Web App URL:
              </label>
              <input
                type="text"
                value={settingsUrlInput}
                onChange={(e) => setSettingsUrlInput(e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            {settingsTestResult && (
              <div style={{
                marginBottom: "16px",
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: settingsTestResult.success ? "#f0fdf4" : "#fef2f2",
                color: settingsTestResult.success ? "#166534" : "#991b1b",
                border: `1px solid ${settingsTestResult.success ? "#bbf7d0" : "#fecaca"}`
              }}>
                {settingsTestResult.message}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                disabled={settingsTesting}
                onClick={handleTestWebAppConnection}
                style={{
                  padding: "7px 12px",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "12px",
                  cursor: settingsTesting ? "default" : "pointer"
                }}
              >
                {settingsTesting ? "Testing..." : "Test connection"}
              </button>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  style={{
                    padding: "8px 16px",
                    background: "none",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSettings}
                  style={{
                    padding: "8px 16px",
                    background: "#0066cc",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Save settings
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
