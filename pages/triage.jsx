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
function NavShell({ activeNav, onHome, onOverview, onTasks, onAppLog, onOutgoings, onInvoices, onSettings, homeAlertCount, taskCount, children }) {
  const [showMore, setShowMore] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 600);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!showMore) return;
    const close = (e) => {
      if (!e.target.closest(".nav-more-dropdown") && !e.target.closest(".nav-more-btn")) {
        setShowMore(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showMore]);

  const Badge = ({ count }) => count > 0 ? (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "#e53e3e", color: "#fff", borderRadius: "10px",
      fontSize: "10px", fontWeight: "700", minWidth: "17px", height: "17px",
      padding: "0 5px", marginLeft: "5px", lineHeight: "1", verticalAlign: "middle",
    }}>{count > 99 ? "99+" : count}</span>
  ) : null;

  const navBtnStyle = (name) => ({
    background: "none", border: "none", cursor: "pointer",
    padding: isMobile ? "12px 12px" : "12px 14px",
    fontSize: "14px", fontWeight: activeNav === name ? "600" : "400",
    color: activeNav === name ? "#0066cc" : "#444",
    borderBottom: activeNav === name ? "2px solid #0066cc" : "2px solid transparent",
    borderRadius: "0", display: "flex", alignItems: "center", whiteSpace: "nowrap",
  });

  const secondaryNavs = [
    { key: "appLog", label: "App Log", handler: onAppLog },
    { key: "outgoings", label: "Vendors", handler: onOutgoings },
    { key: "invoices", label: "Invoices", handler: onInvoices },
    { key: "settings", label: "⚙ Settings", handler: onSettings },
  ];

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      <div style={{ background: "#1a1a2e", color: "#fff", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "15px", fontWeight: "700", letterSpacing: "0.3px" }}>Pulse Triage System</span>
      </div>
      <div style={{ background: "#fff", borderBottom: "1px solid #e0e0e0", padding: "0 8px", display: "flex", alignItems: "stretch", position: "relative" }}>
        <button className="triage-btn pulse-nav-item" onClick={onHome} style={navBtnStyle("home")}>Home<Badge count={homeAlertCount} /></button>
        <button className="triage-btn pulse-nav-item" onClick={onOverview} style={navBtnStyle("overview")}>Overview</button>
        <button className="triage-btn pulse-nav-item" onClick={onTasks} style={navBtnStyle("tasks")}>Tasks<Badge count={taskCount} /></button>
        {!isMobile && secondaryNavs.map(({ key, label, handler }) => (
          <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>{label}</button>
        ))}
        {isMobile && (
          <>
            {secondaryNavs.filter(n => n.key === activeNav).map(({ key, label, handler }) => (
              <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>{label}</button>
            ))}
            <button className="nav-more-btn triage-btn"
              onClick={(e) => { e.stopPropagation(); setShowMore(v => !v); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "12px 14px", fontSize: "16px", color: "#666", borderBottom: "2px solid transparent", marginLeft: "auto" }}>
              {showMore ? "✕" : "•••"}
            </button>
            {showMore && (
              <div className="nav-more-dropdown"
                style={{ position: "absolute", top: "100%", right: "0", background: "#fff", border: "1px solid #ddd", borderRadius: "0 0 8px 8px", boxShadow: "0 6px 20px rgba(0,0,0,0.15)", zIndex: 200, minWidth: "150px" }}>
                {secondaryNavs.map(({ key, label, handler }) => (
                  <button key={key} className="triage-btn"
                    onClick={() => { handler(); setShowMore(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", width: "100%", justifyContent: "flex-start", borderBottom: "1px solid #f0f0f0", padding: "14px 18px", fontSize: "14px", fontWeight: activeNav === key ? "600" : "400", color: activeNav === key ? "#0066cc" : "#444", display: "flex", alignItems: "center" }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
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
  const [previousIgnoreReason, setPreviousIgnoreReason] = useState(null);
  const [proactiveAlerts, setProactiveAlerts] = useState([]);
  const [proactiveCountsByClient, setProactiveCountsByClient] = useState({});
  const [proactiveLoading, setProactiveLoading] = useState(false);
  const [proactiveLoadedAt, setProactiveLoadedAt] = useState(0); // epoch ms of last load
  const [proactiveSelectedClient, setProactiveSelectedClient] = useState(null);
  const [overviewData, setOverviewData] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [activeNav, setActiveNav] = useState("home"); // "home" | "overview" | "tasks" | "appLog" | "outgoings"
  const [outgoingsData, setOutgoingsData] = useState(null); // { contractors, months }
  const [outgoingsLoading, setOutgoingsLoading] = useState(false);
  const [outgoingsClient, setOutgoingsClient] = useState(null); // which client's outgoings are loaded
  const [outgoingsMonthOffset, setOutgoingsMonthOffset] = useState(0); // scroll offset
  const [outgoingsEditCell, setOutgoingsEditCell] = useState(null); // { contractor, colLetter, blocks }
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null); // { rowNum, slotNum, slot }
  const [outgoingsInbox, setOutgoingsInbox] = useState([]); // unmatched expenses from DirComp
  const [outgoingsPlacing, setOutgoingsPlacingState] = useState(null); // expense being placed { appId, amount, ... }
  const outgoingsPlacingRef = React.useRef(null);
  const setOutgoingsPlacing = (val) => { outgoingsPlacingRef.current = val; setOutgoingsPlacingState(val); };
  const [outgoingsEstimate, setOutgoingsEstimate] = useState(null); // { contractor, colLetter, monthLabel }
  const [outgoingsDragging, setOutgoingsDraggingState] = useState(null); // { contractor, colLetter, blockIdx, block }
  const outgoingsDraggingRef = React.useRef(null);
  const setOutgoingsDragging = (val) => { outgoingsDraggingRef.current = val; setOutgoingsDraggingState(val); };
  const [outgoingsNewVendor, setOutgoingsNewVendor] = useState(null); // { exp } — inbox item to place as new vendor
  const [vendorsSubTab, setVendorsSubTab] = useState("contractors"); // "contractors" | "directCosts"
  const [directCostsJobs, setDirectCostsJobs] = useState(null); // [{ client, jobName, projectCode, rows }]
  const [directCostsLoading, setDirectCostsLoading] = useState(false);
  const [directCostsShowAll, setDirectCostsShowAll] = useState(false);
  const [directCostsSavingCell, setDirectCostsSavingCell] = useState(null); // "rowNum-slotNum" or "newrow-<jobKey>" currently saving
  const [allOutgoingsClients, setAllOutgoingsClients] = useState([]); // all clients from AutoUpdates
  // ── Invoices screen state (mirrors Vendors → Direct Costs) ─────────────────
  const [invoicesClient, setInvoicesClient] = useState(null);
  const [invoicesInbox, setInvoicesInbox] = useState([]);
  const [invoicesInboxLoading, setInvoicesInboxLoading] = useState(false);
  const [invoicesPlacing, setInvoicesPlacingState] = useState(null); // invoice being placed
  const invoicesPlacingRef = React.useRef(null);
  const setInvoicesPlacing = (val) => { invoicesPlacingRef.current = val; setInvoicesPlacingState(val); };
  const [invoicesJobs, setInvoicesJobs] = useState(null);
  const [invoicesJobsLoading, setInvoicesJobsLoading] = useState(false);
  const [invoicesShowAll, setInvoicesShowAll] = useState(false);
  const [invoicesSavingCell, setInvoicesSavingCell] = useState(null);
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null); // { rowNum, slotNum, slot }
  const [invoicesNewJob, setInvoicesNewJob] = useState(null); // { inv } — inbox invoice to place as new job
  // assignedAppIds: Set of transactionIds assigned via outgoings — persisted to localStorage
  // until refreshOutgoingsAndUI runs and removes them from DirComp properly
  // assignedAppIdsByClient: Map of {clientName → Set<transactionId>} for per-client count adjustment
  const [assignedAppIds, setAssignedAppIds] = useState(() => {
    try {
      const stored = localStorage.getItem("pulse_assignedAppIds");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  // Tracks whether a GAS outgoings pull is needed. Using a ref (not state) so it
  // doesn't trigger re-renders. Reset to null after the pull fires.
  const outgoingsPullPendingRef = React.useRef(null); // null | masterSheetId
  const [assignedByClient, setAssignedByClient] = useState(() => {
    try {
      const stored = localStorage.getItem("pulse_assignedByClient");
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      // Convert arrays back to Sets
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, new Set(v)]));
    } catch { return {}; }
  });
  const addAssignedAppId = (id, clientName) => {
    setAssignedAppIds(prev => {
      const next = new Set([...prev, id]);
      try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
      return next;
    });
    if (clientName) {
      setAssignedByClient(prev => {
        const clientSet = new Set([...(prev[clientName] || []), id]);
        const next = { ...prev, [clientName]: clientSet };
        try { localStorage.setItem("pulse_assignedByClient", JSON.stringify(
          Object.fromEntries(Object.entries(next).map(([k, v]) => [k, [...v]]))
        )); } catch {}
        return next;
      });
    }
  };
  const [outgoingsReplacePrompt, setOutgoingsReplacePrompt] = useState(null); // { exp, contractor, colLetter, realBlocks, manualTotal, blocksToKeep }
  const [allClientsLoaded, setAllClientsLoaded] = useState(false);
  const [settingsData, setSettingsData] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsEditHourly, setSettingsEditHourly] = useState(10);
  const [settingsEditDaily, setSettingsEditDaily] = useState(30);
  const [settingsEditAnomaly, setSettingsEditAnomaly] = useState(15);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveMsg, setSettingsSaveMsg] = useState("");
  const [diagClientName, setDiagClientName] = useState("");
  const [proactiveCheckLog, setProactiveCheckLog] = useState(null);
  const [proactiveCheckLogLoading, setProactiveCheckLogLoading] = useState(false);
  const [proactiveCheckLogLoaded, setProactiveCheckLogLoaded] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null);
  const [diagError, setDiagError] = useState("");
  const OUTGOINGS_WINDOW = 7; // months visible at once
  const [appLogData, setAppLogData] = useState([]);
  const [appLogLoading, setAppLogLoading] = useState(false);
  const [appLogLoadedAt, setAppLogLoadedAt] = useState(0);
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

  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [debugClientName, setDebugClientName] = useState("");
  const [debugResult, setDebugResult] = useState(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const runDebug = async () => {
    try {
      setDebugLoading(true);
      setDebugResult(null);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "debug_triage_state",
          clientName: debugClientName.trim() || undefined,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      setDebugResult(data);
    } catch (e) {
      setDebugResult({ success: false, error: e.message });
    } finally {
      setDebugLoading(false);
    }
  };
  // Fire the deferred GAS outgoings notes pull if one is pending.
  // Called at the start of every nav handler except handleNavOutgoings.
  // Fire-and-forget — user never waits for this.
  const fireOutgoingsPullIfPending = () => {
    const masterSheetId = outgoingsPullPendingRef.current;
    if (!masterSheetId) return;
    outgoingsPullPendingRef.current = null;
    const clientSheetId = outgoingsClient?.clientSheetId || "";
    if (!clientSheetId) return;
    fetch("/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fire_outgoings_pull", clientSheetId, masterSheetId }),
    }).catch(e => console.error("fireOutgoingsPull error:", e));
  };

  const handleNavHome = () => { fireOutgoingsPullIfPending(); setActiveNav("home"); setScreen("clientSelection"); };
  const handleNavOverview = () => { fireOutgoingsPullIfPending(); setActiveNav("overview"); loadOverview(); };
  const handleNavTasks = () => { fireOutgoingsPullIfPending(); setActiveNav("tasks"); setTasksFilter("active"); loadTasks("active", true); };
  const handleNavAppLog = () => { fireOutgoingsPullIfPending(); setActiveNav("appLog"); loadAppLog(); };
  const handleNavSettings = () => {
    fireOutgoingsPullIfPending();
    setActiveNav("settings");
    setSettingsLoading(true);
    if (!proactiveCheckLogLoaded) loadProactiveCheckLog();
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_claude_settings", automationCommanderSheetId }) })
      .then(r => r.json()).then(d => {
        if (d.success) {
          setSettingsData(d);
          setSettingsEditHourly(d.config?.hourlyLimit ?? 10);
          setSettingsEditDaily(d.config?.dailyLimit ?? 30);
          setSettingsEditAnomaly(d.config?.anomalyThreshold ?? 15);
        }
      })
      .catch(e => console.error("get_claude_settings error:", e))
      .finally(() => setSettingsLoading(false));
  };
  const handleNavOutgoings = () => {
    setActiveNav("outgoings");
    // Always go back to client selection when navigating to Outgoings
    setOutgoingsData(null);
    setOutgoingsClient(null);
    setOutgoingsInbox([]);
    setOutgoingsPlacing(null);
    if (!allClientsLoaded) {
      fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_clients", automationCommanderSheetId }),
      }).then(r => r.json()).then(data => {
        console.log("get_all_clients response:", data.success, "count:", Array.isArray(data.clients) ? data.clients.length : typeof data.clients);
        if (data.success && Array.isArray(data.clients)) {
          setAllOutgoingsClients(data.clients);
          setAllClientsLoaded(true);
        } else {
          console.error("get_all_clients failed or returned non-array:", data);
        }
      }).catch(e => console.error("get_all_clients error:", e));
    }
  };

  const handleNavInvoices = () => {
    setActiveNav("invoices");
    setInvoicesClient(null);
    setInvoicesInbox([]);
    setInvoicesPlacing(null);
    setInvoicesJobs(null);
    setInvoicesShowAll(false);
    if (!allClientsLoaded) {
      fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_clients", automationCommanderSheetId }),
      }).then(r => r.json()).then(data => {
        if (data.success && Array.isArray(data.clients)) {
          setAllOutgoingsClients(data.clients);
          setAllClientsLoaded(true);
        }
      }).catch(e => console.error("get_all_clients error:", e));
    }
  };

  const loadInvoicesInbox = async (client) => {
    if (!client?.clientSheetId) return;
    try {
      setInvoicesInboxLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoices_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        const pruned = (data.inbox || []).filter(inv => !assignedAppIds.has(inv.invoiceNo));
        setInvoicesInbox(pruned);
      }
    } catch(e) { console.error("loadInvoicesInbox error:", e); }
    finally { setInvoicesInboxLoading(false); }
  };

  const loadInvoicesJobs = async (client, showAll) => {
    if (!client?.clientSheetId) return;
    try {
      setInvoicesJobsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoice_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll }),
      });
      const data = await res.json();
      if (data.success) setInvoicesJobs(data.jobs);
    } catch(e) { console.error("loadInvoicesJobs error:", e); }
    finally { setInvoicesJobsLoading(false); }
  };

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
      const pir = data.previousIgnoreReason; setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
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
      const pir = data.previousIgnoreReason; setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
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
    // Filter out expense alerts already assigned in outgoings.
    // DirComp expense alerts carry summary.transactionId (= the App ID from the
    // accounting system). The outgoings inbox uses the field name appId for the
    // same value, so check both to be safe.
    const filteredAlerts = (clientAlerts || []).filter(alert => {
      const txId = alert.summary?.transactionId || alert.summary?.appId;
      if (txId && assignedAppIds.has(txId)) return false;
      return true;
    });
    filteredAlerts.forEach(alert => {
      const type = alert.flagType || alert.alertType || alert.type || "unknown";
      if (!g[type]) g[type] = [];
      g[type].push(alert);
    });
    return g;
  }, [clientAlerts, assignedAppIds]);

  // Live alert count — derived from clientsWithFlags alertCounts so it decrements
  // as each alert is actioned, rather than staying at the original snapshot value.
  // Also includes informational (grey bullet) flags which are noAction flags that
  // are TRUE in clientsWithFlags but not in the actionable set.
  const liveAlertCount = React.useMemo(() => {
    const ACTIONABLE_FLAG_KEYS_SET = new Set([
      "invoiceDashboardDiscr", "expenseDashboardDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
    ]);
    const COUNTED_ALERT_TYPES = [
      "invoiceDashboardDiscr", "invoiceAppDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
      "crmPipeSkippedBlank", "crmConfSkippedBlank",
      "expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps",
      "invoiceStaleUnsentChanges",
    ];
    const EXPENSE_TYPES = new Set(["expenseDashboardDiscr", "expenseAppDiscr"]);
    return clientsWithFlags.reduce((total, c) => {
      // Count actionable alerts from alertCounts, subtracting assigned expenses per client
      const actionable = COUNTED_ALERT_TYPES.reduce((sum, ft) => {
        let count = c.alertCounts?.[ft] || 0;
        if (EXPENSE_TYPES.has(ft)) {
          count = Math.max(0, count - (assignedByClient[c.clientName]?.size || 0));
        }
        return sum + count;
      }, 0);
      // Count info flags (grey bullets) — flags that are TRUE but not in the actionable display set
      const infoFlags = Object.entries(c.flags || {})
        .filter(([key, val]) => val && !ACTIONABLE_FLAG_KEYS_SET.has(key)).length;
      return total + actionable + infoFlags;
    }, 0);
  }, [clientsWithFlags, assignedByClient]);

  // ── Bulk action helpers ──────────────────────────────────────────────────

  const getBulkSelectedAlerts = () => {
    const alerts = [];
    for (const key of bulkSelected) {
      const sepIdx = key.lastIndexOf("|||");
      const type   = key.slice(0, sepIdx);
      const alertId = key.slice(sepIdx + 3); // "SheetName-rowNumber"
      const alert  = (groupedAlerts[type] || []).find(
        a => `${a.sheetName}-${a.rowNumber}` === alertId
      );
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
    }).then(r => r.json()).then(d => { if (d.success) setAllClientsMap(d.clientsMap || d.clients || {}); }).catch(() => {});
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

  // Auto-refresh App Log every 15 minutes while on the App Log screen
  useEffect(() => {
    if (activeNav !== "appLog") return;
    if (!appLogLoading && appLogLoadedAt > 0 && Date.now() - appLogLoadedAt > 15 * 60 * 1000) {
      loadAppLog();
    }
    const interval = setInterval(() => {
      if (!appLogLoading) loadAppLog();
    }, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeNav, appLogLoadedAt]);

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

  const loadProactiveCheckLog = async () => {
    try {
      setProactiveCheckLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_proactive_check_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) setProactiveCheckLog(data.runs || []);
    } catch(e) { console.error("loadProactiveCheckLog error:", e); }
    finally { setProactiveCheckLogLoading(false); setProactiveCheckLogLoaded(true); }
  };

  const loadOutgoings = async (client) => {
    if (!client?.clientSheetId) return;
    try {
      setOutgoingsLoading(true);
      setOutgoingsClient(client);
      const [gridRes, inboxRes] = await Promise.all([
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings", clientSheetId: client.clientSheetId }),
        }),
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId }),
        }),
      ]);
      const [gridData, inboxData] = await Promise.all([gridRes.json(), inboxRes.json()]);
      if (gridData.success) {
        setOutgoingsData({ contractors: gridData.contractors, months: gridData.months });
        // Centre on current month using isoMonth field
        const now = new Date();
        const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const currentIdx = gridData.months.findIndex(m => (m.isoMonth || "").startsWith(curIso));
        if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
      }
      if (inboxData.success) {
        const allInboxIds = new Set((inboxData.inbox || []).map(e => e.appId));
        // Prune assignedAppIds: keep only IDs that are STILL in the inbox
        // (meaning refreshOutgoingsAndUI hasn't run yet — they're assigned but DirComp
        // hasn't been updated). Remove IDs that are no longer in the inbox — they've been
        // fully processed and don't need suppression any more.
        setAssignedAppIds(prev => {
          const pruned = new Set([...prev].filter(id => allInboxIds.has(id)));
          try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...pruned])); } catch {}
          return pruned;
        });
        setAssignedByClient(prev => {
          const next = {};
          for (const [cn, ids] of Object.entries(prev)) {
            const pruned = new Set([...ids].filter(id => allInboxIds.has(id)));
            if (pruned.size > 0) next[cn] = pruned;
          }
          try { localStorage.setItem("pulse_assignedByClient", JSON.stringify(
            Object.fromEntries(Object.entries(next).map(([k, v]) => [k, [...v]]))
          )); } catch {}
          return next;
        });
        // Filter inbox: hide items that are in assignedAppIds (assigned but not yet processed)
        // Use the current state directly since setAssignedAppIds above is async
        const currentAssigned = new Set([
          ...Array.from(assignedAppIds).filter(id => allInboxIds.has(id))
        ]);
        const freshInbox = (inboxData.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
        setOutgoingsInbox(freshInbox);
        if (inboxData.locked) console.warn("Outgoings inbox: GAS lock active —", inboxData.lockMessage);
      }
    } catch(e) { console.error("loadOutgoings error:", e); }
    finally {
      setOutgoingsLoading(false);
      setVendorsSubTab("contractors");
      setDirectCostsJobs(null);
      setDirectCostsShowAll(false);
    }
  };

  const loadDirectCostsJobs = async (client, showAll) => {
    if (!client?.clientSheetId) return;
    try {
      setDirectCostsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_direct_costs_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll }),
      });
      const data = await res.json();
      if (data.success) setDirectCostsJobs(data.jobs);
    } catch(e) { console.error("loadDirectCostsJobs error:", e); }
    finally { setDirectCostsLoading(false); }
  };

  const loadAppLog = async () => {
    try {
      setAppLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_app_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        setAppLogData(data.rows || []);
        setAppLogLoadedAt(Date.now());
      }
    } catch (err) {
      console.error("Failed to load App Log:", err);
    } finally {
      setAppLogLoading(false);
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
  if (screen === "ignoredAlerts" && activeNav === "home") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
                  <div key={a.fingerprintHash} style={{
                    ...styles.ignoredAlertCard,
                    ...(a.status === "superseded" ? { background: "#fff8f2", borderColor: "#fed7aa" } : {}),
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a" }}>
                        {a.alertSummary || "(no summary)"}
                      </div>
                      <div style={styles.ignoredAlertMeta}>
                        {a.clientName} · {a.alertType} · {a.status === "superseded" ? "⚠ Data changed since ignored" : `Ignored ${a.lastSeen}`}
                      </div>
                      {a.ignoreReason && (
                        <div style={{ fontSize: "12px", color: "#888", marginTop: "4px", fontStyle: "italic" }}>
                          Reason: {a.ignoreReason}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
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

  // App Log screen
  // ── OUTGOINGS SCREEN ────────────────────────────────────────────────────────
  if (activeNav === "outgoings") {
    const STATUS_COLOURS = {
      "Paid":     { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
      "Received": { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
      "Draft":    { bg: "#fff8e1", border: "#ffc107", text: "#e65100" },
      "":         { bg: "#f5f5f5", border: "#bdbdbd", text: "#616161" },
    };
    const getStatusColour = (s) => STATUS_COLOURS[s] || STATUS_COLOURS[""];

    const visibleMonths = outgoingsData
      ? outgoingsData.months.slice(outgoingsMonthOffset, outgoingsMonthOffset + OUTGOINGS_WINDOW)
      : [];

    const fmtMonthLabel = (labelOrIso) => {
      if (!labelOrIso) return "";
      // Try parsing as ISO month "2026-01" or ISO date "2026-01-01"
      const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
      if (isoMatch) {
        const d = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, 1);
        return d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
      }
      // Already formatted (e.g. "Jan-26") — return as-is
      return String(labelOrIso).slice(0, 7);
    };

    const getIsoMonth = (m) => m.isoMonth || m.label || "";

    const isCurrentMonth = (labelOrIso) => {
      const now = new Date();
      const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
      if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}` === cur;
      return false;
    };

    const updateCell = async (contractor, colLetter, newBlocks) => {
      setOutgoingsData(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          contractors: prev.contractors.map(c =>
            c.sheetRow === contractor.sheetRow
              ? { ...c, cells: { ...c.cells, [colLetter]: { ...c.cells[colLetter], blocks: newBlocks } } }
              : c
          ),
        };
      });
      try {
        await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_outgoing_note",
            clientSheetId: outgoingsClient?.clientSheetId,
            masterSheetId: outgoingsClient?.masterSheetId || "",
            sheetRow: contractor.sheetRow,
            colLetter,
            blocks: newBlocks,
          }),
        });
        // Mark that an outgoings pull is needed — will fire when user navigates away
        if (outgoingsClient?.masterSheetId) {
          outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
        }
      } catch(e) { console.error("updateCell error:", e); }
    };

    const EditModal = () => {
      if (!outgoingsEditCell) return null;
      const { contractor, colLetter, monthLabel } = outgoingsEditCell;
      const [blocks, setBlocks] = React.useState(
        (contractor.cells[colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"))
      );
      const [saving, setSaving] = React.useState(false);
      const [savedMsg, setSavedMsg] = React.useState("");
      const [splitAmts, setSplitAmts] = React.useState({});
      // Track whether blocks have been modified since last write
      const dirtyRef = React.useRef(false);
      const blocksRef = React.useRef(blocks);
      React.useEffect(() => { blocksRef.current = blocks; }, [blocks]);

      const updateBlock = (i, field, val) => {
        dirtyRef.current = true;
        setBlocks(prev => prev.map((b, idx) => idx === i ? { ...b, [field]: val } : b));
      };
      const removeBlock = (i) => {
        dirtyRef.current = true;
        setBlocks(prev => prev.filter((_, idx) => idx !== i));
      };

      const save = async () => {
        if (!dirtyRef.current) { setOutgoingsEditCell(null); return; }
        setSaving(true);
        setSavedMsg("");
        await updateCell(contractor, colLetter, blocksRef.current);
        setSaving(false);
        setSavedMsg("Saved ✓");
        await new Promise(r => setTimeout(r, 600));
        setOutgoingsEditCell(null);
      };

      const currentMonthIdx = outgoingsData?.months.findIndex(m => m.colLetter === colLetter) ?? -1;
      const prevMonth = currentMonthIdx > 0 ? outgoingsData.months[currentMonthIdx - 1] : null;
      const nextMonth = currentMonthIdx >= 0 && currentMonthIdx < (outgoingsData?.months.length ?? 0) - 1 ? outgoingsData.months[currentMonthIdx + 1] : null;

      const doSplit = (blockIdx, targetCol, amt) => {
        const b = blocks[blockIdx];
        const splitAmt = parseFloat(amt);
        if (!splitAmt || splitAmt <= 0 || splitAmt >= b.amount) return;
        const newSrcAmt = parseFloat((b.amount - splitAmt).toFixed(2));
        const newBlocks = blocks.map((bl, i) => i === blockIdx ? { ...bl, amount: newSrcAmt } : bl);
        blocksRef.current = newBlocks;
        dirtyRef.current = false; // already written below — don't re-write on Save
        setBlocks(newBlocks);
        // Write reduced source cell immediately
        updateCell(contractor, colLetter, newBlocks);
        // Write split portion to target month
        const tb = [...(contractor.cells[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))];
        tb.push({ ...b, amount: splitAmt });
        updateCell(contractor, targetCol, tb);
        setSplitAmts(prev => ({ ...prev, [`${blockIdx}_${targetCol}`]: "" }));
        setSavedMsg("Split saved ✓");
      };

      const doMove = (blockIdx, targetCol) => {
        if (!targetCol) return;
        const b = blocks[blockIdx];
        setBlocks(prev => prev.filter((_, idx) => idx !== blockIdx));
        const tb = [...(contractor.cells[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))];
        tb.push({ ...b });
        updateCell(contractor, targetCol, tb);
      };

      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setOutgoingsEditCell(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 660px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)", position: "relative" }}>
            {saving && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.8)", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, fontSize: "14px", color: "#0066cc", fontWeight: "600" }}>
                Saving changes...
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>{contractor.name}</h3>
                <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>{fmtMonthLabel(monthLabel)}</div>
              </div>
              <button onClick={() => setOutgoingsEditCell(null)} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>x</button>
            </div>

            {blocks.length === 0 && <div style={{ color: "#bbb", fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No expenses in this cell</div>}

            {blocks.map((b, i) => {
              const sc = getStatusColour(b.status);
              const isManual = b.appId.startsWith("MANUAL-ENTRY");
              return (
                <div key={i} style={{ border: `1px solid ${sc.border}`, background: sc.bg, borderRadius: "8px", padding: "14px", marginBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <div style={{ fontSize: "13px", color: "#888", fontFamily: "monospace", wordBreak: "break-all", flex: 1, marginRight: "8px" }}>{b.appId}</div>
                    <button onClick={() => removeBlock(i)} style={{ background: "none", border: "none", color: "#e53935", cursor: "pointer", fontSize: "12px" }}>Remove</button>
                    {!b.appId.startsWith("MANUAL-ENTRY") && !b.appId.startsWith("UNRECON-GAP") && (
                      <button onClick={async () => {
                        // Remove block from cell, write immediately, return to inbox, close modal
                        const newBlocks = blocksRef.current.filter((_, idx) => idx !== i);
                        blocksRef.current = newBlocks;
                        dirtyRef.current = false;
                        // Update grid and write to Sheets
                        await updateCell(contractor, colLetter, newBlocks);
                        // Return to inbox
                        setOutgoingsInbox(prev => {
                          if (prev.some(e => e.appId === b.appId)) return prev;
                          return [...prev, {
                            appId: b.appId, amount: b.amount,
                            date: b.recDate || "", datePaid: b.payDate || "",
                            description: b.description || "", accountName: b.description || "",
                            status: b.status || "",
                          }];
                        });
                        // Close modal
                        setOutgoingsEditCell(null);
                      }} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "12px" }}>↩ Return to inbox</button>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                    <div>
                      <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Amount</label>
                      <input type="number" step="0.01" value={b.amount} onChange={e => updateBlock(i, "amount", parseFloat(e.target.value) || 0)}
                        style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Status</label>
                      {isManual ? (
                        <select value={b.status} onChange={e => updateBlock(i, "status", e.target.value)}
                          style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px" }}>
                          <option value="">—</option>
                          <option>Received</option><option>Paid</option><option>Draft</option>
                        </select>
                      ) : <div style={{ padding: "7px 9px", fontSize: "13px", fontWeight: "600", color: sc.text }}>{b.status || "—"}</div>}
                    </div>
                    <div>
                      <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Rec date</label>
                      <div style={{ padding: "7px 9px", fontSize: "13px" }}>{b.recDate || "—"}</div>
                    </div>
                    <div>
                      <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Pay date{isManual ? " (editable)" : ""}</label>
                      {isManual ? (
                        <input type="text" value={b.payDate} placeholder="e.g. 28-Apr-26" onChange={e => updateBlock(i, "payDate", e.target.value)}
                          style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                      ) : <div style={{ padding: "7px 9px", fontSize: "13px" }}>{b.payDate || "—"}</div>}
                    </div>
                  </div>
                  <div style={{ marginTop: "10px" }}>
                    <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Description</label>
                    <div style={{ padding: "7px 9px", fontSize: "12px", color: "#333", background: "rgba(255,255,255,0.7)", borderRadius: "4px", border: "1px solid rgba(0,0,0,0.06)" }}>{b.description || "—"}</div>
                  </div>
                  <div style={{ marginTop: "10px", borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: "10px" }}>
                    <div style={{ fontSize: "11px", color: "#888", marginBottom: "6px" }}>Split portion to another month:</div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      {[...(prevMonth ? [{ m: prevMonth, dir: "◀" }] : []), ...(nextMonth ? [{ m: nextMonth, dir: "▶" }] : [])].map(({ m, dir }) => {
                        const key = `${i}_${m.colLetter}`;
                        return (
                          <div key={m.colLetter} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            <span style={{ fontSize: "11px", color: "#666" }}>{dir} {fmtMonthLabel(m.isoMonth || m.label)}:</span>
                            <input type="number" step="0.01" value={splitAmts[key] || ""}
                              onChange={e => setSplitAmts(prev => ({ ...prev, [key]: e.target.value }))}
                              placeholder="amt" style={{ width: "70px", padding: "4px 6px", border: "1px solid #ddd", borderRadius: "4px", fontSize: "12px" }} />
                            <button onClick={() => doSplit(i, m.colLetter, splitAmts[key])}
                              disabled={!splitAmts[key] || parseFloat(splitAmts[key]) <= 0 || parseFloat(splitAmts[key]) >= b.amount}
                              style={{ padding: "4px 8px", background: "#f0f4ff", border: "1px solid #c5cff0", borderRadius: "4px", cursor: "pointer", fontSize: "11px", color: "#3a57c4" }}>Split</button>
                          </div>
                        );
                      })}
                      {!prevMonth && !nextMonth && <span style={{ fontSize: "11px", color: "#bbb" }}>No adjacent months visible</span>}
                    </div>
                  </div>
                  <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "#888" }}>Move to:</span>
                    <select value="" onChange={e => doMove(i, e.target.value)}
                      style={{ padding: "4px 6px", border: "1px solid #ddd", borderRadius: "4px", fontSize: "11px" }}>
                      <option value="">— select month —</option>
                      {(outgoingsData?.months || []).filter(m => m.colLetter !== colLetter).map(m => (
                        <option key={m.colLetter} value={m.colLetter}>{fmtMonthLabel(m.isoMonth || m.label)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}

            <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end", borderTop: "1px solid #f0f0f0", paddingTop: "16px", alignItems: "center" }}>
              {savedMsg && <span style={{ fontSize: "13px", color: "#2e7d32", fontWeight: "600", marginRight: "auto" }}>{savedMsg}</span>}
              <button onClick={() => setOutgoingsEditCell(null)}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                {dirtyRef.current ? "Cancel" : "Close"}
              </button>
              <button onClick={save} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      );
    };

    const DirectCostsEditModal = () => {
      if (!directCostsEditSlot) return null;
      const { rowNum, slotNum, slot } = directCostsEditSlot;
      const stripCurrency = v => String(v ?? "").replace(/^[£$€]/, "").trim();
      const [description, setDescription] = React.useState(slot.description || "");
      const [amount, setAmount] = React.useState(stripCurrency(slot.amount));
      const [vat, setVat] = React.useState(/^[£$€]?\d/.test(String(slot.vat||"")) ? "" : (slot.vat || "No"));
      const [date, setDate] = React.useState(slot.date || "");
      const [daysToPay, setDaysToPay] = React.useState(slot.daysToPay || 30);
      const [status, setStatus] = React.useState(slot.status || "");
      const [transactionId, setTransactionId] = React.useState(slot.transactionId || "");
      const [saving, setSaving] = React.useState(false);
      const [confirmingDelete, setConfirmingDelete] = React.useState(false);

      const close = () => setDirectCostsEditSlot(null);

      const save = async () => {
        setSaving(true);
        try {
          await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update_expense_slot",
              clientSheetId: outgoingsClient?.clientSheetId,
              rowNum, slotNum,
              expense: { description, amount: parseFloat(amount) || 0, vat, date, daysToPay: parseInt(daysToPay) || 30, status, transactionId },
            }),
          });
          if (outgoingsClient?.masterSheetId) {
            outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
          }
          setDirectCostsJobs(prev => prev && prev.map(j => ({
            ...j,
            rows: j.rows.map(r => r.rowNum !== rowNum ? r : {
              ...r,
              expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== slotNum ? sl : {
                ...sl, description, amount: parseFloat(amount) || 0, vat, date, daysToPay: parseInt(daysToPay) || 30, status, transactionId,
              }),
            }),
          })));
          close();
        } catch(e) { console.error("update_expense_slot save error:", e); }
        finally { setSaving(false); }
      };

      const doDelete = async () => {
        setSaving(true);
        try {
          await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update_expense_slot",
              clientSheetId: outgoingsClient?.clientSheetId,
              rowNum, slotNum, deleteSlot: true,
            }),
          });
          if (outgoingsClient?.masterSheetId) {
            outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
          }
          setDirectCostsJobs(prev => prev && prev.map(j => ({
            ...j,
            rows: j.rows.map(r => r.rowNum !== rowNum ? r : {
              ...r,
              expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== slotNum ? sl : {
                ...sl, description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: "",
              }),
            }),
          })));
          close();
        } catch(e) { console.error("update_expense_slot delete error:", e); }
        finally { setSaving(false); }
      };

      const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" };
      const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) close(); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Edit expense — Row {rowNum}, Slot {slotNum}</h3>
              <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
            </div>

            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Description</label>
                <input style={inputStyle} value={description} onChange={e => setDescription(e.target.value)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>Amount (£)</label>
                  <input style={inputStyle} type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>VAT charged?</label>
                  <select style={inputStyle} value={vat} onChange={e => setVat(e.target.value)}>
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>Date</label>
                  <input style={inputStyle} value={date} onChange={e => setDate(e.target.value)} placeholder="DD-Mon-YY" />
                </div>
                <div>
                  <label style={labelStyle}>Days to pay</label>
                  <input style={inputStyle} type="number" value={daysToPay} onChange={e => setDaysToPay(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Status</label>
                <input style={inputStyle} value={status} onChange={e => setStatus(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Transaction ID</label>
                <input style={inputStyle} value={transactionId} onChange={e => setTransactionId(e.target.value)} />
              </div>
            </div>

            {confirmingDelete ? (
              <div style={{ marginTop: "18px", padding: "12px", background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "8px" }}>
                <div style={{ fontSize: "13px", color: "#991b1b", marginBottom: "10px" }}>Delete this expense? This clears all 7 fields for this slot and can't be undone from here.</div>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmingDelete(false)} disabled={saving}
                    style={{ padding: "7px 14px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                  <button onClick={doDelete} disabled={saving}
                    style={{ padding: "7px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.7 : 1 }}>
                    {saving ? "Deleting..." : "Yes, delete"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
                <button onClick={() => setConfirmingDelete(true)} disabled={saving}
                  style={{ padding: "8px 16px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                  Delete expense
                </button>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={close} disabled={saving}
                    style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                  <button onClick={save} disabled={saving}
                    style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    };

    const EstimateModal = () => {
      if (!outgoingsEstimate) return null;
      const { contractor } = outgoingsEstimate;
      const [amount, setAmount] = React.useState("");
      const [payDate, setPayDate] = React.useState("");
      const [desc, setDesc] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      const defaultIdx = outgoingsData ? Math.max(0, outgoingsData.months.findIndex(m => m.colLetter === outgoingsEstimate.colLetter)) : 0;
      const [selectedMonthIdx, setSelectedMonthIdx] = React.useState(defaultIdx);
      const selectedMonth = outgoingsData?.months[selectedMonthIdx];

      const save = async () => {
        if (!amount || !selectedMonth) return;
        setSaving(true);
        const manualId = `MANUAL-ENTRY-${Date.now()}`;
        const existing = (contractor.cells[selectedMonth.colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"));
        await updateCell(contractor, selectedMonth.colLetter, [...existing, {
          appId: manualId, amount: parseFloat(amount), status: "", recDate: "", payDate: payDate || "",
          description: desc || `${contractor.name} estimate`,
        }]);
        setOutgoingsEstimate(null);
      };

      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setOutgoingsEstimate(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 440px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Add estimate</h3>
                <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>{contractor.name}</div>
              </div>
              <button onClick={() => setOutgoingsEstimate(null)} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>x</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Month *</label>
                <select value={selectedMonthIdx} onChange={e => setSelectedMonthIdx(parseInt(e.target.value))}
                  style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px" }}>
                  {(outgoingsData?.months || []).map((m, idx) => <option key={m.colLetter} value={idx}>{fmtMonthLabel(m.isoMonth || m.label)}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Amount (£) *</label>
                <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" autoFocus
                  style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Expected pay date</label>
                <input type="text" value={payDate} onChange={e => setPayDate(e.target.value)} placeholder="e.g. 28-Apr-26"
                  style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Description</label>
                <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional note"
                  style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "flex-end" }}>
              <button onClick={() => setOutgoingsEstimate(null)}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={save} disabled={!amount || saving}
                style={{ padding: "8px 22px", background: !amount ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: !amount ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {saving ? "Adding..." : "Add estimate"}
              </button>
            </div>
          </div>
        </div>
      );
    };

    const NewVendorModal = () => {
      if (!outgoingsNewVendor) return null;
      const { exp } = outgoingsNewVendor;
      const [vendorName, setVendorName] = React.useState(exp.description || exp.accountName || "");
      const [vatFlag, setVatFlag] = React.useState("Yes");
      const [invTiming, setInvTiming] = React.useState("Curr");
      const [payTiming, setPayTiming] = React.useState("Curr");
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");

      const save = async () => {
        if (!vendorName.trim()) { setError("Please enter a vendor name"); return; }
        setSaving(true);
        try {
          const res = await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "create_outgoings_vendor",
              clientSheetId: outgoingsClient?.clientSheetId,
              vendorName: vendorName.trim(),
              vatFlag, invTiming, payTiming,
            }),
          });
          const data = await res.json();
          if (!data.success) { setError(data.error || "Failed to create vendor"); setSaving(false); return; }
          // Capture client ref before closing modal (closing clears outgoingsNewVendor state)
          const clientToReload = outgoingsClient;
          setOutgoingsNewVendor(null);
          // Reload grid so new vendor row appears — must use captured ref
          await loadOutgoings(clientToReload);
        } catch(e) { setError(e.message); setSaving(false); }
      };

      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setOutgoingsNewVendor(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 440px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Create new vendor</h3>
              <button onClick={() => setOutgoingsNewVendor(null)} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>x</button>
            </div>
            <div style={{ fontSize: "12px", color: "#888", background: "#f8f8f8", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
              <strong>Expense to place:</strong> {exp.description || exp.accountName} — £{exp.amount}<br/>
              <span style={{ fontFamily: "monospace", fontSize: "10px" }}>{exp.appId}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Vendor name (col A) *</label>
                <input type="text" value={vendorName} onChange={e => setVendorName(e.target.value)} autoFocus
                  style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>VAT?</label>
                  <select value={vatFlag} onChange={e => setVatFlag(e.target.value)}
                    style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px" }}>
                    <option>Yes</option><option>No</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Inv timing</label>
                  <select value={invTiming} onChange={e => setInvTiming(e.target.value)}
                    style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px" }}>
                    <option>Curr</option><option>Next</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Pay timing</label>
                  <select value={payTiming} onChange={e => setPayTiming(e.target.value)}
                    style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px" }}>
                    <option>Curr</option><option>Next</option>
                  </select>
                </div>
              </div>
              {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px" }}>{error}</div>}
            </div>
            <p style={{ fontSize: "11px", color: "#999", margin: "12px 0 0" }}>
              A new row will be inserted in the Contractors section of the Outgoings tab. You can then place the expense in the correct month cell.
            </p>
            <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
              <button onClick={() => setOutgoingsNewVendor(null)}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={save} disabled={saving || !vendorName.trim()}
                style={{ padding: "8px 22px", background: saving || !vendorName.trim() ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {saving ? "Creating..." : "Create vendor"}
              </button>
            </div>
          </div>
        </div>
      );
    };

    const allClients = allOutgoingsClients.length > 0
      ? allOutgoingsClients
      : [...(clientsWithFlags || [])].sort((a, b) => a.clientName.localeCompare(b.clientName));
    const noClient = !outgoingsClient || !outgoingsData;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        {outgoingsEditCell && <EditModal />}
        {directCostsEditSlot && <DirectCostsEditModal />}
        {outgoingsEstimate && <EstimateModal />}
        {outgoingsNewVendor && <NewVendorModal />}
        {outgoingsReplacePrompt && (() => {
          const { exp, contractor, colLetter, realBlocks, totalManual, blocksWithoutManual } = outgoingsReplacePrompt;
          const doPlace = async (keepManual) => {
            setOutgoingsReplacePrompt(null);
            const base = keepManual ? realBlocks : blocksWithoutManual;
            const newBlock = { appId: exp.appId, amount: exp.amount, status: exp.status || "", recDate: exp.date || "", payDate: exp.datePaid || "", description: exp.description || exp.accountName || "" };
            await updateCell(contractor, colLetter, [...base, newBlock]);
            setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
            addAssignedAppId(exp.appId, outgoingsClient?.clientName);
            setOutgoingsPlacing(null);
          };
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 400px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <h3 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: "700" }}>Manual entry exists</h3>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#555" }}>
                  This cell already contains a manual entry of <strong>£{totalManual.toFixed(2)}</strong>.<br/>
                  Would you like to replace it or keep both?
                </p>
                <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                  <button onClick={() => setOutgoingsReplacePrompt(null)}
                    style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                    Cancel
                  </button>
                  <button onClick={() => doPlace(true)}
                    style={{ padding: "8px 18px", background: "#f0f9ff", border: "1px solid #93c5fd", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#1d4ed8" }}>
                    Add alongside
                  </button>
                  <button onClick={() => doPlace(false)}
                    style={{ padding: "8px 18px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                    Replace
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {outgoingsPlacing && (
          <div style={{ background: "#1a56db", color: "#fff", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
            <span>Placing: <strong>{outgoingsPlacing.description || outgoingsPlacing.accountName}</strong> — £{(outgoingsPlacing.amount || 0).toLocaleString()} · Click a contractor cell to place it</span>
            <button onClick={() => setOutgoingsPlacing(null)}
              style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "4px", padding: "4px 12px", cursor: "pointer", fontSize: "12px" }}>Cancel</button>
          </div>
        )}

        <div style={{ padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            {outgoingsClient && (
              <button onClick={() => { setOutgoingsData(null); setOutgoingsClient(null); setOutgoingsInbox([]); setOutgoingsPlacing(null); }}
                style={{ background: "none", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", padding: "4px 10px", fontSize: "16px", color: "#555", lineHeight: 1 }}
                title="Back to client list">&#8592;</button>
            )}
            <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
              {outgoingsClient ? outgoingsClient.clientName : "Vendors"}
            </h2>
            {outgoingsClient && (
              <button className="triage-btn"
                onClick={() => {
                  if (outgoingsClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${outgoingsClient.clientSheetId}/edit`, "_blank");
                }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd", marginLeft: "auto" }}>
                📊 Open Sheets
              </button>
            )}
          </div>

          {noClient && (
            <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
              {outgoingsLoading ? (
                <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading...</div>
              ) : (
                <>
                  <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to assign vendor expenses:</p>
                  {(() => {
                    // Group clients: those with unassigned inbox items first
                    const clientsWithInbox = allClients.filter(c =>
                      clientsWithFlags?.some(f => f.clientName === c.clientName &&
                        (f.flags?.expenseDashboardDiscr || f.flags?.expenseAppDiscr || f.flags?.dirCompMismatch))
                    );
                    const clientsNoInbox = allClients.filter(c => !clientsWithInbox.includes(c));
                    const renderClientBtn = (c) => (
                      <button key={c.clientName} onClick={() => loadOutgoings(c)}
                        style={{ padding: "10px 16px", background: c.inboxCount > 0 ? "#fff7ed" : "#f8f9ff",
                          border: `1px solid ${c.inboxCount > 0 ? "#fed7aa" : "#dde"}`,
                          borderRadius: "8px", cursor: "pointer", textAlign: "left", fontSize: "14px", fontWeight: "500",
                          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>{c.clientName}</span>
                        {c.inboxCount > 0 && <span style={{ fontSize: "11px", background: "#f97316", color: "#fff", borderRadius: "10px", padding: "1px 7px" }}>{c.inboxCount} to assign</span>}
                      </button>
                    );
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {clientsWithInbox.length > 0 && clientsNoInbox.length > 0 && (
                          <div style={{ fontSize: "11px", fontWeight: "700", color: "#f97316", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>Expenses to assign</div>
                        )}
                        {clientsWithInbox.map(renderClientBtn)}
                        {clientsNoInbox.length > 0 && clientsWithInbox.length > 0 && (
                          <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>No expenses to assign</div>
                        )}
                        {clientsNoInbox.map(renderClientBtn)}
                        {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet — go to Home and refresh first.</p>}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {!noClient && (
            <div style={{ background: "#fff", border: `1px solid ${outgoingsInbox.length > 0 ? "#ffc107" : "#e0e0e0"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: outgoingsInbox.length > 0 ? "#e65100" : "#888", marginBottom: outgoingsInbox.length > 0 ? "6px" : "0" }}>
                {outgoingsInbox.length > 0
                  ? `Unmatched expenses (${outgoingsInbox.length}) — click to select, then click a cell to place`
                  : "No unmatched expenses — inbox is clear ✓"}
              </div>
              {outgoingsInbox.length > 0 && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {outgoingsInbox.map((exp, i) => {
                      const isPlacing = outgoingsPlacing?.appId === exp.appId;
                      return (
                        <div key={i} style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
                        <div
                          onClick={() => {
                            setOutgoingsPlacing(outgoingsPlacingRef.current?.appId === exp.appId ? null : exp);
                          }}
                          style={{ background: isPlacing ? "#1a56db" : "#fff8e1", border: `1.5px solid ${isPlacing ? "#1a56db" : "#ffc107"}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px", cursor: "pointer", textAlign: "left", color: isPlacing ? "#fff" : "#333", transition: "background 0.1s, border-color 0.1s", display: "flex", flexDirection: "column", gap: "2px", userSelect: "none" }}>
                          <div style={{ fontWeight: "700" }}>{exp.description || exp.accountName}</div>
                          <div style={{ opacity: 0.8 }}>£{(exp.amount || 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })} · {exp.date}</div>
                          <div style={{ fontSize: "10px", opacity: 0.7 }}>{isPlacing ? "Click a cell below to place" : "Click to select"}</div>
                        </div>
                        {vendorsSubTab === "contractors" && (
                          <button onClick={e => { e.stopPropagation(); setOutgoingsNewVendor({ exp }); }}
                            title="Create new vendor row for this expense"
                            style={{ fontSize: "10px", padding: "2px 8px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", color: "#555", whiteSpace: "nowrap" }}>
                            + New vendor
                          </button>
                        )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {!noClient && outgoingsData && (
            <>
              <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e0e0e0" }}>
                <button onClick={() => setVendorsSubTab("contractors")}
                  style={{ padding: "8px 16px", background: "none", border: "none",
                    borderBottom: vendorsSubTab === "contractors" ? "2px solid #0066cc" : "2px solid transparent",
                    color: vendorsSubTab === "contractors" ? "#0066cc" : "#666",
                    fontWeight: vendorsSubTab === "contractors" ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                  Contractors
                </button>
                <button onClick={() => {
                    setVendorsSubTab("directCosts");
                    if (!directCostsJobs) loadDirectCostsJobs(outgoingsClient, false);
                  }}
                  style={{ padding: "8px 16px", background: "none", border: "none",
                    borderBottom: vendorsSubTab === "directCosts" ? "2px solid #0066cc" : "2px solid transparent",
                    color: vendorsSubTab === "directCosts" ? "#0066cc" : "#666",
                    fontWeight: vendorsSubTab === "directCosts" ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                  Direct costs
                </button>
              </div>
            </>
          )}

          {!noClient && outgoingsData && vendorsSubTab === "contractors" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <button onClick={() => setOutgoingsMonthOffset(Math.max(0, outgoingsMonthOffset - 1))}
                  disabled={outgoingsMonthOffset === 0}
                  style={{ padding: "5px 12px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: outgoingsMonthOffset === 0 ? "default" : "pointer", opacity: outgoingsMonthOffset === 0 ? 0.4 : 1 }}>◀</button>
                <span style={{ fontSize: "13px", color: "#555", minWidth: "140px", textAlign: "center" }}>
                  {fmtMonthLabel(visibleMonths[0]?.isoMonth || visibleMonths[0]?.label)} – {fmtMonthLabel(visibleMonths[visibleMonths.length - 1]?.isoMonth || visibleMonths[visibleMonths.length - 1]?.label)}
                </span>
                <button onClick={() => setOutgoingsMonthOffset(Math.min((outgoingsData.months.length - OUTGOINGS_WINDOW), outgoingsMonthOffset + 1))}
                  disabled={outgoingsMonthOffset >= outgoingsData.months.length - OUTGOINGS_WINDOW}
                  style={{ padding: "5px 12px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: "pointer" }}>▶</button>
                <button onClick={async () => { setOutgoingsLoading(true); await loadOutgoings(outgoingsClient); setOutgoingsLoading(false); }}
                  disabled={outgoingsLoading}
                  style={{ marginLeft: "auto", padding: "5px 14px", background: outgoingsLoading ? "#e0e0e0" : "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: outgoingsLoading ? "default" : "pointer", fontSize: "12px" }}>
                  {outgoingsLoading ? "Loading..." : "↻ Refresh"}
                </button>
              </div>

              <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed", minWidth: `${190 + OUTGOINGS_WINDOW * 160}px` }}>
                  <colgroup>
                    <col style={{ width: "190px" }} />
                    {visibleMonths.map(m => <col key={m.colLetter} style={{ width: "160px" }} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ padding: "9px 12px", background: "#f5f6fa", borderBottom: "2px solid #ddd", borderRight: "1px solid #e0e0e0", fontSize: "12px", fontWeight: "700", textAlign: "left", position: "sticky", left: 0, zIndex: 2 }}>Contractor</th>
                      {visibleMonths.map(m => {
                        const isCurr = isCurrentMonth(m.isoMonth || m.label);
                        return (
                          <th key={m.colLetter} style={{ padding: "9px 10px", background: isCurr ? "#e8f0fe" : "#f5f6fa", borderBottom: "2px solid #ddd", borderRight: "1px solid #e0e0e0", fontSize: "12px", fontWeight: "700", textAlign: "center", color: isCurr ? "#1a56db" : "#444" }}>
                            {fmtMonthLabel(m.isoMonth || m.label)}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {outgoingsData.contractors.map((contractor, rowIdx) => (
                      <tr key={contractor.sheetRow} style={{ background: rowIdx % 2 === 0 ? "#fff" : "#fafbfd" }}>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", borderRight: "1px solid #e0e0e0", fontSize: "12px", background: rowIdx % 2 === 0 ? "#fff" : "#fafbfd", position: "sticky", left: 0, zIndex: 1, verticalAlign: "top" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontWeight: "600", color: "#222" }}>{contractor.name}</div>
                              <div style={{ fontSize: "10px", color: "#aaa", marginTop: "1px" }}>VAT:{contractor.vatFlag} · Inv:{contractor.invTiming} · Pay:{contractor.payTiming}</div>
                            </div>
                            <button
                              onClick={() => {
                                const curM = visibleMonths.find(m => isCurrentMonth(m.label)) || visibleMonths[3] || visibleMonths[0];
                                if (curM) setOutgoingsEstimate({ contractor, colLetter: curM.colLetter, monthLabel: curM.label });
                              }}
                              title="Add estimate"
                              style={{ background: "none", border: "1px solid #ddd", borderRadius: "4px", cursor: "pointer", color: "#888", fontSize: "16px", padding: "0 5px", lineHeight: "18px", flexShrink: 0, marginLeft: "4px" }}>+</button>
                          </div>
                        </td>
                        {visibleMonths.map(m => {
                          const cell = contractor.cells[m.colLetter] || { blocks: [] };
                          const realBlocks = (cell.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"));
                          const total = realBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                          const isEmpty = realBlocks.length === 0;
                          const isTarget = !!outgoingsPlacing;
                          const isCurr = isCurrentMonth(m.isoMonth || m.label);

                          const handleCellClick = async () => {
                            if (outgoingsPlacingRef.current) {
                              const exp = outgoingsPlacingRef.current;
                              const expDesc = (exp.description || exp.accountName || "").toLowerCase();
                              const contrWords = contractor.name.toLowerCase().replace(/[()]/g, " ").split(/\s+/).filter(w => w.length > 3);
                              const nameMatch = contrWords.some(w => expDesc.includes(w));
                              if (!nameMatch) {
                                const ok = window.confirm("Vendor mismatch?\n\nExpense: \"" + (exp.description || exp.accountName) + "\"\nContractor: \"" + contractor.name + "\"\n\nPlace anyway?");
                                if (!ok) return;
                              }
                              // Check for existing manual entry blocks
                              const manualBlocks = realBlocks.filter(b => b.appId && b.appId.startsWith("MANUAL-ENTRY"));
                              if (manualBlocks.length > 0) {
                                const totalManual = manualBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                                // Show custom UI dialog instead of window.confirm
                                setOutgoingsReplacePrompt({
                                  exp, contractor, colLetter: m.colLetter, realBlocks, totalManual,
                                  blocksWithoutManual: realBlocks.filter(b => !b.appId || !b.appId.startsWith("MANUAL-ENTRY")),
                                });
                                return; // wait for user choice in dialog
                              }
                              const newBlock = { appId: exp.appId, amount: exp.amount, status: exp.status || "", recDate: exp.date || "", payDate: exp.datePaid || "", description: exp.description || exp.accountName || "" };
                              await updateCell(contractor, m.colLetter, [...realBlocks, newBlock]);
                              setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                              addAssignedAppId(exp.appId, outgoingsClient?.clientName);
                              setOutgoingsPlacing(null);
                            } else {
                              setOutgoingsEditCell({ contractor, colLetter: m.colLetter, monthLabel: m.label });
                            }
                          };

                          return (
                            <td key={m.colLetter} onClick={handleCellClick}
                              style={{ padding: "6px 8px", borderBottom: "1px solid #eee", borderRight: "1px solid #e0e0e0", verticalAlign: "top", cursor: "pointer", minHeight: "52px",
                                background: isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8",
                                outline: isTarget ? "2px dashed #1a56db" : "none", outlineOffset: "-2px" }}
                              onMouseEnter={e => { e.currentTarget.style.background = "#f0f4ff"; }}
                              onMouseLeave={e => { e.currentTarget.style.background = isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8"; }}>
                              {!isEmpty ? (
                                <>
                                  <div style={{ fontWeight: "700", fontSize: "12px", color: "#1a56db", marginBottom: "3px" }}>
                                    £{total.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                                  </div>
                                  {realBlocks.map((b, bi) => {
                                    const sc = getStatusColour(b.status);
                                    return (
                                      <div key={bi}
                                        style={{ fontSize: "10px", background: sc.bg, border: `1px solid ${sc.border}`, borderRadius: "3px", padding: "2px 5px", marginBottom: "2px", color: sc.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        £{parseFloat(b.amount).toLocaleString("en-GB", { minimumFractionDigits: 0 })}{b.status ? ` · ${b.status}` : ""}{
                                          // Show (split) if this App ID appears in any OTHER month column for this contractor
                                          !b.appId.startsWith("MANUAL-ENTRY") && !b.appId.startsWith("UNRECON-GAP") &&
                                          (outgoingsData?.months || []).some(mo =>
                                            mo.colLetter !== m.colLetter &&
                                            (contractor.cells[mo.colLetter]?.blocks || []).some(ob => ob.appId === b.appId)
                                          ) ? " (split)" : ""
                                        }
                                      </div>
                                    );
                                  })}
                                </>
                              ) : (
                                <div style={{ color: isTarget ? "#1a56db" : "#d0d0d0", fontSize: "18px", textAlign: "center", paddingTop: "4px" }}>{isTarget ? "+" : "+"}</div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!noClient && outgoingsData && vendorsSubTab === "directCosts" && (
            <>
              {directCostsLoading && (
                <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
              )}
              {!directCostsLoading && directCostsJobs && (
                <>
                  <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1140px", tableLayout: "fixed" }}>
                      <colgroup>
                        <col style={{ width: "50px" }} />
                        <col style={{ width: "130px" }} />
                        <col style={{ width: "160px" }} />
                        <col style={{ width: "80px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "70px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "40px" }} />
                      </colgroup>
                      <thead>
                        <tr style={{ background: "#f5f6fa" }}>
                          {["Row","Client","Job name","Code","Revenue","Direct costs","Type","Start","End",
                            "ExpSlot1","ExpSlot2","ExpSlot3",""].map(h => (
                            <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {directCostsJobs.flatMap((job, jobIdx) => {
                          const jobHasEmptySlot = job.rows.some(jr => jr.expenseSlots.some(s => !s.description && !s.amount));
                          const jobLastRow = job.rows[job.rows.length - 1].rowNum;
                          const isPlacing = !!outgoingsPlacing;
                          return job.rows.map((jr, rIdx) => {
                          const isLastRowOfJob = rIdx === job.rows.length - 1;
                          return (
                          <tr key={jr.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#fafbfd" }}>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.client : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.jobName : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.projectCode : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.revenue}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.directCosts}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.projectRetainer}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.endDate}</td>
                            {jr.expenseSlots.map(s => {
                              const isManualEntry = String(s.transactionId || "").toUpperCase().includes("MANUAL-ENTRY");
                              const isGenuinelyBlank = !s.description && !s.amount;
                              const isEmpty = isGenuinelyBlank || isManualEntry;
                              const isPlacing = !!outgoingsPlacing;
                              const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                              const isSaving = directCostsSavingCell === cellSavingKey;
                              return (
                                <td key={s.slotNum}
                                  onClick={async () => {
                                    if (isSaving) return;
                                    if (isPlacing && isEmpty) {
                                      const exp = outgoingsPlacingRef.current;
                                      if (!exp) return;
                                      setOutgoingsPlacing(null);
                                      setDirectCostsSavingCell(cellSavingKey);
                                      setAssignedAppIds(prevSet => {
                                        const next = new Set(prevSet); next.add(exp.appId);
                                        try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
                                        return next;
                                      });
                                      setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                                      try {
                                        await fetch("/api/triage", {
                                          method: "POST", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({
                                            action: "assign_expense_to_job",
                                            clientSheetId: outgoingsClient?.clientSheetId,
                                            masterSheetId: outgoingsClient?.masterSheetId || "",
                                            rowNum: jr.rowNum, slotNum: s.slotNum, expense: exp,
                                          }),
                                        });
                                        if (outgoingsClient?.masterSheetId) {
                                          outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
                                        }
                                        // Update the placed slot in place — no full-table reload/flash
                                        setDirectCostsJobs(prev => prev && prev.map(j => ({
                                          ...j,
                                          rows: j.rows.map(r => r.rowNum !== jr.rowNum ? r : {
                                            ...r,
                                            expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== s.slotNum ? sl : {
                                              ...sl,
                                              description: exp.description || exp.accountName || "",
                                              amount: exp.amount || 0,
                                              date: exp.date || "",
                                              status: exp.status || "",
                                              transactionId: exp.appId || "",
                                            }),
                                          }),
                                        })));
                                      } catch(e) { console.error("assign_expense_to_job error:", e); }
                                      finally { setDirectCostsSavingCell(null); }
                                    } else if (!isPlacing && !isGenuinelyBlank) {
                                      // Click a filled (or manual-entry) slot when not placing → open edit modal
                                      setDirectCostsEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s });
                                    }
                                  }}
                                  style={{ padding: "7px 10px", borderBottom: "1px solid #eee",
                                    cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                    background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                    border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none" }}>
                                  {isSaving ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#666" }}>
                                      <Spinner size={12} color="#1a56db" /> Saving...
                                    </div>
                                  ) : isGenuinelyBlank ? (
                                    isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>—</span>
                                  ) : (
                                    <div>
                                      <div style={{ fontWeight: "600", color: isManualEntry ? "#9333ea" : "inherit" }}>
                                        {isManualEntry && "(placeholder) "}{s.description}
                                      </div>
                                      <div style={{ color: "#888" }}>{/^[£$€]/.test(String(s.amount)) ? s.amount : `£${s.amount}`} · {s.date}{s.status ? ` · ${s.status}` : ""}</div>
                                      {isManualEntry && isPlacing && (
                                        <div style={{ color: "#1a56db", fontWeight: "700", marginTop: "2px" }}>Click to overwrite</div>
                                      )}
                                      {!isPlacing && (
                                        <div style={{ color: "#1a56db", fontSize: "10px", marginTop: "2px" }}>Click to edit</div>
                                      )}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                            {/* Thin +row cell — only on the job's last row, only when no slot is
                                free anywhere in the job, and only while an expense is selected */}
                            <td style={{ padding: "0", borderBottom: "1px solid #eee", textAlign: "center" }}>
                              {directCostsSavingCell === `newrow-${job.client}|||${job.jobName}` ? (
                                <div style={{ height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                  <Spinner size={12} color="#1a56db" />
                                </div>
                              ) : isLastRowOfJob && !jobHasEmptySlot && isPlacing && (
                                <div
                                  title="No spare expense slot — click to add a new row for this job"
                                  onClick={async () => {
                                    const exp = outgoingsPlacingRef.current;
                                    if (!exp) return;
                                    setOutgoingsPlacing(null);
                                    const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                    setDirectCostsSavingCell(savingKey);
                                    setAssignedAppIds(prevSet => {
                                      const next = new Set(prevSet); next.add(exp.appId);
                                      try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
                                      return next;
                                    });
                                    setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                                    try {
                                      await fetch("/api/triage", {
                                        method: "POST", headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          action: "assign_expense_to_job",
                                          clientSheetId: outgoingsClient?.clientSheetId,
                                          masterSheetId: outgoingsClient?.masterSheetId || "",
                                          createNewRow: true,
                                          jobLastRow, jobClient: job.client, jobName: job.jobName,
                                          expense: exp,
                                        }),
                                      });
                                      if (outgoingsClient?.masterSheetId) {
                                        outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
                                      }
                                      await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
                                    } catch(e) { console.error("assign_expense_to_job (new row) error:", e); }
                                    finally { setDirectCostsSavingCell(null); }
                                  }}
                                  style={{ cursor: "pointer", background: "#e8f0fe", border: "1.5px solid #1a56db",
                                    height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center",
                                    color: "#1a56db", fontWeight: "700", fontSize: "16px" }}>
                                  +
                                </div>
                              )}
                            </td>
                          </tr>
                          );
                          });
                        })}
                      </tbody>
                    </table>
                  </div>
                  {!directCostsShowAll && (
                    <div style={{ textAlign: "center", marginTop: "14px" }}>
                      <button onClick={() => { setDirectCostsShowAll(true); loadDirectCostsJobs(outgoingsClient, true); }}
                        style={{ padding: "8px 20px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                        Show all jobs
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </NavShell>
    );
  }


  // ── INVOICES SCREEN ─────────────────────────────────────────────────────────
  const InvoicesEditModal = () => {
    if (!invoicesEditSlot) return null;
    const { rowNum, slotNum, slot } = invoicesEditSlot;
    const stripCurrency = v => String(v ?? "").replace(/^[£$€]/, "").trim();
    const [invoiceNo, setInvoiceNo] = React.useState(slot.ref || "");
    const [amount, setAmount] = React.useState(stripCurrency(slot.amount));
    const [sentDate, setSentDate] = React.useState(slot.sentDate || "");
    const [daysToPay, setDaysToPay] = React.useState(slot.daysToPay || 30);
    const [status, setStatus] = React.useState(slot.status || "");
    const [saving, setSaving] = React.useState(false);
    const [confirmingDelete, setConfirmingDelete] = React.useState(false);

    const close = () => setInvoicesEditSlot(null);

    const save = async () => {
      setSaving(true);
      try {
        await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_invoice_slot",
            clientSheetId: invoicesClient?.clientSheetId,
            rowNum, slotNum,
            invoice: { invoiceNo, amount: parseFloat(amount) || 0, sentDate, daysToPay: parseInt(daysToPay) || 30, status },
          }),
        });
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        setInvoicesJobs(prev => prev && prev.map(j => ({
          ...j,
          rows: j.rows.map(r => r.rowNum !== rowNum ? r : {
            ...r,
            invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== slotNum ? sl : {
              ...sl, ref: invoiceNo, amount: parseFloat(amount) || 0, sentDate, daysToPay: parseInt(daysToPay) || 30, status,
            }),
          }),
        })));
        close();
      } catch(e) { console.error("update_invoice_slot save error:", e); }
      finally { setSaving(false); }
    };

    const doDelete = async () => {
      setSaving(true);
      try {
        await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_invoice_slot",
            clientSheetId: invoicesClient?.clientSheetId,
            rowNum, slotNum, deleteSlot: true,
          }),
        });
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        setInvoicesJobs(prev => prev && prev.map(j => ({
          ...j,
          rows: j.rows.map(r => r.rowNum !== rowNum ? r : {
            ...r,
            invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== slotNum ? sl : {
              ...sl, ref: "", amount: "", sentDate: "", daysToPay: "", status: "",
            }),
          }),
        })));
        close();
      } catch(e) { console.error("update_invoice_slot delete error:", e); }
      finally { setSaving(false); }
    };

    const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" };
    const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={e => { if (e.target === e.currentTarget) close(); }}>
        <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Edit invoice — Row {rowNum}, Slot {slotNum}</h3>
            <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={labelStyle}>Invoice number</label>
              <input style={inputStyle} value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div>
                <label style={labelStyle}>Amount (£)</label>
                <input style={inputStyle} type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Days to pay</label>
                <input style={inputStyle} type="number" value={daysToPay} onChange={e => setDaysToPay(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Sent date</label>
              <input style={inputStyle} value={sentDate} onChange={e => setSentDate(e.target.value)} placeholder="DD-Mon-YY" />
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <input style={inputStyle} value={status} onChange={e => setStatus(e.target.value)} />
            </div>
          </div>

          {confirmingDelete ? (
            <div style={{ marginTop: "18px", padding: "12px", background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "8px" }}>
              <div style={{ fontSize: "13px", color: "#991b1b", marginBottom: "10px" }}>Delete this invoice entry? This clears all 5 fields for this slot and can't be undone from here.</div>
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button onClick={() => setConfirmingDelete(false)} disabled={saving}
                  style={{ padding: "7px 14px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                <button onClick={doDelete} disabled={saving}
                  style={{ padding: "7px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.7 : 1 }}>
                  {saving ? "Deleting..." : "Yes, delete"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
              <button onClick={() => setConfirmingDelete(true)} disabled={saving}
                style={{ padding: "8px 16px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Delete invoice
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={close} disabled={saving}
                  style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                <button onClick={save} disabled={saving}
                  style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const InvoicesNewJobModal = () => {
    if (!invoicesNewJob) return null;
    const { inv } = invoicesNewJob;
    const [jobName, setJobName] = React.useState(inv.job || "");
    const [projectCode, setProjectCode] = React.useState("");
    const [revenue, setRevenue] = React.useState(String(inv.amount || ""));
    const [directCosts, setDirectCosts] = React.useState("0");
    const [vatYesNo, setVatYesNo] = React.useState(inv.vatAmount > 0 ? "Yes" : "No");
    const [projectType, setProjectType] = React.useState("Project");
    const [startDate, setStartDate] = React.useState(inv.sentDate || "");
    const [endDate, setEndDate] = React.useState(inv.dueDate || "");
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");

    const close = () => setInvoicesNewJob(null);

    const save = async () => {
      if (!jobName.trim()) { setError("Please enter a job name"); return; }
      setSaving(true);
      try {
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_job_from_invoice",
            clientSheetId: invoicesClient?.clientSheetId,
            jobName: jobName.trim(), projectCode: projectCode.trim(),
            revenue: parseFloat(revenue) || 0, directCosts: parseFloat(directCosts) || 0,
            vatYesNo, projectType, startDate, endDate,
            invoice: inv,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to create job"); setSaving(false); return; }
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        setAssignedAppIds(prevSet => {
          const next = new Set(prevSet); next.add(inv.invoiceNo);
          try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
          return next;
        });
        setInvoicesInbox(prev => prev.filter(e => e.invoiceNo !== inv.invoiceNo));
        const clientToReload = invoicesClient;
        close();
        await loadInvoicesJobs(clientToReload, invoicesShowAll);
      } catch(e) { setError(e.message); setSaving(false); }
    };

    const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" };
    const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={e => { if (e.target === e.currentTarget) close(); }}>
        <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Create new job</h3>
            <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
          </div>
          <div style={{ fontSize: "12px", color: "#888", background: "#f8f8f8", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
            <strong>Invoice to place:</strong> #{inv.invoiceNo} — £{inv.amount.toFixed(2)}<br/>
            {inv.client}{inv.job ? ` — ${inv.job}` : ""} · {inv.sentDate}
          </div>

          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label style={labelStyle}>Client (col A)</label>
              <input style={{ ...inputStyle, background: "#f5f5f5", color: "#888" }} value={inv.client || ""} disabled />
            </div>
            <div>
              <label style={labelStyle}>Job name (col B) *</label>
              <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Project code (col C)</label>
              <input style={inputStyle} value={projectCode} onChange={e => setProjectCode(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div>
                <label style={labelStyle}>Revenue (£, AG)</label>
                <input style={inputStyle} type="number" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Direct costs (£, AH)</label>
                <input style={inputStyle} type="number" step="0.01" value={directCosts} onChange={e => setDirectCosts(e.target.value)} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div>
                <label style={labelStyle}>VAT? (AI)</label>
                <select style={inputStyle} value={vatYesNo} onChange={e => setVatYesNo(e.target.value)}>
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Type (AJ)</label>
                <select style={inputStyle} value={projectType} onChange={e => setProjectType(e.target.value)}>
                  <option value="Project">Project</option>
                  <option value="Retainer">Retainer</option>
                </select>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div>
                <label style={labelStyle}>Start date (AL)</label>
                <input style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} placeholder="DD-Mon-YY" />
              </div>
              <div>
                <label style={labelStyle}>End date (AM)</label>
                <input style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} placeholder="DD-Mon-YY" />
              </div>
            </div>
          </div>

          {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}
          <p style={{ fontSize: "11px", color: "#999", margin: "12px 0 0" }}>
            A new row will be added at the end of the Confirmed tab, and this invoice will be written into slot 1.
          </p>
          <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
            <button onClick={close} disabled={saving}
              style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
            <button onClick={save} disabled={saving || !jobName.trim()}
              style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
              {saving ? "Creating..." : "Create job"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (activeNav === "invoices") {
    const noInvClient = !invoicesClient;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        {invoicesEditSlot && <InvoicesEditModal />}
        {invoicesNewJob && <InvoicesNewJobModal />}
        <div style={{ padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
              {invoicesClient ? invoicesClient.clientName : "Invoices"}
            </h2>
            {invoicesClient && (
              <button className="triage-btn" onClick={() => { setInvoicesClient(null); setInvoicesInbox([]); setInvoicesJobs(null); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
                ← Back to Clients
              </button>
            )}
          </div>

          {noInvClient && (
            <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
              <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to place unmatched invoices:</p>
              {(() => {
                const allClients = allOutgoingsClients || [];
                // Group clients: those with unactioned invoice discrepancies first
                const clientsWithInbox = allClients.filter(c =>
                  clientsWithFlags?.some(f => f.clientName === c.clientName &&
                    (f.flags?.invoiceDashboardDiscr || f.flags?.invoiceAppDiscr))
                );
                const clientsNoInbox = allClients.filter(c => !clientsWithInbox.includes(c));
                const renderClientBtn = (c) => (
                  <button key={c.clientName} className="triage-btn"
                    onClick={() => {
                      setInvoicesClient(c);
                      loadInvoicesInbox(c);
                      loadInvoicesJobs(c, false);
                      setInvoicesShowAll(false);
                    }}
                    style={{ padding: "10px 16px", background: "#fff8e1",
                      border: "1px solid #ffe082",
                      borderRadius: "8px", cursor: "pointer", textAlign: "left", fontSize: "14px", fontWeight: "500", width: "100%" }}>
                    {c.clientName}
                  </button>
                );
                const renderClientBtnPlain = (c) => (
                  <button key={c.clientName} className="triage-btn"
                    onClick={() => {
                      setInvoicesClient(c);
                      loadInvoicesInbox(c);
                      loadInvoicesJobs(c, false);
                      setInvoicesShowAll(false);
                    }}
                    style={{ ...styles.buttonSecondary, textAlign: "left", padding: "12px 16px", fontSize: "14px" }}>
                    {c.clientName}
                  </button>
                );
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {clientsWithInbox.length > 0 && clientsNoInbox.length > 0 && (
                      <div style={{ fontSize: "11px", fontWeight: "700", color: "#e65100", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>Invoices to assign</div>
                    )}
                    {clientsWithInbox.map(renderClientBtn)}
                    {clientsNoInbox.length > 0 && clientsWithInbox.length > 0 && (
                      <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>No invoices to assign</div>
                    )}
                    {clientsNoInbox.map(renderClientBtnPlain)}
                    {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet — go to Home and refresh first.</p>}
                  </div>
                );
              })()}
            </div>
          )}

          {!noInvClient && (
            <>
              {/* Invoice inbox */}
              <div style={{ background: "#fff", border: `1px solid ${invoicesInbox.length > 0 ? "#ffc107" : "#e0e0e0"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px" }}>
                <div style={{ fontSize: "13px", fontWeight: "700", color: invoicesInbox.length > 0 ? "#e65100" : "#888", marginBottom: invoicesInbox.length > 0 ? "6px" : "0" }}>
                  {invoicesInboxLoading ? "Loading..." : invoicesInbox.length > 0
                    ? `Unmatched invoices (${invoicesInbox.length}) — click to select, then click a slot to place`
                    : "No unmatched invoices"}
                </div>
                {invoicesInbox.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {invoicesInbox.map(inv => {
                      const isPlacing = invoicesPlacing?.invoiceNo === inv.invoiceNo;
                      return (
                        <div key={inv.invoiceNo}
                          style={{ padding: "8px 12px", borderRadius: "8px",
                            background: isPlacing ? "#1a56db" : "#fff8e1",
                            color: isPlacing ? "#fff" : "#333",
                            border: `1px solid ${isPlacing ? "#1a56db" : "#ffe082"}`,
                            fontSize: "12px", minWidth: "160px" }}>
                          <div onClick={() => setInvoicesPlacing(isPlacing ? null : inv)} style={{ cursor: "pointer" }}>
                            <div style={{ fontWeight: "700" }}>#{inv.invoiceNo} — £{inv.amount.toFixed(2)}</div>
                            <div style={{ opacity: 0.85 }}>{inv.client}{inv.job ? ` — ${inv.job}` : ""}</div>
                            <div style={{ opacity: 0.7 }}>{inv.sentDate}{inv.status ? ` · ${inv.status}` : ""}</div>
                          </div>
                          <button onClick={e => { e.stopPropagation(); setInvoicesNewJob({ inv }); }}
                            title="Create new job for this invoice"
                            style={{ marginTop: "6px", fontSize: "10px", padding: "2px 8px",
                              background: isPlacing ? "rgba(255,255,255,0.2)" : "#f0f0f0",
                              border: `1px solid ${isPlacing ? "rgba(255,255,255,0.4)" : "#ccc"}`,
                              borderRadius: "4px", cursor: "pointer",
                              color: isPlacing ? "#fff" : "#555", whiteSpace: "nowrap" }}>
                            + New job
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Jobs list — spreadsheet-style with invoice slots */}
              {invoicesJobsLoading && (
                <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
              )}
              {!invoicesJobsLoading && invoicesJobs && (
                <>
                  <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1100px", tableLayout: "fixed" }}>
                      <colgroup>
                        <col style={{ width: "50px" }} />
                        <col style={{ width: "130px" }} />
                        <col style={{ width: "160px" }} />
                        <col style={{ width: "80px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "70px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                      </colgroup>
                      <thead>
                        <tr style={{ background: "#f5f6fa" }}>
                          {["Row","Client","Job name","Code","Revenue","Direct costs","Type","Start","End",
                            "InvSlot1","InvSlot2","InvSlot3"].map(h => (
                            <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {invoicesJobs.flatMap((job, jobIdx) => job.rows.map((jr, rIdx) => (
                          <tr key={jr.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#fafbfd" }}>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.client : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.jobName : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? jr.projectCode : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.revenue}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.directCosts}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.projectRetainer}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.endDate}</td>
                            {jr.invoiceSlots.map(s => {
                              const isManualEntry = String(s.ref || "").toUpperCase().includes("MANUAL-INV");
                              const isGenuinelyBlank = !s.ref && !s.amount;
                              const isEmpty = isGenuinelyBlank || isManualEntry;
                              const isPlacing = !!invoicesPlacing;
                              const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                              const isSaving = invoicesSavingCell === cellSavingKey;
                              return (
                                <td key={s.slotNum}
                                  onClick={async () => {
                                    if (isSaving) return;
                                    if (isPlacing && isEmpty) {
                                      const inv = invoicesPlacingRef.current;
                                      if (!inv) return;
                                      setInvoicesPlacing(null);
                                      setInvoicesSavingCell(cellSavingKey);
                                      setAssignedAppIds(prevSet => {
                                        const next = new Set(prevSet); next.add(inv.invoiceNo);
                                        try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
                                        return next;
                                      });
                                      setInvoicesInbox(prev => prev.filter(e => e.invoiceNo !== inv.invoiceNo));
                                      try {
                                        await fetch("/api/triage", {
                                          method: "POST", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({
                                            action: "assign_invoice_to_job",
                                            clientSheetId: invoicesClient?.clientSheetId,
                                            rowNum: jr.rowNum, slotNum: s.slotNum, invoice: inv,
                                          }),
                                        });
                                        if (invoicesClient?.masterSheetId) {
                                          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
                                        }
                                        setInvoicesJobs(prev => prev && prev.map(j => ({
                                          ...j,
                                          rows: j.rows.map(r => r.rowNum !== jr.rowNum ? r : {
                                            ...r,
                                            invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== s.slotNum ? sl : {
                                              ...sl,
                                              amount: inv.amount || 0,
                                              ref: inv.invoiceNo || "",
                                              sentDate: inv.sentDate || "",
                                              status: inv.status || "Sent",
                                            }),
                                          }),
                                        })));
                                      } catch(e) { console.error("assign_invoice_to_job error:", e); }
                                      finally { setInvoicesSavingCell(null); }
                                    } else if (!isPlacing && !isGenuinelyBlank) {
                                      setInvoicesEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s });
                                    }
                                  }}
                                  style={{ padding: "7px 10px", borderBottom: "1px solid #eee",
                                    cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                    background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                    border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none" }}>
                                  {isSaving ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#666" }}>
                                      <Spinner size={12} color="#1a56db" /> Saving...
                                    </div>
                                  ) : isGenuinelyBlank ? (
                                    isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>—</span>
                                  ) : (
                                    <div>
                                      <div style={{ fontWeight: "600", color: isManualEntry ? "#9333ea" : "inherit" }}>
                                        {isManualEntry && "(placeholder) "}{s.ref}
                                      </div>
                                      <div style={{ color: "#888" }}>{/^[£$€]/.test(String(s.amount)) ? s.amount : `£${s.amount}`} · {s.sentDate}{s.status ? ` · ${s.status}` : ""}</div>
                                      {isManualEntry && isPlacing && (
                                        <div style={{ color: "#1a56db", fontWeight: "700", marginTop: "2px" }}>Click to overwrite</div>
                                      )}
                                      {!isPlacing && (
                                        <div style={{ color: "#1a56db", fontSize: "10px", marginTop: "2px" }}>Click to edit</div>
                                      )}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        )))}
                      </tbody>
                    </table>
                  </div>
                  {!invoicesShowAll && (
                    <div style={{ textAlign: "center", marginTop: "14px" }}>
                      <button onClick={() => { setInvoicesShowAll(true); loadInvoicesJobs(invoicesClient, true); }}
                        style={{ padding: "8px 20px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                        Show all jobs
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </NavShell>
    );
  }


  // ── SETTINGS SCREEN ─────────────────────────────────────────────────────────
  if (activeNav === "settings") {

    const saveSettings = async () => {
      setSettingsSaving(true); setSettingsSaveMsg("");
      try {
        const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save_claude_settings", automationCommanderSheetId,
            hourlyLimit: settingsEditHourly, dailyLimit: settingsEditDaily, anomalyThreshold: settingsEditAnomaly }) });
        const d = await res.json();
        if (d.success) {
          setSettingsSaveMsg("✓ Saved");
          handleNavSettings();
        } else { setSettingsSaveMsg("Error: " + d.error); }
      } catch(e) { setSettingsSaveMsg("Error: " + e.message); }
      finally { setSettingsSaving(false); }
    };

    const u = settingsData?.usage;
    const rows = settingsData?.recentRows || [];

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={{ padding: "20px", maxWidth: "800px" }}>
          <h2 style={{ margin: "0 0 20px", fontSize: "20px", fontWeight: "700" }}>Settings</h2>

          {settingsLoading && <div style={{ color: "#999", padding: "20px" }}>Loading...</div>}

          {!settingsLoading && (
            <>
              {/* Usage summary */}
              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
                <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Claude API Usage</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                  {[
                    { label: "This hour", calls: u?.thisHour?.calls ?? "–", cost: u?.thisHour?.cost ?? "–" },
                    { label: "Today", calls: u?.today?.calls ?? "–", cost: u?.today?.cost ?? "–" },
                    { label: "This week", calls: u?.week?.calls ?? "–", cost: u?.week?.cost ?? "–" },
                  ].map(({ label, calls, cost }) => (
                    <div key={label} style={{ background: "#f8f9ff", borderRadius: "8px", padding: "12px 14px", border: "1px solid #e8eaf0" }}>
                      <div style={{ fontSize: "11px", color: "#888", marginBottom: "4px" }}>{label}</div>
                      <div style={{ fontSize: "20px", fontWeight: "700", color: "#1a56db" }}>{calls}</div>
                      <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>calls · ${cost}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Limits config */}
              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
                <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Usage Limits (precompute only)</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "14px" }}>
                  {[
                    { label: "Hourly limit", val: settingsEditHourly, set: setSettingsEditHourly, hint: "Max Claude calls per hour during precompute" },
                    { label: "Daily limit", val: settingsEditDaily, set: setSettingsEditDaily, hint: "Max Claude calls per day during precompute" },
                    { label: "Anomaly threshold", val: settingsEditAnomaly, set: setSettingsEditAnomaly, hint: "If a client has ≥ this many invoice/expense alerts, skip ALL precompute Claude calls for that client" },
                  ].map(({ label, val, set, hint }) => (
                    <div key={label}>
                      <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>{label}</label>
                      <input type="number" value={val} min={1} max={500}
                        onChange={e => set(parseInt(e.target.value) || 1)}
                        style={{ width: "100%", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "15px", boxSizing: "border-box" }} />
                      <div style={{ fontSize: "10px", color: "#999", marginTop: "4px" }}>{hint}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <button onClick={saveSettings} disabled={settingsSaving}
                    style={{ padding: "8px 20px", background: settingsSaving ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: settingsSaving ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                    {settingsSaving ? "Saving..." : "Save changes"}
                  </button>
                  {settingsSaveMsg && <span style={{ fontSize: "13px", color: settingsSaveMsg.startsWith("✓") ? "#166534" : "#dc2626" }}>{settingsSaveMsg}</span>}
                </div>
                <div style={{ marginTop: "12px", fontSize: "12px", color: "#888" }}>
                  Note: limits apply to automated precompute only. On-demand analysis (clicking an alert) is always unrestricted.
                </div>
              </div>

              {/* Proactive Checks */}
              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Proactive Checks</h3>
                <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#666" }}>
                  These checks run automatically every night at 3am, across every client, and surface as alerts on the Home screen when something needs attention.
                </p>

                {[
                  { name: "Retainer invoice monitoring", detail: "Flags retainer jobs where an invoice was scheduled to be sent but no invoice reference has been recorded." },
                  { name: "CRM data wipe detection", detail: "Watches for AutoLog entries warning that the CRM wiped a job's data blank." },
                  { name: "Revenue / total invoiced mismatch", detail: "Compares each job's revenue against the total invoiced amount, flagging zero-revenue jobs with invoices and material mismatches." },
                  { name: "Direct costs / total expenses mismatch", detail: "Compares each job's direct cost budget against total recorded expenses, across both Pipeline and Confirmed." },
                  { name: "Pipeline / Confirmed overlap", detail: "Finds jobs present in both tabs where the Pipeline entry hasn't been properly closed out (likelihood not 0%, not marked copied to Confirmed)." },
                  { name: "Retainer shrink blocked", detail: "Flags retainer child rows that couldn't be automatically trimmed after a contract shrank, because the row already has actuals recorded." },
                  { name: "Uninvoiced revenue on completed jobs", detail: "Flags project jobs (not retainers) that ended more than 2 weeks ago but still have uninvoiced revenue, excluding placeholder invoices and Draft invoices that haven't been sent." },
                ].map((c, i) => (
                  <div key={c.name} style={{ display: "flex", gap: "10px", padding: "8px 0", borderTop: i > 0 ? "1px solid #f0f0f0" : "none" }}>
                    <span style={{ color: "#16a34a", fontSize: "14px", lineHeight: "20px" }}>✓</span>
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>{c.name}</div>
                      <div style={{ fontSize: "12px", color: "#777", marginTop: "2px" }}>{c.detail}</div>
                    </div>
                  </div>
                ))}

                <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #e8e8e8" }}>
                  <div style={{ fontSize: "12px", fontWeight: "700", color: "#444", marginBottom: "8px" }}>Recent run history</div>
                  {proactiveCheckLogLoading && <div style={{ fontSize: "12px", color: "#999" }}>Loading...</div>}
                  {!proactiveCheckLogLoading && proactiveCheckLog && proactiveCheckLog.length === 0 && (
                    <div style={{ fontSize: "12px", color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "10px 12px" }}>
                      No runs logged yet — the checks may not have run since this feature was added, or the nightly trigger may need checking.
                    </div>
                  )}
                  {!proactiveCheckLogLoading && proactiveCheckLog && proactiveCheckLog.length > 0 && (
                    <div>
                      <div style={{ fontSize: "12px", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "8px 12px", marginBottom: "10px" }}>
                        ✓ Last ran {new Date(proactiveCheckLog[0].runAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                        {proactiveCheckLog[0].clientsChecked > 0 ? ` — ${proactiveCheckLog[0].clientsChecked} clients checked` : ""}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        {proactiveCheckLog.map((run, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#888", padding: "3px 0" }}>
                            <span>{new Date(run.runAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
                            <span>{run.newAlerts > 0 || run.updatedAlerts > 0 || run.dismissedAlerts > 0
                              ? `${run.newAlerts} new · ${run.updatedAlerts} updated · ${run.dismissedAlerts} cleared`
                              : "No issues found"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Triage Diagnostic */}
              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Triage Diagnostic</h3>
                <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#666" }}>
                  Compare what the Refresh button generates against AlertMemory for a specific client. Reveals fingerprint mismatches between start_triage and the GAS precompute.
                </p>
                <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px" }}>
                  <select value={diagClientName} onChange={e => { setDiagClientName(e.target.value); setDiagResult(null); setDiagError(""); }}
                    style={{ flex: 1, padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px" }}>
                    <option value="">Select a client...</option>
                    {(clientsWithFlags || []).map(c => (
                      <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
                    ))}
                  </select>
                  <button className="triage-btn" disabled={!diagClientName || diagLoading}
                    onClick={async () => {
                      const client = (clientsWithFlags || []).find(c => c.clientName === diagClientName);
                      if (!client) return;
                      setDiagLoading(true); setDiagResult(null); setDiagError("");
                      try {
                        const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "debug_compare_triage", automationCommanderSheetId,
                            clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId, clientName: client.clientName,
                            clientFlags: client.flags || {} }) });
                        const d = await res.json();
                        if (d.success) setDiagResult(d);
                        else setDiagError(d.error || "Unknown error");
                      } catch(e) { setDiagError(e.message); }
                      finally { setDiagLoading(false); }
                    }}
                    style={{ padding: "8px 16px", background: diagLoading ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: diagLoading ? "default" : "pointer", whiteSpace: "nowrap" }}>
                    {diagLoading ? "Running..." : "Run diagnostic"}
                  </button>
                </div>

                {diagError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "12px" }}>Error: {diagError}</div>}

                {diagResult && (() => {
                  const s = diagResult.summary;
                  return (
                    <div>
                      {/* Summary counts */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "16px" }}>
                        {[
                          { label: "Generated", val: s.generated, sub: `inv:${s.inv} dir:${s.dir} crmP:${s.crmPipe} crmC:${s.crmConf}` },
                          { label: "Would filter", val: s.wouldBeFiltered, color: "#166534" },
                          { label: "Would pass through", val: s.wouldPassThrough, color: s.wouldPassThrough > 0 ? "#dc2626" : "#166534" },
                          { label: "AM entries with no match", val: s.unmatchedAlertMemoryEntries, color: s.unmatchedAlertMemoryEntries > 0 ? "#b45309" : "#166534" },
                          { label: "Not in AM anywhere", val: s.notInAnyAlertMemory, color: s.notInAnyAlertMemory > 0 ? "#dc2626" : "#166534" },
                          { label: "Stored under diff. client", val: s.foundUnderDifferentClient, color: s.foundUnderDifferentClient > 0 ? "#7c3aed" : "#166534" },
                        ].map(({ label, val, color, sub }) => (
                          <div key={label} style={{ background: "#f8f9ff", borderRadius: "8px", padding: "10px 12px", border: "1px solid #e8eaf0" }}>
                            <div style={{ fontSize: "10px", color: "#888", marginBottom: "2px" }}>{label}</div>
                            <div style={{ fontSize: "22px", fontWeight: "700", color: color || "#1a56db" }}>{val}</div>
                            {sub && <div style={{ fontSize: "10px", color: "#999", marginTop: "2px" }}>{sub}</div>}
                          </div>
                        ))}
                      </div>

                      {/* Alerts passing through (problem alerts) */}
                      {diagResult.generatedAlerts.filter(a => !a.wouldBeFiltered).length > 0 && (
                        <div style={{ marginBottom: "16px" }}>
                          <div style={{ fontSize: "12px", fontWeight: "700", color: "#dc2626", marginBottom: "6px" }}>
                            ⚠ Alerts that would PASS THROUGH (not suppressed):
                          </div>
                          {diagResult.generatedAlerts.filter(a => !a.wouldBeFiltered).map((a, i) => (
                            <div key={i} style={{ background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                              <div style={{ fontWeight: "600", marginBottom: "2px" }}>{a.flagType} · hash: {a.fingerprintHash} · AM: {a.amStatus}</div>
                              <div style={{ color: "#555", marginBottom: "4px" }}>{a.summary}</div>
                              <div style={{ fontFamily: "monospace", color: "#888", wordBreak: "break-all", fontSize: "10px" }}>{a.rawFingerprint}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* AlertMemory entries with no matching generated alert */}
                      {diagResult.unmatchedAlertMemoryEntries.length > 0 && (
                        <div style={{ marginBottom: "16px" }}>
                          <div style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", marginBottom: "6px" }}>
                            ⚠ AlertMemory entries with NO matching generated alert (old hashes):
                          </div>
                          {diagResult.unmatchedAlertMemoryEntries.map((r, i) => (
                            <div key={i} style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                              <div style={{ fontWeight: "600" }}>{r.alertType} · hash: {r.fingerprintHash} · status: {r.status}</div>
                              <div style={{ color: "#555" }}>{r.alertSummary}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Alerts found under a different client name */}
                      {diagResult.foundUnderDifferentClient?.length > 0 && (
                        <div style={{ marginBottom: "16px" }}>
                          <div style={{ fontSize: "12px", fontWeight: "700", color: "#7c3aed", marginBottom: "6px" }}>
                            ⚠ Alerts found in AM under a DIFFERENT client name:
                          </div>
                          {diagResult.foundUnderDifferentClient.map((r, i) => (
                            <div key={i} style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                              <div style={{ fontWeight: "600" }}>{r.flagType} · hash: {r.hash} · stored as: {r.storedClientName} · status: {r.status}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* All generated alerts (collapsed detail) */}
                      <details style={{ fontSize: "11px" }}>
                        <summary style={{ cursor: "pointer", color: "#1a56db", marginBottom: "8px", userSelect: "none" }}>
                          Show all {diagResult.generatedAlerts.length} generated alerts
                        </summary>
                        {diagResult.generatedAlerts.map((a, i) => (
                          <div key={i} style={{ background: a.wouldBeFiltered ? "#f0fdf4" : "#fff5f5", border: `1px solid ${a.wouldBeFiltered ? "#bbf7d0" : "#fecaca"}`, borderRadius: "6px", padding: "8px 10px", marginBottom: "6px" }}>
                            <div style={{ fontWeight: "600", marginBottom: "2px" }}>{a.wouldBeFiltered ? "✓" : "✗"} {a.flagType} · {a.fingerprintHash} · {a.amStatus}</div>
                            <div style={{ color: "#555", marginBottom: "4px" }}>{a.summary}</div>
                            <div style={{ fontFamily: "monospace", color: "#888", wordBreak: "break-all", fontSize: "10px" }}>{a.rawFingerprint}</div>
                          </div>
                        ))}
                      </details>
                    </div>
                  );
                })()}
              </div>

              {/* Recent call log */}
              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px" }}>
                <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Recent Claude API calls (last 50)</h3>
                {rows.length === 0 ? (
                  <div style={{ color: "#999", fontSize: "13px" }}>No calls recorded yet</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                          {["Time", "Source", "Client", "Alert type", "Tokens", "Cost (USD)"].map(h => (
                            <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: "600", color: "#555", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #f0f0f0", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                            <td style={{ padding: "5px 10px", whiteSpace: "nowrap", color: "#666" }}>{r.ts ? new Date(r.ts).toLocaleString("en-GB") : "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.action || "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.client || "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.alertType || "–"}</td>
                            <td style={{ padding: "5px 10px", textAlign: "right" }}>{r.tokens ? parseInt(r.tokens).toLocaleString() : "–"}</td>
                            <td style={{ padding: "5px 10px", textAlign: "right" }}>${r.cost ? parseFloat(r.cost).toFixed(4) : "0.0000"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </NavShell>
    );
  }

  if (activeNav === "appLog") {
    // Derive column headers from first row, pad to 22 cols
    const COL_COUNT = 22;
    const colLabels = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V"];
    const lastRefresh = appLogLoadedAt
      ? new Date(appLogLoadedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : null;

    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={{ padding: "20px 20px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <h2 style={{ fontSize: "22px", fontWeight: "700", color: "#1a1a1a", margin: "0 0 4px 0" }}>App Log</h2>
              {lastRefresh && <div style={{ fontSize: "12px", color: "#888" }}>Last refreshed {lastRefresh}</div>}
            </div>
            <button className="triage-btn" onClick={loadAppLog} disabled={appLogLoading}
              style={{ background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "8px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}>
              {appLogLoading ? <><Spinner size={12} />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>
        </div>

        {appLogLoading && appLogData.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#666" }}>
            <Spinner size={24} color="#0066cc" /><div style={{ marginTop: "12px" }}>Loading App Log...</div>
          </div>
        ) : appLogData.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#888", fontSize: "14px" }}>
            No data available. Click Refresh to load.
          </div>
        ) : (
          /* Outer wrapper: full viewport width, horizontally scrollable */
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: "40px" }}>
            <style>{`
              .applog-table { border-collapse: collapse; font-size: 12px; }
              .applog-table th, .applog-table td {
                border: 1px solid #e0e0e0;
                padding: 6px 10px;
                text-align: left;
                vertical-align: top;
                width: 200px;
                min-width: 120px;
                max-width: 260px;
                word-break: break-word;
                white-space: normal;
              }
              .applog-table th {
                background: #f3f4f6;
                font-weight: 600;
                color: #555;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.4px;
                position: sticky;
                top: 0;
                z-index: 1;
              }
              /* Freeze col A (client name) */
              .applog-table th:first-child,
              .applog-table td:first-child {
                position: sticky;
                left: 0;
                z-index: 2;
                background: #f9f9f9;
                border-right: 2px solid #d0d0d0;
                min-width: 140px;
                font-weight: 600;
              }
              .applog-table th:first-child {
                z-index: 3;
                background: #f3f4f6;
              }
              .applog-table tr:nth-child(even) td { background: #fafafa; }
              .applog-table tr:nth-child(even) td:first-child { background: #f5f5f5; }
              .applog-table tr:hover td { background: #eef3ff; }
              .applog-table tr:hover td:first-child { background: #e8efff; }
            `}</style>
            <table className="applog-table">
              <thead>
                <tr>
                  {colLabels.map(label => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {appLogData.map((row, rowIdx) => (
                  <tr key={rowIdx}>
                    {colLabels.map((_, colIdx) => (
                      <td key={colIdx}>
                        {String(row[colIdx] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </NavShell>
    );
  }

  // Overview screen — must come before all screen-based checks so nav always works
  if (activeNav === "overview") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
        <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
        <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
              {clientsWithFlags.filter(client => {
                // Check if client has any visible alerts after applying assignedByClient suppression
                const clientAssigned = assignedByClient[client.clientName]?.size || 0;
                const hasVisibleActionable = ACTIONABLE_FLAG_KEYS.some(key => {
                  if (!client.flags?.[key]) return false;
                  let count = client.alertCounts?.[key] || 0;
                  if (key === "expenseDashboardDiscr" || key === "expenseAppDiscr") {
                    count = Math.max(0, count - clientAssigned);
                  }
                  return count > 0;
                });
                const hasInfoFlags = Object.entries(client.flags || {})
                  .some(([key, val]) => val && !ACTIONABLE_FLAG_KEYS.includes(key));
                return hasVisibleActionable || hasInfoFlags;
              }).map((client, idx) => {
                const clientAssigned = assignedByClient[client.clientName]?.size || 0;
                const actionableLines = ACTIONABLE_FLAG_KEYS
                  .filter(key => client.flags?.[key])
                  .map(key => {
                    let count = client.alertCounts?.[key] || 0;
                    // For expense alert types, subtract assigned IDs for THIS client
                    if ((key === "expenseDashboardDiscr" || key === "expenseAppDiscr")) {
                      count = Math.max(0, count - clientAssigned);
                    }
                    if (count === 0) return null; // suppress fully-resolved alert types
                    const label = getFlagName(key);
                    return `${label} (${count} alert${count !== 1 ? "s" : ""})`;
                  })
                  .filter(Boolean);

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
              onClick={() => { setScreen("ignoredAlerts"); loadIgnoredAlerts(); }}
              style={styles.linkButton}
            >
              View ignored alerts →
            </button>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="triage-btn"
                onClick={() => setShowDebugPanel(v => !v)}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#888" }}
              >
                🔍 Debug
              </button>
              <button className="triage-btn"
                onClick={refreshTriage}
                disabled={isLoading}
                style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: isLoading ? 0.5 : 1 }}
              >
                {isLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
              </button>
            </div>
          </div>

          {/* Debug panel */}
          {showDebugPanel && (
            <div style={{ marginTop: "16px", padding: "16px", background: "#1a1a2e", borderRadius: "6px", color: "#e0e0e0" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", marginBottom: "10px", color: "#7dd3fc" }}>🔍 Triage State Debugger</div>
              <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                <input value={debugClientName} onChange={e => setDebugClientName(e.target.value)}
                  placeholder="Client name (blank = all)"
                  style={{ flex: 1, fontSize: "12px", padding: "6px 8px", borderRadius: "4px", border: "1px solid #444", background: "#2d2d4e", color: "#e0e0e0" }} />
                <button className="triage-btn" onClick={runDebug} disabled={debugLoading}
                  style={{ background: "#0066cc", color: "white", border: "none", borderRadius: "4px", padding: "6px 14px", fontSize: "12px", cursor: "pointer" }}>
                  {debugLoading ? "Running..." : "Run"}
                </button>
                <button className="triage-btn" onClick={async () => {
                  setDebugLoading(true);
                  try {
                    const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "cleanup_alert_memory", automationCommanderSheetId }) });
                    setDebugResult(await res.json());
                  } catch(e) { setDebugResult({ error: e.message }); }
                  finally { setDebugLoading(false); }
                }} disabled={debugLoading}
                  style={{ background: "#dc2626", color: "white", border: "none", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", cursor: "pointer" }}>
                  🧹 Dedupe
                </button>
                <button className="triage-btn" onClick={async () => {
                  setDebugLoading(true);
                  try {
                    const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "rehash_alert_memory", automationCommanderSheetId }) });
                    setDebugResult(await res.json());
                  } catch(e) { setDebugResult({ error: e.message }); }
                  finally { setDebugLoading(false); }
                }} disabled={debugLoading}
                  style={{ background: "#0369a1", color: "white", border: "none", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", cursor: "pointer" }}>
                  🔄 Rehash
                </button>
              </div>
              {debugResult && (
                <pre style={{ fontSize: "11px", color: "#a0e0a0", overflow: "auto", maxHeight: "400px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {JSON.stringify(debugResult, null, 2)}
                </pre>
              )}
            </div>
          )}
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
                    uninvoiced_revenue:         "Uninvoiced revenue",
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
          <div style={styles.header}>
          <h1 style={styles.title}>Proactive Alerts</h1>
            <p style={styles.subtitle}>{proactiveSelectedClient} — {clientAlertsList.length} alert{clientAlertsList.length !== 1 ? "s" : ""}</p>
          </div>
          <div style={styles.card}>
            <div style={{ marginBottom: "16px" }}>
              <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
                ← Back to Client List
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {clientAlertsList.map((alert, idx) => {
                const m = alert.metadata || {};
                return (
                  <div key={idx} style={{ border: "1px solid #ddd", borderRadius: "6px", padding: "14px", backgroundColor: "#fafafa" }}>
                    <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a", marginBottom: "6px" }}>
                      {alert.heading}
                    </div>
                    <div style={{ fontSize: "13px", color: "#444", lineHeight: "1.6", marginBottom: "8px" }}>
                      {alert.alertType === "revenue_mismatch" || alert.alertType === "direct_costs_mismatch" || alert.alertType === "pipeline_confirmed_overlap" || alert.alertType === "retainer_shrink_blocked" || alert.alertType === "uninvoiced_revenue" ? null : alert.detail}
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
                        {m.possibleMatchInvoiceNo && (
                          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #bae6fd" }}>
                            <div style={{
                              display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", marginBottom: "6px",
                              background: m.possibleMatchConfidence === "high" ? "#fee2e2" : "#fef9c3",
                              color: m.possibleMatchConfidence === "high" ? "#991b1b" : "#713f12",
                              border: `1px solid ${m.possibleMatchConfidence === "high" ? "#fca5a5" : "#fde047"}`,
                            }}>
                              Possible retainer change — {m.possibleMatchConfidence === "high" ? "high" : "medium"} confidence
                            </div>
                            <div><strong>Invoice found:</strong> #{m.possibleMatchInvoiceNo} for £{parseFloat(m.possibleMatchAmount || 0).toFixed(2)}, sent {m.possibleMatchSentDate}</div>
                            <div>
                              {m.possibleMatchConfirmedRow
                                ? <>Already attached to Confirmed row {m.possibleMatchConfirmedRow}</>
                                : <>Not yet attached to any job in the Confirmed tab</>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Uninvoiced revenue detail */}
                    {alert.alertType === "uninvoiced_revenue" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                        {m.confirmedRow && <div><strong>Confirmed tab row:</strong> {m.confirmedRow}</div>}
                        {m.endDate && <div><strong>Job ended:</strong> {m.endDate}</div>}
                        {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                        {m.uninvoicedAmount && (
                          <div style={{ marginTop: "6px", fontWeight: "700", color: "#991b1b" }}>
                            £{parseFloat(m.uninvoicedAmount).toFixed(2)} uninvoiced (placeholders and drafts excluded)
                          </div>
                        )}
                        {m.draftCount && parseInt(m.draftCount) > 0 && (
                          <div style={{ marginTop: "6px", padding: "6px 8px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "4px", color: "#78350f" }}>
                            {m.draftCount} invoice{parseInt(m.draftCount) > 1 ? "s" : ""} totalling £{parseFloat(m.draftTotal || 0).toFixed(2)} {parseInt(m.draftCount) > 1 ? "have" : "has"} a reference but {parseInt(m.draftCount) > 1 ? "are" : "is"} still <strong>Draft</strong> (not yet sent) — not counted as invoiced above.
                          </div>
                        )}
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
                        {alert.metadata?.tab && (
                          <span style={{ display: "inline-block", marginBottom: "6px", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: alert.metadata.tab === "Pipeline" ? "#fef3c7" : "#dbeafe", color: alert.metadata.tab === "Pipeline" ? "#92400e" : "#1e40af", border: `1px solid ${alert.metadata.tab === "Pipeline" ? "#fcd34d" : "#93c5fd"}` }}>
                            {alert.metadata.tab} tab
                          </span>
                        )}
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
                          <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Likelihood: <strong>{md.likelihood ? (parseFloat(md.likelihood) * 100).toFixed(0) + "%" : "(blank)"}</strong></div>
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
                        {alert.alertType === "expenseDashboardDiscr" && clientInfo && (
                          <button
                            className="triage-btn"
                            onClick={() => {
                              setActiveNav("outgoings");
                              if (clientInfo) loadOutgoings(clientInfo);
                            }}
                            style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7" }}
                          >
                            📤 Assign Outgoings
                          </button>
                        )}
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Alert</h1>
          <p style={styles.subtitle}>{selectedClient.clientName} - {clientAlerts.length} alert(s)</p>
        </div>

        <div style={styles.card}>
          <div style={{ marginBottom: "16px" }}>
            <button className="triage-btn" onClick={() => { setAcceptError(""); setScreen("clientSelection"); }} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
              ← Back to Clients
            </button>
          </div>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

          {/* Open Sheets + Bulk actions row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            {(selectedClient.clientSheetId || selectedClient.masterSheetId) ? (
              <button className="triage-btn" onClick={() => {
                if (selectedClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`, "_blank");
                if (selectedClient.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`, "_blank");
              }} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
                📊 Open Sheets
              </button>
            ) : <div />}
            {clientAlerts.length > 1 && (
              <button className="triage-btn" onClick={() => { setBulkMode(v => !v); setBulkSelected(new Set()); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px",
                  ...(bulkMode ? { background: "#ede9fe", borderColor: "#7c3aed", color: "#5b21b6" } : {}) }}>
                {bulkMode ? "✕ Cancel bulk" : "☑ Bulk actions"}
              </button>
            )}
          </div>
          
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
                const groupKeys   = groupAlerts.map((alert) => `${type}|||${alert.sheetName}-${alert.rowNumber}`);
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
                    {(() => {
                      // For invoice alerts, sub-group by draft status
                      const isInvoiceType = type === "invoiceDashboardDiscr" || type === "invoiceAppDiscr";
                      if (isInvoiceType) {
                        const drafts = groupAlerts.filter(a => (a.summary?.status || "").toLowerCase() === "draft")
                          .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                        const nonDrafts = groupAlerts.filter(a => (a.summary?.status || "").toLowerCase() !== "draft")
                          .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                        const renderGroup = (alerts, label, globalOffset) => alerts.length === 0 ? null : (
                          <div key={label}>
                            <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 4px" }}>{label}</div>
                            {alerts.map((alert, localIdx) => {
                              const selKey = `${type}|||${alert.sheetName}-${alert.rowNumber}`;
                              const isChecked = bulkSelected.has(selKey);
                      return bulkMode ? (
                        <div key={selKey}
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
                                    {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {(parseFloat(likely) * 100).toFixed(0)}%</div>}
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
                        key={selKey}
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
                                {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {(parseFloat(likely) * 100).toFixed(0)}%</div>}
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
                                {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {(parseFloat(likely) * 100).toFixed(0)}%</div>}
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
                        );
                        return (
                          <div>
                            {renderGroup(nonDrafts, "Sent / non-draft", 0)}
                            {renderGroup(drafts, "Draft", nonDrafts.length)}
                          </div>
                        );
                      }
                      // Non-invoice types: render normally
                      const isExpenseGroup = type === "expenseDashboardDiscr" || type === "expenseAppDiscr";
                      const alertBtns = groupAlerts.map((alert, idx) => {
                        const selKey = `${type}|||${alert.sheetName}-${alert.rowNumber}`;
                        const isChecked = bulkSelected.has(selKey);
                        return bulkMode ? (
                          <div key={idx} style={{ padding: "12px", border: "1px solid #e0e0e0", borderRadius: "4px", cursor: "pointer", fontSize: "13px" }}>
                            <input type="checkbox" checked={isChecked} onChange={() => {
                              const newSel = new Set(bulkSelected);
                              if (isChecked) newSel.delete(selKey); else newSel.add(selKey);
                              setBulkSelected(newSel);
                            }} /> {getAlertSummary(alert)}
                          </div>
                        ) : (
                          <button className="triage-btn" key={idx} onClick={() => selectAlert(alert)}
                            style={{ ...styles.optionButton, textAlign: "left", padding: "12px", border: "1px solid #e0e0e0", borderRadius: "4px", cursor: "pointer", backgroundColor: "#fff", fontSize: "13px" }}>
                            {getAlertSummary(alert)}
                          </button>
                        );
                      });
                      return isExpenseGroup && selectedClient
                        ? [...alertBtns, (
                            <div key="assign-btn" style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                              <button className="triage-btn"
                                onClick={() => { setActiveNav("outgoings"); loadOutgoings(selectedClient); }}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}>
                                📤 Assign Outgoings
                              </button>
                            </div>
                          )]
                        : alertBtns;
                    })()}
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
                                // If all noAction flags are now resolved AND no actionable alerts remain,
                                // auto-proceed to clear flags and return to client selection
                                const allResolved = clientNoActionAlerts.every(n => newResolved.has(n.flagType));
                                if (allResolved && clientAlerts.length === 0) {
                                  handlePostClear([], newResolved);
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
                                // If all noAction flags are now resolved AND no actionable alerts remain,
                                // auto-proceed to clear flags and return to client selection
                                const newResolved2 = new Set([...resolvedNoActionFlags, na.flagType]);
                                const allResolved2 = clientNoActionAlerts.every(n => newResolved2.has(n.flagType));
                                if (allResolved2 && clientAlerts.length === 0) {
                                  handlePostClear([], newResolved2);
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
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: "20px" }}>
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
            </div>
          </div>
        </div>
      </NavShell>
    );
  }

  // Screen 1: Loading state (shown while startTriage runs on mount)
  if (!sessionId && !triageComplete && activeNav !== "tasks" && activeNav !== "overview") {
    return withModal(
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
                    uninvoiced_revenue:         "Uninvoiced revenue",
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
        </div>

        <div style={styles.card}>
          <div style={{ marginBottom: "16px" }}>
            <button className="triage-btn" onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
              ← Back to Alerts
            </button>
          </div>
          <div style={styles.alertHeader}>
            <h2 style={styles.alertTitle}>
              {alert.clientName || alert.type || "Financial Alert"}
              {fromCache && (
                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={styles.cacheBadge}>⚡ Cached</span>
                  <button className="triage-btn" onClick={async () => {
                    try {
                      const bustRes = await fetch("/api/triage", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "bust_cache",
                          fingerprintHash: alert.fingerprintHash || undefined,
                          rowNumber: alert.rowNumber,
                          sheetName: alert.sheetName,
                          automationCommanderSheetId,
                        }),
                      });
                      const bustData = await bustRes.json();
                      if (!bustData.success) {
                        console.error("Cache bust failed:", bustData.error);
                        return;
                      }
                      setFromCache(false);
                      // Small delay to ensure Sheets write has committed before re-fetching
                      await new Promise(r => setTimeout(r, 1000));
                      await selectAlert(clientAlerts[currentClientAlertIndex]);
                    } catch(e) { console.error("Cache bust failed:", e); }
                  }} style={{ fontSize: "11px", padding: "2px 8px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", color: "#555" }}>
                    ↻ Refresh
                  </button>
                </span>
              )}
            </h2>
            <span style={styles.alertCounter}>{progress}/{clientAlerts.length}</span>
          </div>

          {alert.flagType && (() => {
            const ALERT_TYPE_FULL_NAMES = {
              invoiceDashboardDiscr: "Invoice Dashboard Discrepancy",
              expenseDashboardDiscr: "Expense Dashboard Discrepancy",
              crmPipeDashDiscr: "CRM Pipeline Dashboard Discrepancy",
              crmPipeAppDiscr: "CRM Pipeline App Discrepancy",
              crmConfDashDiscr: "CRM Confirmed Dashboard Discrepancy",
              crmConfAppDiscr: "CRM Confirmed App Discrepancy",
            };
            const fullName = ALERT_TYPE_FULL_NAMES[alert.flagType] || alert.flagType;
            return (
              <div style={{ ...styles.alertMetadata, fontSize: "15px", fontWeight: "600", padding: "14px", marginBottom: "16px" }}>
                {fullName}
              </div>
            );
          })()}

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
            <div style={{ ...styles.alertSummary, marginBottom: "20px",
              backgroundColor: alert.type === "expense" ? "#f0fdf4" : "#eff6ff",
              borderLeft: `4px solid ${alert.type === "expense" ? "#16a34a" : "#2563eb"}` }}>
              <h3 style={{ fontSize: "17px", fontWeight: "700", marginBottom: "8px", color: alert.type === "expense" ? "#166534" : "#1e40af" }}>
                ⚠ {alert.type === "expense" ? (() => {
                    const expFlags = alert.data?.flags || [];
                    const isMissing = String(expFlags[0]||"").trim() === "1";
                    if (isMissing) return "Missing cost — in accounting system, not in Confirmed tab";
                    const expFlagNames = [null,"Duplicate App ID","Description mismatch","Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
                    const active = expFlags.map((v,i) => String(v||"").trim()==="1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                    return active.length > 0 ? `Field mismatch: ${active.join(", ")}` : "Expense Discrepancy";
                  })()
                  : (() => {
                      const flags = alert.data?.flags || [];
                      const isMissing = String(flags[0]||"").trim() === "1";
                      if (isMissing) return "Missing invoice — in accounting system, not in Confirmed tab";
                      const invFlagNames2 = [null,"Client mismatch","Amount mismatch","Sent date mismatch",null,"Pay date mismatch","Status mismatch"];
                      const active = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames2[i] ? invFlagNames2[i] : null).filter(Boolean);
                      return active.length > 0 ? `Field mismatch: ${active.join(", ")}` : "Invoice Discrepancy";
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
              {/* Field-by-field comparison lines for mismatched fields only */}
              {(() => {
                const flags = alert.data?.flags || [];
                const isMissing = String(flags[0]||"").trim() === "1";
                if (isMissing) return null;
                const acc = alert.data?.accounting || [];
                const conf = alert.data?.confirmed || [];
                let mismatchLines = [];
                if (alert.type === "expense") {
                  const expFlagNames = ["Missing cost","Duplicate app ID","Description mismatch","Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
                  const activeFlags = flags.map((v,i) => String(v||"").trim()==="1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                  const FIELD_DEFS = [
                    { name: "Description mismatch", line: `Description in accounting: ${acc[1] || "(blank)"}. Description in Confirmed tab: ${conf[3] || "(blank)"}.` },
                    { name: "Amount mismatch",       line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[4] ? `£${conf[4]}` : "£0"}.` },
                    { name: "VAT mismatch",          line: `VAT in accounting: ${acc[8] ? `£${acc[8]}` : "£0"}. VAT in Confirmed tab: ${conf[6] || "(blank)"}.` },
                    { name: "Rec date mismatch",     line: `Received date in accounting: ${acc[0] || "(blank)"}. Received date in Confirmed tab: ${conf[7] || "(blank)"}.` },
                    { name: "Pay date mismatch",     line: `Pay date in accounting: ${acc[7] || "(blank)"}. Pay date in Confirmed tab: ${conf[8] || "(blank)"}.` },
                    { name: "Status mismatch",       line: `Status in accounting: ${acc[5] || "(blank)"}. Status in Confirmed tab: ${conf[9] || "(blank)"}.` },
                  ];
                  mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
                } else {
                  const invFlagNames = ["Missing invoice","Client mismatch","Amount mismatch","Sent date mismatch",null,"Pay date mismatch","Status mismatch"];
                  const activeFlags = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);
                  const FIELD_DEFS = [
                    { name: "Client mismatch",    line: `Client in accounting: ${acc[0] || "(blank)"}. Client in Confirmed tab: ${conf[1] || "(blank)"}.` },
                    { name: "Amount mismatch",    line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[2] ? `£${conf[2]}` : "£0"}.` },
                    { name: "Sent date mismatch", line: `Sent date in accounting: ${acc[6] || "(blank)"}. Sent date in Confirmed tab: ${conf[3] || "(blank)"}.` },
                    { name: "Pay date mismatch",  line: `Pay date in accounting: ${acc[8] || "(blank)"}. Pay date in Confirmed tab: ${conf[4] || "(blank)"}.` },
                    { name: "Status mismatch",    line: `Status in accounting: ${acc[9] || "(blank)"}. Status in Confirmed tab: ${conf[5] || "(blank)"}.` },
                  ];
                  mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
                }
                if (mismatchLines.length === 0) return null;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#333", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                    {mismatchLines.map(f => <div key={f.name}>{f.line}</div>)}
                  </div>
                );
              })()}
            </div>
          )}

          {acceptError && (
            <div style={{ ...styles.errorBanner, marginBottom: "16px" }}>
              {acceptError}
              {acceptError.includes("go back to the alert list") && (
                <div style={{ marginTop: "10px" }}>
                  <button className="triage-btn"
                    onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }}
                    style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
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
                  <div><strong>⚠ Previously ignored:</strong> {previousIgnoreReason.ignoreReason}</div>
                  {previousIgnoreReason.changeReason && (
                    <div style={{ marginTop: "6px", color: "#92400e", fontStyle: "italic" }}>
                      <strong>Resurfaced because:</strong> {previousIgnoreReason.changeReason}
                    </div>
                  )}
                </div>
              )}
              {/* Discrepancy summary — what this alert actually is, and the specific field(s) at issue */}
              {(() => {
                const ft = alert?.flagType || alert?.alertType || alert?.type || "";
                const isCRM = ft.startsWith("crm");
                if (!isCRM) return null;
                const isPipeline = ft.includes("Pipe");
                const isMismatch = alert.subType === "field_mismatch";
                const tabLabel = isPipeline ? "Pipeline" : "Confirmed";
                const isDash = ft.includes("Dash");
                const sd = alert.data?.sheetData || [];
                const cd = alert.data?.crmData || [];
                // App discr sheetData (EF:ER):    [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
                // Dash discr sheetData (AO:AW):    [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
                // crmData (both):                  [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
                const client = (isDash ? sd[1] : sd[0]) || cd[0] || "";
                const job    = (isDash ? sd[2] : sd[1]) || cd[1] || "";
                const code   = (isDash ? sd[0] : sd[2]) || cd[2] || "";

                // Per-field CRM vs sheet values, in the same order/index as MISMATCH_FIELD_NAMES
                // server-side: Client name, Job name, Revenue, Direct costs, Start date, End date, % Likelihood
                const sdField = (dashIdx, appIdx) => isDash ? sd[dashIdx] : sd[appIdx];
                const FIELD_DEFS = [
                  { name: "Client name",  crm: cd[0], sheet: sdField(1, 0), fmt: v => v || "(blank)" },
                  { name: "Job name",     crm: cd[1], sheet: sdField(2, 1), fmt: v => v || "(blank)" },
                  { name: "Revenue",      crm: cd[3], sheet: sd[3], fmt: v => v ? `£${v}` : "£0" },
                  { name: "Direct costs", crm: cd[4], sheet: sd[4], fmt: v => v ? `£${v}` : "£0" },
                  { name: "Start date",   crm: cd[5], sheet: sd[5], fmt: v => v || "(blank)" },
                  { name: "End date",     crm: cd[6], sheet: sd[6], fmt: v => v || "(blank)" },
                  { name: "% Likelihood", crm: cd[7], sheet: sd[7], fmt: v => v ? `${(parseFloat(v) * 100).toFixed(0)}%` : "0%" },
                ];
                const mismatchedFieldNames = alert.mismatchFields || [];
                const mismatchedFields = FIELD_DEFS.filter(f => mismatchedFieldNames.includes(f.name));

                const subHeader = isMismatch
                  ? `Field mismatch: ${mismatchedFieldNames.join(", ")}`
                  : `Missing job — in ${tabLabel} tab, not in CRM`;

                return (
                  <div style={{ marginBottom: "16px", padding: "14px 16px", backgroundColor: "#f5f3ff", borderLeft: "4px solid #7c3aed", borderRadius: "4px" }}>
                    <div style={{ fontSize: "17px", fontWeight: "700", color: "#5b21b6", marginBottom: "8px" }}>
                      ⚠ {subHeader}
                    </div>
                    <div style={{ fontSize: "14px", fontWeight: "600", color: "#1a1a1a", marginBottom: isMismatch ? "10px" : "0" }}>
                      {client}{job ? ` — ${job}` : ""}{code ? ` (${code})` : ""}
                    </div>
                    {isMismatch && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#333" }}>
                        {mismatchedFields.map(f => (
                          <div key={f.name}>
                            {f.name} in CRM: <strong>{f.fmt(f.crm)}</strong>. {f.name} in {tabLabel.toLowerCase()} tab: <strong>{f.fmt(f.sheet)}</strong>.
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
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
                        {/* Spreadsheet-style job row(s) display */}
                        {Array.isArray(option.jobRowsData) && option.jobRowsData.length > 0 && (
                          <div style={{ marginBottom: "10px", overflowX: "auto", border: "1px solid #e0e0e0", borderRadius: "6px" }}>
                            <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px" }}>
                              <thead>
                                <tr style={{ background: "#f3f4f6" }}>
                                  {["Row","Client","Job name","Code","Revenue","Direct costs","Type","VAT","Start","End",
                                    ...(option.jobRowsData[0].likelihood !== null ? ["% Likely"] : []),
                                    ...(option.jobRowsData[0].copiedToConf !== null ? ["Copied?"] : [])
                                  ].map(h => (
                                    <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {option.jobRowsData.map(jr => (
                                  <tr key={jr.rowNum} style={{ borderBottom: "1px solid #eee" }}>
                                    <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.client}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.jobName}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.projectCode}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.revenue}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.directCosts}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.projectRetainer}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.vat}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.startDate}</td>
                                    <td style={{ padding: "5px 8px" }}>{jr.endDate}</td>
                                    {jr.likelihood !== null && <td style={{ padding: "5px 8px" }}>{jr.likelihood}</td>}
                                    {jr.copiedToConf !== null && <td style={{ padding: "5px 8px" }}>{jr.copiedToConf}</td>}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {/* Invoice slots — only render if any slot has data or is the target */}
                            {option.jobRowsData.some(jr => jr.invoiceSlots?.some(s => s.amount || s.ref || s.highlighted)) && (
                              <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px", borderTop: "2px solid #ddd" }}>
                                <thead>
                                  <tr style={{ background: "#f3f4f6" }}>
                                    {["Row","Slot","Amount","Reference","Sent","Days","Status"].map(h => (
                                      <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {option.jobRowsData.flatMap(jr => jr.invoiceSlots.map(s => (
                                    <tr key={`${jr.rowNum}-inv${s.slotNum}`} style={{
                                      borderBottom: "1px solid #eee",
                                      background: s.highlighted ? "#fff3cd" : "transparent",
                                      fontWeight: s.highlighted ? "700" : "400",
                                    }}>
                                      <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.slotNum}{s.highlighted ? " ← this option" : ""}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.amount}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.ref}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.sentDate}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.daysToPay}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.status}</td>
                                    </tr>
                                  )))}
                                </tbody>
                              </table>
                            )}
                            {/* Expense slots — only render if any slot has data or is the target */}
                            {option.jobRowsData.some(jr => jr.expenseSlots?.some(s => s.amount || s.description || s.highlighted)) && (
                              <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px", borderTop: "2px solid #ddd" }}>
                                <thead>
                                  <tr style={{ background: "#f3f4f6" }}>
                                    {["Row","Slot","Description","Amount","VAT","Date","Days","Status","Txn ID"].map(h => (
                                      <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {option.jobRowsData.flatMap(jr => jr.expenseSlots.map(s => (
                                    <tr key={`${jr.rowNum}-exp${s.slotNum}`} style={{
                                      borderBottom: "1px solid #eee",
                                      background: s.highlighted ? "#fff3cd" : "transparent",
                                      fontWeight: s.highlighted ? "700" : "400",
                                    }}>
                                      <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.slotNum}{s.highlighted ? " ← this option" : ""}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.description}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.amount}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.vat}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.date}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.daysToPay}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.status}</td>
                                      <td style={{ padding: "5px 8px" }}>{s.transactionId}</td>
                                    </tr>
                                  )))}
                                </tbody>
                              </table>
                            )}
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
                        {/* VAT mismatch — show job context and exact cell that will be updated */}
                        {option.discrepancyType === "inv_vat_mismatch" && option.matchType === "existing_job" && option.jobDetails && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                            <strong style={{ color: "#1d4ed8", fontSize: "12px" }}>Job Details (Confirmed tab, row {option.jobRow}):</strong>
                            <div style={{ marginTop: "6px", fontSize: "12px", color: "#333" }}>
                              {option.jobDetails.clientName && <div><strong>Client:</strong> {option.jobDetails.clientName}</div>}
                              {option.jobDetails.jobName && <div><strong>Job:</strong> {option.jobDetails.jobName}</div>}
                              {option.jobDetails.projectCode && <div><strong>Code:</strong> {option.jobDetails.projectCode}</div>}
                              {option.jobDetails.revenue && <div><strong>Revenue:</strong> {option.jobDetails.revenue}</div>}
                              {option.jobDetails.vatSetting && <div><strong>Current VAT setting:</strong> {option.jobDetails.vatSetting}</div>}
                              {option.jobDetails.startDate && <div><strong>Dates:</strong> {option.jobDetails.startDate} → {option.jobDetails.endDate || "?"}</div>}
                              {option.jobDetails.slot1 && !option.jobDetails.slot1.startsWith("(empty)") && <div><strong>Inv 1:</strong> {option.jobDetails.slot1}</div>}
                              {option.jobDetails.slot2 && !option.jobDetails.slot2.startsWith("(empty)") && <div><strong>Inv 2:</strong> {option.jobDetails.slot2}</div>}
                              {option.jobDetails.slot3 && !option.jobDetails.slot3.startsWith("(empty)") && <div><strong>Inv 3:</strong> {option.jobDetails.slot3}</div>}
                            </div>
                          </div>
                        )}
                        {option.vatUpdate && (
                          <div style={{ marginTop: "12px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "6px", padding: "10px 14px" }}>
                            <strong style={{ color: "#15803d" }}>If accepted, the following will be updated:</strong>
                            <div style={{ fontFamily: "monospace", fontSize: "12px", marginTop: "4px" }}>
                              {option.vatUpdate.cells
                                ? option.vatUpdate.cells.map(cell => (
                                    <div key={cell}>Cell {cell}: "{option.vatUpdate.currentValue}" → "{option.vatUpdate.newValue}"</div>
                                  ))
                                : <div>Cell {option.vatUpdate.cell}: "{option.vatUpdate.currentValue}" → "{option.vatUpdate.newValue}"</div>
                              }
                            </div>
                          </div>
                        )}
                        {/* CRM match analysis - ONLY show for CRM/invoices, not expenses, not VAT mismatches (those use explanation) */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && !option.allocationBreakdown && option.discrepancyType !== "inv_vat_mismatch" && (
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
                        {/* Expense match analysis - only shown alongside allocation breakdown */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && option.allocationBreakdown && (
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
                        {option.recommendedActions && Array.isArray(option.recommendedActions) && option.recommendedActions.length > 0 && option.discrepancyType !== "inv_vat_mismatch" && (
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
            {/* Use AI button — shown for alert types that previously used Claude */}
            {claudeAnalysis && (() => {
              const alert = clientAlerts[currentClientAlertIndex];
              const ft = alert?.flagType || alert?.alertType || alert?.type || "";
              const aiTypes = new Set(["invoiceDashboardDiscr","expenseDashboardDiscr",
                "crmPipeDashDiscr","crmConfDashDiscr","crmPipeAppDiscr","crmConfAppDiscr"]);
              if (!aiTypes.has(ft)) return null;
              return (
                <button className="triage-btn" disabled={isAnalyzing}
                  onClick={async () => {
                    setIsAnalyzing(true);
                    setClaudeAnalysis("");
                    try {
                      const res = await fetch("/api/triage", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "analyze_alert_ai", alert, automationCommanderSheetId }),
                      });
                      const d = await res.json();
                      if (d.success) {
                        const pir = d.previousIgnoreReason;
                        setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
                        setClaudeAnalysis(JSON.stringify(d.options || [], null, 2));
                      } else {
                        setClaudeAnalysis("Error: " + (d.error || "Unknown error"));
                      }
                    } catch(e) { setClaudeAnalysis("Error: " + e.message); }
                    finally { setIsAnalyzing(false); }
                  }}
                  style={{ ...styles.buttonSecondary, color: "#059669", borderColor: "#6ee7b7",
                    opacity: isAnalyzing ? 0.6 : 1 }}>
                  🤖 Use AI
                </button>
              );
            })()}
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Info-Only Alerts</h1>
          <p style={styles.subtitle}>These require no action - acknowledge to clear</p>
        </div>

        <div style={styles.noActionSection}>
          <div style={{ marginBottom: "16px" }}>
            <button className="triage-btn" onClick={() => setShowNoAction(false)} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
              ← Back to Actionable Alerts
            </button>
          </div>
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
      <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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
    <NavShell activeNav={activeNav} onHome={handleNavHome} onOverview={handleNavOverview} onTasks={handleNavTasks} onAppLog={handleNavAppLog} onOutgoings={handleNavOutgoings} onInvoices={handleNavInvoices} onSettings={handleNavSettings} homeAlertCount={liveAlertCount + proactiveAlerts.length} taskCount={navTaskCount}>
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