import React, { useEffect } from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { useTasks } from "../contexts/TaskContext";

export default function TasksView({
  styles,
  allClientsMap,
  automationCommanderSheetId,
  isAccepting,
  setIsAccepting,
  refreshTriage
}) {
  const {
    tasks, setTasks, tasksLoading, tasksFilter, setTasksFilter,
    selectedTask, setSelectedTask, taskDetailOptions, setTaskDetailOptions,
    taskDetailAnalyzing, setTaskDetailAnalyzing, taskNoteInput, setTaskNoteInput,
    taskNoteSubmitting, setTaskNoteSubmitting,
    taskSnoozeDate, setTaskSnoozeDate, taskSnoozeTime, setTaskSnoozeTime,
    taskSnoozeSubmitting, setTaskSnoozeSubmitting, taskActionError, setTaskActionError,
    navTaskCount, setNavTaskCount, snoozedTaskCount, setSnoozedTaskCount,
    tasksLoadedAt, loadTasks
  } = useTasks();

  useEffect(() => {
    if (!tasksLoading && Date.now() - tasksLoadedAt > 5 * 60 * 1000) {
      loadTasks(tasksFilter, true);
    }
    const interval = setInterval(() => {
      if (!tasksLoading) loadTasks(tasksFilter, true);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [tasksFilter, tasksLoadedAt, tasksLoading, loadTasks]);

  const formatAlertType = (type) => {
    const map = {
      invoiceDashboardDiscr: "Invoice discrepancy", invoice: "Invoice",
      expenseDashboardDiscr: "Expense discrepancy", expense: "Expense",
      crmPipeDashDiscr: "CRM pipeline", crmConfDashDiscr: "CRM confirmed",
      crmPipeAppDiscr: "CRM pipeline (app)", crmConfAppDiscr: "CRM confirmed (app)",
      retainerInvoicesCreated: "Retainer invoices", retainerInvoicesDeleted: "Retainer deleted",
      proactive: "Proactive alert",
    };
    return map[type] || type || "Alert";
  };

  const openTask = async (task) => {
    setSelectedTask(task);
    setTaskDetailOptions([]);
    setTaskActionError("");
    setTaskNoteInput("");
    setTaskSnoozeDate("");
    setTaskSnoozeTime("07:00");

    if (task.cachedOptionsJSON) {
      try {
        const opts = JSON.parse(task.cachedOptionsJSON);
        if (Array.isArray(opts) && opts.length > 0 && opts[0].title) {
          setTaskDetailOptions(opts);
          return;
        }
      } catch (e) {}
    }

    if (task.alertDataJSON) {
      try {
        const alertObj = JSON.parse(task.alertDataJSON);
        setTaskDetailAnalyzing(true);
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "analyze_alert", alert: alertObj, automationCommanderSheetId }),
        });
        const data = await res.json();
        if (data.success && data.options) setTaskDetailOptions(data.options);
      } catch (e) {
        console.error("Failed to re-analyze task alert:", e);
      } finally {
        setTaskDetailAnalyzing(false);
      }
    }
  };

  const submitTaskNote = async () => {
    if (!selectedTask || !taskNoteInput.trim()) return;
    try {
      setTaskNoteSubmitting(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_task_note",
          fingerprintHash: selectedTask.fingerprintHash,
          noteText: taskNoteInput.trim(),
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const newNote = { text: taskNoteInput.trim(), timestamp: new Date().toISOString() };
        setSelectedTask(prev => ({ ...prev, furtherNotes: [...(prev.furtherNotes || []), newNote] }));
        setTasks(prev => prev.map(t => t.fingerprintHash === selectedTask.fingerprintHash
          ? { ...t, furtherNotes: [...(t.furtherNotes || []), newNote] } : t));
        setTaskNoteInput("");
      } else setTaskActionError(data.error || "Failed to add note");
    } catch (e) { setTaskActionError(e.message); }
    finally { setTaskNoteSubmitting(false); }
  };

  const submitSnoozeTask = async () => {
    if (!selectedTask || !taskSnoozeDate) return;
    const localDt = new Date(`${taskSnoozeDate}T${taskSnoozeTime}:00`);
    const snoozedUntil = localDt.toISOString();
    try {
      setTaskSnoozeSubmitting(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "snooze_task",
          fingerprintHash: selectedTask.fingerprintHash,
          snoozedUntil,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedTask(null);
        setNavTaskCount(prev => Math.max(0, prev - 1));
        setSnoozedTaskCount(prev => prev + 1);
        setTasksFilter("active");
        loadTasks("active", true);
      } else setTaskActionError(data.error || "Failed to snooze task");
    } catch (e) { setTaskActionError(e.message); }
    finally { setTaskSnoozeSubmitting(false); }
  };

  const resolveTask = async (fingerprintHash) => {
    try {
      setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve_task", fingerprintHash, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        const taskToResolve = tasks.find(t => t.fingerprintHash === fingerprintHash) || selectedTask;
        const wasSnoozed = taskToResolve?.isSnoozed;

        setTasks(prev => prev.filter(t => t.fingerprintHash !== fingerprintHash));
        if (selectedTask?.fingerprintHash === fingerprintHash) setSelectedTask(null);
        
        if (wasSnoozed) {
          setSnoozedTaskCount(prev => Math.max(0, prev - 1));
        } else {
          setNavTaskCount(prev => Math.max(0, prev - 1));
        }
      } else setTaskActionError(data.error || "Failed to resolve task");
    } catch (e) { setTaskActionError(e.message); }
  };

  const handleRevertTaskToAlert = async (fingerprintHash) => {
    try {
      setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert_task_to_alert", fingerprintHash, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        const taskToRevert = tasks.find(t => t.fingerprintHash === fingerprintHash) || selectedTask;
        const wasSnoozed = taskToRevert?.isSnoozed;
        
        setTasks(prev => prev.filter(t => t.fingerprintHash !== fingerprintHash));
        if (selectedTask?.fingerprintHash === fingerprintHash) setSelectedTask(null);
        
        if (wasSnoozed) setSnoozedTaskCount(prev => Math.max(0, prev - 1));
        else setNavTaskCount(prev => Math.max(0, prev - 1));
        
        refreshTriage();
      } else {
        setTaskActionError(data.error || "Failed to revert task");
      }
    } catch (e) { setTaskActionError(e.message); }
  };

  const handleAnalyzeTask = async (task) => {
    setTaskDetailAnalyzing(true);
    setTaskActionError("");
    try {
      const alertObj = JSON.parse(task.alertDataJSON || "{}");
      const clientInfo = allClientsMap[task.clientName] || {};
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_noaction_flag",
          flagType: task.alertType || alertObj.flagType || alertObj.alertType || alertObj.type,
          clientSheetId: clientInfo.clientSheetId || alertObj.clientSheetId || alertObj.clientId,
          masterSheetId: clientInfo.masterSheetId || alertObj.masterSheetId,
          automationCommanderSheetId,
          clientName: task.clientName,
          targetLine: alertObj.detail || alertObj.summary?.summary || task.alertSummary,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedTask(prev => ({ ...prev, analysisResult: data }));
      } else {
        setTaskActionError(data.error || "Analysis failed");
      }
    } catch (e) {
      setTaskActionError(e.message);
    } finally {
      setTaskDetailAnalyzing(false);
    }
  };

  const acceptTaskOption = async (option) => {
    if (!selectedTask?.alertDataJSON) return;
    try {
      const alertObj = JSON.parse(selectedTask.alertDataJSON);
      setIsAccepting(true);
      setTaskActionError("");
      const action = option.matchType === "delete" ? "delete_job" : "accept_option";
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, alert: alertObj, option, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) { setTaskActionError(`Failed: ${data.error || "Unknown error"}`); return; }
      await resolveTask(selectedTask.fingerprintHash);
    } catch (e) { setTaskActionError(e.message); }
    finally { setIsAccepting(false); }
  };

  if (!selectedTask) {
    const filterTabs = [
      { key: "active", label: "Active", count: navTaskCount },
      { key: "snoozed", label: "Snoozed", count: snoozedTaskCount },
      { key: "resolved", label: "Completed", count: 0 },
    ];
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Tasks</h1>
          <p style={styles.subtitle}>Alerts deferred for follow-up</p>
        </div>

        {taskActionError && <div style={styles.errorBanner}>{taskActionError}</div>}

        <div style={{ display: "flex", gap: "0", borderBottom: "1px solid #e0e0e0", marginBottom: "20px" }}>
          {filterTabs.map(tab => (
            <button key={tab.key} className="triage-btn pulse-nav-item"
              onClick={() => { setTasksFilter(tab.key); loadTasks(tab.key); }}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "10px 20px",
                fontSize: "14px", fontWeight: tasksFilter === tab.key ? "600" : "400",
                color: tasksFilter === tab.key ? "#0066cc" : "#555",
                borderBottom: tasksFilter === tab.key ? "2px solid #0066cc" : "2px solid transparent",
                borderRadius: "0", display: "flex", alignItems: "center", gap: "6px",
              }}>
              {tab.label}
              {tab.count > 0 && (
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "#e53e3e", color: "#fff", borderRadius: "10px",
                  fontSize: "10px", fontWeight: "700", minWidth: "17px", height: "17px",
                  padding: "0 5px", lineHeight: "1",
                }}>{tab.count > 99 ? "99+" : tab.count}</span>
              )}
            </button>
          ))}
          <button className="triage-btn" onClick={() => loadTasks(tasksFilter)}
            style={{ ...styles.buttonSecondary, marginLeft: "auto", fontSize: "12px", padding: "6px 14px", alignSelf: "center" }}>
            ↻ Refresh
          </button>
        </div>

        {tasksLoading ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#888" }}><Spinner size={20} color="#0066cc" /> Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#888", fontSize: "14px" }}>
            {tasksFilter === "active" ? "No active tasks" : tasksFilter === "snoozed" ? "No snoozed tasks" : "No completed tasks"}
          </div>
        ) : (
          <div>
            {tasks.map(task => (
              <div key={task.fingerprintHash}
                className="triage-client-card"
                onClick={() => openTask(task)}
                style={{ ...styles.card, cursor: "pointer", marginBottom: "12px", padding: "16px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <span style={{ fontSize: "13px", fontWeight: "700", color: "#1a1a1a" }}>{task.clientName}</span>
                      <span style={{ fontSize: "11px", background: "#f0f4ff", color: "#0066cc", padding: "2px 8px", borderRadius: "10px", fontWeight: "600" }}>
                        {formatAlertType(task.alertType)}
                      </span>
                      {task.isProactive && (
                        <span style={{ fontSize: "11px", background: "#fff3e0", color: "#e65100", padding: "2px 8px", borderRadius: "10px", fontWeight: "600" }}>Proactive</span>
                      )}
                    </div>
                    <div style={{ fontSize: "13px", color: "#555", marginBottom: "4px" }}>{task.alertSummary}</div>
                    {task.taskNote && (
                      <div style={{ fontSize: "12px", color: "#7c3aed", fontStyle: "italic" }}>📋 {task.taskNote}</div>
                    )}
                    {task.furtherNotes?.length > 0 && (
                      <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>
                        {task.furtherNotes.length} note{task.furtherNotes.length > 1 ? "s" : ""} · Last: {new Date(task.furtherNotes[task.furtherNotes.length - 1].timestamp).toLocaleDateString("en-GB")}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: "11px", color: "#aaa" }}>
                      {task.taskCreatedAt ? new Date(task.taskCreatedAt).toLocaleDateString("en-GB") : "—"}
                    </div>
                    {task.isSnoozed && (
                      <div style={{ fontSize: "11px", color: "#d97706", marginTop: "2px" }}>
                        Snoozed → {new Date(task.snoozedUntil).toLocaleDateString("en-GB")}
                      </div>
                    )}
                    {task.isResolved && task.resolvedAt && (
                      <div style={{ fontSize: "11px", color: "#2e7d32", marginTop: "2px" }}>
                        Resolved {new Date(task.resolvedAt).toLocaleDateString("en-GB")}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const taskAlert = (() => { try { return JSON.parse(selectedTask.alertDataJSON || "{}"); } catch(e) { return {}; } })();
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  return (
    <div style={styles.container}>
      <button className="triage-btn" onClick={() => setSelectedTask(null)} style={{ ...styles.buttonSecondary, marginBottom: "16px" }}>
        ← Back to Tasks
      </button>

      {taskActionError && <div style={styles.errorBanner}>{taskActionError}</div>}

      <div style={{ ...styles.card, borderLeft: "4px solid #7c3aed", paddingTop: "16px", paddingBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "16px", fontWeight: "700", color: "#1a1a1a", marginBottom: "4px" }}>
              {selectedTask.clientName}
              <span style={{ marginLeft: "8px", fontSize: "12px", fontWeight: "600", background: "#f0f4ff", color: "#0066cc", padding: "2px 8px", borderRadius: "10px" }}>
                {formatAlertType(selectedTask.alertType)}
              </span>
            </div>
            <div style={{ fontSize: "13px", color: "#555", marginBottom: "4px" }}>{selectedTask.alertSummary}</div>
            <div style={{ fontSize: "12px", color: "#888" }}>
              Created: {selectedTask.taskCreatedAt ? new Date(selectedTask.taskCreatedAt).toLocaleString("en-GB") : "—"}
              {selectedTask.isSnoozed && <span style={{ color: "#d97706", marginLeft: "8px" }}>· Snoozed until {new Date(selectedTask.snoozedUntil).toLocaleString("en-GB")}</span>}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
            {(() => {
              const clientSheetId = taskAlert.clientId || allClientsMap[selectedTask.clientName]?.clientSheetId;
              const masterSheetId = taskAlert.masterSheetId || allClientsMap[selectedTask.clientName]?.masterSheetId;
              if (!clientSheetId && !masterSheetId) return null;
              return (
                <button className="triage-btn"
                  onClick={() => {
                    if (clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientSheetId}/edit`, "_blank");
                    if (masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${masterSheetId}/edit`, "_blank");
                  }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
                  📊 Open Sheets
                </button>
              );
            })()}
            {!selectedTask.isResolved && (
              <>
                <button className="triage-btn"
                  onClick={() => handleRevertTaskToAlert(selectedTask.fingerprintHash)}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#d97706", borderColor: "#fcd34d" }}>
                  ↩ Revert to Alert
                </button>
                <button className="triage-btn"
                  onClick={() => resolveTask(selectedTask.fingerprintHash)}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#16a34a", borderColor: "#86efac" }}>
                  ✓ Resolve Task
                </button>
              </>
            )}
          </div>
        </div>

        {selectedTask.taskNote && (
          <div style={{ marginTop: "12px", padding: "10px 12px", background: "#f3e8ff", borderRadius: "6px", fontSize: "13px", color: "#4c1d95" }}>
            <strong>Note:</strong> {selectedTask.taskNote}
          </div>
        )}

        {selectedTask.furtherNotes?.length > 0 && (
          <div style={{ marginTop: "12px" }}>
            <div style={{ fontSize: "12px", fontWeight: "600", color: "#888", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Notes Log</div>
            {selectedTask.furtherNotes.map((n, i) => (
              <div key={i} style={{ padding: "8px 12px", background: n.system ? "#f0f9ff" : "#fafafa", borderLeft: `3px solid ${n.system ? "#3b82f6" : "#7c3aed"}`, marginBottom: "6px", borderRadius: "0 4px 4px 0" }}>
                <div style={{ fontSize: "12px", color: "#888", marginBottom: "2px" }}>
                  {new Date(n.timestamp).toLocaleString("en-GB")}{n.system ? " · System" : ""}
                </div>
                <div style={{ fontSize: "13px", color: "#333" }}>{n.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {taskAlert.summary && (
        <div style={{ ...styles.alertSummary, marginBottom: "16px" }}>
          <div style={{ fontWeight: "700", fontSize: "13px", marginBottom: "8px", color: "#b45309" }}>ALERT DETAILS</div>
          {taskAlert.summary.invoiceNo && <div style={{ fontSize: "13px" }}><strong>Invoice:</strong> {taskAlert.summary.invoiceNo}</div>}
          {taskAlert.summary.amount && <div style={{ fontSize: "13px" }}><strong>Amount:</strong> £{parseFloat(taskAlert.summary.amount || 0).toFixed(2)}{taskAlert.summary.vatIncluded > 0 ? " +VAT" : ""}</div>}
          {taskAlert.summary.client && <div style={{ fontSize: "13px" }}><strong>Client:</strong> {taskAlert.summary.client}</div>}
          {taskAlert.summary.sentDate && <div style={{ fontSize: "13px" }}><strong>Sent:</strong> {taskAlert.summary.sentDate}</div>}
          {taskAlert.summary.status && <div style={{ fontSize: "13px" }}><strong>Status:</strong> {taskAlert.summary.status}</div>}
          {taskAlert.heading && <div style={{ fontSize: "13px" }}><strong>Alert:</strong> {taskAlert.heading}</div>}
          {taskAlert.detail && <div style={{ fontSize: "13px", marginTop: "4px", color: "#555" }}>{taskAlert.detail}</div>}
        </div>
      )}
      {!taskAlert.summary && taskAlert.heading && (
        <div style={{ ...styles.alertSummary, marginBottom: "16px" }}>
          <div style={{ fontWeight: "700", fontSize: "13px", marginBottom: "8px", color: "#b45309" }}>ALERT DETAILS</div>
          <div style={{ fontSize: "13px", fontWeight: "600", marginBottom: "4px" }}>{taskAlert.heading}</div>
          {taskAlert.detail && <div style={{ fontSize: "13px", color: "#555", marginTop: "4px" }}>{taskAlert.detail}</div>}
        </div>
      )}

      {["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete", "retainerInvoicesCreated", "retainerInvoicesDeleted", "invoiceStaleUnsentChanges", "expenseAdded", "expenseUnreconGaps"].includes(selectedTask.alertType) && (
        <div style={{ ...styles.card, marginBottom: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: "600", color: "#1a1a1a" }}>Live Verification</div>
            <button className="triage-btn" onClick={() => handleAnalyzeTask(selectedTask)} disabled={taskDetailAnalyzing} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px" }}>
              {taskDetailAnalyzing ? <><Spinner size={12} />Analysing...</> : "↻ Re-run Analysis"}
            </button>
          </div>
          
          {selectedTask.analysisResult ? (() => {
            const analysis = selectedTask.analysisResult;
            const overallOk = analysis.overallOk;
            return (
              <div>
                <div style={{
                  padding: "6px 10px", borderRadius: "4px", marginBottom: "8px", fontSize: "12px", fontWeight: "600",
                  background: overallOk ? "#e8f5e9" : "#fbe9e7", color: overallOk ? "#2e7d32" : "#bf360c",
                }}>
                  {overallOk ? "✓ Everything looks correct" : "⚠ Issues found — review below"}
                </div>
                {(analysis.results || []).map((r, ri) => (
                  <div key={ri} style={{
                    marginBottom: "8px", padding: "8px 10px", borderRadius: "4px",
                    border: `1px solid ${r.status === "ok" ? "#c8e6c9" : r.status === "issue" ? "#ffccbc" : "#e0e0e0"}`,
                    background: r.status === "ok" ? "#f9fef9" : r.status === "issue" ? "#fff8f6" : "#fafafa",
                  }}>
                    {r.message && <div style={{ fontSize: "12px", color: "#333", fontWeight: "600", marginBottom: "4px" }}>{r.message}</div>}
                    {(r.checks || []).map((chk, ci) => (
                      <div key={ci} style={{ fontSize: "12px", color: chk.ok ? "#2e7d32" : "#c62828", marginTop: "2px" }}>
                        {(() => {
                          const parts = [];
                          const re = /\(([^)]{17,})\)/g;
                          let last = 0, m;
                          const msg = chk.message || "";
                          while ((m = re.exec(msg)) !== null) {
                            if (m.index > last) parts.push(msg.slice(last, m.index));
                            parts.push(<TruncatedCode key={m.index} code={m[1]} />);
                            last = m.index + m[0].length;
                          }
                          if (last < msg.length) parts.push(msg.slice(last));
                          return parts.length > 1 ? parts : msg;
                        })()}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })() : (
            <div style={{ fontSize: "13px", color: "#666" }}>Click to verify if the underlying issue has been resolved in the live sheet.</div>
          )}
        </div>
      )}

      {!selectedTask.isProactive && (
      <div style={{ ...styles.card, marginBottom: "16px" }}>
        <div style={{ fontSize: "15px", fontWeight: "700", color: "#1a1a1a", marginBottom: "12px" }}>Potential Actions</div>
        {taskDetailAnalyzing && (
          <div style={{ textAlign: "center", padding: "20px", color: "#666" }}><Spinner size={18} color="#0066cc" /> Re-analysing alert...</div>
        )}
        {!taskDetailAnalyzing && taskDetailOptions.length === 0 && (
          <div style={{ color: "#888", fontSize: "13px" }}>No options available — the alert may have been resolved already.</div>
        )}
        {taskDetailOptions.map((option, idx) => (
          <div key={idx} style={{ ...styles.optionCard, marginBottom: "12px" }}>
            <div style={styles.optionTitle}>Option {idx + 1}: {option.title}</div>
            {option.matchType !== "info" && option.explanation && (
              <div style={{ padding: "8px 10px", background: "#fff8e1", borderLeft: "3px solid #f59e0b", fontSize: "13px", marginBottom: "8px", borderRadius: "0 4px 4px 0" }}>
                {option.explanation}
              </div>
            )}
            {option.facts && (
              <ul style={{ margin: "0 0 8px 0", paddingLeft: "18px", fontSize: "13px", color: "#333" }}>
                {option.facts.jobType && <li><strong>Type:</strong> {option.facts.jobType}</li>}
                {option.facts.totalRevenue && <li><strong>Revenue:</strong> £{option.facts.totalRevenue?.toLocaleString?.() || option.facts.totalRevenue}</li>}
                {option.facts.invoiceMatchStatus && <li><strong>{option.facts.invoiceMatchStatus}</strong></li>}
              </ul>
            )}
            {option.recommendedActions?.length > 0 && (
              <div style={{ fontSize: "13px", marginBottom: "8px" }}>
                <strong>Actions:</strong>
                {option.recommendedActions.map((a, i) => (
                  <div key={i} style={{ marginTop: "3px" }}>{i === 0 ? <strong style={{ color: "#059669" }}>✓ {a}</strong> : `• ${a}`}</div>
                ))}
              </div>
            )}
            {option.matchType !== "info" && (
              <button className="triage-btn triage-btn-primary"
                onClick={() => acceptTaskOption(option)}
                disabled={isAccepting}
                style={{ ...styles.decisionButton, ...styles.approveButton, width: "100%", marginTop: "4px" }}>
                {isAccepting ? <><Spinner />Applying...</> : `✓ Accept Option ${idx + 1}`}
              </button>
            )}
            {option.matchType === "info" && (
              <button className="triage-btn triage-btn-primary"
                onClick={() => resolveTask(selectedTask.fingerprintHash)}
                style={{ ...styles.decisionButton, ...styles.approveButton, width: "100%", marginTop: "4px" }}>
                ✓ Mark as Resolved
              </button>
            )}
          </div>
        ))}
      </div>
      )}

      <div style={{ ...styles.card, marginBottom: "16px" }}>
        <div style={{ fontSize: "14px", fontWeight: "600", color: "#1a1a1a", marginBottom: "10px" }}>Add Note</div>
        <textarea
          value={taskNoteInput}
          onChange={e => setTaskNoteInput(e.target.value)}
          placeholder="Add a note to the task log..."
          style={{ ...styles.modalTextarea, minHeight: "60px" }}
        />
        <button className="triage-btn"
          onClick={submitTaskNote}
          disabled={taskNoteSubmitting || !taskNoteInput.trim()}
          style={{ ...styles.buttonSecondary, marginTop: "8px", opacity: !taskNoteInput.trim() ? 0.5 : 1 }}>
          {taskNoteSubmitting ? <><Spinner />Adding...</> : "Add Note"}
        </button>
      </div>

      {!selectedTask.isResolved && (
        <div style={{ ...styles.card, marginBottom: "16px" }}>
          <div style={{ fontSize: "14px", fontWeight: "600", color: "#1a1a1a", marginBottom: "10px" }}>
            {selectedTask.isSnoozed ? "Update Snooze" : "Snooze Task"}
          </div>
          {selectedTask.isSnoozed && (
            <div style={{ fontSize: "13px", color: "#d97706", marginBottom: "8px" }}>
              Currently snoozed until {new Date(selectedTask.snoozedUntil).toLocaleString("en-GB")}
              <button className="triage-btn" onClick={async () => {
                await fetch("/api/triage", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "snooze_task", fingerprintHash: selectedTask.fingerprintHash, unsnooze: true, automationCommanderSheetId }),
                });
                setSelectedTask(prev => ({ ...prev, isSnoozed: false, snoozedUntil: "" }));
                setTasks(prev => prev.map(t => t.fingerprintHash === selectedTask.fingerprintHash ? { ...t, isSnoozed: false, snoozedUntil: "" } : t));
              }} style={{ ...styles.linkButton, marginLeft: "10px", fontSize: "12px" }}>
                Unsnooze
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "3px" }}>Date</label>
              <input type="date" min={todayStr} value={taskSnoozeDate} onChange={e => setTaskSnoozeDate(e.target.value)}
                style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "6px 10px", fontSize: "13px" }} />
            </div>
            <div>
              <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "3px" }}>Time</label>
              <input type="time" value={taskSnoozeTime} onChange={e => setTaskSnoozeTime(e.target.value)}
                style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "6px 10px", fontSize: "13px" }} />
            </div>
            <button className="triage-btn"
              onClick={submitSnoozeTask}
              disabled={taskSnoozeSubmitting || !taskSnoozeDate}
              style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#fbbf24", alignSelf: "flex-end", opacity: !taskSnoozeDate ? 0.5 : 1 }}>
              {taskSnoozeSubmitting ? <><Spinner />Snoozing...</> : "⏰ Snooze"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}