import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Spinner from "../components/Spinner";
import { MonthViewSkeleton, PmaHomeSkeleton, PmaAlertsSkeleton, PmaActivitySkeleton, PmaTasksSkeleton, PmaInvoicesTableSkeleton, PmaJobsTableSkeleton, PmaOutgoingsTableSkeleton, PmaRetainersTableSkeleton, PmaSalariesSkeleton, PmaExpensesTableSkeleton, PmaNBToFindSkeleton, PmaIntegrationsSkeleton, PmaSetupOverviewSkeleton, BudgetSkeleton } from "../components/Skeleton";
import TruncatedCode from "../components/TruncatedCode";
import NavShell from "../components/NavShell";
import PortalShell from "../components/portal/PortalShell";
import dynamic from "next/dynamic";
import { calculateIntegrationsAttentionCount } from "../utils/integrationsBadge";

// Core initial views loaded statically for instant render
import ClientSelectionView from "../components/ClientSelectionView";
import AlertSelectionView from "../components/AlertSelectionView";
import TriageAnalysisView from "../components/TriageAnalysisView";
import HomeView from "../components/HomeView";
import AuthGateView from "../components/AuthGateView";
import InvoicesView from "../components/InvoicesView";
import OutgoingsView from "../components/OutgoingsView";

// Secondary views code-split via next/dynamic to reduce PMA bundle size
const AppLogView = dynamic(() => import("../components/AppLogView"), { loading: () => <PmaActivitySkeleton /> });
const ActivityView = dynamic(() => import("../components/ActivityView"), { loading: () => <PmaActivitySkeleton /> });
const IgnoredAlertsView = dynamic(() => import("../components/IgnoredAlertsView"), { loading: () => <PmaAlertsSkeleton /> });
const TasksView = dynamic(() => import("../components/TasksView"), { loading: () => <PmaTasksSkeleton /> });
const CreateTaskModal = dynamic(() => import("../components/CreateTaskModal"));
const JobsView = dynamic(() => import("../components/JobsView"), { loading: () => <PmaJobsTableSkeleton /> });
const RetainersView = dynamic(() => import("../components/RetainersView"), { loading: () => <PmaRetainersTableSkeleton /> });
const SalariesView = dynamic(() => import("../components/SalariesView"), { loading: () => <PmaSalariesSkeleton /> });
const ExpensesView = dynamic(() => import("../components/ExpensesView"), { loading: () => <PmaExpensesTableSkeleton /> });
const NBToFindView = dynamic(() => import("../components/NBToFindView"), { loading: () => <PmaNBToFindSkeleton /> });
const BudgetView = dynamic(() => import("../components/BudgetView"), { loading: () => <BudgetSkeleton /> });
const CashEditView = dynamic(() => import("../components/CashEditView"), { loading: () => <PmaOutgoingsTableSkeleton /> });
const ToolsView = dynamic(() => import("../components/ToolsView"), { loading: () => <PmaSetupOverviewSkeleton /> });
const SettingsView = dynamic(() => import("../components/SettingsView"), { loading: () => <PmaSetupOverviewSkeleton /> });
const IntegrationsView = dynamic(() => import("../components/IntegrationsView"), { loading: () => <PmaIntegrationsSkeleton /> });
const SetupView = dynamic(() => import("../components/SetupView"), { loading: () => <PmaSetupOverviewSkeleton /> });
const ViewsScreen = dynamic(() => import("../components/ViewsScreen"), { loading: () => <PmaHomeSkeleton /> });
import { useAuth } from "../hooks/useAuth";
import { useOverview } from "../hooks/useOverview";
import { TaskProvider, useTasks } from "../contexts/TaskContext";
import { TriageProvider } from "../contexts/TriageContext";
import { useIgnoredAlerts } from "../hooks/useIgnoredAlerts";
import { styles, injectGlobalStyles } from "../utils/styles";
import {
  getAlertSummary,
  PROACTIVE_TYPE_LABELS,
  getFlagName,
  ADMIN_ONLY_FLAG_KEYS,
  ADMIN_ONLY_PROACTIVE_TYPES,
  isUserAuthorizedForClient
} from "../utils/helpers";
import { AppGlobalsProvider, useAppGlobals } from "../hooks/useAppGlobals";
import { useTriageEngine } from "../hooks/useTriageEngine";

// Inject global styles into the document head
injectGlobalStyles();

export default function TriageSystem({ onBack, initialNav, initialUser = null, initialClients = [], initialIntegrations = null }) {
  return (
    <TriageSystemWithGlobals
      onBack={onBack}
      initialNav={initialNav}
      initialUser={initialUser}
      initialClients={initialClients}
      initialIntegrations={initialIntegrations}
    />
  );
}

function TriageSystemWithGlobals({ onBack, initialNav, initialUser = null, initialClients = [], initialIntegrations = null }) {
  const appGlobals = useAppGlobals();
  return (
    <>
      <Head>
        <title>PMA - Pulse Management Area</title>
      </Head>
      <TaskProvider automationCommanderSheetId={appGlobals.automationCommanderSheetId} managedClient={appGlobals.managedClient}>
        <TriageSystemContent
          onBack={onBack}
          appGlobals={appGlobals}
          initialNav={initialNav}
          initialUser={initialUser}
          initialClients={initialClients}
          initialIntegrations={initialIntegrations}
        />
      </TaskProvider>
    </>
  );
}

function TriageSystemContent({ onBack, appGlobals, initialNav, initialUser = null, initialClients = [], initialIntegrations = null }) {
  const {
    automationCommanderSheetId, assignedAppIds, setAssignedAppIds,
    assignedByClient, setAssignedByClient, addAssignedAppId,
    outgoingsPullPendingRef, allClientsMap, setAllClientsMap,
    showDebugPanel, setShowDebugPanel, debugClientName, setDebugClientName,
    debugResult, setDebugResult, debugLoading, setDebugLoading, runDebug,
    managedClient, setManagedClient, preloadClientData
  } = appGlobals;


  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => { setHasMounted(true); }, []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const auth = useAuth(initialUser);
  const {
    isAuthenticated, authChecking, user, logout
  } = auth;
  // Only Admin is an internal staff role able to see all clients (never when in read-only OTP mode)
  const isAdmin = !user?.isReadOnly && !!(user?.isAdmin || user?.role === "Admin");
  const isPulseOnly = Boolean(
    user && (user.isReadOnly || user.authProvider === "EmailOTP" || user.role === "ClientUser" || user.role === "Senior (Restricted)" || user.isSenior || (!isAdmin && user.role !== "ClientManager"))
  );

  // If ClientUser, Senior (Restricted), or Read-Only (OTP) lands on PMA, redirect immediately to Pulse
  useEffect(() => {
    if (!authChecking && isAuthenticated && (isPulseOnly || user?.isReadOnly)) {
      if (router?.replace) {
        router.replace("/pulse");
      } else {
        window.location.href = "/pulse";
      }
    }
  }, [authChecking, isAuthenticated, isPulseOnly, user?.isReadOnly, router]);

  const [screen, setScreen] = useState("initial");
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);
  const [activeNav, setActiveNav] = useState(() => {
    if (initialNav) return initialNav;
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      if (p.get("integration")) return "integrations";
      const navParam = p.get("nav");
      if (navParam) return navParam;
      const path = window.location.pathname.toLowerCase();
      if (path.includes("/alerts")) return "alerts";
    }
    return "home";
  });
  const [setupClientName, setSetupClientName] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("client") || "";
    }
    return "";
  });
  const [settingsClientName, setSettingsClientName] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("client") || "";
    }
    return "";
  });
  const [settingsSection, setSettingsSection] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("section") || "main";
    }
    return "main";
  });
  const [settingsSubsection, setSettingsSubsection] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("subsection") || "";
    }
    return "";
  });
  const lastHandledAsPathRef = useRef(typeof window !== "undefined" ? window.location.pathname + window.location.search : "");

  // Watch router query changes for client-side Link navigations (e.g. <Link href="/pma?nav=settings...">)
  useEffect(() => {
    if (!router?.isReady) return;
    const asPath = router.asPath || "";
    // Only process if the router asPath is different from what we last handled/synchronized
    if (asPath && asPath === lastHandledAsPathRef.current) return;
    if (asPath) lastHandledAsPathRef.current = asPath;

    const query = router.query;
    if (query.integration) {
      setActiveNav("integrations");
    } else if (query.nav && typeof query.nav === "string") {
      setActiveNav(query.nav);
    }
    if (query.client && typeof query.client === "string") {
      setSetupClientName(query.client);
      setSettingsClientName(query.client);
    }
    if (query.section && typeof query.section === "string") {
      setSettingsSection(query.section);
    }
    if (query.subsection && typeof query.subsection === "string") {
      setSettingsSubsection(query.subsection);
    }
  }, [router?.isReady, router?.asPath]);
  const [invoicesInitialClient, setInvoicesInitialClient] = useState(null);
  const [outgoingsInitialClient, setOutgoingsInitialClient] = useState(null);
  const [editStickyClient, setEditStickyClient] = useState(null);
  const [viewsStickyClient, setViewsStickyClient] = useState(null);
  const [activeViewTab, setActiveViewTab] = useState("fyPerformance");
  const [alertAssignOverlay, setAlertAssignOverlay] = useState(null); // { mode: "invoices" | "outgoings", client }

  const EDIT_NAV_KEYS = useMemo(
    () => new Set(["jobs", "outgoings", "invoices", "retainers", "salaries", "expenses", "nbtofind", "budget", "cash"]),
    []
  );

  useEffect(() => {
    if (!EDIT_NAV_KEYS.has(activeNav)) {
      setEditStickyClient(null);
      setInvoicesInitialClient(null);
      setOutgoingsInitialClient(null);
    }
    if (activeNav !== "views") {
      setViewsStickyClient(null);
    }
    if (activeNav !== "alerts") {
      setAlertAssignOverlay(null);
    }
  }, [activeNav, EDIT_NAV_KEYS]);

  useEffect(() => {
    if (!alertAssignOverlay) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [alertAssignOverlay]);

  const resolveFullClient = (client) => {
    if (!client) return null;
    const targetName = String(client.clientName || client.name || "").trim().toLowerCase();
    const matchOutgoings = (allOutgoingsClients || []).find(
      c => String(c.clientName || "").trim().toLowerCase() === targetName && c.clientSheetId
    );
    const matchFlags = (triageEngine.clientsWithFlags || []).find(
      c => String(c.clientName || "").trim().toLowerCase() === targetName
    );
    const matchMap = allClientsMap?.[client.clientName] ||
      Object.values(allClientsMap || {}).find(c => String(c.clientName || "").trim().toLowerCase() === targetName);
    return {
      ...(matchMap || {}),
      ...(matchFlags || {}),
      ...(matchOutgoings || {}),
      ...client,
      clientSheetId: client.clientSheetId || matchOutgoings?.clientSheetId || matchFlags?.clientSheetId || matchMap?.clientSheetId || "",
      masterSheetId: client.masterSheetId || matchOutgoings?.masterSheetId || matchFlags?.masterSheetId || matchMap?.masterSheetId || "",
    };
  };

  const handleNavInvoicesForClient = (client) => {
    loadClients();
    const resolved = resolveFullClient(client);
    setAlertAssignOverlay({ mode: "invoices", client: resolved });
  };

  const handleNavOutgoingsForClient = (client) => {
    loadClients();
    const resolved = resolveFullClient(client);
    setAlertAssignOverlay({ mode: "outgoings", client: resolved });
  };

  const {
    navTaskCount, setNavTaskCount, snoozedTaskCount, setSnoozedTaskCount,
    showTaskModal, setShowTaskModal, taskModalAlert, setTaskModalAlert,
    taskModalIsProactive, setTaskModalIsProactive, taskModalIsInfo, setTaskModalIsInfo, taskModalNote, setTaskModalNote,
    taskModalSnoozeDate, setTaskModalSnoozeDate, taskModalSnoozeTime, setTaskModalSnoozeTime,
    taskModalSubmitting, setTaskModalSubmitting, taskActionError, setTaskActionError,
    existingTaskBanner, setExistingTaskBanner,
    setTasksFilter, loadTasks, refreshTaskCount
  } = useTasks();

  const triageEngine = useTriageEngine({
    automationCommanderSheetId, screen, setScreen, activeNav, assignedAppIds,
    assignedByClient, addAssignedAppId, existingTaskBanner, setExistingTaskBanner, allClientsMap, isLoading, setIsLoading,
    error, setError, setBulkMode: () => { }, setBulkSelected: () => { },
    user,
    onRefreshTasks: refreshTaskCount
  });

  const {
    sessionId, selectedClient, clientAlerts, proactiveAlerts,
    liveAlertCount, startTriage, acceptError, setAcceptError,
    isAccepting, setIsAccepting, refreshTriage, reloadFromCache
  } = triageEngine;

  const [cachedAlertCount, setCachedAlertCount] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pulse_cached_alert_badge");
        return stored != null ? parseInt(stored, 10) : 0;
      } catch { return 0; }
    }
    return 0;
  });

  const authorizedProactiveCount = useMemo(() => {
    return (proactiveAlerts || []).filter(
      a => isUserAuthorizedForClient(user, a.clientName) && (isAdmin || !ADMIN_ONLY_PROACTIVE_TYPES.has(a.alertType))
    ).length;
  }, [proactiveAlerts, user, isAdmin]);

  const currentLiveAlertCount = liveAlertCount + authorizedProactiveCount;

  const [integrationsRawData, setIntegrationsRawData] = useState(() => {
    if (initialIntegrations && Array.isArray(initialIntegrations.allClients) && initialIntegrations.allClients.length > 0) {
      return initialIntegrations;
    }
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pulse_cached_integrations_data");
        if (stored) return JSON.parse(stored);
      } catch {}
    }
    return { allClients: [], sharedXero: null };
  });

  const [cachedIntegrationsAttentionCount, setCachedIntegrationsAttentionCount] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pulse_cached_integrations_badge");
        return stored != null ? parseInt(stored, 10) : 0;
      } catch { return 0; }
    }
    return 0;
  });

  const fetchIntegrationsStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/status?all=true");
      const data = await res.json();
      if (data.success && Array.isArray(data.allClients)) {
        const payload = { allClients: data.allClients, sharedXero: data.sharedXero || null };
        setIntegrationsRawData(payload);
        try {
          localStorage.setItem("pulse_cached_integrations_data", JSON.stringify(payload));
        } catch {}
      }
    } catch (e) {
      console.warn("triage: failed to fetch integration statuses for badge", e);
    }
  }, []);

  const handleIntegrationsStatusRefresh = useCallback((payload) => {
    setIntegrationsRawData(payload);
    try {
      localStorage.setItem("pulse_cached_integrations_data", JSON.stringify(payload));
    } catch {}
  }, []);

  useEffect(() => {
    if (initialIntegrations && Array.isArray(initialIntegrations.allClients) && initialIntegrations.allClients.length > 0) {
      try {
        localStorage.setItem("pulse_cached_integrations_data", JSON.stringify(initialIntegrations));
      } catch {}
      return;
    }
    if (isAuthenticated && user?.email) {
      fetchIntegrationsStatus();
    }
  }, [isAuthenticated, user?.email, fetchIntegrationsStatus, initialIntegrations]);

  const integrationsAttentionCount = useMemo(() => {
    if (!integrationsRawData?.allClients?.length) {
      return cachedIntegrationsAttentionCount;
    }
    const count = calculateIntegrationsAttentionCount(
      integrationsRawData.allClients,
      integrationsRawData.sharedXero,
      managedClient?.clientName
    );
    if (typeof window !== "undefined" && !managedClient) {
      try { localStorage.setItem("pulse_cached_integrations_badge", String(count)); } catch {}
    }
    return count;
  }, [integrationsRawData, managedClient, cachedIntegrationsAttentionCount]);

  const managedClientAlertCount = useMemo(() => {
    if (!managedClient?.clientName) return null;
    const targetName = managedClient.clientName.toLowerCase();
    const ACTIONABLE_FLAG_KEYS_SET = new Set([
      "invoiceDashboardDiscr", "expenseDashboardDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
    ]);
    const EXPENSE_TYPES = new Set(["expenseDashboardDiscr"]);
    const INVOICE_TYPES = new Set(["invoiceDashboardDiscr"]);

    const client = (triageEngine.clientsWithFlags || []).find(
      c => (c.clientName || "").toLowerCase() === targetName
    );

    let flagCount = 0;
    if (client) {
      const normClient = String(client.clientName || "").trim().toLowerCase();
      let assignedSet = new Set();
      for (const [k, s] of Object.entries(assignedByClient || {})) {
        if (String(k).trim().toLowerCase() === normClient) {
          assignedSet = s;
          break;
        }
      }
      const isIdMatch = (id) => {
        if (id === null || id === undefined || id === "") return false;
        const s = String(id).trim();
        const clean = s.replace(/^#/, "");
        if (assignedSet.has(id) || assignedSet.has(s) || assignedSet.has(clean)) return true;
        if (!isNaN(Number(clean)) && clean !== "" && assignedSet.has(Number(clean))) return true;
        if (assignedAppIds.has(id) || assignedAppIds.has(s) || assignedAppIds.has(clean)) return true;
        if (!isNaN(Number(clean)) && clean !== "" && assignedAppIds.has(Number(clean))) return true;
        return false;
      };
      const expenseIds = client.activeExpenseIds || [];
      const invoiceIds = client.activeInvoiceIds || [];
      const validAssignedExp = expenseIds.filter(isIdMatch).length;
      const validAssignedInv = invoiceIds.filter(isIdMatch).length;

      Object.entries(client.flags || {}).forEach(([flagKey, isSet]) => {
        if (!isSet || (!isAdmin && ADMIN_ONLY_FLAG_KEYS.has(flagKey))) return;
        let count = client.alertCounts?.[flagKey] || 0;
        if (ACTIONABLE_FLAG_KEYS_SET.has(flagKey)) {
          if (EXPENSE_TYPES.has(flagKey)) count = Math.max(0, count - validAssignedExp);
          if (INVOICE_TYPES.has(flagKey)) count = Math.max(0, count - validAssignedInv);
          flagCount += count;
        } else {
          flagCount += (count > 0 ? count : 0);
        }
      });
    }

    const proactiveCount = (proactiveAlerts || []).filter(
      a => (a.clientName || "").toLowerCase() === targetName && (isAdmin || !ADMIN_ONLY_PROACTIVE_TYPES.has(a.alertType))
    ).length;

    return flagCount + proactiveCount;
  }, [managedClient, triageEngine.clientsWithFlags, assignedByClient, assignedAppIds, proactiveAlerts, isAdmin]);

  useEffect(() => {
    if (triageEngine.triageComplete && !managedClient) {
      setCachedAlertCount(currentLiveAlertCount);
      try {
        localStorage.setItem("pulse_cached_alert_badge", String(currentLiveAlertCount));
        localStorage.setItem("pulse_cached_total_alerts", String(currentLiveAlertCount));
      } catch {}
    }
  }, [triageEngine.triageComplete, currentLiveAlertCount, managedClient]);

  // --- INITIAL DATA LOAD ---
  // Explicitly trigger triage data load only when authenticated, scoped to current user, and allowed in PMA
  const currentAuthEmail = user?.email || "";
  const prevAuthEmailRef = useRef("");

  useEffect(() => {
    if (!isAuthenticated || authChecking || isPulseOnly) return;

    if (prevAuthEmailRef.current !== currentAuthEmail) {
      prevAuthEmailRef.current = currentAuthEmail;
      startTriage();
      refreshTaskCount?.();
    } else if (!sessionId && !isLoading) {
      startTriage();
      refreshTaskCount?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authChecking, isPulseOnly, currentAuthEmail, sessionId]);

  // Background reload of latest cached triage data every 15 minutes if left open
  useEffect(() => {
    if (!isAuthenticated || authChecking || isPulseOnly) return;
    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    const interval = setInterval(() => {
      console.log("⏰ 15-minute background refresh: reloading cached triage data...");
      reloadFromCache?.(true);
      refreshTaskCount?.(true);
    }, FIFTEEN_MINUTES);
    return () => clearInterval(interval);
  }, [isAuthenticated, authChecking, isPulseOnly, reloadFromCache, refreshTaskCount]);

  const { overviewData, setOverviewData, overviewLoading, setOverviewLoading, loadOverview } = useOverview(automationCommanderSheetId);

  const [allOutgoingsClients, setAllOutgoingsClients] = useState(() => {
    if (Array.isArray(initialClients) && initialClients.length > 0) {
      return initialClients;
    }
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pulse_cached_all_clients");
        return stored ? JSON.parse(stored) : [];
      } catch { return []; }
    }
    return [];
  });
  const [allClientsLoaded, setAllClientsLoaded] = useState(
    Boolean(Array.isArray(initialClients) && initialClients.length > 0)
  );

  // Single client access check: only non-admins who only have access to a single client
  const isSingleClientUser = Boolean(
    !isAdmin && (
      (Array.isArray(allOutgoingsClients) && allOutgoingsClients.length === 1) ||
      (Array.isArray(user?.assignedClients) && user.assignedClients.length === 1)
    )
  );

  const singleClient = useMemo(() => {
    if (!isSingleClientUser) return null;
    if (Array.isArray(allOutgoingsClients) && allOutgoingsClients.length === 1 && allOutgoingsClients[0]?.clientName) {
      return allOutgoingsClients[0];
    }
    if (Array.isArray(user?.assignedClients) && user.assignedClients.length === 1) {
      const assignedName = user.assignedClients[0];
      const match =
        (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === assignedName?.toLowerCase()) ||
        (allClientsMap && (allClientsMap[assignedName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === assignedName?.toLowerCase()))) ||
        { clientName: assignedName };
      return match;
    }
    return null;
  }, [isSingleClientUser, allOutgoingsClients, user?.assignedClients, allClientsMap]);

  // When a non-admin only has access to a single client, automatically operate in managed mode and preload data
  useEffect(() => {
    if (isSingleClientUser && singleClient?.clientName) {
      const isDifferentClient = !managedClient || managedClient.clientName?.toLowerCase() !== singleClient.clientName?.toLowerCase();
      const needsSheetId = !managedClient?.clientSheetId && Boolean(singleClient.clientSheetId);
      if (isDifferentClient || needsSheetId) {
        setManagedClient(singleClient);
      }
      if (singleClient.clientSheetId) {
        preloadClientData?.(singleClient);
      }
    }
  }, [isSingleClientUser, singleClient, managedClient, setManagedClient, preloadClientData]);

  const handleClearManagedClient = () => {
    if (isSingleClientUser) return;
    setManagedClient(null);
    setSetupClientName("");
    if (activeNav === "alerts") {
      triageEngine.setSelectedClient(null);
      setScreen("clientSelection");
    }
  };

  const { ignoredAlerts, isLoadingIgnored, isUnignoring, loadIgnoredAlerts, unignoreAlert } = useIgnoredAlerts(automationCommanderSheetId, setAcceptError);

  const openCreateTaskModal = (alert, isProactive = false, isInfo = false) => {
    setTaskModalAlert(alert);
    setTaskModalIsProactive(isProactive);
    setTaskModalIsInfo(isInfo);
    setTaskModalNote("");
    setShowTaskModal(true);
    setTaskActionError("");
  };

  // ── Navigation helpers ──────────────────────────────────────────────────

  // Fire the deferred GAS outgoings notes pull if one is pending.
  const fireOutgoingsPullIfPending = () => {
    const pending = outgoingsPullPendingRef.current;
    if (!pending) return;
    outgoingsPullPendingRef.current = null;
    let clientSheetId = typeof pending === "object" ? (pending.clientSheetId || "") : "";
    let masterSheetId = typeof pending === "object" ? (pending.masterSheetId || "") : pending;
    if (!clientSheetId && masterSheetId) {
      const match = (allOutgoingsClients || []).find(c => c.masterSheetId === masterSheetId) ||
        Object.values(allClientsMap || {}).find(c => c.masterSheetId === masterSheetId);
      if (match) clientSheetId = match.clientSheetId || "";
    }
    if (!clientSheetId || !masterSheetId) return;
    fetch("/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fire_outgoings_pull", clientSheetId, masterSheetId }),
    }).catch(e => console.error("fireOutgoingsPull error:", e));
  };

  const handleCloseAlertAssignOverlay = () => {
    fireOutgoingsPullIfPending();
    setAlertAssignOverlay(null);
  };

  const clientsLoadedRef = useRef(Boolean(Array.isArray(initialClients) && initialClients.length > 0));
  const clientsLoadingRef = useRef(false);

  useEffect(() => {
    if (Array.isArray(initialClients) && initialClients.length > 0) {
      try {
        localStorage.setItem("pulse_cached_all_clients", JSON.stringify(initialClients));
      } catch {}
      if (setAllClientsMap) {
        const map = {};
        for (const c of initialClients) {
          if (c.clientName) map[c.clientName] = c;
        }
        setAllClientsMap(map);
      }
    }
  }, [initialClients, setAllClientsMap]);

  const loadClients = useCallback((force = false) => {
    if (!force && clientsLoadedRef.current) return;
    if (clientsLoadingRef.current) return;
    clientsLoadingRef.current = true;
    const acId = automationCommanderSheetId || "default";
    fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_all_clients", automationCommanderSheetId: acId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.clients)) {
          setAllOutgoingsClients(data.clients);
          try {
            localStorage.setItem("pulse_cached_all_clients", JSON.stringify(data.clients));
          } catch {}
          if (data.clientsMap && setAllClientsMap) {
            setAllClientsMap(data.clientsMap);
          }
          if (data.clients.length === 1 && !isAdmin) {
            const sc = data.clients[0];
            setManagedClient(sc);
            if (sc.clientSheetId) {
              preloadClientData?.(sc);
            }
          }
          setAllClientsLoaded(true);
          clientsLoadedRef.current = true;
        }
      })
      .catch(e => {
        console.error("get_all_clients error:", e);
        try {
          const stored = localStorage.getItem("pulse_cached_all_clients");
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setAllOutgoingsClients(parsed);
              setAllClientsLoaded(true);
            }
          }
        } catch {}
      })
      .finally(() => {
        clientsLoadingRef.current = false;
      });
  }, [automationCommanderSheetId, setAllClientsMap, isAdmin, setManagedClient, preloadClientData]);

  const prevUserEmailRef = useRef(Array.isArray(initialClients) && initialClients.length > 0 ? (user?.email || null) : null);
  useEffect(() => {
    if (isAuthenticated && user?.email) {
      if (prevUserEmailRef.current !== user.email) {
        prevUserEmailRef.current = user.email;
        clientsLoadedRef.current = false;
        loadClients(true);
      } else if (!clientsLoadedRef.current) {
        loadClients(true);
      }
    } else if (!authChecking && !isAuthenticated) {
      prevUserEmailRef.current = null;
      clientsLoadedRef.current = false;
      setAllOutgoingsClients([]);
      setAllClientsLoaded(false);
    }
  }, [isAuthenticated, authChecking, user?.email, loadClients]);

  // ── Navigation Guard for Unsaved Changes ──────────────────────────────
  const navGuardRef = useRef(null);
  const registerNavGuard = useCallback((guardFn) => {
    navGuardRef.current = guardFn;
  }, []);
  const navigateWithGuard = useCallback((action) => {
    if (navGuardRef.current) {
      navGuardRef.current(action);
    } else {
      action();
    }
  }, []);

  const handleNavHome = () => navigateWithGuard(() => { fireOutgoingsPullIfPending(); setActiveNav("home"); });
  const lastManagedAlertSelectionRef = useRef("");
  const handleNavAlerts = () => navigateWithGuard(() => {
    fireOutgoingsPullIfPending();
    setActiveNav("alerts");
    if (managedClient) {
      const targetName = managedClient.clientName?.toLowerCase() || "";
      const match =
        (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === targetName) ||
        (triageEngine.clientsWithFlags || []).find(c => c.clientName?.toLowerCase() === targetName) ||
        (allClientsMap && (allClientsMap[managedClient.clientName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === targetName))) ||
        managedClient;
      if (triageEngine.sessionId) {
        lastManagedAlertSelectionRef.current = `${targetName}-${triageEngine.sessionId}`;
        triageEngine.selectClient(match);
      }
    } else {
      setScreen("clientSelection");
    }
  });

  // Automatically select managed client alerts when activeNav is alerts
  useEffect(() => {
    if (activeNav === "alerts" && managedClient) {
      const targetName = managedClient.clientName?.toLowerCase() || "";
      const sessionKey = `${targetName}-${triageEngine.sessionId || "nosession"}`;
      if (lastManagedAlertSelectionRef.current !== sessionKey) {
        lastManagedAlertSelectionRef.current = sessionKey;
        const match =
          (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === targetName) ||
          (triageEngine.clientsWithFlags || []).find(c => c.clientName?.toLowerCase() === targetName) ||
          (allClientsMap && (allClientsMap[managedClient.clientName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === targetName))) ||
          managedClient;
        triageEngine.selectClient(match);
      }
    } else if (!managedClient) {
      lastManagedAlertSelectionRef.current = "";
    }
  }, [activeNav, managedClient, triageEngine.sessionId, allOutgoingsClients, triageEngine.clientsWithFlags]);
  const handleNavOverview = () => navigateWithGuard(() => { fireOutgoingsPullIfPending(); setActiveNav("overview"); loadOverview(); });
  const handleNavTasks = () => navigateWithGuard(() => { fireOutgoingsPullIfPending(); setActiveNav("tasks"); setTasksFilter("active"); loadTasks("active", true); });
  const handleNavActivity = () => navigateWithGuard(() => { fireOutgoingsPullIfPending(); setActiveNav("activity"); loadClients(); });
  const handleNavAppLog = handleNavActivity;
  const handleNavSettings = (clientName = "", section = "", subsection = "") => navigateWithGuard(() => {
    fireOutgoingsPullIfPending();
    if (typeof clientName === "string" && clientName.trim()) {
      setSettingsClientName(clientName.trim());
    }
    if (typeof section === "string" && section.trim()) {
      setSettingsSection(section.trim());
    }
    if (typeof subsection === "string" && subsection.trim()) {
      setSettingsSubsection(subsection.trim());
    }
    setActiveNav("settings");
    loadClients();
  });
  const handleNavIntegrations = () => navigateWithGuard(() => { fireOutgoingsPullIfPending(); setActiveNav("integrations"); loadClients(); });
  const handleNavSetup = (clientName = "") => navigateWithGuard(() => {
    fireOutgoingsPullIfPending();
    if (typeof clientName === "string" && clientName.trim()) {
      setSetupClientName(clientName.trim());
    } else if (managedClient?.clientName) {
      setSetupClientName(managedClient.clientName);
    } else {
      setSetupClientName("");
    }
    setActiveNav("setup");
    loadClients();
  });
  const handleNavTools = () => navigateWithGuard(() => { setActiveNav("tools"); loadClients(); });
  const handleNavOutgoings = () => navigateWithGuard(() => { setActiveNav("outgoings"); loadClients(); });
  const handleNavInvoices = () => navigateWithGuard(() => { setActiveNav("invoices"); loadClients(); });
  const handleNavJobs = () => navigateWithGuard(() => { setActiveNav("jobs"); loadClients(); });
  const handleNavRetainers = () => navigateWithGuard(() => { setActiveNav("retainers"); loadClients(); });
  const handleNavSalaries = () => navigateWithGuard(() => { setActiveNav("salaries"); loadClients(); });
  const handleNavExpenses = () => navigateWithGuard(() => { setActiveNav("expenses"); loadClients(); });
  const handleNavNBToFind = () => navigateWithGuard(() => { setActiveNav("nbtofind"); loadClients(); });
  const handleNavBudget = () => navigateWithGuard(() => { setActiveNav("budget"); loadClients(); });
  const handleNavCash = () => navigateWithGuard(() => { setActiveNav("cash"); loadClients(); });
  const handleNavViews = (tabId = "fyPerformance") => navigateWithGuard(() => {
    fireOutgoingsPullIfPending();
    if (typeof tabId === "string" && tabId) {
      setActiveViewTab(tabId);
    }
    setActiveNav("views");
    loadClients();
  });

  // Synchronize browser URL with activeNav so direct bookmarking works naturally
  // Rule: Canonical URL for PMA is ALWAYS /pma (never bare root /)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isAuthenticated || authChecking || isPulseOnly || user?.isReadOnly) return;
    let target = "/pma";
    if (activeNav === "alerts") {
      target = "/pma/alerts";
    } else if (activeNav === "setup") {
      const activeClient = managedClient?.clientName || setupClientName;
      target = activeClient ? `/pma?nav=setup&client=${encodeURIComponent(activeClient)}` : `/pma?nav=setup`;
    } else if (activeNav === "settings") {
      const activeClient = managedClient?.clientName || settingsClientName;
      const params = new URLSearchParams();
      params.set("nav", "settings");
      if (activeClient) params.set("client", activeClient);
      if (settingsSection && settingsSection !== "main") params.set("section", settingsSection);
      if (settingsSubsection) params.set("subsection", settingsSubsection);
      target = `/pma?${params.toString()}`;
    } else if (activeNav !== "home") {
      target = `/pma?nav=${activeNav}`;
    }
    const current = window.location.pathname + (window.location.search ? window.location.search : "");
    if (current !== target && !window.location.search.includes("integration=")) {
      lastHandledAsPathRef.current = target;
      window.history.replaceState({ nav: activeNav }, "", target);
    }
  }, [activeNav, setupClientName, settingsClientName, settingsSection, settingsSubsection, managedClient]);

  useEffect(() => {
    const onPopState = (e) => {
      if (e.state?.nav) {
        setActiveNav(e.state.nav);
        if (typeof window !== "undefined") {
          const p = new URLSearchParams(window.location.search);
          const clientParam = p.get("client");
          if (clientParam) {
            setSetupClientName(clientParam);
            setSettingsClientName(clientParam);
          }
          const sectionParam = p.get("section");
          if (sectionParam) setSettingsSection(sectionParam);
          const subParam = p.get("subsection");
          if (subParam) setSettingsSubsection(subParam);
        }
      } else if (typeof window !== "undefined") {
        const path = window.location.pathname.toLowerCase();
        if (path.includes("/alerts")) setActiveNav("alerts");
        else setActiveNav("home");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Check URL query parameters and initialNav on mount to deep-link
  useEffect(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const navParam = p.get("nav");
      const clientParam = p.get("client");
      const sectionParam = p.get("section");
      const subsectionParam = p.get("subsection");
      if (clientParam) {
        setSetupClientName(clientParam);
        setSettingsClientName(clientParam);
        if (!managedClient || managedClient.clientName !== clientParam) {
          setManagedClient(clientParam);
        }
      }
      if (sectionParam) setSettingsSection(sectionParam);
      if (subsectionParam) setSettingsSubsection(subsectionParam);
      const path = window.location.pathname.toLowerCase();
      if (initialNav) {
        setActiveNav(initialNav);
      } else if (path.includes("/alerts") || navParam === "alerts") {
        setActiveNav("alerts");
      } else if (navParam === "integrations" || p.get("integration") === "xero") {
        setActiveNav("integrations");
      } else if (navParam === "setup") {
        setActiveNav("setup");
      } else if (navParam === "tasks") {
        const filterParam = p.get("filter");
        if (filterParam) setTasksFilter(filterParam);
        setActiveNav("tasks");
      } else if (navParam) {
        setActiveNav(navParam);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNav]);

  // Page title and favicon are handled globally by Next.js <Head> in index.js
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // --- AUTHENTICATION GATE ---
  if (authChecking || !hasMounted) {
    const ssrNav = initialNav || "home";
    const hasSsrClients = Array.isArray(initialClients) && initialClients.length > 0;
    return (
      <TriageProvider value={triageEngine}>
        <CreateTaskModal />
        <NavShell activeNav={ssrNav} user={user} isAdmin={isAdmin} clients={initialClients}>
          {ssrNav === "alerts" ? (
            <PmaAlertsSkeleton />
          ) : hasSsrClients ? (
            <HomeView
              clients={initialClients}
              integrationsData={initialIntegrations?.allClients || []}
              user={user}
              isAdmin={isAdmin}
              isLoadingAlerts={true}
            />
          ) : (
            <PmaHomeSkeleton />
          )}
        </NavShell>
      </TriageProvider>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthGateView
        authStep={auth.authStep}
        emailInput={auth.emailInput}
        setEmailInput={auth.setEmailInput}
        codeInput={auth.codeInput}
        setCodeInput={auth.setCodeInput}
        authError={auth.authError}
        setAuthError={auth.setAuthError}
        authLoading={auth.authLoading}
        statusMessage={auth.statusMessage}
        cooldown={auth.cooldown}
        sendVerificationCode={auth.sendVerificationCode}
        verifyCode={auth.verifyCode}
        resetToEmailStep={auth.resetToEmailStep}
      />
    );
  }

  // ClientUser and Senior (Restricted) must never see or interact with PMA;
  // immediately render the Pulse shell + MonthViewSkeleton while router.replace("/pulse") completes.
  if (isPulseOnly) {
    const singleAssignedName =
      Array.isArray(user?.assignedClients) && user.assignedClients.length === 1 && user.assignedClients[0] !== "*"
        ? user.assignedClients[0]
        : "";
    return (
      <PortalShell
        clientName={singleAssignedName}
        clients={[]}
        onSelectClient={() => {}}
        activeView="month"
        onSelectView={() => {}}
        user={user}
        onLogout={logout}
        hasBudget={true}
        hasCash={true}
        setupStatus={null}
      >
        <MonthViewSkeleton />
      </PortalShell>
    );
  }

  // Pass-through wrapper to satisfy child components that still expect withModal
  function withModal(jsx) {
    return jsx;
  }

  // --- DYNAMIC VIEW ROUTER ---
  const renderActiveView = () => {
    // ── HOME SCREEN ─────────────────────────────────────────────────────────────
    if (activeNav === "home") {
      return (
        <HomeView
          clients={allOutgoingsClients}
          clientsWithFlags={triageEngine.clientsWithFlags}
          proactiveAlerts={triageEngine.proactiveAlerts}
          proactiveCountsByClient={triageEngine.proactiveCountsByClient}
          assignedByClient={assignedByClient}
          assignedAppIds={assignedAppIds}
          navTaskCount={navTaskCount}
          user={user}
          isAdmin={isAdmin}
          onGoToAlerts={handleNavAlerts}
          onGoToTasks={handleNavTasks}
          onGoToSetup={(clientName) => {
            handleNavSetup(clientName);
          }}
          onGoToIntegrations={handleNavIntegrations}
          onSelectClientAlerts={(clientName) => {
            handleNavAlerts();
            const match = (triageEngine.clientsWithFlags || []).find(c => c.clientName === clientName);
            if (match) triageEngine.selectClient(match);
          }}
          isLoadingAlerts={isLoading}
          triageComplete={triageEngine.triageComplete}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          integrationsData={integrationsRawData?.allClients || []}
        />
      );
    }

    // ── ALERTS SCREEN ───────────────────────────────────────────────────────────
    if (activeNav === "alerts") {
      // Screen: Ignored Alerts
      if (screen === "ignoredAlerts") {
        if (!isAdmin) {
          setScreen("clientSelection");
          return null;
        }
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

      // Screen: Triage Analysis
      if (screen === "triageAnalysis" && selectedClient && clientAlerts.length > 0) {
        return (
          <TriageAnalysisView
            styles={styles}
            setScreen={setScreen}
            getFlagName={getFlagName}
            openCreateTaskModal={openCreateTaskModal}
            setActiveNav={setActiveNav}
            handleNavTasks={handleNavTasks}
            isAdmin={isAdmin}
            user={user}
          />
        );
      }

      // Screen: Alert Selection
      if (screen === "alertSelection" && selectedClient) {
        return (
          <AlertSelectionView
            styles={styles}
            setScreen={setScreen}
            getFlagName={getFlagName}
            getAlertSummary={getAlertSummary}
            PROACTIVE_TYPE_LABELS={PROACTIVE_TYPE_LABELS}
            openCreateTaskModal={openCreateTaskModal}
            setActiveNav={setActiveNav}
            onNavInvoices={handleNavInvoicesForClient}
            onNavOutgoings={handleNavOutgoingsForClient}
            isAdmin={isAdmin}
            user={user}
            managedClient={managedClient}
            onClearManagedClient={handleClearManagedClient}
            allClients={allOutgoingsClients}
            isSingleClientUser={isSingleClientUser}
            isAssignOverlayOpen={Boolean(alertAssignOverlay)}
          />
        );
      }

      // Screen: Client Selection (Main Alerts List)
      if (sessionId || (!isLoading && (triageEngine.clientsWithFlags || []).length >= 0)) {
        return (
          <ClientSelectionView
            styles={styles}
            isLoading={isLoading}
            error={error}
            getFlagName={getFlagName}
            PROACTIVE_TYPE_LABELS={PROACTIVE_TYPE_LABELS}
            setScreen={setScreen}
            loadIgnoredAlerts={loadIgnoredAlerts}
            user={user}
            managedClient={managedClient}
            onClearManagedClient={handleClearManagedClient}
            isSingleClientUser={isSingleClientUser}
          />
        );
      }

      if (isLoading) {
        return <PmaAlertsSkeleton />;
      }

      return (
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Alerts</h1>
            <p style={styles.subtitle}>{error ? error : "Initialising..."}</p>
          </div>
          {error && <div style={styles.errorBanner}>{error}</div>}
        </div>
      );
    }

    // ── OUTGOINGS SCREEN ────────────────────────────────────────────────────────
    if (activeNav === "outgoings") {
      return (
        <OutgoingsView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          withModal={withModal}
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={outgoingsInitialClient || editStickyClient}
          onSelectClient={(c) => {
            setEditStickyClient(c);
            if (!c) setOutgoingsInitialClient(null);
          }}
        />
      );
    }

    // ── INVOICES SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "invoices") {
      return (
        <InvoicesView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={invoicesInitialClient || editStickyClient}
          onSelectClient={(c) => {
            setEditStickyClient(c);
            if (!c) setInvoicesInitialClient(null);
          }}
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
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
        />
      );
    }

    // ── SALARIES SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "salaries") {
      return (
        <SalariesView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
        />
      );
    }

    // ── EXPENSES SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "expenses") {
      return (
        <ExpensesView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
        />
      );
    }

    // ── NEW BUSINESS TO FIND SCREEN ─────────────────────────────────────────────
    if (activeNav === "nbtofind") {
      return (
        <NBToFindView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
        />
      );
    }

    // ── BUDGET SCREEN ───────────────────────────────────────────────────────────
    if (activeNav === "budget") {
      return (
        <BudgetView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
        />
      );
    }

    // ── CASH SCREEN ─────────────────────────────────────────────────────────────
    if (activeNav === "cash") {
      return (
        <CashEditView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
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
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          isAdmin={isAdmin}
        />
      );
    }

    // ── JOBS SCREEN ─────────────────────────────────────────────────────────────
    if (activeNav === "jobs") {
      return (
        <JobsView
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          initialClient={editStickyClient}
          onSelectClient={setEditStickyClient}
          isAdmin={isAdmin}
        />
      );
    }

    // ── INTEGRATIONS SCREEN ─────────────────────────────────────────────────
    if (activeNav === "integrations") {
      return (
        <IntegrationsView
          allOutgoingsClients={allOutgoingsClients}
          user={user}
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          onStatusRefresh={handleIntegrationsStatusRefresh}
        />
      );
    }

    // ── SETUP SCREEN ─────────────────────────────────────────────────────────
    if (activeNav === "setup") {
      return (
        <SetupView
          allOutgoingsClients={allOutgoingsClients}
          initialClientName={managedClient ? managedClient.clientName : setupClientName}
          onSelectClient={setSetupClientName}
          onGoToBudget={handleNavBudget}
          user={user}
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
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
          isAdmin={isAdmin}
          user={user}
          managedClient={managedClient}
          initialClientName={managedClient ? managedClient.clientName : settingsClientName}
          initialSection={settingsSection}
          initialSubsection={settingsSubsection}
          onSelectClient={(cName) => setSettingsClientName(cName || "")}
          onRegisterNavGuard={registerNavGuard}
        />
      );
    }

    // ── VIEWS SCREEN ────────────────────────────────────────────────────────────
    if (activeNav === "views") {
      return (
        <ViewsScreen
          allClients={allOutgoingsClients}
          styles={styles}
          isAdmin={isAdmin}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
          activeTab={activeViewTab}
          onSelectTab={setActiveViewTab}
          initialClient={viewsStickyClient}
          onSelectClient={setViewsStickyClient}
        />
      );
    }

    // ── ACTIVITY / APP LOG SCREEN ──────────────────────────────────────────────
    if (activeNav === "activity" || activeNav === "appLog") {
      return (
        <ActivityView
          automationCommanderSheetId={automationCommanderSheetId}
          allOutgoingsClients={allOutgoingsClients}
          styles={styles}
          isAdmin={isAdmin}
          user={user}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
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
          isAdmin={isAdmin}
          user={user}
          managedClient={managedClient}
          onClearManagedClient={handleClearManagedClient}
        />
      );
    }

    // ── DEFAULT FALLBACK SCREEN ─────────────────────────────────────────────────
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Pulse Management Area</h1>
          <p style={styles.subtitle}>{isLoading ? "Loading..." : error ? error : "Initialising..."}</p>
        </div>
        {error && <div style={styles.errorBanner}>{error}</div>}
        {isLoading && (
          <div style={{ textAlign: "center", padding: "40px" }}>
            <Spinner size={28} color="#0066cc" />
            <div style={{ marginTop: "12px", color: "#666" }}>Loading data...</div>
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
        activeViewTab={activeViewTab}
        onSelectViewTab={handleNavViews}
        onHome={handleNavHome}
        onAlerts={handleNavAlerts}
        onOverview={handleNavOverview}
        onTasks={handleNavTasks}
        onActivity={handleNavActivity}
        onAppLog={handleNavAppLog}
        onOutgoings={handleNavOutgoings}
        onInvoices={handleNavInvoices}
        onRetainers={handleNavRetainers}
        onJobs={handleNavJobs}
        onSalaries={handleNavSalaries}
        onExpenses={handleNavExpenses}
        onNBToFind={handleNavNBToFind}
        onBudget={handleNavBudget}
        onCash={handleNavCash}
        onViews={handleNavViews}
        onTools={handleNavTools}
        onIntegrations={handleNavIntegrations}
        onSetup={handleNavSetup}
        onSettings={handleNavSettings}
        homeAlertCount={managedClient ? (managedClientAlertCount ?? 0) : (triageEngine.triageComplete ? currentLiveAlertCount : (cachedAlertCount || currentLiveAlertCount))}
        taskCount={navTaskCount}
        integrationsCount={integrationsAttentionCount}
        user={user}
        onLogout={logout}
        clients={allOutgoingsClients}
        managedClient={managedClient}
        isSingleClientUser={isSingleClientUser}
        singleClient={singleClient}
        onSelectManagedClient={(c) => navigateWithGuard(() => setManagedClient(c))}
        onClearManagedClient={() => navigateWithGuard(() => handleClearManagedClient())}
        onBeforeNavigateToPulse={(proceed) => navigateWithGuard(() => { fireOutgoingsPullIfPending(); proceed(); })}
      >
        {renderActiveView()}
        {alertAssignOverlay && (
          <div
            className="pma-assign-overlay-backdrop"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 950,
              backgroundColor: "rgba(15, 23, 42, 0.58)",
              backdropFilter: "blur(3px)",
              WebkitBackdropFilter: "blur(3px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              boxSizing: "border-box",
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                handleCloseAlertAssignOverlay();
              }
            }}
          >
            <style>{`
              @media (max-width: 640px) {
                .pma-assign-overlay-backdrop {
                  padding: 0 !important;
                }
                .pma-assign-overlay-dialog {
                  width: 100vw !important;
                  height: 100vh !important;
                  max-height: 100vh !important;
                  border-radius: 0 !important;
                }
              }
            `}</style>
            <div
              className="pma-assign-overlay-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={alertAssignOverlay.mode === "invoices" ? "Assign invoices" : "Assign expenses"}
              style={{
                width: "min(96vw, 1680px)",
                height: "92vh",
                maxHeight: "92vh",
                backgroundColor: "#f8fafc",
                borderRadius: "14px",
                boxShadow: "0 25px 60px -12px rgba(15, 23, 42, 0.45), 0 0 0 1px rgba(15, 23, 42, 0.08)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Modal sticky top header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "14px 24px",
                  backgroundColor: "#ffffff",
                  borderBottom: "1px solid #e2e8f0",
                  flexShrink: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", minWidth: 0 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "32px",
                      height: "32px",
                      borderRadius: "8px",
                      backgroundColor: "#eff6ff",
                      color: "#0047AB",
                      flexShrink: 0,
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {alertAssignOverlay.mode === "invoices" ? (
                        <>
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                        </>
                      ) : (
                        <>
                          <rect x="2" y="5" width="20" height="14" rx="2" />
                          <line x1="2" y1="10" x2="22" y2="10" />
                        </>
                      )}
                    </svg>
                  </span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                    <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                      {alertAssignOverlay.mode === "invoices" ? "Assign invoices" : "Assign expenses"}
                    </h2>
                    {alertAssignOverlay.client?.clientName && (
                      <span
                        style={{
                          fontSize: "13px",
                          fontWeight: 600,
                          color: "#0047AB",
                          backgroundColor: "#eff6ff",
                          border: "1px solid #bfdbfe",
                          padding: "2px 10px",
                          borderRadius: "999px",
                        }}
                      >
                        {alertAssignOverlay.client.clientName}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={handleCloseAlertAssignOverlay}
                    style={{
                      padding: "7px 16px",
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "#ffffff",
                      backgroundColor: "#0047AB",
                      border: "none",
                      borderRadius: "7px",
                      cursor: "pointer",
                      boxShadow: "0 1px 2px rgba(0, 71, 171, 0.2)",
                    }}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseAlertAssignOverlay}
                    title="Close and return to alerts"
                    aria-label="Close modal"
                    style={{
                      width: "34px",
                      height: "34px",
                      borderRadius: "8px",
                      border: "1px solid #cbd5e1",
                      backgroundColor: "#ffffff",
                      color: "#475569",
                      fontSize: "18px",
                      lineHeight: 1,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Modal scrollable workspace body */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  overflowX: "hidden",
                  position: "relative",
                }}
              >
                {(() => {
                  const overlayClient = resolveFullClient(alertAssignOverlay.client);
                  return alertAssignOverlay.mode === "invoices" ? (
                    <InvoicesView
                      allOutgoingsClients={allOutgoingsClients}
                      styles={styles}
                      isAdmin={isAdmin}
                      managedClient={overlayClient}
                      initialClient={overlayClient}
                      isModalOverlay={true}
                    />
                  ) : (
                    <OutgoingsView
                      allOutgoingsClients={allOutgoingsClients}
                      styles={styles}
                      isAdmin={isAdmin}
                      managedClient={overlayClient}
                      initialClient={overlayClient}
                      isModalOverlay={true}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </NavShell>
    </TriageProvider>
  );
}

export async function getServerSideProps() {
  return {
    redirect: {
      destination: "/pma",
      permanent: false,
    },
  };
}