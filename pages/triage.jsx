import React, { useState, useEffect } from "react";
import Spinner from "../components/Spinner";
import TruncatedCode from "../components/TruncatedCode";
import NavShell from "../components/NavShell";
import AppLogView from "../components/AppLogView";
import IgnoredAlertsView from "../components/IgnoredAlertsView";
import TasksView from "../components/TasksView";
import CreateTaskModal from "../components/CreateTaskModal";
import InvoicesView from "../components/InvoicesView";
import JobsView from "../components/JobsView";
import OutgoingsView from "../components/OutgoingsView";
import RetainersView from "../components/RetainersView";
import ToolsView from "../components/ToolsView";
import SettingsView from "../components/SettingsView";
import ClientSelectionView from "../components/ClientSelectionView";
import AlertSelectionView from "../components/AlertSelectionView";
import TriageAnalysisView from "../components/TriageAnalysisView";
import AuthGateView from "../components/AuthGateView";
import { useAuth } from "../hooks/useAuth";
import { useOverview } from "../hooks/useOverview";
import { TaskProvider, useTasks } from "../contexts/TaskContext";
import { TriageProvider } from "../contexts/TriageContext";
import { useIgnoredAlerts } from "../hooks/useIgnoredAlerts";
import { styles, injectGlobalStyles } from "../utils/styles";
import { 
  getAlertSummary, 
  PROACTIVE_TYPE_LABELS, 
  getFlagName 
} from "../utils/helpers";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriageEngine } from "../hooks/useTriageEngine";

// Inject global styles into the document head
injectGlobalStyles();

export default function TriageSystem({ onBack }) {
  const appGlobals = useAppGlobals();
  return (
    <TaskProvider automationCommanderSheetId={appGlobals.automationCommanderSheetId}>
      <TriageSystemContent onBack={onBack} appGlobals={appGlobals} />
    </TaskProvider>
  );
}

function TriageSystemContent({ onBack, appGlobals }) {
  const {
    automationCommanderSheetId, assignedAppIds, setAssignedAppIds,
    assignedByClient, setAssignedByClient, addAssignedAppId,
    outgoingsPullPendingRef, allClientsMap, setAllClientsMap,
    showDebugPanel, setShowDebugPanel, debugClientName, setDebugClientName,
    debugResult, setDebugResult, debugLoading, setDebugLoading, runDebug
  } = appGlobals;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const {
    isAuthenticated, authChecking, pinInput, pinError, pinVerifying, handlePinInput, setPinInput
  } = useAuth();

  const [screen, setScreen] = useState("initial"); 
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);
  const [activeNav, setActiveNav] = useState("home");

  const {
    navTaskCount, setNavTaskCount, snoozedTaskCount, setSnoozedTaskCount,
    showTaskModal, setShowTaskModal, taskModalAlert, setTaskModalAlert,
    taskModalIsProactive, setTaskModalIsProactive, taskModalNote, setTaskModalNote,
    taskModalSnoozeDate, setTaskModalSnoozeDate, taskModalSnoozeTime, setTaskModalSnoozeTime,
    taskModalSubmitting, setTaskModalSubmitting, taskActionError, setTaskActionError,
    existingTaskBanner, setExistingTaskBanner,
    setTasksFilter, loadTasks
  } = useTasks();
  
  const triageEngine = useTriageEngine({
    automationCommanderSheetId, screen, setScreen, activeNav, assignedAppIds,
    assignedByClient, setExistingTaskBanner, allClientsMap, isLoading, setIsLoading,
    error, setError, setBulkMode: () => {}, setBulkSelected: () => {}
  });

  const {
    sessionId, setSessionId, totalAlerts, setTotalAlerts, noActionCount, setNoActionCount,
    acknowledgedNoAction, setAcknowledgedNoAction, triageComplete, setTriageComplete,
    claudeAnalysis, setClaudeAnalysis, isAnalyzing, setIsAnalyzing, refreshStatus, setRefreshStatus,
    clientsWithFlags, setClientsWithFlags, selectedClient, setSelectedClient, clientAlerts, setClientAlerts,
    currentClientAlertIndex, setCurrentClientAlertIndex, isAccepting, setIsAccepting, acceptError, setAcceptError,
    processedAlerts, setProcessedAlerts, showIgnoreModal, setShowIgnoreModal, ignoreReason, setIgnoreReason,
    isIgnoring, setIsIgnoring, selectingClient, setSelectingClient, previousIgnoreReason, setPreviousIgnoreReason,
    proactiveAlerts, setProactiveAlerts, proactiveCountsByClient, setProactiveCountsByClient,
    proactiveLoading, setProactiveLoading, proactiveLoadedAt, setProactiveLoadedAt, fromCache, setFromCache,
    clientNoActionAlerts, setClientNoActionAlerts, resolvedNoActionFlags, setResolvedNoActionFlags,
    noActionAnalysis, setNoActionAnalysis, noActionAnalysisLoading, setNoActionAnalysisLoading,
    precomputedNoActionResults, setPrecomputedNoActionResults,
    refreshTriage, startTriage, reloadFromCache, selectClient, selectAlert, acceptOption,
    allNoActionResolved, autoClearFlags, handlePostClear, groupedAlerts, liveAlertCount,
    computeAlertCheckCount, analyzeNoActionFlag, ignoreAlert, loadProactiveAlerts, checkExistingTask
  } = triageEngine;

  // --- INITIAL DATA LOAD ---
  // Explicitly trigger the initial triage data load on mount.
  // (This was previously triggered implicitly by the EoM tasks preload effect we extracted).
  useEffect(() => {
    if (!sessionId && !isLoading) {
      startTriage();
    }
  }, [sessionId, isLoading, startTriage]);

  const { overviewData, setOverviewData, overviewLoading, setOverviewLoading, loadOverview } = useOverview(automationCommanderSheetId);

  const [allOutgoingsClients, setAllOutgoingsClients] = useState([]); // all clients from AutoUpdates
  const [allClientsLoaded, setAllClientsLoaded] = useState(false);
  
  const { ignoredAlerts, isLoadingIgnored, isUnignoring, loadIgnoredAlerts, unignoreAlert } = useIgnoredAlerts(automationCommanderSheetId, setAcceptError);

  const openCreateTaskModal = (alert, isProactive = false) => {
    setTaskModalAlert(alert);
    setTaskModalIsProactive(isProactive);
    setTaskModalNote("");
    setShowTaskModal(true);
    setTaskActionError("");
  };

  // ── Navigation helpers ──────────────────────────────────────────────────

  // Fire the deferred GAS outgoings notes pull if one is pending.
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
  const handleNavAppLog = () => { fireOutgoingsPullIfPending(); setActiveNav("appLog"); };
  
  const handleNavSettings = () => {
    fireOutgoingsPullIfPending();
    setActiveNav("settings");
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
  const handleNavTools = () => {
    setActiveNav("tools");
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

  const handleNavOutgoings = () => {
    setActiveNav("outgoings");
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

  const handleNavInvoices = () => {
    setActiveNav("invoices");
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

  const handleNavJobs = () => {
    setActiveNav("jobs");
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

  const handleNavRetainers = () => {
    setActiveNav("retainers");
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

  // Page title and favicon are handled globally by Next.js <Head> in index.js
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // --- AUTHENTICATION GATE ---
  if (authChecking) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f5f5f5" }}>
        <Spinner size={32} color="#0066cc" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthGateView
        pinInput={pinInput}
        pinVerifying={pinVerifying}
        pinError={pinError}
        handlePinInput={handlePinInput}
        setPinInput={setPinInput}
      />
    );
  }

  // Pass-through wrapper to satisfy child components that still expect withModal
  function withModal(jsx) {
    return jsx;
  }

  // --- DYNAMIC VIEW ROUTER ---
  const renderActiveView = () => {
    // Screen: Ignored Alerts
    if (screen === "ignoredAlerts" && activeNav === "home") {
      return (
        <IgnoredAlertsView 
          styles={styles}
          acceptError={acceptError}
          setAcceptError={setAcceptError}
          isLoadingIgnored={isLoadingIgnored}
          ignoredAlerts={ignoredAlerts}
          isUnignoring={isUnignoring}
          unignoreAlert={unignoreAlert}
          setScreen={setScreen}
          automationCommanderSheetId={automationCommanderSheetId}
        />
      );
    }

    
    
    
    // ── OUTGOINGS SCREEN ────────────────────────────────────────────────────────
    if (activeNav === "outgoings") {
      return (
        <OutgoingsView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          withModal={withModal}
        />
      );
    }

    // ── INVOICES SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "invoices") {
      return (
        <InvoicesView 
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
        />
      );
    }

    // ── RETAINERS SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "retainers") {
      return (
        <RetainersView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          withModal={withModal}
        />
      );
    }

    // ── TOOLS SCREEN ─────────────────────────────────────────────────────────────
    if (activeNav === "tools") {
      return (
        <ToolsView
          automationCommanderSheetId={automationCommanderSheetId}
          allOutgoingsClients={allOutgoingsClients}
          allClientsLoaded={allClientsLoaded}
          styles={styles}
          withModal={withModal}
        />
      );
    }

    // ── JOBS SCREEN ─────────────────────────────────────────────────────────────
    if (activeNav === "jobs") {
      return (
        <JobsView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
        />
      );
    }

    // ── SETTINGS SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "settings") {
      return (
        <SettingsView
          automationCommanderSheetId={automationCommanderSheetId}
          allOutgoingsClients={allOutgoingsClients}
          getFlagName={getFlagName}
          withModal={withModal}
        />
      );
    }

    // ── APP LOG SCREEN ──────────────────────────────────────────────────────────
    if (activeNav === "appLog") {
      return (
        <AppLogView 
          automationCommanderSheetId={automationCommanderSheetId}
        />
      );
    }

    // ── CLIENT SELECTION SCREEN ─────────────────────────────────────────────────
    if (screen === "clientSelection" && sessionId && activeNav !== "tasks") {
      return (
        <ClientSelectionView
          styles={styles}
          isLoading={isLoading}
          error={error}
          getFlagName={getFlagName}
          PROACTIVE_TYPE_LABELS={PROACTIVE_TYPE_LABELS}
          setScreen={setScreen}
          loadIgnoredAlerts={loadIgnoredAlerts}
        />
      );
    }

    // ── ALERT SELECTION SCREEN ──────────────────────────────────────────────────
    if (screen === "alertSelection" && selectedClient && activeNav !== "tasks") {
      return (
        <AlertSelectionView
          styles={styles}
          setScreen={setScreen}
          getFlagName={getFlagName}
          getAlertSummary={getAlertSummary}
          PROACTIVE_TYPE_LABELS={PROACTIVE_TYPE_LABELS}
          openCreateTaskModal={openCreateTaskModal}
          setActiveNav={setActiveNav}
        />
      );
    }

    // ── TRIAGE ANALYSIS SCREEN ──────────────────────────────────────────────────
    if (screen === "triageAnalysis" && selectedClient && clientAlerts.length > 0 && activeNav !== "tasks") {
      return (
        <TriageAnalysisView
          styles={styles}
          setScreen={setScreen}
          getFlagName={getFlagName}
          openCreateTaskModal={openCreateTaskModal}
          setActiveNav={setActiveNav}
          handleNavTasks={handleNavTasks}
        />
      );
    }

    // ── TASKS SCREEN ────────────────────────────────────────────────────────────
    if (activeNav === "tasks") {
      return (
        <TasksView
          styles={styles}
          allClientsMap={allClientsMap}
          automationCommanderSheetId={automationCommanderSheetId}
          isAccepting={isAccepting}
          setIsAccepting={setIsAccepting}
          refreshTriage={refreshTriage}
        />
      );
    }

    // ── DEFAULT / HOME SCREEN ───────────────────────────────────────────────────
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alerts</h1>
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
    );
  };

  // --- FINAL RENDER ---
  return (
    <TriageProvider value={triageEngine}>
      <CreateTaskModal />
      <NavShell
      activeNav={activeNav} 
      onHome={handleNavHome} 
      onOverview={handleNavOverview} 
      onTasks={handleNavTasks} 
      onAppLog={handleNavAppLog} 
      onOutgoings={handleNavOutgoings} 
      onInvoices={handleNavInvoices} 
      onRetainers={handleNavRetainers} 
      onJobs={handleNavJobs} 
      onTools={handleNavTools} 
      onSettings={handleNavSettings} 
      homeAlertCount={liveAlertCount + proactiveAlerts.length} 
      taskCount={navTaskCount}
    >
        {renderActiveView()}
      </NavShell>
    </TriageProvider>
  );
}