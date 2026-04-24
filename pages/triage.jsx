import React, { useState, useEffect } from "react";

// Helper function defined OUTSIDE component to prevent re-creation on each render
function getAlertSummary(alert) {
  if (alert.type === "invoice" || alert.flagType === "invoiceDashboardDiscr") {
    const inv = alert.summary;
    const vatLabel = inv?.vatIncluded && inv.vatIncluded > 0 ? " +VAT" : " (no VAT)";
    return `Invoice #${inv?.invoiceNo || inv?.reference || "?"} - £${inv?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "expense" || alert.flagType === "expenseDashboardDiscr") {
    const exp = alert.summary;
    const vat = parseFloat(String(exp?.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
    const vatLabel = vat > 0 ? " +VAT" : " (no VAT)";
    return `${exp?.description || "Expense"} - £${exp?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "crm" || alert.flagType?.includes("crm")) {
    const crm = alert.data;
    const flagType = alert.alertType || alert.flagType || "";

    const isAppDiscr  = flagType === "crmConfAppDiscr" || flagType === "crmPipeAppDiscr";
    const isDashDiscr = flagType === "crmPipeDashDiscr" || flagType === "crmConfDashDiscr";
    const src = isAppDiscr ? crm?.sheetData : crm?.crmData;
    // appDiscr sheetData: [0]=client, [1]=job, [2]=code
    // dashDiscr crmData:  [0]=client, [1]=job, [2]=code
    const client = src?.[0] || "";
    const job    = src?.[1] || "";
    const code   = src?.[2] || "";
    const base   = `${client}${job ? " — " + job : ""}${code ? " (" + code + ")" : ""}` || "CRM alert";
    if (isDashDiscr && alert.subType === "field_mismatch" && alert.mismatchFields?.length) {
      return `${base} — ⚠ ${alert.mismatchFields.join(", ")} mismatch`;
    }
    return base;
  }
  return "Alert";
}

// Inline spinner SVG — shown inside buttons during async operations
function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24" fill="none"
      style={{ display: "inline-block", verticalAlign: "middle", marginRight: "6px", animation: "triage-spin 0.7s linear infinite" }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Renders a project code inline. Codes longer than `maxLen` chars are truncated with "..."
// and can be tapped/clicked to expand. Keeps the job header line from breaking on mobile.
const TRUNCATED_CODE_MAX = 16;
function TruncatedCode({ code }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!code) return null;
  const isLong = code.length > TRUNCATED_CODE_MAX;
  const display = isLong && !expanded ? code.slice(0, TRUNCATED_CODE_MAX) + "…" : code;
  return (
    <span
      style={{ fontWeight: "400", color: "#888", marginLeft: "6px", wordBreak: "break-all",
               cursor: isLong ? "pointer" : "default" }}
      title={isLong && !expanded ? code : undefined}
      onClick={isLong ? (e) => { e.stopPropagation(); setExpanded(v => !v); } : undefined}
    >
      ({display}{isLong && (
        <span style={{ color: "#aaa", fontSize: "10px", marginLeft: "3px" }}>
          {expanded ? "▲" : "▼"}
        </span>
      )})
    </span>
  );
}

// Global styles injected once — handles :hover/:active which React inline styles can't do
const GLOBAL_STYLES = `
  html, body { margin: 0; padding: 0; scroll-behavior: auto; }
  @keyframes triage-spin { to { transform: rotate(360deg); } }
  .triage-btn { transition: filter 0.15s, transform 0.1s, background 0.15s, box-shadow 0.15s !important; }
  .triage-btn:hover:not(:disabled) { filter: brightness(0.92); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
  .triage-btn:active:not(:disabled) { transform: scale(0.97); filter: brightness(0.85); }
  .triage-btn:disabled { cursor: not-allowed !important; opacity: 0.55 !important; }
  .triage-btn-primary:hover:not(:disabled) { background: #0055aa !important; }
  .triage-client-card { transition: background 0.12s, border-color 0.12s, box-shadow 0.12s !important; }
  .triage-client-card:hover { background: #f0f4ff !important; border-color: #2196f3 !important; box-shadow: 0 2px 8px rgba(33,150,243,0.15) !important; }
  .triage-client-card:active { background: #e3ecff !important; transform: scale(0.995); }
  .pulse-nav-item { transition: color 0.15s, border-color 0.15s !important; }
  .pulse-nav-item:hover { color: #0066cc !important; }
`;

// Persistent top bar — rendered around every screen
function NavShell({ activeNav, onHome, onOverview, onTasks, homeAlertCount, taskCount, children }) {
  const Badge = ({ count }) => count > 0 ? (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "#e53e3e", color: "#fff", borderRadius: "10px",
      fontSize: "10px", fontWeight: "700", minWidth: "17px", height: "17px",
      padding: "0 5px", marginLeft: "5px", lineHeight: "1", verticalAlign: "middle",
    }}>{count > 99 ? "99+" : count}</span>
  ) : null;

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      {/* Top identity bar */}
      <div style={{ background: "#1a1a2e", color: "#fff", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "15px", fontWeight: "700", letterSpacing: "0.3px" }}>Pulse Triage System</span>
      </div>
      {/* Nav bar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e0e0e0", padding: "0 20px", display: "flex", gap: "4px" }}>
        <button
          className="triage-btn pulse-nav-item"
          onClick={onHome}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "12px 16px",
            fontSize: "14px", fontWeight: activeNav === "home" ? "600" : "400",
            color: activeNav === "home" ? "#0066cc" : "#444",
            borderBottom: activeNav === "home" ? "2px solid #0066cc" : "2px solid transparent",
            borderRadius: "0", display: "flex", alignItems: "center",
          }}
        >Home<Badge count={homeAlertCount} /></button>
        <button
          className="triage-btn pulse-nav-item"
          onClick={onOverview}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "12px 16px",
            fontSize: "14px", fontWeight: activeNav === "overview" ? "600" : "400",
            color: activeNav === "overview" ? "#0066cc" : "#444",
            borderBottom: activeNav === "overview" ? "2px solid #0066cc" : "2px solid transparent",
            borderRadius: "0",
          }}
        >Overview</button>
        <button
          className="triage-btn pulse-nav-item"
          onClick={onTasks}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "12px 16px",
            fontSize: "14px", fontWeight: activeNav === "tasks" ? "600" : "400",
            color: activeNav === "tasks" ? "#0066cc" : "#444",
            borderBottom: activeNav === "tasks" ? "2px solid #0066cc" : "2px solid transparent",
            borderRadius: "0", display: "flex", alignItems: "center",
          }}
        >Tasks<Badge count={taskCount} /></button>
      </div>
      {/* Page content */}
      <div>{children}</div>
    </div>
  );
}

// Overview table cell showing run time and feedback metrics
function FeedbackCell({ seq }) {
  if (!seq) return <td style={{ padding: "8px 12px", color: "#bbb", fontSize: "12px" }}>—</td>;
  const { lastRunTime, feedback } = seq;
  const isOk = feedback?.outcome?.toUpperCase() === "OK";
  const outcomeColor = isOk ? "#2e7d32" : "#c62828";
  return (
    <td style={{ padding: "8px 12px", verticalAlign: "top", minWidth: "140px" }}>
      {lastRunTime && (
        <div style={{ fontSize: "12px", color: "#555", marginBottom: "3px", fontWeight: "500" }}>
          {lastRunTime}
        </div>
      )}
      {feedback && (
        feedback.raw ? (
          <div style={{ fontSize: "11px", color: "#666" }}>{feedback.raw}</div>
        ) : (
          <div style={{ fontSize: "11px", lineHeight: "1.6" }}>
            <span style={{ color: "#555" }}>Last: {feedback.last ?? "—"}</span>
            <span style={{ color: "#555", margin: "0 6px" }}>Day: {feedback.day ?? "—"}</span>
            <span style={{ color: "#555" }}>Week: {feedback.week ?? "—"}</span>
            <span style={{ color: outcomeColor, fontWeight: "600", marginLeft: "6px" }}>| {feedback.outcome}</span>
          </div>
        )
      )}
    </td>
  );
}

export default function TriageSystem({ onBack }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const [automationCommanderSheetId] = useState(AUTOMATION_COMMANDER_SHEET_ID);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [totalAlerts, setTotalAlerts] = useState(0);
  const [noActionCount, setNoActionCount] = useState(0);
  const [showNoAction, setShowNoAction] = useState(false);
  const [acknowledgedNoAction, setAcknowledgedNoAction] = useState(new Set());
  const [triageComplete, setTriageComplete] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [currentAlertIndex, setCurrentAlertIndex] = useState(0);
  const [claudeAnalysis, setClaudeAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [userDecision, setUserDecision] = useState(null);
  
  // NEW: Client selection states
  const [screen, setScreen] = useState("initial"); // initial | clientSelection | alertSelection | triageAnalysis | ignoredAlerts
  // Scroll to top on every screen transition
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);
  const [clientsWithFlags, setClientsWithFlags] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientAlerts, setClientAlerts] = useState([]);
  const [currentClientAlertIndex, setCurrentClientAlertIndex] = useState(0);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");
  const [processedAlerts, setProcessedAlerts] = useState(new Set());

  // AlertMemory: ignore modal + ignored alerts screen
  const [showIgnoreModal, setShowIgnoreModal] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState("");
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [selectingClient, setSelectingClient] = useState(null); // clientName being loaded
  const [previousIgnoreReason, setPreviousIgnoreReason] = useState("");
  const [proactiveAlerts, setProactiveAlerts] = useState([]);
  const [proactiveCountsByClient, setProactiveCountsByClient] = useState({});
  const [proactiveLoading, setProactiveLoading] = useState(false);
  const [proactiveLoadedAt, setProactiveLoadedAt] = useState(0); // epoch ms of last load
  const [proactiveSelectedClient, setProactiveSelectedClient] = useState(null);
  const [overviewData, setOverviewData] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [activeNav, setActiveNav] = useState("home"); // "home" | "overview" | "tasks"
  const [navTaskCount, setNavTaskCount] = useState(0); // active task count for badge
  const [allClientsMap, setAllClientsMap] = useState({}); // {clientName: {clientSheetId, masterSheetId}} — always populated
  const [tasksLoadedAt, setTasksLoadedAt] = useState(0); // epoch ms of last task load
  const [snoozedTaskCount, setSnoozedTaskCount] = useState(0); // snoozed task count for badge

  // ── Tasks state ───────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksFilter, setTasksFilter] = useState("active"); // "active" | "snoozed" | "resolved"
  const [selectedTask, setSelectedTask] = useState(null); // task object when viewing detail
  const [taskDetailOptions, setTaskDetailOptions] = useState([]); // parsed options for selected task
  const [taskDetailAnalyzing, setTaskDetailAnalyzing] = useState(false);
  const [taskNoteInput, setTaskNoteInput] = useState("");
  const [taskNoteSubmitting, setTaskNoteSubmitting] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false); // "create task" modal
  const [taskModalNote, setTaskModalNote] = useState("");
  const [taskModalSubmitting, setTaskModalSubmitting] = useState(false);
  const [taskModalAlert, setTaskModalAlert] = useState(null); // alert being turned into task
  const [taskModalIsProactive, setTaskModalIsProactive] = useState(false);
  const [taskModalSnoozeDate, setTaskModalSnoozeDate] = useState(""); // optional: create as snoozed
  const [taskModalSnoozeTime, setTaskModalSnoozeTime] = useState("09:00");

  // Bulk action state
  const [bulkMode, setBulkMode]                 = useState(false);       // bulk selection active
  const [bulkSelected, setBulkSelected]         = useState(new Set());   // Set of "type|||idx" keys
  const [showBulkIgnoreModal, setShowBulkIgnoreModal] = useState(false);
  const [showBulkTaskModal, setShowBulkTaskModal]     = useState(false);
  const [bulkIgnoreReason, setBulkIgnoreReason] = useState("");
  const [bulkTaskNote, setBulkTaskNote]         = useState("");
  const [bulkTaskSnoozeDate, setBulkTaskSnoozeDate] = useState("");
  const [bulkTaskSnoozeTime, setBulkTaskSnoozeTime] = useState("09:00");
  const [bulkSubmitting, setBulkSubmitting]     = useState(false);
  const [taskSnoozeDate, setTaskSnoozeDate] = useState(""); // ISO date string for snooze
  const [taskSnoozeTime, setTaskSnoozeTime] = useState("09:00");
  const [taskSnoozeSubmitting, setTaskSnoozeSubmitting] = useState(false);
  const [taskActionError, setTaskActionError] = useState("");
  const [existingTaskBanner, setExistingTaskBanner] = useState(null); // {task, dataChanged}
  const [existingTaskChecking, setExistingTaskChecking] = useState(false);

  // Nav handlers — defined early so they're available throughout the render
  const handleNavHome = () => { setActiveNav("home"); };
  const handleNavOverview = () => { setActiveNav("overview"); loadOverview(); };
  const handleNavTasks = () => { setActiveNav("tasks"); setTasksFilter("active"); loadTasks("active", true); };

  // ── Task handlers ─────────────────────────────────────────────────────────

  const loadTasks = async (filter = "active", bypassCache = false) => {
    try {
      setTasksLoading(true);
      setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId, filter, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setTasks(data.tasks || []);
        setTasksLoadedAt(Date.now());
      } else setTaskActionError(data.error || "Failed to load tasks");
      // Keep nav badge in sync whenever active tasks are loaded
      if (filter === "active" && data.success) {
        setNavTaskCount(data.tasks?.length || 0);
        // Also refresh snoozed count in background
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId, filter: "snoozed", bypassCache }),
        }).then(r => r.json()).then(d => { if (d.success) setSnoozedTaskCount(d.tasks?.length || 0); }).catch(() => {});
      }
      if (filter === "snoozed" && data.success) setSnoozedTaskCount(data.tasks?.length || 0);
    } catch (e) {
      setTaskActionError(e.message);
    } finally {
      setTasksLoading(false);
    }
  };

  // Open the "Create task" modal for an alert (automation or proactive)
  const openCreateTaskModal = (alert, isProactive = false) => {
    setTaskModalAlert(alert);
    setTaskModalIsProactive(isProactive);
    setTaskModalNote("");
    setShowTaskModal(true);
    setTaskActionError("");
  };

  const submitCreateTask = async () => {
    if (!taskModalAlert) return;
    try {
      setTaskModalSubmitting(true);
      setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_task",
          alert: taskModalAlert,
          taskNote: taskModalNote,
          automationCommanderSheetId,
          isProactive: taskModalIsProactive,
          proactiveAlertKey: taskModalIsProactive ? taskModalAlert.alertKey : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setTaskActionError(data.error || "Failed to create task");
        return;
      }

      // If the user set a snooze date, immediately snooze the newly created task
      if (taskModalSnoozeDate && data.fingerprintHash) {
        const localDt = new Date(`${taskModalSnoozeDate}T${taskModalSnoozeTime}:00`);
        const snoozedUntil = localDt.toISOString();
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "snooze_task",
            fingerprintHash: data.fingerprintHash,
            snoozedUntil,
            automationCommanderSheetId,
          }),
        }).catch(() => {}); // best-effort — task already created, snooze failure is non-critical
      }

      setShowTaskModal(false);
      setTaskModalNote("");
      setTaskModalSnoozeDate("");
      setTaskModalSnoozeTime("09:00");
      // Only increment active task badge if the task is NOT being immediately snoozed
      if (!taskModalSnoozeDate) {
        setNavTaskCount(prev => prev + 1);
      } else {
        setSnoozedTaskCount(prev => prev + 1);
      }

      // Remove alert from active list (same as ignore/accept)
      if (!taskModalIsProactive) {
        const alert = taskModalAlert;
        const alertId = `${alert.sheetName}-${alert.rowNumber}`;
        setProcessedAlerts(prev => new Set([...prev, alertId]));
        if (sessionId) {
          fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
          }).catch(() => {});
        }
        const updatedAlerts = clientAlerts.filter(a => `${a.sheetName}-${a.rowNumber}` !== alertId);
        setClientAlerts(updatedAlerts);
        const taskFlagType = alert.flagType || alert.type || "";
        setClientsWithFlags(prev => prev.map(c => {
          if (c.clientName !== selectedClient?.clientName) return c;
          const updatedCounts = { ...c.alertCounts };
          if (updatedCounts[taskFlagType] > 0) updatedCounts[taskFlagType]--;
          return { ...c, alertCounts: updatedCounts };
        }));
        if (updatedAlerts.length === 0) {
          if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
          else setScreen("alertSelection");
        } else {
          setScreen("alertSelection");
        }
      } else {
        // Proactive: remove from proactive list — use rowIndex (unique) not alertKey
        setProactiveAlerts(prev => {
          const remaining = taskModalAlert.rowIndex
            ? prev.filter(a => a.rowIndex !== taskModalAlert.rowIndex)
            : prev.filter(a => a.alertKey !== taskModalAlert.alertKey);
          const counts = {};
          remaining.forEach(a => { counts[a.clientName] = (counts[a.clientName] || 0) + 1; });
          setProactiveCountsByClient(counts);
          return remaining;
        });
      }
    } catch (e) {
      setTaskActionError(e.message);
    } finally {
      setTaskModalSubmitting(false);
    }
  };

  // Open a task for detail view
  const openTask = async (task) => {
    setSelectedTask(task);
    setTaskDetailOptions([]);
    setTaskActionError("");
    setTaskNoteInput("");
    setTaskSnoozeDate("");
    setTaskSnoozeTime("09:00");

    // Parse cached options
    if (task.cachedOptionsJSON) {
      try {
        const opts = JSON.parse(task.cachedOptionsJSON);
        if (Array.isArray(opts) && opts.length > 0 && opts[0].title) {
          setTaskDetailOptions(opts);
          return;
        }
      } catch (e) {}
    }

    // If no cached options but we have alert data, re-analyze
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
    // Build ISO string with local timezone offset so Node.js interprets it correctly
    const localDt = new Date(`${taskSnoozeDate}T${taskSnoozeTime}:00`);
    const snoozedUntil = localDt.toISOString(); // always UTC ISO — consistent on both sides
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
        setTasks(prev => prev.filter(t => t.fingerprintHash !== fingerprintHash));
        if (selectedTask?.fingerprintHash === fingerprintHash) setSelectedTask(null);
        setNavTaskCount(prev => Math.max(0, prev - 1));
      } else setTaskActionError(data.error || "Failed to resolve task");
    } catch (e) { setTaskActionError(e.message); }
  };

  // Accept an option from within the task detail view
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
      // Mark task as resolved
      await resolveTask(selectedTask.fingerprintHash);
    } catch (e) { setTaskActionError(e.message); }
    finally { setIsAccepting(false); }
  };

  // Check if incoming alert has existing task (called from analyzeAlert)
  const checkExistingTask = async (alert) => {
    try {
      setExistingTaskChecking(true);
      setExistingTaskBanner(null);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_existing_task", alert, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success && data.found) setExistingTaskBanner(data.task);
    } catch (e) { /* silent */ }
    finally { setExistingTaskChecking(false); }
  };

  // Inject global button/interaction styles once on mount, and set page title/favicon
  useEffect(() => {
    window.scrollTo(0, 0);
    // Set title and favicon directly — reliable across all screen transitions
    document.title = "Triage System";
    let favicon = document.querySelector("link[rel~='icon']");
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }
    favicon.href = "https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png";

    const id = "triage-global-styles";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = GLOBAL_STYLES;
      document.head.appendChild(el);
    }
  }, []);
  const [ignoredAlerts, setIgnoredAlerts] = useState([]);
  const [isLoadingIgnored, setIsLoadingIgnored] = useState(false);
  const [isUnignoring, setIsUnignoring] = useState(null);
  const [fromCache, setFromCache] = useState(false);

  // Clear flags: which flag groups to clear
  const [flagsToClear, setFlagsToClear] = useState({ invoice: false, crm: false, expense: false });

  // Non-actionable flags for the selected client
  const [clientNoActionAlerts, setClientNoActionAlerts] = useState([]);
  const [resolvedNoActionFlags, setResolvedNoActionFlags] = useState(new Set());

  // Rich analysis for noaction flags (crmCopiedConfChecked, crmCopiedConfUnchecked, retainerInvoicesCreated)
  const [noActionAnalysis, setNoActionAnalysis] = useState({}); // keyed by flagType, for current client only
  const [noActionAnalysisLoading, setNoActionAnalysisLoading] = useState({}); // keyed by flagType
  const [precomputedNoActionResults, setPrecomputedNoActionResults] = useState({}); // keyed by "clientName___flagType", never wiped

  const fetchAndAnalyzeAlerts = async (sessionId) => {
    try {
      setIsAnalyzing(true);
      
      // Fetch alerts from Redis via API
      const response = await fetch(`/api/triage?action=get_alerts&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (!data.success || !data.alerts) {
        setError("Failed to load alerts");
        return;
      }
      
      console.log(`📋 Loaded ${data.alerts.length} alerts from Redis`);
      setAlerts(data.alerts);
      setCurrentAlertIndex(0);
      setAlertsLoaded(true);
      
      // Start analyzing the first alert
      if (data.alerts.length > 0) {
        await analyzeAlert(data.alerts[0]);
      }
    } catch (err) {
      setError(`Failed to load alerts: ${err.message}`);
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const analyzeAlert = async (alert) => {
    try {
      setIsAnalyzing(true);
      setClaudeAnalysis(""); setPreviousIgnoreReason("");
      
      console.log(`🔍 Generating options for alert:`, alert.flagType);
      
      // Call API to get matching options
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_alert",
          alert,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        setClaudeAnalysis("Error generating options: " + (data.error || "Unknown error"));
        return;
      }
      
      console.log(`✅ Options generated:`, data.options?.length || 0);
      setPreviousIgnoreReason(data.previousIgnoreReason || "");
      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
    } catch (err) {
      setClaudeAnalysis(`Error generating options: ${err.message}`);
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAlertDecision = async (decision) => {
    const alert = alerts[currentAlertIndex];
    
    console.log(`📝 Recording decision for alert: ${decision}`, alert);
    
    try {
      // TODO: Log decision to TriageLog sheet
      setUserDecision(decision);
      
      // Move to next alert
      if (currentAlertIndex < alerts.length - 1) {
        const nextAlert = alerts[currentAlertIndex + 1];
        setCurrentAlertIndex(currentAlertIndex + 1);
        setUserDecision(null);
        await analyzeAlert(nextAlert);
      } else {
        // All alerts processed
        setTriageComplete(true);
      }
    } catch (err) {
      setError(`Failed to record decision: ${err.message}`);
    }
  };

  // Manual refresh — skips precomputed cache and runs a live start_triage
  const refreshTriage = async () => {
    try {
      setIsLoading(true);
      setError("");
      setAcceptError("");
      // Invalidate proactive alerts so they reload fresh after refresh
      setProactiveLoadedAt(0);
      setProactiveAlerts([]);

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_triage",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.error || "Failed to refresh triage data");
        return;
      }

      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setClientsWithFlags(data.clientsWithFlags || []);
      setProcessedAlerts(new Set());
      setAcknowledgedNoAction(new Set());
      setSelectedClient(null);
      setClientAlerts([]);

      if ((data.clientsWithFlags || []).length > 0) {
        setScreen("clientSelection");
      } else {
        setTriageComplete(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const startTriage = async () => {
    try {
      setIsLoading(true);
      setError("");

      // ── Step 1: Check for fresh precomputed data from cron job ──────────
      console.log("Checking for precomputed triage data...");
      let precomputedUsed = false;
      try {
        const preResponse = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_precomputed", automationCommanderSheetId }),
        });
        const preData = await preResponse.json();

        if (preData.success && preData.available) {
          console.log(`✅ Using precomputed data (${preData.computedMinutesAgo} min old, ${preData.totalAlerts} alerts)`);
          setSessionId(preData.sessionId);
          setTotalAlerts(preData.totalAlerts || 0);
          setNoActionCount(preData.noActionCount || 0);
          setClientsWithFlags(preData.clientsWithFlags || []);
          setAcknowledgedNoAction(new Set());
          setProcessedAlerts(new Set());

          // Store precomputed noAction analysis results in persistent state (keyed by "clientName___flagType")
          // This survives client switches — unpacked per-client on selection
          if (preData.noActionAnalysisResults && Object.keys(preData.noActionAnalysisResults).length > 0) {
            // Normalise: GAS stores as { clientName: { flagType: results } }
            // Frontend expects flat { "clientName___flagType": results }
            const raw = preData.noActionAnalysisResults;
            const flat = {};
            Object.entries(raw).forEach(([keyOrClient, val]) => {
              if (keyOrClient.includes("___")) {
                // Already flat format
                flat[keyOrClient] = val;
              } else {
                // Nested format — flatten it
                Object.entries(val || {}).forEach(([flagType, results]) => {
                  flat[`${keyOrClient}___${flagType}`] = results;
                });
              }
            });
            setPrecomputedNoActionResults(flat);
            console.log(`  ✅ Pre-populated ${Object.keys(flat).length} noAction analysis results`);
          }

          // Go to clientSelection if any clients have flags (actionable or noAction-only).
          // The old showNoAction path is bypassed — noAction flags are handled within clientSelection.
          if ((preData.clientsWithFlags || []).length > 0) {
            setScreen("clientSelection");
          } else {
            setTriageComplete(true);
          }
          precomputedUsed = true;
        } else {
          console.log(`No fresh precomputed data available — running live triage`);
        }
      } catch (preErr) {
        console.log(`Precomputed check failed, falling back to live run: ${preErr.message}`);
      }

      if (precomputedUsed) return;

      // ── Step 2: Fall back to live start_triage ───────────────────────────
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_triage",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();

      console.log("📥 Response from /api/triage:", JSON.stringify(data, null, 2));

      if (!response.ok || !data.success) {
        const errorMsg = data.error || "Failed to start triage";
        console.error("Triage API error:", errorMsg);
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      console.log(`Setting state: totalAlerts=${data.totalAlerts}, clientsWithFlags=${data.clientsWithFlags?.length}`);
      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setClientsWithFlags(data.clientsWithFlags || []);
      setAcknowledgedNoAction(new Set());
      setProcessedAlerts(new Set());

      if ((data.clientsWithFlags || []).length > 0) {
        console.log(`${(data.clientsWithFlags || []).length} client(s) with flags, showing client selection...`);
        setScreen("clientSelection");
      } else {
        console.log("No clients with flags, showing complete screen");
        setTriageComplete(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleAckNoAction = (index) => {
    const newAcknowledged = new Set(acknowledgedNoAction);
    if (newAcknowledged.has(index)) {
      newAcknowledged.delete(index);
    } else {
      newAcknowledged.add(index);
    }
    setAcknowledgedNoAction(newAcknowledged);

    // Check if all acknowledged
    if (newAcknowledged.size === noActionCount) {
      setTriageComplete(true);
    }
  };

  const goToNoAction = () => {
    setShowNoAction(true);
  };

  const resetTriage = () => {
    setSessionId("");
    setTotalAlerts(0);
    setNoActionCount(0);
    setShowNoAction(false);
    setAcknowledgedNoAction(new Set());
    setTriageComplete(false);
    setError("");
    setAlerts([]);
    setCurrentAlertIndex(0);
    setClaudeAnalysis(""); setPreviousIgnoreReason("");
    setAlertsLoaded(false);
    setUserDecision(null);
  };

  // NEW: Helper function to get flag name from flag key
  const getFlagName = (flagKey) => {
    const flagNames = {
      "invoiceDashboardDiscr": "Invoice discrepancy",
      "invoiceAppDiscr":       "Invoice app discrepancy",
      "crmPipeDashDiscr":      "CRM dashboard discrepancy (Pipeline)",
      "crmPipeAppDiscr":       "CRM app discrepancy (Pipeline)",
      "crmConfDashDiscr":      "CRM dashboard discrepancy (Confirmed)",
      "crmConfAppDiscr":       "CRM app discrepancy (Confirmed)",
      "crmPipeSkippedBlank":   "CRM pipeline skipped (blank)",
      "crmConfSkippedBlank":   "CRM confirmed skipped (blank)",
      "crmCopiedConfChecked":  "CRM copied to conf box checked",
      "crmCopiedConfUnchecked":"CRM copied to conf box UNchecked",
      "crmCopiedConfDelete":   "CRM copied to conf box DELETE",
      "retainerInvoicesCreated": "Retainer invoices created",
      "retainerInvoicesDeleted": "Retainer invoices deleted",
      "expenseDashboardDiscr": "Expense discrepancy",
      "expenseAppDiscr":       "Expense app discrepancy",
      "expenseAdded":          "Expense added",
      "expenseUnreconGaps":    "Expense reconciliation gaps",
      "invoiceStaleUnsentChanges": "Invoice stale/unsent changes",
    };
    return flagNames[flagKey] || flagKey;
  };

  // NEW: Select a client and fetch its alerts
  const selectClient = async (client) => {
    try {
      console.log(`\n📍 selectClient called: ${client.clientName}`);
      setSelectingClient(client.clientName);
      setSelectedClient(client);
      setCurrentClientAlertIndex(0);
      setAcceptError("");
      
      console.log(`Selected client: ${client.clientName}`);
      console.log(`  masterSheetId: ${client.masterSheetId}`);
      console.log(`  clientSheetId: ${client.clientSheetId}`);
      
      // Fetch all alerts from Redis
      console.log(`  Fetching alerts from Redis (sessionId: ${sessionId})`);
      const response = await fetch(`/api/triage?action=get_alerts&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (!data.success || !data.alerts) {
        console.error(`❌ Failed to load alerts from Redis`);
        setAcceptError("Failed to load alerts");
        return;
      }
      
      console.log(`  ✅ Loaded ${data.alerts.length} total alerts from Redis`);
      
      // Filter alerts for this client and remove processed ones
      const filteredAlerts = data.alerts.filter(alert => 
        alert.clientName === client.clientName && !processedAlerts.has(`${alert.sheetName}-${alert.rowNumber}`)
      );
      
      // Filter non-actionable alerts for this client by masterSheetId
      const filteredNoAction = (data.noActionAlerts || []).filter(
        na => na.clientId === client.masterSheetId
      );

      console.log(`  📊 Found ${filteredAlerts.length} unprocessed alerts for ${client.clientName}`);
      console.log(`  📋 Found ${filteredNoAction.length} non-actionable flags for ${client.clientName}`);
      
      setClientAlerts(filteredAlerts);
      setClientNoActionAlerts(filteredNoAction);
      setNoActionAnalysisLoading({});      // reset loading state

      // Restore resolved noAction flags from Redis session for this client
      const sessionResolved = (data.resolvedNoActionFlags || []);
      const restoredResolved = new Set(
        sessionResolved
          .filter(key => key.startsWith(client.clientName + "___"))
          .map(key => key.slice(client.clientName.length + 3))
      );
      setResolvedNoActionFlags(restoredResolved);

      // Seed analysis results from precomputed data for this client only
      // precomputedNoActionResults is keyed as "clientName___flagType" and never wiped
      const precomputedForClient = {};
      console.log(`  Unpacking noActionAnalysis keys for ${client.clientName}:`, Object.keys(precomputedNoActionResults));
      Object.entries(precomputedNoActionResults).forEach(([key, result]) => {
        const sep = "___";
        const sepIdx = key.indexOf(sep);
        if (sepIdx !== -1) {
          const keyClient = key.slice(0, sepIdx);
          const keyFlag = key.slice(sepIdx + sep.length);
          if (keyClient === client.clientName) {
            // Normalise: precompute stores just the results array; frontend expects {success, results, overallOk}
            const normalised = Array.isArray(result)
              ? { success: true, results: result, overallOk: result.every(r => r.status === "ok" || r.status === "info") }
              : result;
            precomputedForClient[keyFlag] = normalised;
            console.log(`    ✓ Matched precomputed result: ${keyFlag}`);
          }
        }
      });
      console.log(`  precomputedForClient keys:`, Object.keys(precomputedForClient));
      setNoActionAnalysis(precomputedForClient);
      
      if (filteredAlerts.length === 0) {
        // No actionable alerts — only go to clearFlags if no-action flags are all resolved too
        // Use restoredResolved directly — resolvedNoActionFlags state update is async
        const noActionAllDone = filteredNoAction.length === 0 ||
          filteredNoAction.every(na => restoredResolved.has(na.flagType));
        if (noActionAllDone) {
          console.log(`  → No unprocessed alerts and all no-action flags resolved, auto-clearing`);
          handlePostClear([], restoredResolved, client);
        } else {
          console.log(`  → No actionable alerts but ${filteredNoAction.length} non-actionable flag(s) need resolving`);
          setScreen("alertSelection");
        }
      } else {
        console.log(`  → ${filteredAlerts.length} alerts ready, going to alertSelection screen`);
        setScreen("alertSelection");
      }
    } catch (err) {
      console.error(`❌ selectClient error: ${err.message}`);
      setAcceptError(`Failed to select client: ${err.message}`);
      console.error(err);
    } finally {
      setSelectingClient(null);
    }
  };

  // NEW: Select an alert and analyze it
  const selectAlert = async (alert) => {
    setBulkMode(false);
    setBulkSelected(new Set());
    try {
      console.log(`\n📍 selectAlert called for: ${alert.sheetName}-${alert.rowNumber}`);
      
      const alertIndex = clientAlerts.indexOf(alert);
      setCurrentClientAlertIndex(alertIndex);
      setAcceptError("");
      setIsAnalyzing(true);
      setClaudeAnalysis(""); setPreviousIgnoreReason("");
      setFromCache(false);
      setShowIgnoreModal(false);
      setIgnoreReason("");
      
      setScreen("triageAnalysis");
      
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_alert",
          alert,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        console.error(`❌ Analysis failed: ${data.error}`);
        setClaudeAnalysis("Error generating options: " + (data.error || "Unknown error"));
        setIsAnalyzing(false);
        return;
      }
      
      console.log(`✅ Generated ${data.options?.length || 0} options${data.fromCache ? " (from cache)" : ""}`);
      setFromCache(!!data.fromCache);
      setPreviousIgnoreReason(data.previousIgnoreReason || "");
      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
      setIsAnalyzing(false);

      // Check for existing task (fire-and-forget, non-blocking)
      checkExistingTask(alert);
    } catch (err) {
      console.error(`❌ selectAlert error: ${err.message}`);
      setAcceptError(`Failed to analyze alert: ${err.message}`);
      setIsAnalyzing(false);
    }
  };

  // NEW: Accept an option and write to sheet
  const acceptOption = async (option) => {
    const alert = clientAlerts[currentClientAlertIndex];
    
    try {
      setIsAccepting(true);
      setAcceptError("");
      
      console.log(`Accepting option: ${option.title}`);

      // delete matchType uses a dedicated action that does a fresh sheet read
      const action = option.matchType === "delete" ? "delete_job" : "accept_option";
      
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          alert,
          option,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        const isStale = response.status === 409;
        setAcceptError(isStale
          ? `⚠ ${data.error}`
          : `Failed to write to sheet: ${data.error || "Unknown error"}`);
        return;
      }
      
      console.log(`✅ Option accepted! ${data.cellsWritten} cells written`);
      
      // Mark alert as processed
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(new Set([...processedAlerts, alertId]));

      // Update Redis session so reloads reflect resolved state (fire-and-forget)
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }
      
      // Remove from client alerts
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);

      // Decrement the alert count for this client/flagType in clientsWithFlags
      const acceptedFlagType = alert.flagType || alert.type || "";
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        if (updatedCounts[acceptedFlagType] > 0) updatedCounts[acceptedFlagType]--;
        return { ...c, alertCounts: updatedCounts };
      }));
      
      if (updatedAlerts.length === 0) {
        // All actionable alerts processed — auto-clear if noAction flags resolved too
        if (allNoActionResolved()) {
          handlePostClear([], resolvedNoActionFlags);
        } else {
          // Still have unresolved non-actionable flags — go back to alertSelection to show them
          setScreen("alertSelection");
          setCurrentClientAlertIndex(0);
        }
      } else {
        // Go to next alert in this client
        setScreen("alertSelection");
        setCurrentClientAlertIndex(0);
      }
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
      console.error(err);
    } finally {
      setIsAccepting(false);
    }
  };

  // Returns true when all non-actionable flags for the current client are resolved
  const allNoActionResolved = () =>
    clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.flagType));

  // Rich noAction flags that belong to CRM or invoice groups —
  // when marked resolved, trigger auto-clear for their parent group
  const RICH_NOACTION_FLAG_GROUP = {
    crmCopiedConfChecked:    "crm",
    crmCopiedConfUnchecked:  "crm",
    crmCopiedConfDelete:     "crm",
    retainerInvoicesCreated: "invoice",
    retainerInvoicesDeleted: "invoice",
    invoiceStaleUnsentChanges: "invoice",
  };

  // Silently fires clear_flags for any flag groups that are now fully resolved.
  // Called after every alert action and after rich noAction "Mark resolved".
  // Does NOT navigate to clearFlags screen — clears happen in the background.
  // Returns the set of groups that were auto-cleared (for downstream use).
  const autoClearFlags = async (remainingAlerts, resolvedNoActionFlagsOverride, clientOverride) => {
    const client = clientOverride || selectedClient;
    if (!client) return new Set();
    const resolvedSet = resolvedNoActionFlagsOverride || resolvedNoActionFlags;
    const activeNoActionAlerts = clientOverride ? [] : clientNoActionAlerts;

    // Compute which groups are fully resolved
    const groups = computeFlagGroups(client, remainingAlerts);

    const invoiceBlockingFlags  = ["invoiceStaleUnsentChanges"];
    const crmBlockingFlags      = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"];

    const invoiceNoActionDone = invoiceBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => resolvedSet.has(f));
    const crmNoActionDone = crmBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => resolvedSet.has(f));

    // Groups where all actionable alerts are gone — used for visual update regardless of noAction blocking
    const toZeroVisually = {
      invoice: groups.invoice,
      crm:     groups.crm,
      expense: groups.expense,
    };
    const visualGroups = Object.entries(toZeroVisually).filter(([, v]) => v).map(([k]) => k);

    // Groups that can actually be cleared in AutoUpdates (requires noAction flags resolved too)
    const toClear = {
      invoice: groups.invoice && invoiceNoActionDone,
      crm:     groups.crm     && crmNoActionDone,
      expense: groups.expense,
    };
    const selected = Object.entries(toClear).filter(([, v]) => v).map(([k]) => k);

    // Always zero ACTIONABLE flag types visually (removes blue items from client card)
    // even if noAction blocking flags prevent the full clear_flags API call
    const ACTIONABLE_FLAG_TYPE_MAP = {
      invoice: ["invoiceDashboardDiscr","invoiceAppDiscr","retainerInvoicesCreated","retainerInvoicesDeleted","invoiceStaleUnsentChanges"],
      crm:     ["crmPipeDashDiscr","crmPipeAppDiscr","crmConfDashDiscr","crmConfAppDiscr","crmPipeSkippedBlank","crmConfSkippedBlank"],
      expense: ["expenseDashboardDiscr","expenseAppDiscr","expenseAdded","expenseUnreconGaps"],
    };
    const FULL_FLAG_TYPE_MAP = {
      invoice: [...ACTIONABLE_FLAG_TYPE_MAP.invoice],
      crm:     [...ACTIONABLE_FLAG_TYPE_MAP.crm, "crmCopiedConfChecked","crmCopiedConfUnchecked","crmCopiedConfDelete"],
      expense: [...ACTIONABLE_FLAG_TYPE_MAP.expense],
    };

    if (visualGroups.length > 0) {
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== client.clientName) return c;
        const updatedFlags = { ...c.flags };
        const updatedCounts = { ...c.alertCounts };
        // For groups being fully cleared (API call too), zero all flags including noAction
        // For groups only visually clearing (noAction blocking), zero only actionable flags
        for (const group of visualGroups) {
          const flagList = selected.includes(group)
            ? FULL_FLAG_TYPE_MAP[group]
            : ACTIONABLE_FLAG_TYPE_MAP[group];
          for (const ft of (flagList || [])) {
            updatedFlags[ft] = false;
            updatedCounts[ft] = 0;
          }
        }
        return { ...c, flags: updatedFlags, alertCounts: updatedCounts };
      }));
    }

    if (selected.length === 0) return new Set();

    try {
      await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_flags",
          masterSheetId: client.masterSheetId,
          automationCommanderSheetId,
          flagsToClear: selected,
          clientName: client.clientName,
        }),
      });
      console.log(`Auto-cleared flags: ${selected.join(", ")} for ${client.clientName}`);
    } catch (e) {
      console.log(`Auto-clear failed (non-fatal): ${e.message}`);
    }
    return new Set(selected);
  };

  // After processing alerts/noAction flags, decide whether to show clearFlags screen
  // or skip it (if auto-clear handled everything) or go back to client selection.
  const handlePostClear = async (remainingAlerts, resolvedNoActionFlagsOverride, clientOverride) => {
    const client = clientOverride || selectedClient;
    const autoCleared = await autoClearFlags(remainingAlerts, resolvedNoActionFlagsOverride, clientOverride);
    const groups = computeFlagGroups(client, remainingAlerts);
    const resolvedSet = resolvedNoActionFlagsOverride || resolvedNoActionFlags;
    const activeNoActionAlerts = clientOverride ? [] : clientNoActionAlerts;

    // Check what's left that wasn't auto-cleared
    const invoiceBlockingFlags  = ["invoiceStaleUnsentChanges"];
    const crmBlockingFlags      = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"];
    const invoiceNoActionDone  = invoiceBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => resolvedSet.has(f));
    const crmNoActionDone      = crmBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => resolvedSet.has(f));

    const remainingGroups = {
      invoice: groups.invoice && !autoCleared.has("invoice"),
      crm:     groups.crm     && !autoCleared.has("crm"),
      expense: groups.expense && !autoCleared.has("expense"),
    };
    const anyRemaining = remainingGroups.invoice || remainingGroups.crm || remainingGroups.expense;

    if (anyRemaining) {
      setFlagsToClear(remainingGroups);
      setScreen("clearFlags");
    } else {
      // Everything cleared — go back to client selection
      setScreen("clientSelection");
    }
  };

  // Hoist groupedAlerts so bulk helpers can reference it
  const groupedAlerts = React.useMemo(() => {
    const g = {};
    (clientAlerts || []).forEach(alert => {
      const type = alert.flagType || alert.alertType || alert.type || "unknown";
      if (!g[type]) g[type] = [];
      g[type].push(alert);
    });
    return g;
  }, [clientAlerts]);

  // ── Bulk action helpers ──────────────────────────────────────────────────

  const getBulkSelectedAlerts = () => {
    const alerts = [];
    for (const key of bulkSelected) {
      const sepIdx = key.lastIndexOf("|||");
      const type   = key.slice(0, sepIdx);
      const idx    = parseInt(key.slice(sepIdx + 3), 10);
      const alert  = (groupedAlerts[type] || [])[idx];
      if (alert) alerts.push(alert);
    }
    return alerts;
  };

  const bulkIgnore = async () => {
    const alerts = getBulkSelectedAlerts();
    if (!alerts.length) return;
    try {
      setBulkSubmitting(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_ignore_alerts", alerts, ignoreReason: bulkIgnoreReason, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) { setAcceptError(data.error || "Bulk ignore failed"); return; }

      const alertSet = new Set(alerts);
      const updatedAlerts = clientAlerts.filter(a => !alertSet.has(a));

      if (sessionId) {
        for (const alert of alerts) {
          const alertId = `${alert.sheetName}-${alert.rowNumber}`;
          setProcessedAlerts(prev => new Set([...prev, alertId]));
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_alert", sessionId, alertId }) }).catch(() => {});
        }
      }

      const countDeltas = {};
      for (const a of alerts) {
        const ft = a.flagType || a.type || "";
        countDeltas[ft] = (countDeltas[ft] || 0) + 1;
      }
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        for (const [ft, delta] of Object.entries(countDeltas)) {
          if ((updatedCounts[ft] || 0) > 0) updatedCounts[ft] -= delta;
        }
        return { ...c, alertCounts: updatedCounts };
      }));

      setClientAlerts(updatedAlerts);
      setBulkSelected(new Set());
      setBulkMode(false);
      setShowBulkIgnoreModal(false);
      setBulkIgnoreReason("");

      if (updatedAlerts.length === 0 && allNoActionResolved()) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      setAcceptError(`Bulk ignore error: ${err.message}`);
    } finally {
      setBulkSubmitting(false);
    }
  };

  const bulkCreateTasks = async () => {
    const alerts = getBulkSelectedAlerts();
    if (!alerts.length) return;
    try {
      setBulkSubmitting(true);
      const snoozedUntil = bulkTaskSnoozeDate
        ? new Date(`${bulkTaskSnoozeDate}T${bulkTaskSnoozeTime}:00`).toISOString()
        : null;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_create_tasks", alerts, taskNote: bulkTaskNote, snoozedUntil, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) { setAcceptError(data.error || "Bulk task creation failed"); return; }

      const alertSet = new Set(alerts);
      const updatedAlerts = clientAlerts.filter(a => !alertSet.has(a));

      if (sessionId) {
        for (const alert of alerts) {
          const alertId = `${alert.sheetName}-${alert.rowNumber}`;
          setProcessedAlerts(prev => new Set([...prev, alertId]));
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_alert", sessionId, alertId }) }).catch(() => {});
        }
      }

      const countDeltas = {};
      for (const a of alerts) {
        const ft = a.flagType || a.type || "";
        countDeltas[ft] = (countDeltas[ft] || 0) + 1;
      }
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        for (const [ft, delta] of Object.entries(countDeltas)) {
          if ((updatedCounts[ft] || 0) > 0) updatedCounts[ft] -= delta;
        }
        return { ...c, alertCounts: updatedCounts };
      }));

      const tasksAdded = (data.results || []).filter(r => !r.error).length;
      if (!bulkTaskSnoozeDate) setNavTaskCount(prev => prev + tasksAdded);
      else setSnoozedTaskCount(prev => prev + tasksAdded);

      setClientAlerts(updatedAlerts);
      setBulkSelected(new Set());
      setBulkMode(false);
      setShowBulkTaskModal(false);
      setBulkTaskNote("");
      setBulkTaskSnoozeDate("");
      setBulkTaskSnoozeTime("09:00");

      if (updatedAlerts.length === 0 && allNoActionResolved()) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      setAcceptError(`Bulk task error: ${err.message}`);
    } finally {
      setBulkSubmitting(false);
    }
  };

  useEffect(() => {
    startTriage();
    // Load active task count for nav badge
    fetch("/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId: AUTOMATION_COMMANDER_SHEET_ID, filter: "active" }),
    }).then(r => r.json()).then(d => { if (d.success) setNavTaskCount(d.tasks?.length || 0); }).catch(() => {});
    // Load full client map for sheet URL lookups (needed when no automation alerts)
    fetch("/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_all_clients", automationCommanderSheetId: AUTOMATION_COMMANDER_SHEET_ID }),
    }).then(r => r.json()).then(d => { if (d.success) setAllClientsMap(d.clients || {}); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute which flag groups (invoice/crm/expense) are active for a client
  // Used to pre-check the right toggles on the Clear Flags screen
  const computeFlagGroups = (client, remainingAlerts) => {
    if (!client) return { invoice: false, crm: false, expense: false };
    const f = client.flags || {};

    // A group is pre-checked only if:
    // (a) the client has flags in that group, AND
    // (b) there are no remaining unprocessed alerts for that group
    const invoiceAlertTypes = new Set(["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated", "retainerInvoicesDeleted"]);
    const crmAlertTypes = new Set(["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
      "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"]);
    const expenseAlertTypes = new Set(["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"]);

    const remaining = remainingAlerts || [];
    const hasInvoiceFlag = !!(f.invoiceDashboardDiscr || f.invoiceAppDiscr || f.invoiceStaleUnsentChanges || f.retainerInvoicesCreated || f.retainerInvoicesDeleted);
    const hasCRMFlag = !!(f.crmPipeDashDiscr || f.crmPipeAppDiscr || f.crmConfDashDiscr || f.crmConfAppDiscr ||
      f.crmPipeSkippedBlank || f.crmConfSkippedBlank || f.crmCopiedConfChecked || f.crmCopiedConfUnchecked || f.crmCopiedConfDelete);
    const hasExpenseFlag = !!(f.expenseDashboardDiscr || f.expenseAppDiscr || f.expenseAdded || f.expenseUnreconGaps);

    const remainingInvoice = remaining.some(a => invoiceAlertTypes.has(a.flagType || a.type));
    const remainingCRM = remaining.some(a => crmAlertTypes.has(a.flagType || a.type));
    const remainingExpense = remaining.some(a => expenseAlertTypes.has(a.flagType || a.type));

    return {
      invoice: hasInvoiceFlag && !remainingInvoice,
      crm: hasCRMFlag && !remainingCRM,
      expense: hasExpenseFlag && !remainingExpense,
    };
  };

  // Clear selected flag groups by writing directly to DataChgAlert cells
  const clearSelectedFlags = async () => {
    if (!selectedClient) return;

    const selected = Object.entries(flagsToClear)
      .filter(([, checked]) => checked)
      .map(([group]) => group);

    if (selected.length === 0) {
      setAcceptError("Please select at least one flag group to clear.");
      return;
    }

    try {
      setIsLoading(true);
      setAcceptError("");

      console.log(`Clearing flags for ${selectedClient.clientName}: ${selected.join(", ")}`);

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_flags",
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
          flagsToClear: selected,
          clientName: selectedClient.clientName,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        setAcceptError(`Failed to clear flags: ${data.error || "Unknown error"}`);
        return;
      }

      console.log(`✅ Flags cleared for ${selectedClient.clientName}: ${data.cellsWritten?.join(", ")}`);

      // Map cleared groups back to individual flag keys
      const FLAG_GROUP_KEYS = {
        invoice: ["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated", "retainerInvoicesDeleted"],
        crm: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
              "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked",
              "crmCopiedConfUnchecked", "crmCopiedConfDelete"],
        expense: ["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"],
      };
      const clearedKeys = new Set(selected.flatMap(group => FLAG_GROUP_KEYS[group] || []));

      // Update Redis session and precomputed cache so reloads reflect the cleared state
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_session_flags",
            sessionId,
            clientName: selectedClient.clientName,
            clearedFlagKeys: [...clearedKeys],
          }),
        }).catch(() => {});
      }

      // Zero out the cleared flag keys on the selected client only.
      // Do NOT remove any clients from the list — the list only refreshes from the
      // server on reload. Removing clients here causes other clients to vanish too.
      setClientsWithFlags(prev =>
        prev.map(client => {
          if (client.clientName !== selectedClient.clientName) return client;
          const updatedFlags = { ...client.flags };
          clearedKeys.forEach(key => { updatedFlags[key] = false; });
          return { ...client, flags: updatedFlags };
        })
      );

      // Go back to client selection
      setSelectedClient(null);
      setClientAlerts([]);
      setFlagsToClear({ invoice: false, crm: false, expense: false });
      setScreen("clientSelection");
    } catch (err) {
      setAcceptError(`Failed to clear flags: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Analyze a rich non-actionable flag (CRM copied / retainer invoices)
  const analyzeNoActionFlag = async (flagType) => {
    if (!selectedClient || noActionAnalysisLoading[flagType]) return;
    setNoActionAnalysisLoading(prev => ({ ...prev, [flagType]: true }));
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_noaction_flag",
          flagType,
          clientSheetId: selectedClient.clientSheetId,
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
          clientName: selectedClient.clientName,
        }),
      });
      const data = await resp.json();
      setNoActionAnalysis(prev => ({ ...prev, [flagType]: data }));
    } catch (e) {
      setNoActionAnalysis(prev => ({ ...prev, [flagType]: { success: false, error: e.message } }));
    } finally {
      setNoActionAnalysisLoading(prev => ({ ...prev, [flagType]: false }));
    }
  };

  // AlertMemory: ignore current alert permanently
  const ignoreAlert = async () => {
    const alert = clientAlerts[currentClientAlertIndex];
    try {
      setIsIgnoring(true);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ignore_alert",
          alert,
          ignoreReason,
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to ignore alert: ${data.error || "Unknown error"}`);
        return;
      }

      console.log(`✅ Alert ignored`);
      setShowIgnoreModal(false);
      setIgnoreReason("");

      // Mark as processed so it won't reappear if selectClient reloads from Redis
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(prev => new Set([...prev, alertId]));

      // Update Redis session so reloads reflect resolved state (fire-and-forget)
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }

      // Remove from client alerts list
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);
      setCurrentClientAlertIndex(0);

      // Decrement the alert count for this client/flagType in clientsWithFlags
      const ignoredFlagType = alert.flagType || alert.type || "";
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        if (updatedCounts[ignoredFlagType] > 0) updatedCounts[ignoredFlagType]--;
        return { ...c, alertCounts: updatedCounts };
      }));

      if (updatedAlerts.length === 0) {
        // Same gate as acceptOption — only go to clearFlags if no-action flags resolved too
        if (allNoActionResolved()) {
          handlePostClear([], resolvedNoActionFlags);
        } else {
          setScreen("alertSelection");
        }
      } else {
        setScreen("alertSelection");
      }
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsIgnoring(false);
    }
  };

  // AlertMemory: load all ignored alerts for the ignored alerts screen
  const loadIgnoredAlerts = async () => {
    try {
      setIsLoadingIgnored(true);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_ignored_alerts",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to load ignored alerts: ${data.error || "Unknown error"}`);
        return;
      }

      setIgnoredAlerts(data.ignoredAlerts || []);
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsLoadingIgnored(false);
    }
  };

  const loadProactiveAlerts = async () => {
    try {
      setProactiveLoading(true);
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_proactive_alerts", automationCommanderSheetId }),
      });
      const data = await response.json();
      console.log(`📋 get_proactive_alerts response: success=${data.success}, alerts=${data.alerts?.length ?? "none"}, countsByClient=${JSON.stringify(data.countsByClient)}`);
      if (data.success) {
        setProactiveAlerts(data.alerts || []);
        setProactiveCountsByClient(data.countsByClient || {});
      } else {
        console.error(`📋 get_proactive_alerts failed: ${data.error}`);
      }
      setProactiveLoadedAt(Date.now());
    } catch (err) {
      console.error("Failed to load proactive alerts:", err);
    } finally {
      setProactiveLoading(false);
    }
  };

  // When on All Clear screen and proactive alerts finish loading, redirect to clientSelection
  useEffect(() => {
    if (triageComplete && totalAlerts === 0 && noActionCount === 0
        && proactiveLoadedAt > 0 && proactiveAlerts.length > 0
        && activeNav !== "tasks" && activeNav !== "overview"
        && screen !== "proactiveReview" && screen !== "clientSelection") {
      console.log(`📋 Proactive alerts loaded (${proactiveAlerts.length}), redirecting to clientSelection`);
      setScreen("clientSelection");
    }
  }, [proactiveAlerts, proactiveLoadedAt]);

  // Load proactive alerts when we arrive at a screen that needs them.
  // Only fires when proactiveLoadedAt is 0 (never loaded or explicitly invalidated).
  // Using a useEffect (not render-time calls) to prevent cascading re-renders.
  useEffect(() => {
    const needsProactive = (
      screen === "clientSelection" ||
      (triageComplete && totalAlerts === 0 && noActionCount === 0)
    ) && activeNav !== "tasks" && activeNav !== "overview";

    if (!needsProactive) return;
    if (!proactiveLoading && proactiveLoadedAt === 0) {
      loadProactiveAlerts();
    }
  }, [screen, triageComplete, totalAlerts, noActionCount, activeNav, proactiveLoadedAt]);

  // Auto-refresh active tasks every 5 minutes while on the Tasks screen,
  // so snoozed tasks reappear promptly when their snooze expires.
  useEffect(() => {
    if (activeNav !== "tasks") return;
    // Reload if stale (older than 5 minutes) and not already loading
    if (!tasksLoading && Date.now() - tasksLoadedAt > 5 * 60 * 1000) {
      loadTasks(tasksFilter, true);
    }
    // Set up an interval to keep reloading every 5 minutes while on the Tasks screen
    const interval = setInterval(() => {
      if (!tasksLoading) loadTasks(tasksFilter, true);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeNav, tasksFilter]);

  const acknowledgeProactiveAlert = async (alertKey, rowIndex) => {
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge_proactive_alert", alertKey, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) {
        console.error(`❌ acknowledge_proactive_alert failed: ${data.error}`);
        return;
      }
      console.log(`✅ Acknowledged alert: ${alertKey} (rowIndex ${rowIndex})`);
      setProactiveAlerts(prev => {
        // Remove by rowIndex (unique) not alertKey — prevents removing duplicates at once
        const remaining = rowIndex
          ? prev.filter(a => a.rowIndex !== rowIndex)
          : prev.filter(a => a.alertKey !== alertKey);
        const counts = {};
        remaining.forEach(a => { counts[a.clientName] = (counts[a.clientName] || 0) + 1; });
        setProactiveCountsByClient(counts);
        const remainingForClient = remaining.filter(a => a.clientName === proactiveSelectedClient);
        if (remainingForClient.length === 0) setScreen("clientSelection");
        return remaining;
      });
    } catch (err) {
      console.error("Failed to acknowledge proactive alert:", err);
    }
  };

  const loadOverview = async () => {
    try {
      setOverviewLoading(true);
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_overview", automationCommanderSheetId }),
      });
      const data = await response.json();
      if (data.success) setOverviewData(data.clients || []);
    } catch (err) {
      console.error("Failed to load overview:", err);
    } finally {
      setOverviewLoading(false);
    }
  };

  // Navigate to a client's triage from the Overview screen
  const navigateToClientTriage = async (clientName) => {
    setActiveNav("home");
    setScreen("initial");
    setIsLoading(true);
    try {
      // Try precomputed first
      const preResponse = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_precomputed", automationCommanderSheetId }),
      });
      const preData = await preResponse.json();
      let clientsData = [];
      if (preData.success && preData.available) {
        setSessionId(preData.sessionId);
        setTotalAlerts(preData.totalAlerts || 0);
        setNoActionCount(preData.noActionCount || 0);
        setClientsWithFlags(preData.clientsWithFlags || []);
        setAcknowledgedNoAction(new Set());
        setProcessedAlerts(new Set());
        if (preData.noActionAnalysisResults) {
          const raw2 = preData.noActionAnalysisResults;
          const flat2 = {};
          Object.entries(raw2).forEach(([k, v]) => {
            if (k.includes("___")) { flat2[k] = v; }
            else { Object.entries(v || {}).forEach(([ft, r]) => { flat2[`${k}___${ft}`] = r; }); }
          });
          setPrecomputedNoActionResults(flat2);
        }
        clientsData = preData.clientsWithFlags || [];
      } else {
        const response = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_triage", automationCommanderSheetId }),
        });
        const data = await response.json();
        if (data.success) {
          setSessionId(data.sessionId);
          setTotalAlerts(data.totalAlerts || 0);
          setNoActionCount(data.noActionCount || 0);
          setClientsWithFlags(data.clientsWithFlags || []);
          setAcknowledgedNoAction(new Set());
          setProcessedAlerts(new Set());
          clientsData = data.clientsWithFlags || [];
        }
      }
      // Find and select the target client
      const target = clientsData.find(c => c.clientName === clientName);
      if (target) {
        setIsLoading(false);
        await selectClient(target);
      } else {
        setScreen("clientSelection");
      }
    } catch (err) {
      setError(err.message);
      setScreen("initial");
    } finally {
      setIsLoading(false);
    }
  };

  // AlertMemory: un-ignore an alert so it reappears in future triage runs
  const unignoreAlert = async (fingerprintHash) => {
    try {
      setIsUnignoring(fingerprintHash);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unignore_alert",
          fingerprintHash,
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to un-ignore alert: ${data.error || "Unknown error"}`);
        return;
      }

      // Remove from local list
      setIgnoredAlerts(prev => prev.filter(a => a.fingerprintHash !== fingerprintHash));
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsUnignoring(null);
    }
  };

  const styles = {
    container: {
      maxWidth: "900px",
      margin: "0 auto",
      padding: "20px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    },
    header: {
      marginBottom: "30px",
      textAlign: "center",
    },
    title: {
      fontSize: "28px",
      fontWeight: "700",
      color: "#1a1a1a",
      margin: "0 0 8px 0",
    },
    subtitle: {
      fontSize: "14px",
      color: "#666",
      margin: "0",
    },
    card: {
      background: "#fff",
      border: "1px solid #e0e0e0",
      borderRadius: "8px",
      padding: "24px",
      marginBottom: "20px",
    },
    button: {
      background: "#0066cc",
      color: "white",
      border: "none",
      padding: "12px 24px",
      borderRadius: "6px",
      fontSize: "16px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "background 0.2s",
    },
    buttonSecondary: {
      background: "#f0f0f0",
      color: "#1a1a1a",
      border: "1px solid #ddd",
      padding: "10px 16px",
      borderRadius: "6px",
      fontSize: "14px",
      fontWeight: "500",
      cursor: "pointer",
    },
    optionButton: {
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: "0",
      textAlign: "left",
    },
    errorBanner: {
      background: "#fee",
      color: "#c00",
      padding: "12px 16px",
      borderRadius: "6px",
      marginBottom: "16px",
      fontSize: "14px",
      border: "1px solid #fcc",
    },
    successBanner: {
      background: "#efe",
      color: "#060",
      padding: "12px 16px",
      borderRadius: "6px",
      marginBottom: "16px",
      fontSize: "14px",
      border: "1px solid #cfc",
    },
    loadingText: {
      color: "#666",
      fontSize: "14px",
      margin: "16px 0 0 0",
    },
    noActionSection: {
      background: "#f9f9f9",
      border: "1px solid #ddd",
      borderRadius: "8px",
      padding: "20px",
      marginTop: "20px",
    },
    noActionItem: {
      background: "white",
      border: "1px solid #e0e0e0",
      borderRadius: "6px",
      padding: "16px",
      marginBottom: "12px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    },
    noActionLabel: {
      flex: 1,
    },
    noActionTitle: {
      fontWeight: "600",
      color: "#1a1a1a",
      marginBottom: "4px",
    },
    noActionDesc: {
      fontSize: "13px",
      color: "#666",
    },
    checkmark: {
      width: "24px",
      height: "24px",
      borderRadius: "4px",
      border: "2px solid #0066cc",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      marginLeft: "12px",
      fontSize: "14px",
      fontWeight: "bold",
    },
    checkmarkChecked: {
      background: "#0066cc",
      color: "white",
    },
    statsBox: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "16px",
      marginBottom: "20px",
    },
    stat: {
      background: "#f9f9f9",
      padding: "16px",
      borderRadius: "6px",
      textAlign: "center",
    },
    statNumber: {
      fontSize: "24px",
      fontWeight: "700",
      color: "#0066cc",
      margin: "0 0 4px 0",
    },
    statLabel: {
      fontSize: "13px",
      color: "#666",
      margin: "0",
    },
    buttonGroup: {
      display: "flex",
      gap: "12px",
      marginTop: "16px",
    },
    alertCard: {
      background: "#f9f9f9",
      border: "1px solid #ddd",
      borderRadius: "8px",
      padding: "24px",
      marginBottom: "20px",
    },
    alertHeader: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "20px",
      paddingBottom: "16px",
      borderBottom: "1px solid #e0e0e0",
    },
    alertTitle: {
      fontSize: "18px",
      fontWeight: "600",
      color: "#1a1a1a",
      margin: "0",
    },
    alertCounter: {
      fontSize: "14px",
      color: "#666",
      fontWeight: "500",
    },
    alertMetadata: {
      fontSize: "13px",
      color: "#666",
      marginBottom: "16px",
      padding: "12px",
      background: "white",
      borderRadius: "6px",
      borderLeft: "3px solid #0066cc",
    },
    alertSummary: {
      background: "#fff9e6",
      padding: "14px",
      borderRadius: "6px",
      borderLeft: "4px solid #ff9800",
      marginBottom: "20px",
    },
    claudeAnalysis: {
      background: "white",
      border: "1px solid #e0e0e0",
      borderRadius: "6px",
      padding: "16px",
      marginBottom: "20px",
      lineHeight: "1.6",
      color: "#333",
      fontSize: "14px",
    },
    decisionButtons: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "12px",
      marginTop: "20px",
    },
    optionCard: {
      background: "#f5f5f5",
      border: "1px solid #ddd",
      borderRadius: "6px",
      padding: "12px",
    },
    optionTitle: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#0066cc",
      marginBottom: "8px",
    },
    optionDetail: {
      fontSize: "13px",
      color: "#333",
      marginBottom: "6px",
      lineHeight: "1.4",
    },
    optionSummary: {
      fontSize: "13px",
      color: "#666",
      marginTop: "8px",
      fontStyle: "italic",
    },
    decisionButtons: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "12px",
      marginTop: "20px",
    },
    decisionButton: {
      padding: "12px 16px",
      borderRadius: "6px",
      border: "none",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "all 0.2s",
    },
    approveButton: {
      background: "#4caf50",
      color: "white",
    },
    rejectButton: {
      background: "#f44336",
      color: "white",
    },
    investigateButton: {
      background: "#2196f3",
      color: "white",
    },
    cacheBadge: {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      background: "#e8f5e9",
      color: "#2e7d32",
      border: "1px solid #a5d6a7",
      borderRadius: "4px",
      padding: "3px 8px",
      fontSize: "12px",
      fontWeight: "600",
      marginLeft: "8px",
    },
    modalOverlay: {
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    },
    modalCard: {
      background: "white",
      borderRadius: "8px",
      padding: "24px",
      width: "440px",
      maxWidth: "90vw",
      boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    },
    modalTitle: {
      fontSize: "16px",
      fontWeight: "700",
      color: "#1a1a1a",
      margin: "0 0 8px 0",
    },
    modalSubtitle: {
      fontSize: "13px",
      color: "#666",
      margin: "0 0 16px 0",
      lineHeight: "1.5",
    },
    modalTextarea: {
      width: "100%",
      border: "1px solid #ddd",
      borderRadius: "6px",
      padding: "10px",
      fontSize: "16px",
      fontFamily: "inherit",
      resize: "vertical",
      minHeight: "80px",
      boxSizing: "border-box",
    },
    modalButtons: {
      display: "flex",
      gap: "10px",
      marginTop: "16px",
      justifyContent: "flex-end",
    },
    ignoreButton: {
      background: "#ef6c00",
      color: "white",
      border: "none",
      borderRadius: "6px",
      padding: "9px 18px",
      fontWeight: "600",
      fontSize: "13px",
      cursor: "pointer",
    },
    ignoredAlertCard: {
      background: "#fff8f2",
      border: "1px solid #ffe0b2",
      borderRadius: "6px",
      padding: "14px 16px",
      marginBottom: "10px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: "12px",
    },
    ignoredAlertMeta: {
      fontSize: "12px",
      color: "#999",
      marginTop: "4px",
    },
    unignoreButton: {
      background: "#1976d2",
      color: "white",
      border: "none",
      borderRadius: "6px",
      padding: "6px 14px",
      fontWeight: "600",
      fontSize: "12px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      flexShrink: 0,
    },
    linkButton: {
      background: "none",
      border: "none",
      color: "#0066cc",
      fontSize: "13px",
      cursor: "pointer",
      padding: "0",
      textDecoration: "underline",
    },
    flagToggleRow: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "12px 14px",
      borderRadius: "6px",
      border: "1px solid #e0e0e0",
      marginBottom: "8px",
      cursor: "pointer",
      background: "#fafafa",
      userSelect: "none",
    },
    flagToggleRowActive: {
      background: "#e8f5e9",
      borderColor: "#a5d6a7",
    },
    flagToggleLabel: {
      flex: 1,
      fontSize: "14px",
      fontWeight: "600",
      color: "#1a1a1a",
    },
    flagToggleSub: {
      fontSize: "12px",
      color: "#888",
      fontWeight: "400",
      marginTop: "2px",
    },
    flagCheckbox: {
      width: "18px",
      height: "18px",
      accentColor: "#4caf50",
      cursor: "pointer",
      flexShrink: 0,
    },
  };

  // Wrap any screen JSX with the task creation modal overlay (rendered above everything)
  const withModal = (jsx) => showTaskModal ? (
    <>
      {jsx}
      <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) { setShowTaskModal(false); setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("09:00"); } }}>
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

          {/* Optional snooze */}
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
                  <button className="triage-btn" onClick={() => { setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("09:00"); }}
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
            <button className="triage-btn" onClick={() => { setShowTaskModal(false); setTaskModalNote(""); setTaskModalSnoozeDate(""); setTaskModalSnoozeTime("09:00"); setTaskActionError(""); }} style={styles.buttonSecondary}>Cancel</button>
            <button className="triage-btn" onClick={submitCreateTask} disabled={taskModalSubmitting}
              style={{ background: taskModalSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer", opacity: taskModalSubmitting ? 0.5 : 1 }}>
              {taskModalSubmitting ? <><Spinner />Creating...</> : taskModalSnoozeDate ? "📋 Create & Snooze" : "📋 Create Task"}
            </button>
          </div>
        </div>
      </div>
    </>
  ) : jsx;

  // Screen: Ignored Alerts
  if (screen === "ignoredAlerts" && activeNav !== "tasks") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Ignored Alerts</h1>
            <p style={styles.subtitle}>Alerts permanently excluded from triage</p>
          </div>

          <div style={styles.card}>
            {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

            {isLoadingIgnored ? (
              <p style={styles.loadingText}>Loading ignored alerts...</p>
            ) : ignoredAlerts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "24px", color: "#666" }}>
                No ignored alerts yet.
              </div>
            ) : (
              <div>
                {ignoredAlerts.map((a) => (
                  <div key={a.fingerprintHash} style={styles.ignoredAlertCard}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a" }}>
                        {a.alertSummary || "(no summary)"}
                      </div>
                      <div style={styles.ignoredAlertMeta}>
                        {a.clientName} · {a.alertType} · Ignored {a.lastSeen}
                      </div>
                      {a.ignoreReason && (
                        <div style={{ fontSize: "12px", color: "#888", marginTop: "4px", fontStyle: "italic" }}>
                          Reason: {a.ignoreReason}
                        </div>
                      )}
                    </div>
                    <button className="triage-btn"
                      onClick={() => unignoreAlert(a.fingerprintHash)}
                      disabled={isUnignoring === a.fingerprintHash}
                      style={{
                        ...styles.unignoreButton,
                        opacity: isUnignoring === a.fingerprintHash ? 0.5 : 1,
                      }}
                    >
                      {isUnignoring === a.fingerprintHash ? "Restoring..." : "↩ Un-ignore"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: "20px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button className="triage-btn"
                onClick={() => { setAcceptError(""); setScreen("clientSelection"); }}
                style={styles.buttonSecondary}
              >
                ← Back to Clients
              </button>
              <button className="triage-btn"
                onClick={async () => {
                  try {
                    setAcceptError("");
                    const r = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "rehash_ignored_alerts", automationCommanderSheetId }) });
                    const d = await r.json();
                    if (d.success) {
                      setAcceptError(`✓ Rehashed: ${d.updated} of ${d.total} ignored alerts updated. Click Refresh to reload.`);
                    } else {
                      setAcceptError(`Failed: ${d.error}`);
                    }
                  } catch (e) { setAcceptError(`Error: ${e.message}`); }
                }}
                style={{ ...styles.buttonSecondary, fontSize: "13px" }}
                title="Fix ignored alerts that reappeared after a system update"
              >
                🔧 Fix stale hashes
              </button>
            </div>
          </div>
        </div>
      </NavShell>
    );
  }

  // Overview screen — must come before all screen-based checks so nav always works
  if (activeNav === "overview") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "24px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <h2 style={{ fontSize: "22px", fontWeight: "700", color: "#1a1a1a", margin: 0 }}>Overview</h2>
            <button className="triage-btn" onClick={loadOverview} disabled={overviewLoading}
              style={{ background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "8px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}>
              {overviewLoading ? <><Spinner size={12} />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>

          {overviewLoading && overviewData.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#666", background: "#fff", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <Spinner size={24} color="#0066cc" /><div style={{ marginTop: "12px" }}>Loading overview...</div>
            </div>
          ) : overviewData.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#888", background: "#fff", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              No client data available. Click Refresh to load.
            </div>
          ) : (
            <>
              {/* Desktop table — hidden on mobile via inline media query trick using a wrapper */}
              <style>{`
                .overview-table { display: table; }
                .overview-cards { display: none; }
                @media (max-width: 700px) {
                  .overview-table { display: none; }
                  .overview-cards { display: flex; }
                }
              `}</style>

              {/* Desktop: table layout */}
              <div className="overview-table" style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "8px", overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ background: "#f8f8f8", borderBottom: "2px solid #e0e0e0" }}>
                      <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: "600", color: "#333", width: "20%" }}>Client</th>
                      <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: "600", color: "#333", width: "26%" }}>Invoices</th>
                      <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: "600", color: "#333", width: "26%" }}>CRM</th>
                      <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: "600", color: "#333", width: "26%" }}>Expenses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overviewData.map((client, idx) => {
                      const hasFlags = !!client.flagsText;
                      return (
                        <tr key={idx} style={{
                          borderBottom: "1px solid #eee",
                          background: hasFlags ? "#fffde7" : idx % 2 === 0 ? "#fff" : "#fafafa",
                        }}>
                          <td style={{ padding: "8px 12px", verticalAlign: "top" }}>
                            <div style={{ fontWeight: "600", fontSize: "13px", color: "#1a1a1a" }}>{client.clientName}</div>
                            {hasFlags && (
                              <div style={{ marginTop: "4px" }}>
                                <button className="triage-btn" onClick={() => navigateToClientTriage(client.clientName)}
                                  style={{ fontSize: "11px", color: "#c62828", background: "none", border: "1px solid #f5c6c6", borderRadius: "4px", padding: "2px 7px", cursor: "pointer" }}>
                                  ⚠ {client.flagsText}
                                </button>
                              </div>
                            )}
                          </td>
                          <FeedbackCell seq={client.inv} />
                          <FeedbackCell seq={client.crm} />
                          <FeedbackCell seq={client.exp} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile: card layout */}
              <div className="overview-cards" style={{ flexDirection: "column", gap: "10px" }}>
                {overviewData.map((client, idx) => {
                  const hasFlags = !!client.flagsText;
                  return (
                    <div key={idx} style={{
                      background: hasFlags ? "#fffde7" : "#fff",
                      border: `1px solid ${hasFlags ? "#f5c6a0" : "#e0e0e0"}`,
                      borderRadius: "8px",
                      padding: "12px 14px",
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                        <div style={{ fontWeight: "700", fontSize: "14px", color: "#1a1a1a" }}>{client.clientName}</div>
                        {hasFlags && (
                          <button className="triage-btn" onClick={() => navigateToClientTriage(client.clientName)}
                            style={{ fontSize: "11px", color: "#c62828", background: "none", border: "1px solid #f5c6c6", borderRadius: "4px", padding: "2px 7px", cursor: "pointer", flexShrink: 0, marginLeft: "8px" }}>
                            ⚠ {client.flagsText}
                          </button>
                        )}
                      </div>
                      {[
                        { label: "Invoices", seq: client.inv },
                        { label: "CRM",      seq: client.crm },
                        { label: "Expenses", seq: client.exp },
                      ].filter(({ seq }) => seq && (seq.lastRunTime || seq.feedback)).map(({ label, seq }) => (
                        <div key={label} style={{ display: "flex", gap: "8px", marginBottom: "5px", alignItems: "flex-start" }}>
                          <div style={{ fontSize: "11px", fontWeight: "600", color: "#888", width: "60px", flexShrink: 0, paddingTop: "1px" }}>{label}</div>
                          <div style={{ fontSize: "12px", color: "#444", flex: 1 }}>
                            {seq ? (
                              <>
                                {seq.lastRunTime && <span style={{ fontWeight: "500", color: "#333" }}>{seq.lastRunTime} </span>}
                                {seq.feedback && (
                                  seq.feedback.raw ? (
                                    <span style={{ color: "#666" }}>{seq.feedback.raw}</span>
                                  ) : (
                                    <span>
                                      <span style={{ color: "#666" }}>Last: {seq.feedback.last ?? "—"}  Day: {seq.feedback.day ?? "—"}  Week: {seq.feedback.week ?? "—"} </span>
                                      <span style={{ fontWeight: "600", color: seq.feedback.outcome?.toUpperCase() === "OK" ? "#2e7d32" : "#c62828" }}>| {seq.feedback.outcome}</span>
                                    </span>
                                  )
                                )}
                              </>
                            ) : <span style={{ color: "#bbb" }}>—</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </NavShell>
    );
  }

  // Screen 1b: Client Selection Screen
  if (screen === "clientSelection" && sessionId && activeNav !== "tasks") {
    const ACTIONABLE_FLAG_KEYS = [
      "invoiceDashboardDiscr", "expenseDashboardDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
    ];

    // If all clients have had their flags zeroed out AND no proactive alerts, show complete screen
    const activeClients = clientsWithFlags.filter(c => Object.values(c.flags || {}).some(v => v));
    if (activeClients.length === 0 && proactiveAlerts.length === 0 && proactiveLoadedAt > 0) {
      return (
        <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
          <div style={styles.container}>
            <div style={styles.header}>
              <h1 style={styles.title}>All Done</h1>
              <p style={styles.subtitle}>All alerts and flags have been resolved</p>
            </div>
            <div style={styles.card}>
              <div style={styles.successBanner}>✓ No outstanding alerts or flags</div>
              <button className="triage-btn" onClick={refreshTriage} disabled={isLoading} style={{ ...styles.buttonSecondary, marginTop: "16px", opacity: isLoading ? 0.5 : 1 }}>
                {isLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
              </button>
            </div>
          </div>
        </NavShell>
      );
    }
    // If still loading proactive alerts, wait before deciding
    if (activeClients.length === 0 && proactiveLoadedAt === 0) {
      return (
        <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
          <div style={styles.container}>
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#888" }}>
              <Spinner size={28} color="#0066cc" />
              <div style={{ marginTop: "12px", fontSize: "14px" }}>Checking for alerts...</div>
            </div>
          </div>
        </NavShell>
      );
    }

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Client</h1>
          <p style={styles.subtitle}>Choose a client to review their alerts ({totalAlerts} total)</p>
        </div>

        <div style={styles.card}>
          <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>Automation Alerts</h2>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

          {isLoading ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: "#666" }}>
              <Spinner size={32} color="#0066cc" />
              <div style={{ fontSize: "15px", fontWeight: "600", color: "#333", marginTop: "12px", marginBottom: "6px" }}>
                Refreshing data...
              </div>
              <div style={{ fontSize: "13px", color: "#888" }}>
                Reading latest flags and alerts from your sheets
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {clientsWithFlags.filter(client =>
                Object.values(client.flags || {}).some(v => v)
              ).map((client, idx) => {
                const actionableLines = ACTIONABLE_FLAG_KEYS
                  .filter(key => client.flags?.[key])
                  .map(key => {
                    const count = client.alertCounts?.[key];
                    const label = getFlagName(key);
                    return count
                      ? `${label} (${count} alert${count !== 1 ? "s" : ""})`
                      : label;
                  });

                const infoLines = Object.entries(client.flags || {})
                  .filter(([key, val]) => val && !ACTIONABLE_FLAG_KEYS.includes(key))
                  .map(([key]) => getFlagName(key));

                return (
                  <button
                    key={idx}
                    onClick={() => selectClient(client)}
                    className="triage-client-card"
                    disabled={selectingClient !== null}
                    style={{
                      ...styles.optionButton,
                      textAlign: "left",
                      padding: "16px",
                      border: `1px solid ${selectingClient === client.clientName ? "#2196f3" : "#ddd"}`,
                      borderRadius: "6px",
                      cursor: selectingClient !== null ? "wait" : "pointer",
                      backgroundColor: selectingClient === client.clientName ? "#e8f0fe" : "#f9f9f9",
                      width: "100%",
                      opacity: selectingClient !== null && selectingClient !== client.clientName ? 0.5 : 1,
                    }}
                  >
                    <div style={{ fontWeight: "bold", fontSize: "16px", marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                      {selectingClient === client.clientName && <Spinner size={13} />}
                      {client.clientName}
                      {proactiveCountsByClient[client.clientName] > 0 && (
                        <span style={{ fontSize: "11px", background: "#f59e0b", color: "#fff", borderRadius: "10px", padding: "1px 7px", fontWeight: "600" }}>
                          {proactiveCountsByClient[client.clientName]} proactive
                        </span>
                      )}
                    </div>
                    {actionableLines.map((line, i) => (
                      <div key={i} style={{ fontSize: "13px", color: "#1976d2", marginBottom: "2px" }}>
                        • {line}
                      </div>
                    ))}
                    {infoLines.map((line, i) => (
                      <div key={i} style={{ fontSize: "13px", color: "#888", marginBottom: "2px" }}>
                        • {line}
                      </div>
                    ))}
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button className="triage-btn"
              onClick={() => {
                setScreen("ignoredAlerts");
                loadIgnoredAlerts();
              }}
              style={styles.linkButton}
            >
              View ignored alerts →
            </button>
            <button className="triage-btn"
              onClick={refreshTriage}
              disabled={isLoading}
              style={{
                ...styles.buttonSecondary,
                fontSize: "13px",
                padding: "6px 14px",
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              {isLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>
        </div>

        {/* Proactive Alerts — separate card below */}
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>
            Proactive Alerts {!proactiveLoading && proactiveAlerts.length > 0 && `(${proactiveAlerts.length})`}
          </h2>
          {proactiveLoading ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#666", fontSize: "13px" }}>
              <Spinner size={20} color="#0066cc" />
              <div style={{ marginTop: "8px" }}>Loading proactive alerts...</div>
            </div>
          ) : proactiveAlerts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#888", fontSize: "13px" }}>
              ✓ No proactive alerts
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {(() => {
                // Group by clientName
                const grouped = {};
                proactiveAlerts.forEach(a => {
                  if (!grouped[a.clientName]) grouped[a.clientName] = [];
                  grouped[a.clientName].push(a);
                });
                return Object.entries(grouped).map(([clientName, alerts], idx) => {
                  const typeLabels = {
                    retainer_invoice:           "Retainer invoice",
                    crm_wipe:                   "CRM data wipe",
                    revenue_mismatch:           "Revenue / invoiced mismatch",
                    direct_costs_mismatch:      "Direct costs / expenses mismatch",
                    pipeline_confirmed_overlap: "Pipeline / Confirmed overlap",
                    retainer_shrink_blocked:    "Retainer row blocked from trimming",
                  };
                  const typeCounts = {};
                  alerts.forEach(a => {
                    const label = typeLabels[a.alertType] || a.alertType || "Alert";
                    typeCounts[label] = (typeCounts[label] || 0) + 1;
                  });
                  return (
                    <button
                      key={idx}
                      className="triage-client-card"
                      onClick={() => { setProactiveSelectedClient(clientName); setScreen("proactiveReview"); }}
                      style={{
                        ...styles.optionButton,
                        textAlign: "left",
                        padding: "16px",
                        border: "1px solid #ddd",
                        borderRadius: "6px",
                        backgroundColor: "#f9f9f9",
                        width: "100%",
                      }}
                    >
                      <div style={{ fontWeight: "bold", fontSize: "16px", marginBottom: "6px" }}>
                        {clientName}
                      </div>
                      {Object.entries(typeCounts).map(([type, count], i) => (
                        <div key={i} style={{ fontSize: "13px", color: "#d97706", marginBottom: "2px" }}>
                          • {type} ({count} alert{count !== 1 ? "s" : ""})
                        </div>
                      ))}
                    </button>
                  );
                });
              })()}
            </div>
          )}
          <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end" }}>
            <button className="triage-btn" onClick={loadProactiveAlerts} disabled={proactiveLoading}
              style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: proactiveLoading ? 0.5 : 1 }}>
              {proactiveLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>
        </div>

        </div>
      </NavShell>
    );
  }

  // Screen 1b: Proactive Alert Review Screen
  if (screen === "proactiveReview" && proactiveSelectedClient && activeNav !== "tasks") {
    const clientAlertsList = proactiveAlerts.filter(a => a.clientName === proactiveSelectedClient);
    const freqLabel = (days) => {
      if (days <= 31) return "monthly";
      if (days <= 65) return "bi-monthly";
      if (days <= 95) return "quarterly";
      if (days <= 190) return "semi-annual";
      return "annual";
    };

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Proactive Alerts</h1>
            <p style={styles.subtitle}>{proactiveSelectedClient} — {clientAlertsList.length} alert{clientAlertsList.length !== 1 ? "s" : ""}</p>
          </div>
          <div style={styles.card}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {clientAlertsList.map((alert, idx) => {
                const m = alert.metadata || {};
                return (
                  <div key={idx} style={{ border: "1px solid #ddd", borderRadius: "6px", padding: "14px", backgroundColor: "#fafafa" }}>
                    <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a", marginBottom: "6px" }}>
                      {alert.heading}
                    </div>
                    <div style={{ fontSize: "13px", color: "#444", lineHeight: "1.6", marginBottom: "8px" }}>
                      {alert.alertType === "revenue_mismatch" || alert.alertType === "direct_costs_mismatch" || alert.alertType === "pipeline_confirmed_overlap" || alert.alertType === "retainer_shrink_blocked" ? null : alert.detail}
                    </div>

                    {/* Retainer invoice detail */}
                    {alert.alertType === "retainer_invoice" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}</div>}
                        {m.confirmedRow && <div><strong>Confirmed tab row:</strong> {m.confirmedRow}</div>}
                        {m.revenue && <div><strong>Monthly revenue:</strong> {m.revenue}</div>}
                        {m.startDate && <div><strong>Contract period:</strong> {m.startDate} → {m.endDate}</div>}
                        {m.frequencyDays && <div><strong>Invoice frequency:</strong> {freqLabel(m.frequencyDays)} (every ~{m.frequencyDays} days)</div>}
                        {m.lastInvoiceDate && <div><strong>Last invoice sent:</strong> {m.lastInvoiceDate}</div>}
                        {m.expectedByDate && <div><strong>Next expected by:</strong> {m.expectedByDate}</div>}
                      </div>
                    )}

                    {/* CRM wipe detail */}
                    {alert.alertType === "crm_wipe" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.timestamp && <div><strong>Log timestamp:</strong> {m.timestamp}</div>}
                        {m.sequenceType && <div><strong>Sequence:</strong> {m.sequenceType}</div>}
                        {m.summary && <div><strong>Summary:</strong> {m.summary}</div>}
                        {m.jobInfo && <div><strong>Job:</strong> {m.jobInfo}</div>}
                        {m.detailsSnippet && (
                          <div style={{ marginTop: "4px" }}>
                            <strong>AutoLog details:</strong>
                            <div style={{ fontFamily: "monospace", fontSize: "11px", color: "#666", marginTop: "2px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                              {m.detailsSnippet}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Revenue / invoiced mismatch detail */}
                    {alert.alertType === "revenue_mismatch" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fef3c7", border: "1px solid #fcd34d", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {(() => {
                          const detail = alert.detail || "";
                          const mismatchIdx = detail.indexOf("Mismatched rows:");
                          if (mismatchIdx === -1) {
                            // No mismatch breakdown — just show the whole detail bolded
                            return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          }
                          const header = detail.slice(0, mismatchIdx).trim();
                          const rowsPart = detail.slice(mismatchIdx + "Mismatched rows:".length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched rows:</div>
                              {rows.map((row, i) => {
                                // Bold the "— diff £X" part
                                const diffIdx = row.indexOf("— diff");
                                if (diffIdx === -1) {
                                  return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row}</div>;
                                }
                                return (
                                  <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>
                                    • {row.slice(0, diffIdx)}<strong>{row.slice(diffIdx)}</strong>
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {/* Direct costs / expenses mismatch detail */}
                    {alert.alertType === "direct_costs_mismatch" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fce7f3", border: "1px solid #f9a8d4", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {(() => {
                          const detail = alert.detail || "";
                          const mismatchIdx = detail.indexOf("Mismatched rows:");
                          if (mismatchIdx === -1) {
                            return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          }
                          const header = detail.slice(0, mismatchIdx).trim();
                          const rowsPart = detail.slice(mismatchIdx + "Mismatched rows:".length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched rows:</div>
                              {rows.map((row, i) => {
                                const diffIdx = row.indexOf("— diff");
                                if (diffIdx === -1) {
                                  return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row}</div>;
                                }
                                return (
                                  <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>
                                    • {row.slice(0, diffIdx)}<strong>{row.slice(diffIdx)}</strong>
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {/* Pipeline / Confirmed overlap detail */}
                    {alert.alertType === "pipeline_confirmed_overlap" && (() => {
                      const md = alert.metadata || {};
                      return (
                        <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0fdf4", border: "1px solid #86efac", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                          <div style={{ fontWeight: "600", marginBottom: "6px" }}>Job exists in both tabs but Pipeline is not closed out</div>
                          <div style={{ marginBottom: "4px" }}><strong>Confirmed tab</strong></div>
                          {md.confirmedRow  && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Row: {md.confirmedRow}</div>}
                          {md.clientName    && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Client: {md.clientName}</div>}
                          {md.jobName       && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job: {md.jobName}</div>}
                          {md.projectCode   && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Project code: {md.projectCode}</div>}
                          {md.jobType       && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job type: {md.jobType}</div>}
                          <div style={{ marginBottom: "4px", marginTop: "6px" }}><strong>Pipeline tab</strong></div>
                          {md.pipelineRow   && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Row: {md.pipelineRow}</div>}
                          <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Likelihood: <strong>{md.likelihood || "(blank)"}</strong></div>
                          <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>"Copied to confirmed?": <strong>{md.copiedToConf || "(blank)"}</strong></div>
                          <div style={{ marginTop: "6px", color: "#166534", fontStyle: "italic" }}>
                            Expected fix: set Pipeline likelihood to 0% or mark "Copied to confirmed?" as Yes.
                          </div>
                        </div>
                      );
                    })()}

                    {/* Retainer shrink blocked detail */}
                    {alert.alertType === "retainer_shrink_blocked" && (() => {
                      const md = alert.metadata || {};
                      return (
                        <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                          <div style={{ fontWeight: "600", marginBottom: "6px" }}>Retainer contract shrunk — excess child row could not be removed automatically</div>
                          {md.clientJobStr && <div style={{ marginBottom: "2px" }}><strong>Job:</strong> {md.clientJobStr}</div>}
                          {md.childRowNum  && <div style={{ marginBottom: "2px" }}><strong>Blocked child row:</strong> {md.childRowNum}</div>}
                          {md.timestamp    && <div style={{ marginBottom: "6px" }}><strong>First detected:</strong> {String(md.timestamp).slice(0, 10)}</div>}
                          <div style={{ color: "#92400e", fontStyle: "italic" }}>
                            Row {md.childRowNum} falls outside the new contract period but contains actuals (invoices or expenses) so cannot be auto-removed. Manual review required.
                          </div>
                        </div>
                      );
                    })()}

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: "11px", color: "#aaa" }}>
                        First seen: {alert.firstSeen} · Last seen: {alert.lastSeen}
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        {(() => {
                          const clientInfo = clientsWithFlags.find(c => c.clientName === proactiveSelectedClient)
                            || allClientsMap[proactiveSelectedClient];
                          if (!clientInfo?.clientSheetId && !clientInfo?.masterSheetId) return null;
                          return (
                            <button className="triage-btn"
                              onClick={() => {
                                if (clientInfo.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.clientSheetId}/edit`, "_blank");
                                if (clientInfo.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.masterSheetId}/edit`, "_blank");
                              }}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}
                            >
                              📊 Open Sheets
                            </button>
                          );
                        })()}
                        <button
                          className="triage-btn"
                          onClick={() => openCreateTaskModal(alert, true)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}
                        >
                          📋 Create Task
                        </button>
                        <button
                          className="triage-btn"
                          onClick={() => acknowledgeProactiveAlert(alert.alertKey, alert.rowIndex)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px" }}
                        >
                          ✓ Acknowledge
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {clientAlertsList.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px", color: "#888", fontSize: "13px" }}>
                  All alerts acknowledged
                </div>
              )}
            </div>
            <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #eee" }}>
              <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
                ← Back to Client List
              </button>
            </div>
          </div>
        </div>
      </NavShell>
    );
  }

  // Screen 1c: Alert Selection Screen
  if (screen === "alertSelection" && selectedClient && activeNav !== "tasks") {
    // groupedAlerts is hoisted above as a useMemo

    const noActionDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.flagType));
    const allActionableDone = clientAlerts.length === 0;
    const canProceed = allActionableDone && noActionDone;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Alert</h1>
          <p style={styles.subtitle}>{selectedClient.clientName} - {clientAlerts.length} alert(s)</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

          {/* Bulk mode toggle — only show when there are multiple alerts */}
          {clientAlerts.length > 1 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "10px" }}>
              <button className="triage-btn" onClick={() => { setBulkMode(v => !v); setBulkSelected(new Set()); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px",
                  ...(bulkMode ? { background: "#ede9fe", borderColor: "#7c3aed", color: "#5b21b6" } : {}) }}>
                {bulkMode ? "✕ Cancel bulk" : "☑ Bulk actions"}
              </button>
            </div>
          )}
          
          {/* Actionable alerts */}
          {Object.keys(groupedAlerts).length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#666", marginBottom: "8px" }}>
              {clientNoActionAlerts.length > 0
                ? "All actionable alerts resolved ✓"
                : "No more alerts for this client"}
            </div>
          ) : (
            <div>
              {Object.keys(groupedAlerts).map((type) => {
                const groupAlerts = groupedAlerts[type];
                const groupKeys   = groupAlerts.map((_, idx) => `${type}|||${idx}`);
                const allSelected = groupKeys.every(k => bulkSelected.has(k));
                const anySelected = groupKeys.some(k => bulkSelected.has(k));
                return (
                <div key={type} style={{ marginBottom: "20px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                    <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#2196f3", margin: 0 }}>
                      {(() => {
                        const isDash = type === "crmPipeDashDiscr" || type === "crmConfDashDiscr";
                        const isApp  = type === "crmPipeAppDiscr"  || type === "crmConfAppDiscr";
                        const tab    = (type === "crmPipeDashDiscr" || type === "crmPipeAppDiscr") ? "Pipeline" : "Confirmed";
                        const kind   = isDash ? "dashboard" : "app";
                        if (isDash || isApp) {
                          const hasNotFound = groupAlerts.some(a => !a.subType || a.subType === "not_found");
                          const hasMismatch = groupAlerts.some(a => a.subType === "field_mismatch");
                          if (hasMismatch && !hasNotFound) return `CRM ${kind} discrepancy — field mismatch (${tab})`;
                          if (!hasMismatch && hasNotFound) return `CRM ${kind} discrepancy — missing job (${tab})`;
                          if (hasMismatch && hasNotFound)  return `CRM ${kind} discrepancy (${tab})`;
                        }
                        return getFlagName(type);
                      })()}
                    </h3>
                    {bulkMode && groupAlerts.length > 1 && (
                      <button className="triage-btn" onClick={() => {
                        const newSel = new Set(bulkSelected);
                        if (allSelected) { groupKeys.forEach(k => newSel.delete(k)); }
                        else             { groupKeys.forEach(k => newSel.add(k)); }
                        setBulkSelected(newSel);
                      }} style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "3px 8px" }}>
                        {allSelected ? "Deselect all" : "Select all"}
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {groupAlerts.map((alert, idx) => {
                      const selKey    = `${type}|||${idx}`;
                      const isChecked = bulkSelected.has(selKey);
                      return bulkMode ? (
                        <div key={idx}
                          onClick={() => {
                            const newSel = new Set(bulkSelected);
                            if (isChecked) newSel.delete(selKey); else newSel.add(selKey);
                            setBulkSelected(newSel);
                          }}
                          style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "12px",
                            border: `1px solid ${isChecked ? "#7c3aed" : "#e0e0e0"}`,
                            borderRadius: "4px", cursor: "pointer",
                            backgroundColor: isChecked ? "#ede9fe" : "#fff", fontSize: "13px" }}>
                          <input type="checkbox" checked={isChecked} onChange={() => {}}
                            style={{ marginTop: "2px", accentColor: "#7c3aed", flexShrink: 0 }} />
                          <div style={{ flex: 1, pointerEvents: "none" }}>
                            {(() => {
                              const ft = alert.flagType || alert.alertType || "";
                              const isAppDiscr  = ft === "crmConfAppDiscr" || ft === "crmPipeAppDiscr";
                              const isDashDiscr = ft === "crmPipeDashDiscr" || ft === "crmConfDashDiscr";
                              if (isAppDiscr) {
                                const sd = alert.data?.sheetData || [];
                                const client = sd[0] || ""; const job = sd[1] || ""; const code = sd[2] || "";
                                const rev = sd[3] ? `£${parseFloat(String(sd[3]).replace(/[£$€,\s]/g,""))||0}` : "";
                                const start = sd[5] || ""; const end = sd[6] || ""; const likely = sd[7] || "";
                                const isPipeline = ft === "crmPipeAppDiscr";
                                const isMismatch = alert.subType === "field_mismatch";
                                return (
                                  <div>
                                    <div style={{ fontWeight: "600" }}>{client}{job ? ` — ${job}` : ""}</div>
                                    {code && <div style={{ fontSize: "11px", color: "#888" }}>Code: {code}</div>}
                                    {rev  && <div style={{ fontSize: "11px", color: "#888" }}>Revenue: {rev}</div>}
                                    {start && <div style={{ fontSize: "11px", color: "#888" }}>Dates: {start}{end ? ` → ${end}` : ""}</div>}
                                    {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {likely}</div>}
                                    {isMismatch
                                      ? <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>⚠ {(alert.mismatchFields||[]).join(", ")}</div>
                                      : <div style={{ fontSize: "11px", color: "#c62828", marginTop: "3px" }}>{isPipeline ? "In Pipeline — not in CRM" : "In Confirmed — not in CRM"}</div>
                                    }
                                  </div>
                                );
                              }
                              if (isDashDiscr) {
                                const cd = alert.data?.crmData || [];
                                const isMismatch = alert.subType === "field_mismatch";
                                return <div><div style={{ fontWeight: "600" }}>{cd[0]}{cd[1] ? ` — ${cd[1]}` : ""}</div>
                                  <div style={{ fontSize: "11px", color: isMismatch ? "#d97706" : "#c62828" }}>
                                    {isMismatch ? `⚠ ${(alert.mismatchFields || []).join(", ")}` : "In CRM — not in sheet"}
                                  </div></div>;
                              }
                              return <div>{getAlertSummary(alert)}</div>;
                            })()}
                          </div>
                        </div>
                      ) : (
                      <button className="triage-btn"
                        key={idx}
                        onClick={() => selectAlert(alert)}
                        style={{
                          ...styles.optionButton,
                          textAlign: "left",
                          padding: "12px",
                          border: "1px solid #e0e0e0",
                          borderRadius: "4px",
                          cursor: "pointer",
                          backgroundColor: "#fff",
                          fontSize: "13px",
                          transition: "all 0.2s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "#f5f5f5";
                          e.currentTarget.style.borderColor = "#2196f3";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "#fff";
                          e.currentTarget.style.borderColor = "#e0e0e0";
                        }}
                      >
                        {(() => {
                          const ft = alert.flagType || alert.alertType || "";
                          const isAppDiscr = ft === "crmConfAppDiscr" || ft === "crmPipeAppDiscr";
                          const isDashDiscr = ft === "crmPipeDashDiscr" || ft === "crmConfDashDiscr";
                          if (isAppDiscr) {
                            const sd = alert.data?.sheetData || [];
                            const client = sd[0] || ""; const job = sd[1] || ""; const code = sd[2] || "";
                            const rev = sd[3] ? `£${parseFloat(String(sd[3]).replace(/[£$€,\s]/g,""))||0}` : "";
                            const start = sd[5] || ""; const end = sd[6] || "";
                            const likely = sd[7] || "";
                            const isPipeline = ft === "crmPipeAppDiscr";
                            const isMismatch = alert.subType === "field_mismatch";
                            return (
                              <div>
                                <div style={{ fontWeight: "600" }}>{client}{job ? ` — ${job}` : ""}</div>
                                {code    && <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>Code: {code}</div>}
                                {rev     && <div style={{ fontSize: "11px", color: "#888" }}>Revenue: {rev}</div>}
                                {start   && <div style={{ fontSize: "11px", color: "#888" }}>Dates: {start}{end ? ` → ${end}` : ""}</div>}
                                {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {likely}</div>}
                                {isMismatch ? (
                                  <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>
                                    ⚠ Field mismatch: {(alert.mismatchFields || []).join(", ")}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: "11px", color: "#c62828", marginTop: "3px" }}>
                                    {isPipeline ? "In Pipeline — not in CRM" : "In Confirmed — not in CRM"}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          if (isDashDiscr) {
                            const cd = alert.data?.crmData || [];
                            const client = cd[0] || ""; const job = cd[1] || ""; const code = cd[2] || "";
                            const rev = cd[3] ? `£${parseFloat(String(cd[3]).replace(/[£$€,\s]/g,""))||0}` : "";
                            const start = cd[5] || ""; const end = cd[6] || ""; const likely = cd[7] || "";
                            const isMismatch = alert.subType === "field_mismatch";
                            const isPipeline = ft === "crmPipeDashDiscr";
                            const mismatchFields = alert.mismatchFields || [];
                            return (
                              <div>
                                <div style={{ fontWeight: "600" }}>{client}{job ? ` — ${job}` : ""}</div>
                                {code    && <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>Code: {code}</div>}
                                {rev     && <div style={{ fontSize: "11px", color: "#888" }}>Revenue: {rev}</div>}
                                {start   && <div style={{ fontSize: "11px", color: "#888" }}>Dates: {start}{end ? ` → ${end}` : ""}</div>}
                                {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {likely}</div>}
                                {isMismatch ? (
                                  <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>
                                    ⚠ Field mismatch: {mismatchFields.join(", ")}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: "11px", color: "#c62828", marginTop: "3px" }}>
                                    {isPipeline ? "In CRM — not in Pipeline" : "In CRM — not in Confirmed"}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          return getAlertSummary(alert);
                        })()}
                      </button>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* Sticky bulk action bar */}
          {bulkMode && bulkSelected.size > 0 && (
            <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "2px solid #7c3aed",
              padding: "12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap",
              boxShadow: "0 -2px 8px rgba(0,0,0,0.08)", zIndex: 10, marginTop: "12px" }}>
              <span style={{ fontSize: "13px", color: "#5b21b6", fontWeight: "600", flex: 1 }}>
                {bulkSelected.size} alert{bulkSelected.size !== 1 ? "s" : ""} selected
              </span>
              <button className="triage-btn" onClick={() => setShowBulkIgnoreModal(true)}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#dc2626", borderColor: "#fca5a5" }}>
                🚫 Ignore selected
              </button>
              <button className="triage-btn" onClick={() => setShowBulkTaskModal(true)}
                style={{ background: "#7c3aed", color: "white", border: "none", borderRadius: "6px",
                  padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer" }}>
                📋 Create tasks
              </button>
            </div>
          )}

          {/* Bulk ignore modal */}
          {showBulkIgnoreModal && (
            <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowBulkIgnoreModal(false); }}>
              <div style={styles.modalCard}>
                <h3 style={styles.modalTitle}>Ignore {bulkSelected.size} Alert{bulkSelected.size !== 1 ? "s" : ""}</h3>
                <p style={styles.modalSubtitle}>These alerts will be marked as ignored and removed from future triage runs.</p>
                <textarea value={bulkIgnoreReason} onChange={e => setBulkIgnoreReason(e.target.value)}
                  placeholder="Reason for ignoring (optional)..." style={styles.modalTextarea} autoFocus />
                <div style={styles.modalButtons}>
                  <button className="triage-btn" onClick={() => setShowBulkIgnoreModal(false)} style={styles.buttonSecondary}>Cancel</button>
                  <button className="triage-btn" onClick={bulkIgnore} disabled={bulkSubmitting}
                    style={{ background: "#dc2626", color: "white", border: "none", borderRadius: "6px",
                      padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer",
                      opacity: bulkSubmitting ? 0.5 : 1 }}>
                    {bulkSubmitting ? <><Spinner />Ignoring...</> : `🚫 Ignore ${bulkSelected.size} alert${bulkSelected.size !== 1 ? "s" : ""}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk create tasks modal */}
          {showBulkTaskModal && (
            <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowBulkTaskModal(false); }}>
              <div style={styles.modalCard}>
                <h3 style={styles.modalTitle}>Create {bulkSelected.size} Task{bulkSelected.size !== 1 ? "s" : ""}</h3>
                <p style={styles.modalSubtitle}>These alerts will be added to your task list for follow-up.</p>
                <textarea value={bulkTaskNote} onChange={e => setBulkTaskNote(e.target.value)}
                  placeholder="Shared note for all tasks (optional)..." style={styles.modalTextarea} autoFocus />
                <div style={{ marginTop: "12px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
                  <div style={{ fontSize: "13px", fontWeight: "600", color: "#444", marginBottom: "8px" }}>Snooze until (optional)</div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <input type="date" value={bulkTaskSnoozeDate}
                      min={new Date().toISOString().split("T")[0]}
                      onChange={e => setBulkTaskSnoozeDate(e.target.value)}
                      style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px" }} />
                    {bulkTaskSnoozeDate && (
                      <>
                        <input type="time" value={bulkTaskSnoozeTime}
                          onChange={e => setBulkTaskSnoozeTime(e.target.value)}
                          style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", width: "100px" }} />
                        <button className="triage-btn" onClick={() => { setBulkTaskSnoozeDate(""); setBulkTaskSnoozeTime("09:00"); }}
                          style={{ fontSize: "12px", padding: "5px 8px", color: "#888", borderColor: "#ddd" }}>✕ Clear</button>
                      </>
                    )}
                  </div>
                  {bulkTaskSnoozeDate && (
                    <div style={{ fontSize: "12px", color: "#d97706", marginTop: "6px" }}>
                      Tasks will be snoozed until {new Date(`${bulkTaskSnoozeDate}T${bulkTaskSnoozeTime}:00`).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
                    </div>
                  )}
                </div>
                <div style={styles.modalButtons}>
                  <button className="triage-btn" onClick={() => setShowBulkTaskModal(false)} style={styles.buttonSecondary}>Cancel</button>
                  <button className="triage-btn" onClick={bulkCreateTasks} disabled={bulkSubmitting}
                    style={{ background: bulkTaskSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none",
                      borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px",
                      cursor: "pointer", opacity: bulkSubmitting ? 0.5 : 1 }}>
                    {bulkSubmitting ? <><Spinner />Creating...</> : bulkTaskSnoozeDate
                      ? `📋 Create & Snooze ${bulkSelected.size} task${bulkSelected.size !== 1 ? "s" : ""}`
                      : `📋 Create ${bulkSelected.size} task${bulkSelected.size !== 1 ? "s" : ""}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Non-actionable flags section */}
          {clientNoActionAlerts.length > 0 && (
            <div style={styles.noActionSection}>
              <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#666", marginBottom: "10px" }}>
                Informational Flags
                <span style={{ fontWeight: "400", marginLeft: "8px", fontSize: "12px" }}>
                  ({resolvedNoActionFlags.size}/{clientNoActionAlerts.length} resolved)
                </span>
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {clientNoActionAlerts.map((na) => {
                  const isResolved = resolvedNoActionFlags.has(na.flagType);
                  const isRichFlag = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated", "retainerInvoicesDeleted", "crmCopiedConfDelete", "invoiceStaleUnsentChanges"].includes(na.flagType);
                  const analysis = noActionAnalysis[na.flagType];
                  const isLoading = noActionAnalysisLoading[na.flagType];

                  if (isRichFlag && !isResolved) {
                    // Rich analysis card
                    const overallOk = analysis?.overallOk;
                    const hasIssues = analysis && !analysis.overallOk;
                    const borderColor = !analysis ? "#e0e0e0" : overallOk ? "#c8e6c9" : "#ffccbc";
                    const bgColor = !analysis ? "#fff" : overallOk ? "#f1f8f2" : "#fff8f6";

                    return (
                      <div key={na.flagType} style={{ border: `1px solid ${borderColor}`, borderRadius: "6px", background: bgColor, padding: "12px" }}>
                        {/* Header row */}
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: analysis ? "10px" : "0", flexWrap: "wrap", gap: "8px" }}>
                          <span style={{ fontSize: "13px", fontWeight: "600", color: "#444", flexShrink: 1, minWidth: 0 }}>
                            {na.flagName || getFlagName(na.flagType)}
                          </span>
                          <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
                            {selectedClient?.clientSheetId && (
                              <button className="triage-btn"
                                onClick={() => {
                                  if (selectedClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`, "_blank");
                                  if (selectedClient.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`, "_blank");
                                }}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#1d4ed8", borderColor: "#93c5fd" }}
                              >
                                📊 Open Sheets
                              </button>
                            )}
                            {!analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na.flagType)}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                              >
                                🔍 Analyse
                              </button>
                            )}
                            {isLoading && (
                              <span style={{ fontSize: "12px", color: "#888", padding: "5px 10px", display: "inline-flex", alignItems: "center" }}><Spinner size={12} />Analysing…</span>
                            )}
                            {analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na.flagType)}
                                style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 8px" }}
                              >
                                ↻ Re-run
                              </button>
                            )}
                            <button className="triage-btn"
                              onClick={() => {
                                const newResolved = new Set([...resolvedNoActionFlags, na.flagType]);
                                setResolvedNoActionFlags(newResolved);
                                // Zero out this flag in clientsWithFlags so the pill disappears on the client selection screen
                                setClientsWithFlags(prev => prev.map(c => {
                                  if (c.clientName !== selectedClient?.clientName) return c;
                                  return { ...c, flags: { ...c.flags, [na.flagType]: false } };
                                }));
                                if (sessionId && selectedClient) {
                                  // Persist to Redis session and clear from precomputed cache
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType, automationCommanderSheetId }),
                                  }).catch(() => {});
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: [na.flagType] }),
                                  }).catch(() => {});
                                }
                                // Auto-clear this flag group if it qualifies (rich noAction flags only)
                                if (RICH_NOACTION_FLAG_GROUP[na.flagType]) {
                                  autoClearFlags(clientAlerts, newResolved).catch(() => {});
                                }
                              }}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                            >
                              ✓ Mark resolved
                            </button>
                          </div>
                        </div>

                        {/* Analysis results */}
                        {analysis && !isLoading && (
                          <div>
                            {/* Overall status banner */}
                            <div style={{
                              padding: "6px 10px",
                              borderRadius: "4px",
                              marginBottom: "8px",
                              fontSize: "12px",
                              fontWeight: "600",
                              background: overallOk ? "#e8f5e9" : "#fbe9e7",
                              color: overallOk ? "#2e7d32" : "#bf360c",
                            }}>
                              {overallOk ? "✓ Everything looks correct" : "⚠ Issues found — review below"}
                            </div>

                            {/* Per-job results */}
                            {(analysis.results || []).map((r, ri) => (
                              <div key={ri} style={{
                                marginBottom: "8px",
                                padding: "8px 10px",
                                borderRadius: "4px",
                                border: `1px solid ${r.status === "ok" ? "#c8e6c9" : r.status === "issue" ? "#ffccbc" : "#e0e0e0"}`,
                                background: r.status === "ok" ? "#f9fef9" : r.status === "issue" ? "#fff8f6" : "#fafafa",
                              }}>
                                {/* Job header */}
                                {(r.jobName || r.projectCode) && (
                                  <div style={{ fontSize: "12px", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                                    {r.clientName && (
                                      <span style={{ fontWeight: "400", color: "#666" }}>{r.clientName} — </span>
                                    )}
                                    {r.jobName || r.projectCode}
                                    {r.projectCode && r.jobName && (
                                      <TruncatedCode code={r.projectCode} />
                                    )}
                                    {r.periodLabel && (
                                      <span style={{ fontWeight: "400", color: "#666", marginLeft: "6px" }}> — {r.periodLabel}</span>
                                    )}
                                    {r.parentSheetRow && (
                                      <span style={{ fontWeight: "400", color: "#aaa", marginLeft: "6px", fontSize: "11px" }}>{r.tab || "Confirmed"} row {r.parentSheetRow}</span>
                                    )}
                                    {(r.pipelineRow || r.confirmedRow) && (
                                      <span style={{ fontWeight: "400", color: "#aaa", marginLeft: "6px", fontSize: "11px" }}>
                                        {r.pipelineRow ? `Pipeline row ${r.pipelineRow}` : ""}
                                        {r.pipelineRow && r.confirmedRow ? " · " : ""}
                                        {r.confirmedRow ? `Confirmed row ${r.confirmedRow}` : ""}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {/* Info message (no job breakdown) */}
                                {r.message && (!r.checks || r.checks.length === 0) && (
                                  <div style={{ fontSize: "12px", color: "#666" }}>{r.message}</div>
                                )}
                                {/* Check lines */}
                                {(r.checks || []).map((chk, ci) => (
                                  <div key={ci} style={{ fontSize: "12px", color: chk.ok ? "#2e7d32" : "#c62828", marginTop: "2px" }}>
                                    {(() => {
                                      // Split message on (LONG_CODE) tokens and render codes via TruncatedCode
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
                        )}

                        {/* API error */}
                        {analysis && !analysis.success && (
                          <div style={{ fontSize: "12px", color: "#c62828", marginTop: "6px" }}>
                            Error: {analysis.error}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Simple flag (no rich analysis) or resolved
                  return (
                    <div
                      key={na.flagType}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "4px",
                        border: `1px solid ${isResolved ? "#c8e6c9" : "#e0e0e0"}`,
                        background: isResolved ? "#f1f8f2" : "#fff",
                        gap: "12px",
                      }}
                    >
                      <span style={{
                        fontSize: "13px",
                        color: isResolved ? "#2e7d32" : "#555",
                        textDecoration: isResolved ? "line-through" : "none",
                      }}>
                        {na.flagName || getFlagName(na.flagType)}
                      </span>
                      {isResolved ? (
                        <span style={{ fontSize: "12px", color: "#2e7d32", fontWeight: "600", whiteSpace: "nowrap" }}>
                          ✓ Resolved
                        </span>
                      ) : (
                        <button className="triage-btn"
                          onClick={() => {
                                setResolvedNoActionFlags(prev => new Set([...prev, na.flagType]));
                                // Zero out this flag in clientsWithFlags so the pill disappears on the client selection screen
                                setClientsWithFlags(prev => prev.map(c => {
                                  if (c.clientName !== selectedClient?.clientName) return c;
                                  return { ...c, flags: { ...c.flags, [na.flagType]: false } };
                                }));
                                if (sessionId && selectedClient) {
                                  // Persist to Redis session and clear from precomputed cache
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType, automationCommanderSheetId }),
                                  }).catch(() => {});
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: [na.flagType] }),
                                  }).catch(() => {});
                                }
                              }}
                          style={{
                            ...styles.buttonSecondary,
                            fontSize: "12px",
                            padding: "5px 10px",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          Mark resolved
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bottom button row — always visible */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
            <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
              ← Back to Clients
            </button>
            <button className="triage-btn"
              onClick={() => {
                setFlagsToClear(computeFlagGroups(selectedClient, clientAlerts));
                setScreen("clearFlags");
              }}
              style={styles.buttonSecondary}
            >
              Clear Flags →
            </button>
          </div>
        </div>
        </div>
      </NavShell>
    );
  }

  // Screen 1d: Clear Flags Screen
  if (screen === "clearFlags" && selectedClient && activeNav !== "tasks") {
    const allChecked = flagsToClear.invoice && flagsToClear.crm && flagsToClear.expense;
    const noneChecked = !flagsToClear.invoice && !flagsToClear.crm && !flagsToClear.expense;
    const anyActive = flagsToClear.invoice || flagsToClear.crm || flagsToClear.expense;

    const FLAG_GROUPS = [
      {
        key: "invoice",
        label: "Invoice flags",
        sub: "Clears AS2 in DataChgAlert",
        flags: ["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated", "retainerInvoicesDeleted"],
      },
      {
        key: "crm",
        label: "CRM flags",
        sub: "Clears AT2 and AU2 in DataChgAlert",
        flags: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
                "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked",
                "crmCopiedConfUnchecked", "crmCopiedConfDelete"],
      },
      {
        key: "expense",
        label: "Expense flags",
        sub: "Clears AV2 in DataChgAlert",
        flags: ["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"],
      },
    ];

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Clear Flags</h1>
            <p style={styles.subtitle}>{selectedClient.clientName} — select which flags to clear</p>
          </div>

          <div style={styles.card}>
            {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

            <div style={{ ...styles.successBanner, marginBottom: "20px" }}>
              Select which flag groups to clear in the client's DataChgAlert sheet. Groups with unresolved alerts are unchecked by default.
            </div>

            {/* Select All / None toggle */}
            <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
              <button className="triage-btn"
                onClick={() => setFlagsToClear({ invoice: true, crm: true, expense: true })}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}
              >
                Select All
              </button>
              <button className="triage-btn"
                onClick={() => setFlagsToClear({ invoice: false, crm: false, expense: false })}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}
              >
                Select None
              </button>
            </div>

            {/* Per-group toggles */}
            {FLAG_GROUPS.map(group => {
              const isChecked = flagsToClear[group.key];
              const hasActiveFlags = group.flags.some(f => selectedClient.flags?.[f]);
              return (
                <div
                  key={group.key}
                  style={{
                    ...styles.flagToggleRow,
                    ...(isChecked ? styles.flagToggleRowActive : {}),
                  }}
                  onClick={() => setFlagsToClear(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}}
                    style={styles.flagCheckbox}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={styles.flagToggleLabel}>
                      {group.label}
                      {hasActiveFlags && (
                        <span style={{ marginLeft: "8px", fontSize: "11px", color: "#e65100", fontWeight: "700" }}>
                          ● active
                        </span>
                      )}
                    </div>
                    <div style={styles.flagToggleSub}>{group.sub}</div>
                  </div>
                </div>
              );
            })}

            <div style={{ display: "flex", gap: "12px", flexDirection: "column", marginTop: "20px" }}>
              <button className="triage-btn triage-btn-primary"
                onClick={clearSelectedFlags}
                disabled={isLoading || noneChecked}
                style={{
                  ...styles.button,
                  opacity: isLoading || noneChecked ? 0.5 : 1,
                }}
              >
                {isLoading
                  ? <><Spinner color="white" />Clearing...</>
                  : allChecked
                  ? "✓ Clear All Flags"
                  : anyActive
                  ? "✓ Clear Selected Flags"
                  : "Select flags to clear"}
              </button>
              <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
                ← Back to Clients
              </button>
            </div>
          </div>
        </div>
      </NavShell>
    );
  }

  // Screen 1: Loading state (shown while startTriage runs on mount)
  if (!sessionId && !triageComplete && activeNav !== "tasks" && activeNav !== "overview") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Automation Alerts</h1>
            <p style={styles.subtitle}>Review and resolve financial automation alerts</p>
          </div>
          <div style={styles.card}>
            {error ? (
              <>
                <div style={styles.errorBanner}>{error}</div>
                <button className="triage-btn"
                  onClick={startTriage}
                  disabled={isLoading}
                  style={{ ...styles.button, marginTop: "12px", opacity: isLoading ? 0.5 : 1 }}
                >
                  {isLoading ? <><Spinner color="white" />Loading...</> : "Retry →"}
                </button>
              </>
            ) : (
              <p style={styles.loadingText}>
                {isLoading ? <><Spinner color="white" />Loading alerts...</> : "Initialising..."}
              </p>
            )}
          </div>
        </div>
      </NavShell>
    );
  }

  // Screen 2: Triage complete with no alerts
  if (triageComplete && totalAlerts === 0 && noActionCount === 0 && activeNav !== "tasks" && activeNav !== "overview") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>✓ All Clear</h1>
          <p style={styles.subtitle}>No alerts to triage</p>
        </div>

        <div style={styles.card}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: "32px 16px" }}>
              <Spinner size={32} color="#0066cc" />
              <div style={{ fontSize: "15px", fontWeight: "600", color: "#333", marginTop: "12px", marginBottom: "6px" }}>
                Checking for new alerts...
              </div>
              <div style={{ fontSize: "13px", color: "#888" }}>
                Reading latest flags from your sheets
              </div>
            </div>
          ) : (
            <>
              <div style={styles.successBanner}>
                No discrepancies detected. Your financial automation system is running smoothly!
              </div>
              <div style={styles.buttonGroup}>
                <button className="triage-btn triage-btn-primary" onClick={refreshTriage} style={styles.button}>
                  ↻ Refresh
                </button>
              </div>
            </>
          )}
        </div>

        {/* Proactive alerts — shown even when no automation alerts */}
        <div style={{ ...styles.card, marginTop: "16px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>
            Proactive Alerts {!proactiveLoading && proactiveAlerts.length > 0 && `(${proactiveAlerts.length})`}
          </h2>
          {proactiveLoading ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#666", fontSize: "13px" }}>
              <Spinner size={20} color="#0066cc" />
              <div style={{ marginTop: "8px" }}>Loading proactive alerts...</div>
            </div>
          ) : proactiveAlerts.length === 0 && proactiveLoadedAt > 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#888", fontSize: "13px" }}>
              ✓ No proactive alerts
            </div>
          ) : proactiveAlerts.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#888", fontSize: "13px" }}>
              Checking for proactive alerts...
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {(() => {
                const typeLabels = {
                  retainer_invoice:           "Retainer invoice",
                  crm_wipe:                   "CRM data wipe",
                  revenue_mismatch:           "Revenue / invoiced mismatch",
                  direct_costs_mismatch:      "Direct costs / expenses mismatch",
                  pipeline_confirmed_overlap: "Pipeline / Confirmed overlap",
                  retainer_shrink_blocked:    "Retainer row blocked from trimming",
                };
                const grouped = {};
                proactiveAlerts.forEach(a => {
                  if (!grouped[a.clientName]) grouped[a.clientName] = [];
                  grouped[a.clientName].push(a);
                });
                return Object.entries(grouped).map(([clientName, alerts], idx) => {
                  const typeCounts = {};
                  alerts.forEach(a => {
                    const label = typeLabels[a.alertType] || a.alertType || "Alert";
                    typeCounts[label] = (typeCounts[label] || 0) + 1;
                  });
                  return (
                    <button key={idx} className="triage-client-card"
                      onClick={() => { setProactiveSelectedClient(clientName); setScreen("proactiveReview"); }}
                      style={{ ...styles.optionButton, textAlign: "left", padding: "16px", border: "1px solid #ddd", borderRadius: "6px", backgroundColor: "#f9f9f9", width: "100%" }}>
                      <div style={{ fontWeight: "bold", fontSize: "16px", marginBottom: "6px" }}>{clientName}</div>
                      {Object.entries(typeCounts).map(([type, count], i) => (
                        <div key={i} style={{ fontSize: "13px", color: "#d97706", marginBottom: "2px" }}>
                          • {type} ({count} alert{count !== 1 ? "s" : ""})
                        </div>
                      ))}
                    </button>
                  );
                });
              })()}
            </div>
          )}
          <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end" }}>
            <button className="triage-btn" onClick={loadProactiveAlerts} disabled={proactiveLoading}
              style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: proactiveLoading ? 0.5 : 1 }}>
              {proactiveLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>
        </div>

      </div>
      </NavShell>
    );
  }

  // Screen 3b: Display individual alert with Claude analysis (NEW CLIENT-BASED FLOW)
  if (screen === "triageAnalysis" && selectedClient && clientAlerts.length > 0 && activeNav !== "tasks") {
    const alert = clientAlerts[currentClientAlertIndex];
    const progress = currentClientAlertIndex + 1;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
        </div>

        <div style={styles.card}>
          <div style={styles.alertHeader}>
            <h2 style={styles.alertTitle}>
              {alert.clientName || alert.type || "Financial Alert"}
              {fromCache && (
                <span style={styles.cacheBadge}>⚡ Cached</span>
              )}
            </h2>
            <span style={styles.alertCounter}>{progress}/{clientAlerts.length}</span>
          </div>

          {alert.flagType && (
            <div style={{ ...styles.alertMetadata, fontSize: "15px", fontWeight: "600", padding: "14px", marginBottom: "16px" }}>
              {alert.flagType}
            </div>
          )}

          {alert.type === "locked" && alert.summary?.lockedMessage && (
            <div style={{ ...styles.alertSummary, marginBottom: "20px", backgroundColor: "#fff3e0", borderLeft: "4px solid #f59e0b" }}>
              <h3 style={{ fontSize: "13px", fontWeight: "700", marginBottom: "8px", color: "#92400e", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                🔒 Automation In Progress
              </h3>
              <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#78350f" }}>
                {alert.summary.lockedMessage}
              </div>
            </div>
          )}

          {alert.summary && alert.type !== "locked" && (
            <div style={{ ...styles.alertSummary, marginBottom: "20px" }}>
              <h3 style={{ fontSize: "13px", fontWeight: "700", marginBottom: "8px", color: "#1a1a1a", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {alert.type === "expense" ? "Unmatched Expense"
                  : (() => {
                      const flags = alert.data?.flags || [];
                      if (String(flags[2]||"").trim() === "1" && String(flags[0]||"").trim() !== "1") return "Invoice Amount Mismatch";
                      if (String(flags[0]||"").trim() === "1") return "Unmatched Invoice";
                      const invFlagNames2 = [null,"Client mismatch",null,"Sent date mismatch",null,"Fully paid on mismatch","Status mismatch"];
                      const active = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames2[i] ? invFlagNames2[i] : null).filter(Boolean);
                      return active.length > 0 ? active.join(", ") : "Invoice Discrepancy";
                    })()
                }
              </h3>
              <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#333" }}>
                {alert.type === "expense" ? (
                  // Expense display
                  <>
                    {alert.summary.reference && <div><strong>Reference:</strong> {alert.summary.reference}</div>}
                    {alert.summary.description && <div><strong>Description:</strong> {alert.summary.description}</div>}
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{(() => {
                      const vat = parseFloat(String(alert.summary.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
                      return vat > 0 ? " +VAT" : " (no VAT)";
                    })()}</div>
                    {alert.summary.date && <div><strong>Date:</strong> {alert.summary.date}</div>}
                    {alert.summary.accountName && <div><strong>Account Name:</strong> {alert.summary.accountName}</div>}
                    {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                    {alert.summary.transactionId && <div><strong>Transaction ID:</strong> {alert.summary.transactionId}</div>}
                  </>
                ) : (
                  // Invoice display
                  <>
                    <div><strong>Invoice:</strong> {alert.summary.invoiceNo}</div>
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{alert.summary.vatIncluded && alert.summary.vatIncluded > 0 ? " +VAT" : " (no VAT)"}</div>
                    <div><strong>Client:</strong> {alert.summary.client}</div>
                    {alert.summary.job && <div><strong>Description:</strong> {alert.summary.job}</div>}
                    {alert.summary.sentDate && <div><strong>Sent:</strong> {alert.summary.sentDate}</div>}
                    {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                  </>
                )}
              </div>
            </div>
          )}

          {acceptError && (
            <div style={{ ...styles.errorBanner, marginBottom: "16px" }}>
              {acceptError}
              {acceptError.includes("go back to the alert list") && (
                <div style={{ marginTop: "10px" }}>
                  <button
                    className="triage-btn"
                    onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }}
                    style={{ ...styles.buttonSecondary, fontSize: "13px" }}
                  >
                    ← Back to Alert List
                  </button>
                </div>
              )}
            </div>
          )}

          {claudeAnalysis && (
            <div>
              {previousIgnoreReason && (
                <div style={{ marginBottom: "12px", padding: "10px 14px", backgroundColor: "#fff8e1", borderLeft: "4px solid #f59e0b", borderRadius: "4px", fontSize: "13px", color: "#78350f" }}>
                  <strong>⚠ Previously ignored:</strong> {previousIgnoreReason}
                </div>
              )}
              <h3 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>
                Potential Actions
              </h3>
              {(() => {
                try {
                  const options = JSON.parse(claudeAnalysis);
                  if (Array.isArray(options)) {
                    return options.map((option, idx) => (
                      <div key={idx} style={{ ...styles.optionCard, marginBottom: "16px" }}>
                        <div style={styles.optionTitle}>
                          Option {idx + 1}: {option.title}
                        </div>
                        {option.jobName && option.matchType !== "info" && (
                          <div style={styles.optionDetail}>
                            <strong>Job:</strong> {option.jobName} (Row {option.jobRow})
                          </div>
                        )}

                        {/* Info matchType: explanation + job details, Mark as resolved button */}
                        {option.matchType === "info" && (
                          <>
                            {option.explanation && (
                              <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#fff8e1", borderLeft: "3px solid #f59e0b", fontSize: "13px", lineHeight: "1.5" }}>
                                {option.explanation}
                              </div>
                            )}
                            {option.jobDetails && (
                              <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                                <strong style={{ color: "#1d4ed8", fontSize: "12px" }}>Job Details:</strong>
                                <div style={{ marginTop: "6px", fontSize: "12px", color: "#333" }}>
                                  {option.jobDetails.clientName && <div><strong>Client:</strong> {option.jobDetails.clientName}</div>}
                                  {option.jobDetails.jobName && <div><strong>Job:</strong> {option.jobDetails.jobName}</div>}
                                  {option.jobDetails.projectCode && <div><strong>Code:</strong> {option.jobDetails.projectCode}</div>}
                                  {option.jobDetails.revenue && <div><strong>Revenue:</strong> {option.jobDetails.revenue}</div>}
                                  {option.jobDetails.vatSetting && <div><strong>VAT:</strong> {option.jobDetails.vatSetting}</div>}
                                  {option.jobDetails.startDate && <div><strong>Dates:</strong> {option.jobDetails.startDate} → {option.jobDetails.endDate || "?"}</div>}
                                  {option.jobDetails.slot1 && !option.jobDetails.slot1.startsWith("(empty)") && <div><strong>Inv 1:</strong> {option.jobDetails.slot1}</div>}
                                  {option.jobDetails.slot2 && !option.jobDetails.slot2.startsWith("(empty)") && <div><strong>Inv 2:</strong> {option.jobDetails.slot2}</div>}
                                  {option.jobDetails.slot3 && !option.jobDetails.slot3.startsWith("(empty)") && <div><strong>Inv 3:</strong> {option.jobDetails.slot3}</div>}
                                </div>
                              </div>
                            )}
                            {option.recommendedActions && option.recommendedActions.length > 0 && (
                              <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                                <strong>Actions:</strong>
                                {option.recommendedActions.map((action, i) => (
                                  <div key={i} style={{ marginTop: "4px", fontSize: "13px" }}>
                                    {i === 0 ? <strong style={{ color: "#059669" }}>✓ {action}</strong> : `• ${action}`}
                                  </div>
                                ))}
                              </div>
                            )}
                            <button className="triage-btn triage-btn-primary"
                              onClick={() => {
                                const alert2 = clientAlerts[currentClientAlertIndex];
                                const alertId = `${alert2.sheetName}-${alert2.rowNumber}`;
                                setProcessedAlerts(new Set([...processedAlerts, alertId]));
                                if (sessionId) {
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
                                  }).catch(() => {});
                                }
                                const updatedAlerts = clientAlerts.filter((_, i) => i !== currentClientAlertIndex);
                                setClientAlerts(updatedAlerts);
                                if (updatedAlerts.length === 0) {
                                  if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                                  else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                                } else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                              }}
                              style={{ ...styles.decisionButton, ...styles.approveButton, marginTop: "12px", width: "100%" }}
                            >
                              ✓ Mark as Resolved
                            </button>
                          </>
                        )}
                        {/* Standard (non-info) rendering: CRM details, match analysis, accept button */}
                        {option.matchType !== "info" && (<>
                        {/* Explanation and revenue impact for invoice amount mismatch options */}
                        {option.explanation && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#fff8e1", borderLeft: "3px solid #f59e0b", fontSize: "13px", lineHeight: "1.5" }}>
                            {option.explanation}
                          </div>
                        )}
                        {option.slotBreakdown && option.slotBreakdown.lines && option.slotBreakdown.lines.length > 0 && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6", fontSize: "12px" }}>
                            <strong style={{ color: "#1d4ed8", display: "block", marginBottom: "6px" }}>Invoice slots on this job:</strong>
                            {option.slotBreakdown.lines.map((line, i) => (
                              <div key={i} style={{ fontFamily: "monospace", color: line.includes("← this invoice") ? "#0f766e" : line.includes("MANUAL-INV") ? "#9333ea" : "#333", marginBottom: "2px", fontWeight: line.includes("← this invoice") ? "600" : "400" }}>
                                {line}
                              </div>
                            ))}
                            <div style={{ marginTop: "8px", paddingTop: "6px", borderTop: "1px solid #bfdbfe", color: "#1e40af", fontWeight: "600" }}>
                              New real total invoiced (excl. MANUAL-INV): {option.slotBreakdown.correctedTotal} / Revenue: {option.slotBreakdown.currentRevenue} ({option.slotBreakdown.revenueRatio})
                            </div>
                          </div>
                        )}
                        {option.revenueImpact && (
                          <div style={{ ...styles.optionDetail, marginTop: "6px", padding: "10px", backgroundColor: "#fef2f2", borderLeft: "3px solid #ef4444", fontSize: "13px", fontWeight: "500" }}>
                            ⚠ Revenue impact: {option.revenueImpact}
                          </div>
                        )}
                        {/* CRM matching details */}
                        {option.matchingDetails && typeof option.matchingDetails === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#f5f3ff", borderLeft: "3px solid #7c3aed" }}>
                            <strong style={{ color: "#5b21b6" }}>CRM Job Matching Details:</strong>
                            {option.matchingDetails.unmatchedJobSummary && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>
                                  {option.matchType === "ignore" || option.matchType === "delete"
                                    ? "Unmatched job — in dashboard but not in CRM:"
                                    : "Unmatched Job (CRM):"}
                                </strong>
                                <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px" }}>
                                  {option.matchingDetails.unmatchedJobSummary.clientName && <div>Client: {option.matchingDetails.unmatchedJobSummary.clientName}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.jobName && <div>Job: {option.matchingDetails.unmatchedJobSummary.jobName}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.projectCode && <div>Code: {option.matchingDetails.unmatchedJobSummary.projectCode}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.revenue && <div>Revenue: {option.matchingDetails.unmatchedJobSummary.revenue}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.startDate && <div>Dates: {option.matchingDetails.unmatchedJobSummary.startDate} → {option.matchingDetails.unmatchedJobSummary.endDate || "?"}</div>}
                                </div>
                              </div>
                            )}
                            {option.matchingDetails.matchedJobDetails && (
                              <div style={{ marginTop: "8px", fontSize: "13px", color: "#333" }}>
                                <strong>Matched Job ({option.matchType === 'create_new' ? 'Would Create New' : 'In Sheet'}):</strong>
                                {option.matchType === 'create_new' ? (
                                  <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px", color: "#7c3aed" }}>
                                    Create new job matching the CRM details above
                                  </div>
                                ) : (
                                  <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px" }}>
                                    {option.matchingDetails.matchedJobDetails.projectCode && <div>Code: {option.matchingDetails.matchedJobDetails.projectCode}</div>}
                                    {option.matchingDetails.matchedJobDetails.clientName && <div>Client: {option.matchingDetails.matchedJobDetails.clientName}</div>}
                                    {option.matchingDetails.matchedJobDetails.jobName && <div>Job: {option.matchingDetails.matchedJobDetails.jobName}</div>}
                                    {option.matchingDetails.matchedJobDetails.revenue && <div>Revenue: {option.matchingDetails.matchedJobDetails.revenue}</div>}
                                    {option.matchingDetails.matchedJobDetails.startDate && <div>Dates: {option.matchingDetails.matchedJobDetails.startDate} → {option.matchingDetails.matchedJobDetails.endDate}</div>}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {/* CRM match analysis - ONLY show for CRM/invoices, not expenses */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && !option.allocationBreakdown && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                            <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                            {option.matchAnalysis.matchConfidence && (
                              <div style={{ marginTop: "6px", fontSize: "13px" }}>
                                <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                              </div>
                            )}
                            {option.matchAnalysis.clientNameMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Client Name:</strong> {option.matchAnalysis.clientNameMatch}
                              </div>
                            )}
                            {option.matchAnalysis.jobNameMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Job Name:</strong> {option.matchAnalysis.jobNameMatch}
                              </div>
                            )}
                            {option.matchAnalysis.revenueMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Revenue:</strong> {option.matchAnalysis.revenueMatch}
                              </div>
                            )}
                            {option.matchAnalysis.dateRangeMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Dates:</strong> {option.matchAnalysis.dateRangeMatch}
                              </div>
                            )}
                            {option.matchAnalysis.projectCodeMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Project Code:</strong> {option.matchAnalysis.projectCodeMatch}
                              </div>
                            )}
                            {option.matchAnalysis.reasonForChoice && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                                <strong>Why:</strong> {option.matchAnalysis.reasonForChoice}
                              </div>
                            )}
                            {option.matchAnalysis.discrepancies && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                                <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                              </div>
                            )}
                            {option.matchAnalysis.whyItDidntAutoMatch && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#666" }}>
                                <strong>Why no auto-match:</strong> {option.matchAnalysis.whyItDidntAutoMatch}
                              </div>
                            )}
                          </div>
                        )}
                        {/* NEW FORMAT: Display allocation breakdown for expenses */}
                        {option.allocationBreakdown && typeof option.allocationBreakdown === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                            <strong style={{ color: "#1e40af" }}>Direct Cost Allocation:</strong>
                            {option.allocationBreakdown.jobDirectCostBudget && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>Total Budget:</strong> {option.allocationBreakdown.jobDirectCostBudget}
                              </div>
                            )}
                            {option.allocationBreakdown.allocatedExpenses && Array.isArray(option.allocationBreakdown.allocatedExpenses) && option.allocationBreakdown.allocatedExpenses.length > 0 && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>Allocated Expenses:</strong>
                                <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                  {option.allocationBreakdown.allocatedExpenses.map((exp, i) => (
                                    <li key={i} style={{ color: "#444", marginBottom: "2px" }}>{exp}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {option.allocationBreakdown.totalAllocated && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Total Allocated:</strong> {option.allocationBreakdown.totalAllocated}
                              </div>
                            )}
                            {option.allocationBreakdown.placeholderExpenses && Array.isArray(option.allocationBreakdown.placeholderExpenses) && option.allocationBreakdown.placeholderExpenses.length > 0 && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#b45309" }}>
                                <strong>Pending Placeholders:</strong>
                                <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                  {option.allocationBreakdown.placeholderExpenses.map((exp, i) => (
                                    <li key={i} style={{ color: "#92400e", marginBottom: "2px" }}>{exp}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {option.allocationBreakdown.remainingBudget && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#059669", fontWeight: "bold" }}>
                                Remaining Budget: {option.allocationBreakdown.remainingBudget}
                              </div>
                            )}
                            {option.allocationBreakdown.expenseCanFit && (
                              <div style={{
                                marginTop: "6px", fontSize: "13px",
                                color: String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "#059669" : "#dc2626"
                              }}>
                                {String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "✓" : "✗"} {option.allocationBreakdown.expenseCanFit}
                              </div>
                            )}
                          </div>
                        )}
                        {/* NEW FORMAT: Display match analysis */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                            <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                            {option.matchAnalysis.matchConfidence && (
                              <div style={{ marginTop: "6px", fontSize: "13px" }}>
                                <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                              </div>
                            )}
                            {option.matchAnalysis.vendorAnalysis && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Vendor:</strong> {option.matchAnalysis.vendorAnalysis}
                              </div>
                            )}
                            {option.matchAnalysis.placeholderMatch && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Placeholder Match:</strong> {option.matchAnalysis.placeholderMatch}
                              </div>
                            )}
                            {option.matchAnalysis.budgetFit && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Budget Fit:</strong> {option.matchAnalysis.budgetFit}
                              </div>
                            )}
                            {option.matchAnalysis.reasonForChoice && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                                {option.matchAnalysis.reasonForChoice}
                              </div>
                            )}
                            {option.matchAnalysis.discrepancies && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                                <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                              </div>
                            )}
                          </div>
                        )}
                        {option.facts && typeof option.facts === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "13px", color: "#555" }}>
                              {option.facts.jobType && <li><strong>Type:</strong> {option.facts.jobType}</li>}
                              {option.facts.totalRevenue && <li><strong>Total revenue:</strong> £{option.facts.totalRevenue.toLocaleString()}</li>}
                              {option.facts.startDate && <li><strong>Start date:</strong> {option.facts.startDate}</li>}
                              {option.facts.endDate && <li><strong>End date:</strong> {option.facts.endDate}</li>}
                              {option.facts.existingInvoices && (
                                <li>
                                  <strong>Existing invoices:</strong>
                                  <div style={{ marginTop: "4px", fontFamily: "monospace", fontSize: "11px", color: "#333", lineHeight: "1.6" }}>
                                    {option.facts.existingInvoices.split(/\.\s+(?=Row )/).map((line, i) => (
                                      <div key={i} style={{ paddingLeft: "4px", borderLeft: "2px solid #e0e0e0", marginBottom: "2px" }}>{line.trim()}</div>
                                    ))}
                                  </div>
                                </li>
                              )}
                              {option.facts.remainingToInvoice && <li><strong>Left to invoice:</strong> £{option.facts.remainingToInvoice.toLocaleString()}</li>}
                              {option.facts.invoiceMatchStatus && <li><strong>{option.facts.invoiceMatchStatus}</strong></li>}
                            </ul>
                          </div>
                        )}
                        {option.facts && option.facts.discrepancies && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #ddd" }}>
                            <strong style={{ color: "#d97706" }}>⚠️ {option.facts.discrepancies}</strong>
                          </div>
                        )}
                        {option.businessLogic && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <strong>Why this works:</strong>
                            <div style={{ marginTop: "4px", color: "#555", fontStyle: "italic" }}>{option.businessLogic}</div>
                          </div>
                        )}
                        {option.recommendedActions && Array.isArray(option.recommendedActions) && option.recommendedActions.length > 0 && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <strong>Actions:</strong>
                            {option.recommendedActions.map((action, i) => (
                              <div key={i} style={{ fontSize: "13px", color: "#555", marginTop: i === 0 ? "8px" : "6px", paddingTop: i === 0 ? "8px" : "0", borderTop: i === 0 ? "1px solid #ddd" : "none" }}>
                                {i === 0 ? <strong style={{ color: "#059669" }}>✓ {action}</strong> : `• ${action}`}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Fallback for old format fields */}
                        {option.jobStatus && (
                          <div style={styles.optionDetail}>
                            <strong>Status:</strong> {option.jobStatus}
                          </div>
                        )}
                        {option.existingInvoices && option.existingInvoices.length > 0 && (
                          <div style={styles.optionDetail}>
                            <strong>Existing invoices:</strong>
                            {option.existingInvoices.map((inv, i) => (
                              <div key={i} style={{ marginLeft: "16px", fontSize: "13px" }}>
                                {inv.date} - {inv.amount} ({inv.ref})
                              </div>
                            ))}
                          </div>
                        )}
                        {option.remainingToInvoice && (
                          <div style={styles.optionDetail}>
                            <strong>Remaining to invoice:</strong> {option.remainingToInvoice}
                          </div>
                        )}
                        {option.summary && !option.businessLogic && (
                          <div style={styles.optionSummary}>{option.summary}</div>
                        )}
                        <button className="triage-btn triage-btn-primary"
                          onClick={() => acceptOption(option)}
                          disabled={isAccepting}
                          style={{
                            ...styles.decisionButton,
                            ...styles.approveButton,
                            marginTop: "12px",
                            width: "100%",
                            opacity: isAccepting ? 0.5 : 1,
                          }}
                        >
                          {isAccepting ? <><Spinner color="white" />Writing to sheet...</> : `✓ Accept Option ${idx + 1}`}
                        </button>
                        </>)}
                      </div>
                    ));
                  }
                } catch (e) {
                  // Show as plain text if not JSON
                  return (
                    <div style={styles.claudeAnalysis}>
                      {claudeAnalysis.split('\n').map((line, idx) => (
                        <div key={idx}>{line || <br />}</div>
                      ))}
                    </div>
                  );
                }
              })()}
            </div>
          )}

          {isAnalyzing && (
            <div style={{ ...styles.claudeAnalysis, textAlign: "center", color: "#666" }}>
              Generating options for this alert...
            </div>
          )}

          <div style={{ marginTop: "16px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button className="triage-btn" onClick={() => { setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={styles.buttonSecondary}>
              ← Back to Alerts
            </button>
            <button className="triage-btn"
              onClick={() => {
                const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
                setClientAlerts(updatedAlerts);
                setCurrentClientAlertIndex(0);
                if (updatedAlerts.length === 0) {
                  if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                  else setScreen("alertSelection");
                } else { setScreen("alertSelection"); }
              }}
              style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#d97706" }}
            >
              ⏭ Skip Alert
            </button>
            <button className="triage-btn"
              onClick={() => setShowIgnoreModal(true)}
              style={{ ...styles.buttonSecondary, color: "#c62828", borderColor: "#ef9a9a" }}
            >
              🚫 Ignore Forever
            </button>
            <button className="triage-btn"
              onClick={() => openCreateTaskModal(clientAlerts[currentClientAlertIndex], false)}
              style={{ ...styles.buttonSecondary, color: "#7c3aed", borderColor: "#c4b5fd" }}
            >
              📋 Create Task
            </button>
            {(selectedClient?.clientSheetId || selectedClient?.masterSheetId) && (
              <button className="triage-btn"
                onClick={() => {
                  const clientUrl = selectedClient.clientSheetId
                    ? `https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`
                    : null;
                  const masterUrl = selectedClient.masterSheetId
                    ? `https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`
                    : null;
                  if (clientUrl) window.open(clientUrl, "_blank");
                  if (masterUrl) window.open(masterUrl, "_blank");
                }}
                style={{ ...styles.buttonSecondary, color: "#1d4ed8", borderColor: "#93c5fd" }}
              >
                📊 Open Sheets
              </button>
            )}
          </div>

          {/* Existing task banner */}
          {existingTaskBanner && (
            <div style={{ marginTop: "12px", padding: "12px 16px", background: "#f3e8ff", border: "1px solid #c4b5fd", borderRadius: "6px" }}>
              <div style={{ fontSize: "13px", fontWeight: "600", color: "#7c3aed", marginBottom: "6px" }}>
                📋 This alert has an existing task{existingTaskBanner.dataChanged ? " — underlying data has changed since the task was created" : ""}
              </div>
              <div style={{ fontSize: "12px", color: "#555", marginBottom: "8px" }}>
                Created: {existingTaskBanner.taskCreatedAt ? new Date(existingTaskBanner.taskCreatedAt).toLocaleDateString("en-GB") : "unknown"}
                {existingTaskBanner.taskNote ? ` · Note: "${existingTaskBanner.taskNote}"` : ""}
                {existingTaskBanner.isSnoozed ? ` · Snoozed until ${new Date(existingTaskBanner.snoozedUntil).toLocaleString("en-GB")}` : ""}
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button className="triage-btn" onClick={() => { handleNavTasks(); setActiveNav("tasks"); }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                  View Task
                </button>
                {existingTaskBanner.dataChanged && (
                  <>
                    <button className="triage-btn"
                      onClick={async () => {
                        const alert = clientAlerts[currentClientAlertIndex];
                        await fetch("/api/triage", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: "update_task",
                            fingerprintHash: existingTaskBanner.fingerprintHash,
                            newCachedOptionsJSON: claudeAnalysis,
                            newAlertData: JSON.stringify(alert),
                            unsnooze: false,
                            automationCommanderSheetId,
                          }),
                        });
                        setExistingTaskBanner(prev => ({ ...prev, dataChanged: false }));
                      }}
                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}>
                      Update Task
                    </button>
                    {existingTaskBanner.isSnoozed && (
                      <button className="triage-btn"
                        onClick={async () => {
                          const alert = clientAlerts[currentClientAlertIndex];
                          await fetch("/api/triage", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "update_task",
                              fingerprintHash: existingTaskBanner.fingerprintHash,
                              newCachedOptionsJSON: claudeAnalysis,
                              newAlertData: JSON.stringify(alert),
                              unsnooze: true,
                              automationCommanderSheetId,
                            }),
                          });
                          setExistingTaskBanner(prev => ({ ...prev, dataChanged: false, isSnoozed: false }));
                        }}
                        style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                        Update &amp; Unsnooze
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Ignore reason modal */}
          {showIgnoreModal && (
            <div style={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowIgnoreModal(false); }}>
              <div style={styles.modalCard}>
                <h3 style={styles.modalTitle}>Permanently Ignore Alert</h3>
                <p style={styles.modalSubtitle}>
                  This alert will be hidden from all future triage runs unless its underlying data changes.
                  Optionally add a reason for your records.
                </p>
                <textarea
                  value={ignoreReason}
                  onChange={(e) => setIgnoreReason(e.target.value)}
                  placeholder="Reason for ignoring (optional)..."
                  style={styles.modalTextarea}
                  autoFocus
                />
                <div style={styles.modalButtons}>
                  <button className="triage-btn"
                    onClick={() => { setShowIgnoreModal(false); setIgnoreReason(""); }}
                    style={styles.buttonSecondary}
                  >
                    Cancel
                  </button>
                  <button className="triage-btn"
                    onClick={ignoreAlert}
                    disabled={isIgnoring}
                    style={{ ...styles.ignoreButton, opacity: isIgnoring ? 0.5 : 1 }}
                  >
                    {isIgnoring ? <><Spinner />Ignoring...</> : "🚫 Confirm Ignore"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </NavShell>
    );
  }
  if (showNoAction && noActionCount > 0 && activeNav !== "tasks") {
    const allAcknowledged = acknowledgedNoAction.size === noActionCount;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Info-Only Alerts</h1>
          <p style={styles.subtitle}>These require no action - acknowledge to clear</p>
        </div>

        <div style={styles.noActionSection}>
          <h2 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: "600" }}>
            {acknowledgedNoAction.size} of {noActionCount} Acknowledged
          </h2>

          {/* TODO: Replace with actual no-action alerts from API response */}
          <div style={styles.noActionItem}>
            <div style={styles.noActionLabel}>
              <div style={styles.noActionTitle}>Invoice app discr</div>
              <div style={styles.noActionDesc}>No action required - informational only</div>
            </div>
            <div
              style={{
                ...styles.checkmark,
                ...(acknowledgedNoAction.has(0) ? styles.checkmarkChecked : {}),
              }}
              onClick={() => toggleAckNoAction(0)}
            >
              {acknowledgedNoAction.has(0) ? "✓" : ""}
            </div>
          </div>

          {allAcknowledged && (
            <div style={styles.successBanner}>
              All info-only alerts acknowledged. Ready to complete triage!
            </div>
          )}

          <div style={styles.buttonGroup}>
            {totalAlerts > 0 && (
              <button className="triage-btn" onClick={() => setShowNoAction(false)} style={styles.buttonSecondary}>
                ← Back to Actionable Alerts
              </button>
            )}
            {allAcknowledged && (
              <button className="triage-btn"
                onClick={() => setTriageComplete(true)}
                style={styles.button}
              >
                Complete Triage ✓
              </button>
            )}
          </div>
        </div>
      </div>
      </NavShell>
    );
  }

  // ── Tasks screens ─────────────────────────────────────────────────────────

  // Helper: format alert type label
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

  // Task list screen
  if (activeNav === "tasks" && !selectedTask) {
    const filterTabs = [
      { key: "active", label: "Active", count: navTaskCount },
      { key: "snoozed", label: "Snoozed", count: snoozedTaskCount },
      { key: "resolved", label: "Completed", count: 0 },
    ];
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Tasks</h1>
            <p style={styles.subtitle}>Alerts deferred for follow-up</p>
          </div>

          {taskActionError && <div style={styles.errorBanner}>{taskActionError}</div>}

          {/* Filter tabs */}
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
      </NavShell>
    );
  }

  // Task detail screen
  if (activeNav === "tasks" && selectedTask) {
    const taskAlert = (() => { try { return JSON.parse(selectedTask.alertDataJSON || "{}"); } catch(e) { return {}; } })();
    // Snooze date min = tomorrow
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          {/* Back button */}
          <button className="triage-btn" onClick={() => setSelectedTask(null)} style={{ ...styles.buttonSecondary, marginBottom: "16px" }}>
            ← Back to Tasks
          </button>

          {taskActionError && <div style={styles.errorBanner}>{taskActionError}</div>}

          {/* Task header */}
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
                  // Sheet URLs: automation alerts use clientId/masterSheetId from taskAlert,
                  // proactive alerts fall back to allClientsMap
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
                  <button className="triage-btn"
                    onClick={() => resolveTask(selectedTask.fingerprintHash)}
                    style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#16a34a", borderColor: "#86efac" }}>
                    ✓ Resolve Task
                  </button>
                )}
              </div>
            </div>

            {/* Initial note */}
            {selectedTask.taskNote && (
              <div style={{ marginTop: "12px", padding: "10px 12px", background: "#f3e8ff", borderRadius: "6px", fontSize: "13px", color: "#4c1d95" }}>
                <strong>Note:</strong> {selectedTask.taskNote}
              </div>
            )}

            {/* Further notes log */}
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

          {/* Alert summary card (replayed from stored alert data) */}
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
          {/* Proactive alert detail (no summary object — use heading/detail directly) */}
          {!taskAlert.summary && taskAlert.heading && (
            <div style={{ ...styles.alertSummary, marginBottom: "16px" }}>
              <div style={{ fontWeight: "700", fontSize: "13px", marginBottom: "8px", color: "#b45309" }}>ALERT DETAILS</div>
              <div style={{ fontSize: "13px", fontWeight: "600", marginBottom: "4px" }}>{taskAlert.heading}</div>
              {taskAlert.detail && <div style={{ fontSize: "13px", color: "#555", marginTop: "4px" }}>{taskAlert.detail}</div>}
            </div>
          )}

          {/* Options — only shown for automation alert tasks, not proactive */}
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
          )} {/* end !selectedTask.isProactive */}

          {/* Add note */}
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

          {/* Snooze */}
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
      </NavShell>
    );
  }

  // ── Home screen (initial / loading) ──────────────────────────────────────
  return withModal(
    <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} homeAlertCount={totalAlerts + proactiveAlerts.length} taskCount={navTaskCount}>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>{isLoading ? "Loading..." : error ? error : "Initialising..."}</p>
        </div>
        {error && <div style={styles.errorBanner}>{error}</div>}
        {isLoading && (
          <div style={{ textAlign: "center", padding: "40px" }}>
            <Spinner size={28} color="#0066cc" />
            <div style={{ marginTop: "12px", color: "#666" }}>Loading triage data...</div>
          </div>
        )}
      </div>
    </NavShell>
  );
}