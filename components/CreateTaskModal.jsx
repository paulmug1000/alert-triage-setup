import React from "react";
import Spinner from "./Spinner";
import { useTasks } from "../contexts/TaskContext";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { getAlertSummary } from "../utils/helpers";
import { styles } from "../utils/styles";

export default function CreateTaskModal() {
  const {
    navTaskCount, setNavTaskCount, snoozedTaskCount, setSnoozedTaskCount,
    showTaskModal, setShowTaskModal, taskModalAlert,
    taskModalIsProactive, taskModalNote, setTaskModalNote,
    taskModalSnoozeDate, setTaskModalSnoozeDate, taskModalSnoozeTime, setTaskModalSnoozeTime,
    taskModalSubmitting, setTaskModalSubmitting, taskActionError, setTaskActionError
  } = useTasks();

  const {
    sessionId, selectedClient, clientAlerts, setClientAlerts, setProcessedAlerts,
    setClientsWithFlags, allNoActionResolved, resolvedNoActionFlags, setScreen,
    handlePostClear, setProactiveAlerts, setProactiveCountsByClient, clientNoActionAlerts
  } = useTriage();

  const { automationCommanderSheetId } = useAppGlobals();

  if (!showTaskModal) return null;

  const submitCreateTask = async () => {
    if (!taskModalAlert) return;
    try {
      setTaskModalSubmitting(true);
      setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_task", alert: taskModalAlert, taskNote: taskModalNote, automationCommanderSheetId,
          isProactive: taskModalIsProactive, proactiveAlertKey: taskModalIsProactive ? taskModalAlert.alertKey : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) { setTaskActionError(data.error || "Failed to create task"); return; }

      if (taskModalSnoozeDate && data.fingerprintHash) {
        const localDt = new Date(`${taskModalSnoozeDate}T${taskModalSnoozeTime}:00`);
        await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "snooze_task", fingerprintHash: data.fingerprintHash, snoozedUntil: localDt.toISOString(), automationCommanderSheetId }),
        }).catch(() => {});
      }

      setShowTaskModal(false); setTaskModalNote(""); setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("07:00");
      if (!taskModalSnoozeDate) setNavTaskCount(prev => prev + 1); else setSnoozedTaskCount(prev => prev + 1);

      if (!taskModalIsProactive) {
        const alertId = `${taskModalAlert.sheetName}-${taskModalAlert.rowNumber}`;
        const uniqueId = taskModalAlert.fingerprintHash || `${taskModalAlert.flagType || taskModalAlert.type}-${alertId}`;
        setProcessedAlerts(prev => new Set([...prev, uniqueId]));
        if (sessionId) {
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove_alert", sessionId, alertId }) }).catch(() => {});
        }
        const updatedAlerts = clientAlerts.filter(a => (a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`) !== uniqueId);
        setClientAlerts(updatedAlerts);
        let ft = taskModalAlert.flagType || taskModalAlert.alertType || taskModalAlert.type || "";
        if (ft === "invoice") ft = "invoiceDashboardDiscr"; if (ft === "expense") ft = "expenseDashboardDiscr"; if (ft === "crm") ft = "crmPipeAppDiscr";
        
        setClientsWithFlags(prev => prev.map(c => {
          if (c.clientName !== selectedClient?.clientName) return c;
          const updatedCounts = { ...c.alertCounts };
          if (updatedCounts[ft] > 0) updatedCounts[ft]--;
          return { ...c, alertCounts: updatedCounts };
        }));
        if (updatedAlerts.length === 0) {
          if (allNoActionResolved()) handlePostClear([], resolvedNoActionFlags); else setScreen("alertSelection");
        } else setScreen("alertSelection");
      } else {
        if (sessionId) fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove_alert", sessionId, alertId: taskModalAlert.alertKey }) }).catch(() => {});
        let remainingProactiveCount = 0;
        setProactiveAlerts(prev => {
          const remaining = (taskModalAlert.rowIndex != null) ? prev.filter(a => a.rowIndex !== taskModalAlert.rowIndex) : prev.filter(a => a.alertKey !== taskModalAlert.alertKey);
          const counts = {};
          remaining.forEach(a => { const cName = a.clientName || a.metadata?.endClientName || a.metadata?.clientName; if (cName) counts[cName] = (counts[cName] || 0) + 1; });
          setProactiveCountsByClient(counts);
          remainingProactiveCount = remaining.filter(a => a.clientName === selectedClient?.clientName).length;
          return remaining;
        });
        const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`));
        if (clientAlerts.length === 0 && infoDone && remainingProactiveCount === 0) handlePostClear([], resolvedNoActionFlags); else setScreen("alertSelection");
      }
    } catch (e) { setTaskActionError(e.message); } finally { setTaskModalSubmitting(false); }
  };

  return (
    <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) { setShowTaskModal(false); setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("07:00"); } }}>
      <div style={styles.modalCard}>
        <h3 style={styles.modalTitle}>Create Task</h3>
        <p style={styles.modalSubtitle}>
          This alert will be marked as resolved and added to your task list for follow-up.
          {taskModalIsProactive ? " (Proactive alert)" : ""}
        </p>
        {taskModalAlert && (
          <div style={{ fontSize: "13px", color: "#555", marginBottom: "12px", padding: "8px 10px", background: "#f5f5f5", borderRadius: "4px" }}>
            <strong>{taskModalAlert.clientName}</strong>
            {taskModalIsProactive
              ? ` · ${taskModalAlert.heading || taskModalAlert.alertType || "Proactive alert"}`
              : ` · ${getAlertSummary(taskModalAlert)}`}
          </div>
        )}
        <textarea value={taskModalNote} onChange={e => setTaskModalNote(e.target.value)}
          placeholder="Add a note for this task (optional)..." style={styles.modalTextarea} autoFocus />

        <div style={{ marginTop: "12px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#444", marginBottom: "8px" }}>
            Snooze until (optional)
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="date"
              value={taskModalSnoozeDate}
              min={new Date().toISOString().split("T")[0]}
              onChange={e => setTaskModalSnoozeDate(e.target.value)}
              style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", color: taskModalSnoozeDate ? "#333" : "#999" }}
            />
            {taskModalSnoozeDate && (
              <>
                <input
                  type="time"
                  value={taskModalSnoozeTime}
                  onChange={e => setTaskModalSnoozeTime(e.target.value)}
                  style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", width: "100px" }}
                />
                <button className="triage-btn" onClick={() => { setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("07:00"); }}
                  style={{ fontSize: "12px", padding: "5px 8px", color: "#888", borderColor: "#ddd" }}>
                  ✕ Clear
                </button>
              </>
            )}
          </div>
          {taskModalSnoozeDate && (
            <div style={{ fontSize: "12px", color: "#d97706", marginTop: "6px" }}>
              Task will be created and immediately snoozed until {new Date(`${taskModalSnoozeDate}T${taskModalSnoozeTime}:00`).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
            </div>
          )}
        </div>

        {taskActionError && <div style={{ ...styles.errorBanner, marginTop: "8px" }}>{taskActionError}</div>}
        <div style={styles.modalButtons}>
          <button className="triage-btn" onClick={() => { setShowTaskModal(false); setTaskModalNote(""); setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("07:00"); setTaskActionError(""); }} style={styles.buttonSecondary}>Cancel</button>
          <button className="triage-btn" onClick={submitCreateTask} disabled={taskModalSubmitting}
            style={{ background: taskModalSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer", opacity: taskModalSubmitting ? 0.5 : 1 }}>
            {taskModalSubmitting ? <><Spinner />Creating...</> : taskModalSnoozeDate ? "📋 Create & Snooze" : "📋 Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}