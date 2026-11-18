import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "../../hooks/useAuth";
import AuthGateView from "../../components/AuthGateView";
import PortalShell from "../../components/portal/PortalShell";
import MonthView from "../../components/portal/MonthView";
import PerformanceFYView from "../../components/portal/PerformanceFYView";
import PerformanceYTDView from "../../components/portal/PerformanceYTDView";
import PerformanceBreakdownView from "../../components/portal/PerformanceBreakdownView";
import CashflowView from "../../components/portal/CashflowView";
import CashflowBreakdownView from "../../components/portal/CashflowBreakdownView";
import PortalJobsView from "../../components/portal/PortalJobsView";
import PortalOutgoingsView from "../../components/portal/PortalOutgoingsView";
import PortalSalariesView from "../../components/portal/PortalSalariesView";
import PortalNBToFindView from "../../components/portal/PortalNBToFindView";
import BudgetView from "../../components/portal/BudgetView";
import BudgetVarianceView from "../../components/portal/BudgetVarianceView";
import ScenariosView from "../../components/portal/ScenariosView";
import {
  MonthViewSkeleton
} from "../../components/Skeleton";
import CompanyChooser from "../../components/portal/CompanyChooser";
import SetupHoldingGate from "../../components/portal/SetupHoldingGate";
import Spinner from "../../components/Spinner";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function PortalPage({
  initialUser = null,
  initialSetupClient = null,
  initialSetupStatus = null,
  initialClients = null,
  initialSelectedClient = null,
  initialPayload = null,
  initialPerformanceData = null
}) {
  const router = useRouter();
  const auth = useAuth(initialUser);
  const { isAuthenticated, authChecking, user, logout } = auth;

  // Read instant client-side handoff from PMA NavShell (never present during SSR HTML hydration)
  const navHandoffRef = useRef(undefined);
  if (navHandoffRef.current === undefined) {
    if (typeof window !== "undefined" && window.__PULSE_PORTAL_HANDOFF__) {
      const h = window.__PULSE_PORTAL_HANDOFF__;
      const isFresh = Boolean(h.timestamp && Date.now() - h.timestamp < 30000);
      const urlParams = new URLSearchParams(window.location.search);
      const isChoose = router.query.choose === "true" || urlParams.get("choose") === "true";
      const queryClient =
        (typeof router.query.client === "string" && router.query.client) ||
        urlParams.get("client") ||
        "";
      const matchesClient =
        !queryClient ||
        !h.client?.clientName ||
        String(h.client.clientName).trim().toLowerCase() === String(queryClient).trim().toLowerCase();
      navHandoffRef.current = isFresh && !isChoose && matchesClient ? h : null;
    } else {
      navHandoffRef.current = null;
    }
  }
  const navHandoff = navHandoffRef.current;

  const baseSsrClient = initialSetupClient || initialSelectedClient || initialUser?.initialSetupClient || null;
  const ssrActiveClient =
    baseSsrClient &&
    !baseSsrClient.clientSheetId &&
    navHandoff?.client?.clientSheetId &&
    String(baseSsrClient.clientName || "").trim().toLowerCase() ===
      String(navHandoff.client.clientName || "").trim().toLowerCase()
      ? { ...navHandoff.client, ...baseSsrClient, clientSheetId: navHandoff.client.clientSheetId }
      : baseSsrClient || navHandoff?.client || null;

  const [clients, setClients] = useState(() => {
    if (Array.isArray(initialClients) && initialClients.length > 0) return initialClients;
    if (Array.isArray(navHandoff?.clients) && navHandoff.clients.length > 0) return navHandoff.clients;
    return [];
  });
  const [selectedClient, setSelectedClient] = useState(() => ssrActiveClient);
  const selectedClientRef = useRef(selectedClient);
  selectedClientRef.current = selectedClient;
  const [clientsLoaded, setClientsLoaded] = useState(() => Boolean(Array.isArray(initialClients) && initialClients.length > 0));
  const clientsFetchedRef = useRef(Boolean(Array.isArray(initialClients) && initialClients.length > 0));
  const lastLoggedClientRef = useRef(null);
  const activeClientSheetIdRef = useRef(ssrActiveClient?.clientSheetId || null);
  const [activeView, setActiveView] = useState("month");

  // Setup Mode & Tool Connection State
  const [setupStatus, setSetupStatus] = useState(
    () => initialSetupStatus || initialUser?.initialSetupStatus || null
  );
  const [loadingSetupStatus, setLoadingSetupStatus] = useState(false);
  const [isPreviewSetup, setIsPreviewSetup] = useState(false);
  const [oauthFeedback, setOauthFeedback] = useState(null);
  const [oauthEvent, setOauthEvent] = useState(null);

  // Immediately hydrate setup client & status when user logs in via OTP on client side
  useEffect(() => {
    if (user?.initialSetupClient && !selectedClient) {
      setSelectedClient(user.initialSetupClient);
    }
    if (user?.initialSetupStatus && !setupStatus) {
      setSetupStatus(user.initialSetupStatus);
    }
  }, [user, selectedClient, setupStatus]);

  // Monitor URL for ?preview=setup or OAuth return params (?integration=...&status=...)
  useEffect(() => {
    const isPreview = router.query.preview === "setup" || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "setup");
    if (isPreview) {
      setIsPreviewSetup(true);
    }
    const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const tool = router.query.integration || router.query.tool || searchParams?.get("integration") || searchParams?.get("tool");
    if (tool) {
      const status = router.query.status || searchParams?.get("status");
      const modalParam = router.query.modal || searchParams?.get("modal");
      const accountParam = router.query.account || router.query.tenant || searchParams?.get("account") || searchParams?.get("tenant") || "";
      const messageParam = router.query.message || router.query.error_description || router.query.error || searchParams?.get("message") || searchParams?.get("error_description") || searchParams?.get("error") || "";
      const urlParam = router.query.url || searchParams?.get("url") || "";
      setOauthEvent({
        tool: String(tool),
        status: status ? String(status) : "",
        modal: modalParam ? String(modalParam) : "",
        account: String(accountParam),
        message: String(messageParam),
        url: String(urlParam)
      });
      const isGoogleSheetPickerReturn = String(tool).toLowerCase() === "googlesheet" && (status === "oauth_authorized" || modalParam === "picker");
      if (isGoogleSheetPickerReturn) {
        // Handled directly inside SetupHoldingGate / PortalShell by reopening GoogleSheetLinkModal and launching the Google Picker
      } else if (status === "success") {
        setOauthFeedback({
          type: "success",
          message: `Thanks for connecting ${String(tool)}. Pulse is still in setup mode.`
        });
      } else if (status === "denied") {
        setOauthFeedback({
          type: "warning",
          message: `Authorisation for ${String(tool)} was cancelled. No changes were made to your account. You can connect ${String(tool)} whenever you're ready.`
        });
      } else if (status === "error" || router.query.error) {
        setOauthFeedback({
          type: "error",
          message: `Connection to ${String(tool)} could not be completed. Please try again or contact Pulse support.`
        });
      }
    }
  }, [router.query]);

  // Keep activeClientSheetIdRef in sync with selectedClient
  useEffect(() => {
    activeClientSheetIdRef.current = selectedClient?.clientSheetId || null;
  }, [selectedClient]);

  // View state from URL query with alias normalization
  useEffect(() => {
    if (router.query.view) {
      const raw = String(router.query.view);
      const v = raw.toLowerCase().trim();
      const aliasMap = {
        breakdown: "perfBreakdown",
        perfbreakdown: "perfBreakdown",
        performancebreakdown: "perfBreakdown",
        cashflow: "cash",
        forecast: "cash",
        cashbreakdown: "cashBreakdown",
        cashbreakdowns: "cashBreakdown",
        outgoings: "expenses",
        "budget-overview": "viewBudget",
        budgetoverview: "viewBudget",
        viewbudget: "viewBudget",
        "budget-variance": "budgetVariance",
        budgetvariance: "budgetVariance",
        scenario: "scenarios",
        scenarioplanning: "scenarios",
        fy: "dashboard",
        financialyear: "dashboard",
      };
      setActiveView(aliasMap[v] || raw);
    }
  }, [router.query.view]);

  // Month View live payload state (hydrated from SSR when available)
  const [payload, setPayload] = useState(() => initialPayload || null);
  const [loadingPayload, setLoadingPayload] = useState(false);
  const [payloadError, setPayloadError] = useState(null);

  // Performance Views data state (FY, YTD, Breakdowns - hydrated from SSR when available)
  const [performanceData, setPerformanceData] = useState(() =>
    initialPerformanceData && ssrActiveClient?.clientSheetId
      ? { ...initialPerformanceData, clientSheetId: ssrActiveClient.clientSheetId }
      : initialPerformanceData || null
  );
  const [loadingPerformance, setLoadingPerformance] = useState(false);
  const [perfError, setPerfError] = useState(null);

  // Cashflow Views data state (Forecast, Breakdowns)
  const [cashflowData, setCashflowData] = useState(null);
  const [loadingCashflow, setLoadingCashflow] = useState(false);
  const [cashError, setCashError] = useState(null);

  // Key Data Views data state (Jobs, Contractors, Expenses, Salaries, Dividends, NBtoFind)
  const [keyData, setKeyData] = useState(null);
  const [loadingKeyData, setLoadingKeyData] = useState(false);
  const [keyDataError, setKeyDataError] = useState(null);

  // Budget Views data state (Budget Overview, Budget Variance)
  const [budgetData, setBudgetData] = useState(null);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [budgetError, setBudgetError] = useState(null);

  const inFlightPayloadRef = useRef(false);

  const fetchPayload = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (client.clientSheetId !== activeClientSheetIdRef.current) return;
    inFlightPayloadRef.current = true;
    if (!isSilent) {
      setLoadingPayload(true);
      setPayloadError(null);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `/api/portal/payload?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true${isSilent ? "&autoRefresh=true" : ""}&_t=${Date.now()}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server returned error (${res.status})`);
        throw jsonErr;
      }
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      if (data.success && data.payload) {
        setPayload(data.payload);
        if (data.performanceData) {
          setPerformanceData({ ...data.performanceData, clientSheetId: client.clientSheetId });
        }
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load client data");
      }
    } catch (err) {
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      console.error("Payload fetch error:", err);
      if (!isSilent) {
        setPayloadError(err.name === "AbortError" ? "Request timed out" : (err.message || "Failed to load dashboard data"));
      }
    } finally {
      clearTimeout(timeoutId);
      inFlightPayloadRef.current = false;
      if (!isSilent) {
        setLoadingPayload(false);
      }
    }
  }, []);

  // Keep latest data & loading refs for background preloading without restarting timers on state updates
  const dataStateRef = useRef({});
  dataStateRef.current = {
    selectedClient,
    payload,
    performanceData,
    loadingPerformance,
    keyData,
    loadingKeyData,
    cashflowData,
    loadingCashflow,
    budgetData,
    loadingBudget,
  };

  const lastFetchedPayloadSheetIdRef = useRef(
    initialPayload && ssrActiveClient?.clientSheetId ? ssrActiveClient.clientSheetId : null
  );
  const ssrSilentRevalidatedRef = useRef(false);
  useEffect(() => {
    const sheetId = selectedClient?.clientSheetId || null;
    if (!sheetId) {
      lastFetchedPayloadSheetIdRef.current = null;
      return;
    }
    // Skip dashboard payload fetch for ClientUser when client is in setupMode
    const isClientOnly = Boolean(
      user && !(!user.isReadOnly && (user.isAdmin || user.role === "Admin" || user.role === "ClientManager"))
    );
    if (isClientOnly && (selectedClient?.setupMode === true || setupStatus?.setupMode === true)) {
      return;
    }
    if (lastFetchedPayloadSheetIdRef.current !== sheetId) {
      lastFetchedPayloadSheetIdRef.current = sheetId;
      setPayload(null);
      setPerformanceData(null);
      setCashflowData(null);
      setKeyData(null);
      setBudgetData(null);
      fetchPayload(selectedClient, false);
    } else if (!ssrSilentRevalidatedRef.current && initialPayload) {
      ssrSilentRevalidatedRef.current = true;
      const cachedAtMs = initialPayload._cachedAt ? new Date(initialPayload._cachedAt).getTime() : 0;
      if (!cachedAtMs || Date.now() - cachedAtMs > 60000 || !performanceData) {
        fetchPayload(selectedClient, false, true);
      }
    }
  }, [selectedClient, fetchPayload, user, setupStatus?.setupMode, initialPayload, performanceData]);

  const fetchPerformance = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (client.clientSheetId !== activeClientSheetIdRef.current) return;
    if (!isSilent) {
      setLoadingPerformance(true);
      setPerfError(null);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `/api/portal/performance?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true${isSilent ? "&autoRefresh=true" : ""}&_t=${Date.now()}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server returned error (${res.status})`);
        throw jsonErr;
      }
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      if (data.success && data.data) {
        setPerformanceData({ ...data.data, clientSheetId: client.clientSheetId });
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load performance data");
      }
    } catch (err) {
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      console.error("Performance fetch error:", err);
      if (!isSilent) {
        setPerfError(err.name === "AbortError" ? "Request timed out" : (err.message || "Failed to load performance data"));
      }
    } finally {
      clearTimeout(timeoutId);
      if (!isSilent) {
        setLoadingPerformance(false);
      }
    }
  }, []);

  // Fetch performance data when switching to a performance view or budget view (for actuals), or home view (if payload didn't bundle it)
  useEffect(() => {
    if (["dashboard", "ytd", "perfBreakdown", "scenarios", "viewBudget", "budgetVariance"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!performanceData && !loadingPerformance) {
        fetchPerformance(selectedClient, false);
      }
    } else if (activeView === "month" && selectedClient?.clientSheetId) {
      if (payload && !loadingPayload && !inFlightPayloadRef.current && !performanceData && !loadingPerformance) {
        const timer = setTimeout(() => {
          if (!inFlightPayloadRef.current && !dataStateRef.current.performanceData && !dataStateRef.current.loadingPerformance) {
            fetchPerformance(selectedClient, false);
          }
        }, 250);
        return () => clearTimeout(timer);
      }
    }
  }, [activeView, selectedClient, payload, loadingPayload, performanceData, loadingPerformance, fetchPerformance]);

  const fetchCashflow = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (client.clientSheetId !== activeClientSheetIdRef.current) return;
    if (!isSilent) {
      setLoadingCashflow(true);
      setCashError(null);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `/api/portal/cash?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true${isSilent ? "&autoRefresh=true" : ""}&_t=${Date.now()}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server returned error (${res.status})`);
        throw jsonErr;
      }
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      if (data.success && data.data) {
        setCashflowData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load cashflow data");
      }
    } catch (err) {
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      console.error("Cashflow fetch error:", err);
      if (!isSilent) {
        setCashError(err.name === "AbortError" ? "Request timed out" : (err.message || "Failed to load cashflow data"));
      }
    } finally {
      clearTimeout(timeoutId);
      if (!isSilent) {
        setLoadingCashflow(false);
      }
    }
  }, []);

  // Fetch cashflow data when switching to a cash view
  useEffect(() => {
    if (["cash", "cashBreakdown"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!cashflowData && !loadingCashflow) {
        fetchCashflow(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, cashflowData, loadingCashflow, fetchCashflow]);

  const fetchKeyData = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (client.clientSheetId !== activeClientSheetIdRef.current) return;
    if (!isSilent) {
      setLoadingKeyData(true);
      setKeyDataError(null);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const url = `/api/portal/key-data?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true${isSilent ? "&autoRefresh=true" : ""}&_t=${Date.now()}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server returned error (${res.status})`);
        throw jsonErr;
      }
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      if (data.success && data.data) {
        setKeyData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load key data");
      }
    } catch (err) {
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      console.error("Key data fetch error:", err);
      if (!isSilent) {
        setKeyDataError(err.name === "AbortError" ? "Request timed out" : (err.message || "Failed to load key data"));
      }
    } finally {
      clearTimeout(timeoutId);
      if (!isSilent) {
        setLoadingKeyData(false);
      }
    }
  }, []);

  // Fetch key data when switching to any key data view
  useEffect(() => {
    if (
      ["jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind", "cashBreakdown", "scenarios", "perfBreakdown"].includes(activeView) &&
      selectedClient?.clientSheetId
    ) {
      if (!keyData && !loadingKeyData) {
        fetchKeyData(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, keyData, loadingKeyData, fetchKeyData]);

  const handleRefreshPayload = () => {
    if (selectedClient) {
      fetchPayload(selectedClient, true);
      fetchKeyData(selectedClient, true);
    }
  };

  const handleRefreshPerformance = () => {
    if (selectedClient) {
      fetchPerformance(selectedClient, true);
      fetchKeyData(selectedClient, true);
    }
  };

  const handleRefreshCashflow = () => {
    if (selectedClient) {
      fetchCashflow(selectedClient, true);
      fetchKeyData(selectedClient, true);
    }
  };

  const handleRefreshKeyData = () => {
    if (selectedClient) {
      fetchKeyData(selectedClient, true);
    }
  };

  const fetchBudget = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (client.clientSheetId !== activeClientSheetIdRef.current) return;
    if (!isSilent) {
      setLoadingBudget(true);
      setBudgetError(null);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const url = `/api/portal/budget?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true${isSilent ? "&autoRefresh=true" : ""}&_t=${Date.now()}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server returned error (${res.status})`);
        throw jsonErr;
      }
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      if (data.success && data.data) {
        setBudgetData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load budget data");
      }
    } catch (err) {
      if (client.clientSheetId !== activeClientSheetIdRef.current) return;
      console.error("Budget fetch error:", err);
      if (!isSilent) {
        setBudgetError(err.name === "AbortError" ? "Request timed out" : (err.message || "Failed to load budget data"));
      }
    } finally {
      clearTimeout(timeoutId);
      if (!isSilent) {
        setLoadingBudget(false);
      }
    }
  }, []);

  // Fetch budget when switching to viewBudget or budgetVariance
  useEffect(() => {
    if (["viewBudget", "budgetVariance"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!budgetData && !loadingBudget) {
        fetchBudget(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, budgetData, loadingBudget, fetchBudget]);

  // For Scenarios, we ensure both performance and key data are loaded
  useEffect(() => {
    if (activeView === "scenarios" && selectedClient?.clientSheetId) {
      if (!performanceData && !loadingPerformance) fetchPerformance(selectedClient, false);
      if (!keyData && !loadingKeyData) fetchKeyData(selectedClient, false);
    }
  }, [activeView, selectedClient, performanceData, loadingPerformance, keyData, loadingKeyData, fetchPerformance, fetchKeyData]);

  // Background preloading queue: ONLY after the Pulse Home Page (payload + performanceData) has 100% finished
  // loading, preload secondary sections with generous idle spacing so Home Page speed is never contested.
  const hasHomeFullyLoaded = Boolean(payload && performanceData && !loadingPayload && !loadingPerformance);
  const currentClientSheetId = selectedClient?.clientSheetId || null;
  useEffect(() => {
    if (!hasHomeFullyLoaded || !currentClientSheetId) return;

    const t2 = setTimeout(() => {
      const s = dataStateRef.current;
      if (s.selectedClient?.clientSheetId !== currentClientSheetId) return;
      if (!s.keyData && !s.loadingKeyData) {
        fetchKeyData(s.selectedClient, false, true);
      }
    }, 2500);

    const t3 = setTimeout(() => {
      const s = dataStateRef.current;
      if (s.selectedClient?.clientSheetId !== currentClientSheetId) return;
      if (!s.cashflowData && !s.loadingCashflow) {
        fetchCashflow(s.selectedClient, false, true);
      }
    }, 5000);

    const t4 = setTimeout(() => {
      const s = dataStateRef.current;
      if (s.selectedClient?.clientSheetId !== currentClientSheetId) return;
      const clientHasBudget = Boolean(s.payload?.clientInfo?.hasBudget ?? s.payload?.hasBudget);
      if (clientHasBudget && !s.budgetData && !s.loadingBudget) {
        fetchBudget(s.selectedClient, false, true);
      }
    }, 7500);

    return () => {
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [hasHomeFullyLoaded, currentClientSheetId, fetchKeyData, fetchCashflow, fetchBudget]);

  const handleRefreshBudget = () => {
    if (selectedClient) {
      fetchBudget(selectedClient, true);
      fetchPerformance(selectedClient, true);
      fetchKeyData(selectedClient, true);
    }
  };

  // 60-Second Background Auto-Refresh (matching original GAS WebApp REFRESH_INTERVAL = 60000)
  // Pauses background polling when browser tab is hidden/minimized and refreshes immediately on refocus
  const lastAutoRefreshAtRef = useRef(Date.now());
  useEffect(() => {
    if (!selectedClient?.clientSheetId) return;
    lastAutoRefreshAtRef.current = Date.now();

    const triggerSilentRefresh = () => {
      lastAutoRefreshAtRef.current = Date.now();
      fetchPayload(selectedClient, true, true);

      if (["dashboard", "ytd", "perfBreakdown", "scenarios"].includes(activeView)) {
        fetchPerformance(selectedClient, true, true);
      }
      if (["cash", "cashBreakdown"].includes(activeView)) {
        fetchCashflow(selectedClient, true, true);
      }
      if (["month", "dashboard", "ytd", "cash", "jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind", "cashBreakdown", "scenarios", "perfBreakdown"].includes(activeView)) {
        fetchKeyData(selectedClient, true, true);
      }
      if (["viewBudget", "budgetVariance"].includes(activeView)) {
        fetchBudget(selectedClient, true, true);
      }
    };

    const intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      triggerSilentRefresh();
    }, 60000);

    const handleVisibilityChange = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        Date.now() - lastAutoRefreshAtRef.current >= 60000
      ) {
        triggerSilentRefresh();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [selectedClient, activeView, fetchPayload, fetchPerformance, fetchCashflow, fetchKeyData, fetchBudget]);

  // Clear one-shot PMA -> Pulse handoff once mounted, and clear skeleton epoch once payload renders
  useEffect(() => {
    if (typeof window !== "undefined" && window.__PULSE_PORTAL_HANDOFF__) {
      delete window.__PULSE_PORTAL_HANDOFF__;
    }
  }, []);

  useEffect(() => {
    if (payload && typeof window !== "undefined" && window.__PULSE_SKELETON_T0__) {
      delete window.__PULSE_SKELETON_T0__;
    }
  }, [payload]);

  // Pre-paint localStorage hydration of authorized clients list if SSR & handoff both missed
  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated || clients.length > 0) return;
    try {
      const raw =
        localStorage.getItem("pulse_portal_clients_cache") ||
        localStorage.getItem("pulse_cached_all_clients");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const isSysAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
      const filtered = parsed.filter((c) => {
        if (!c?.clientName || !c?.clientSheetId) return false;
        if (!isSysAdmin && !String(c.clientSheetId).startsWith("ws_")) return false;
        if (user?.isAdmin) return true;
        return (
          Array.isArray(user?.assignedClients) &&
          user.assignedClients.some(
            (a) => String(a || "").trim().toLowerCase() === String(c.clientName || "").trim().toLowerCase()
          )
        );
      });
      if (filtered.length > 0) {
        setClients(filtered);
      }
    } catch { }
  }, [isAuthenticated, user, clients.length]);

  // Fast client restore on mount from localStorage to eliminate waterfall delay
  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) return;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      if (router.query.choose === "true" || urlParams.get("choose") === "true") return;
      const queryClient =
        (typeof router.query.client === "string" && router.query.client) ||
        urlParams.get("client") ||
        "";
      const savedObj = localStorage.getItem("pulse_portal_active_client_obj");
      if (savedObj) {
        const parsed = JSON.parse(savedObj);
        if (parsed?.clientSheetId) {
          const isSysAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
          if (!isSysAdmin && !String(parsed.clientSheetId).startsWith("ws_")) {
            localStorage.removeItem("pulse_portal_active_client_obj");
            return;
          }
          // Verify the logged-in user is permitted to access this cached client
          const isAuthorizedForCached = Boolean(
            user?.isAdmin ||
            (Array.isArray(user?.assignedClients) &&
              user.assignedClients.some(
                (a) => String(a || "").trim().toLowerCase() === String(parsed.clientName || "").trim().toLowerCase()
              ))
          );
          if (!isAuthorizedForCached) return;

          // Restore immediately if no explicit ?client= is in URL, OR if cached client matches ?client=
          const matchesQuery =
            !queryClient ||
            String(parsed.clientName || "").trim().toLowerCase() === String(queryClient).trim().toLowerCase();
          if (matchesQuery) {
            activeClientSheetIdRef.current = parsed.clientSheetId;
            if (parsed.setupStatus) {
              setSetupStatus((prev) => prev || parsed.setupStatus);
            }
            setSelectedClient((curr) => {
              if (!curr) {
                return parsed;
              }
              if (
                String(curr.clientName || "").trim().toLowerCase() ===
                String(parsed.clientName || "").trim().toLowerCase()
              ) {
                const nextSetupMode = Boolean(curr.setupMode ?? parsed.setupMode);
                const nextSetupStatus = curr.setupStatus || parsed.setupStatus || null;
                if (
                  curr.clientSheetId === parsed.clientSheetId &&
                  (curr.masterSheetId || "") === (parsed.masterSheetId || "") &&
                  Boolean(curr.setupMode) === nextSetupMode &&
                  curr.setupStatus === nextSetupStatus
                ) {
                  return curr;
                }
                return {
                  ...parsed,
                  ...curr,
                  clientSheetId: curr.clientSheetId || parsed.clientSheetId,
                  masterSheetId: curr.masterSheetId || parsed.masterSheetId,
                  setupMode: nextSetupMode,
                  setupStatus: nextSetupStatus
                };
              }
              if (curr.clientSheetId !== parsed.clientSheetId) {
                return parsed;
              }
              return curr;
            });
          }
        }
      }
    } catch (e) { }
  }, [isAuthenticated, user, router.query.choose, router.query.client]);

  const logWorkspaceAccess = useCallback((client) => {
    if (!client || !client.clientName) return;
    if (lastLoggedClientRef.current === client.clientName) return;
    lastLoggedClientRef.current = client.clientName;

    fetch("/api/portal/log-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: client.clientName,
        clientSheetId: client.clientSheetId,
        action: "PORTAL_ENTERED"
      })
    }).catch(() => { });
  }, []);

  // Fetch authorized clients for portal
  useEffect(() => {
    if (!isAuthenticated) {
      clientsFetchedRef.current = false;
      setClientsLoaded(false);
      setClients([]);
      setSelectedClient(null);
      return;
    }

    if (clientsFetchedRef.current) return;

    let isMounted = true;

    fetch("/api/portal/clients")
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.success && Array.isArray(data.clients)) {
          setClients(data.clients);
          clientsFetchedRef.current = true;
          try {
            localStorage.setItem("pulse_portal_clients_cache", JSON.stringify(data.clients));
          } catch { }

          // Check if client specified in legacy URL query or localStorage
          let queryClient = router.query.client;
          if (!queryClient && typeof window !== "undefined") {
            const urlParams = new URLSearchParams(window.location.search);
            queryClient = urlParams.get("client");
          }
          let initial = null;
          const currentSelected = selectedClientRef.current;

          const isChooseRequested = router.query.choose === "true" || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("choose") === "true");
          const isPulseOnly = Boolean(
            user && (user.role === "ClientUser" || user.role === "Senior (Restricted)" || user.isSenior) && !user.isAdmin
          );

          if (data.clients.length === 1) {
            // Single company: take directly to their company's Pulse app
            initial = data.clients[0];
          } else if (data.clients.length > 1) {
            if (isChooseRequested) {
              initial = null;
            } else {
              // Priority 1: Check query client FIRST! An explicit URL parameter takes precedence over previous cached selection
              if (queryClient) {
                initial = data.clients.find(
                  (c) => c.clientName.toLowerCase() === String(queryClient).toLowerCase()
                );
              }
              // Priority 2: Match currently selected client (e.g. from fast restore or SSR setup hydration)
              if (!initial && (currentSelected?.clientSheetId || currentSelected?.clientName)) {
                initial = data.clients.find(
                  (c) =>
                    (currentSelected.clientSheetId && c.clientSheetId === currentSelected.clientSheetId) ||
                    c.clientName?.toLowerCase() === currentSelected.clientName?.toLowerCase()
                );
              }
              // Priority 3: Check localStorage
              if (!initial && typeof window !== "undefined") {
                const saved = localStorage.getItem("pulse_portal_client");
                if (saved) {
                  initial = data.clients.find(
                    (c) => c.clientName.toLowerCase() === saved.toLowerCase()
                  );
                }
              }
              // Priority 4: For internal staff without a prior selection, default to APPTEST or first client
              if (!initial && !isPulseOnly) {
                initial =
                  data.clients.find((c) => c.clientName.toUpperCase() === "APPTEST") ||
                  data.clients[0] ||
                  null;
              }
            }
          }

          if (initial?.setupStatus) {
            setSetupStatus((prev) => prev || initial.setupStatus);
          }
          setSelectedClient((curr) => {
            if (
              curr &&
              initial &&
              curr.clientSheetId === initial.clientSheetId &&
              Boolean(curr.setupMode) === Boolean(initial.setupMode) &&
              (curr.masterSheetId || "") === (initial.masterSheetId || "") &&
              !initial.setupStatus
            ) {
              return curr;
            }
            return initial;
          });
          if (initial && typeof window !== "undefined") {
            localStorage.setItem("pulse_portal_client", initial.clientName);
            localStorage.setItem("pulse_portal_active_client_obj", JSON.stringify(initial));
            document.cookie = `pulse_portal_client=${encodeURIComponent(initial.clientName)}; path=/; max-age=31536000; SameSite=Lax`;
          }
          if (initial) {
            logWorkspaceAccess(initial);
          }
        }
      })
      .catch((err) => {
        console.error("Failed to load portal clients:", err);
      })
      .finally(() => {
        if (isMounted) {
          setClientsLoaded(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, router.query.client, router.query.choose, user, logWorkspaceAccess]);

  const handleSelectClient = useCallback((client) => {
    if (client?.clientSheetId && client.clientSheetId === selectedClient?.clientSheetId) {
      return;
    }
    activeClientSheetIdRef.current = client?.clientSheetId || null;
    if (client?.setupStatus) {
      setSetupStatus(client.setupStatus);
    } else if (!client?.setupMode) {
      setSetupStatus({ setupMode: false });
    } else {
      setSetupStatus(null);
    }
    setSelectedClient(client);

    // Synchronously clear previous client's data to eliminate any stale charts/sparklines flashing
    setPayload(null);
    setLoadingPayload(false);
    setPayloadError(null);

    setPerformanceData(null);
    setLoadingPerformance(false);
    setPerfError(null);

    setCashflowData(null);
    setLoadingCashflow(false);
    setCashError(null);

    setKeyData(null);
    setLoadingKeyData(false);
    setKeyDataError(null);

    setBudgetData(null);
    setLoadingBudget(false);
    setBudgetError(null);

    if (client) {
      if (typeof window !== "undefined") {
        localStorage.setItem("pulse_portal_client", client.clientName);
        localStorage.setItem("pulse_portal_active_client_obj", JSON.stringify(client));
        document.cookie = `pulse_portal_client=${encodeURIComponent(client.clientName)}; path=/; max-age=31536000; SameSite=Lax`;
      }
      logWorkspaceAccess(client);
    } else {
      lastLoggedClientRef.current = null;
      if (typeof window !== "undefined") {
        localStorage.removeItem("pulse_portal_client");
        localStorage.removeItem("pulse_portal_active_client_obj");
        document.cookie = "pulse_portal_client=; path=/; max-age=0; SameSite=Lax";
      }
    }
    // Clean URL: Keep URL as clean /pulse using history.replaceState to avoid Next.js router navigation side-effects
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      if (p.has("client") || p.has("choose")) {
        p.delete("client");
        p.delete("choose");
        const qs = p.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
      }
    }
  }, [selectedClient, logWorkspaceAccess]);

  // Clean URL: Strip any legacy ?client=... or ?choose=... so the address bar stays clean (/pulse)
  useEffect(() => {
    // Only clean URL once clients have actually finished loading and selection is settled!
    if (!clientsLoaded || typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (p.has("client") || p.has("choose")) {
      p.delete("client");
      p.delete("choose");
      const qs = p.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, [clientsLoaded]);

  // Handle in-page client parameter updates (e.g. shallow router changes or preview links)
  useEffect(() => {
    if (!clientsLoaded || !router.query.client || clients.length === 0) return;
    const target = clients.find(
      (c) => c.clientName.toLowerCase() === String(router.query.client).toLowerCase()
    );
    if (target && target.clientSheetId !== selectedClient?.clientSheetId) {
      handleSelectClient(target);
    }
  }, [clientsLoaded, router.query.client, clients, selectedClient, handleSelectClient]);

  const handleLogout = async () => {
    activeClientSheetIdRef.current = null;
    clientsFetchedRef.current = false;
    lastLoggedClientRef.current = null;
    setClientsLoaded(false);
    setSelectedClient(null);
    setPayload(null);
    setLoadingPayload(false);
    setPayloadError(null);
    setPerformanceData(null);
    setLoadingPerformance(false);
    setPerfError(null);
    setCashflowData(null);
    setLoadingCashflow(false);
    setCashError(null);
    setKeyData(null);
    setLoadingKeyData(false);
    setKeyDataError(null);
    setBudgetData(null);
    setLoadingBudget(false);
    setBudgetError(null);
    setClients([]);
    if (typeof window !== "undefined") {
      localStorage.removeItem("pulse_portal_client");
      localStorage.removeItem("pulse_portal_active_client_obj");
      document.cookie = "pulse_portal_client=; path=/; max-age=0; SameSite=Lax";
    }
    await logout();
  };

  const refreshSetupStatus = useCallback(async () => {
    if (!selectedClient?.clientName) return null;
    try {
      const res = await fetch(
        `/api/setup/status?clientName=${encodeURIComponent(selectedClient.clientName)}&masterSheetId=${encodeURIComponent(selectedClient.masterSheetId || "")}&clientSheetId=${encodeURIComponent(selectedClient.clientSheetId || "")}`
      );
      const d = await res.json();
      if (d.success && d.status) {
        setSetupStatus(d.status);
        return d.status;
      }
    } catch (e) {
      console.error("Setup status refresh note:", e);
    }
    return null;
  }, [selectedClient?.clientName, selectedClient?.masterSheetId, selectedClient?.clientSheetId]);

  useEffect(() => {
    if (oauthEvent?.status === "success" && selectedClient?.clientName) {
      refreshSetupStatus();
    }
  }, [oauthEvent?.status, selectedClient?.clientName, refreshSetupStatus]);

  const lastSetupStatusClientRef = useRef(null);

  // Fetch detailed setup status (immediately for setupMode/preview, and lazily in background for live clients to populate profile menu tool indicators)
  useEffect(() => {
    if (!selectedClient?.clientName) {
      lastSetupStatusClientRef.current = null;
      setSetupStatus(null);
      return;
    }

    if (selectedClient.setupStatus && !isPreviewSetup) {
      lastSetupStatusClientRef.current = selectedClient.clientName;
      setSetupStatus(selectedClient.setupStatus);
      setLoadingSetupStatus(false);
      return;
    }

    const isLiveOnly = !selectedClient.setupMode && !isPreviewSetup;
    const clientChanged = lastSetupStatusClientRef.current !== selectedClient.clientName;
    lastSetupStatusClientRef.current = selectedClient.clientName;

    if (isLiveOnly) {
      setSetupStatus((prev) => (!clientChanged && prev?.setupMode === false ? prev : { setupMode: false }));
      setLoadingSetupStatus(false);
    } else {
      setLoadingSetupStatus(true);
    }

    let isMounted = true;
    const targetClientName = selectedClient.clientName;
    const targetMasterSheetId = selectedClient.masterSheetId || "";
    const targetClientSheetId = selectedClient.clientSheetId || "";

    const fetchSetupStatus = () => {
      fetch(`/api/setup/status?clientName=${encodeURIComponent(targetClientName)}&masterSheetId=${encodeURIComponent(targetMasterSheetId)}&clientSheetId=${encodeURIComponent(targetClientSheetId)}`)
        .then(r => r.json())
        .then(d => {
          if (isMounted && d.success && d.status) {
            setSetupStatus(d.status);
          }
        })
        .catch(e => console.error("Setup status check note:", e))
        .finally(() => {
          if (isMounted && !isLiveOnly) {
            setLoadingSetupStatus(false);
          }
        });
    };

    if (isLiveOnly) {
      // Defer slightly on live clients so initial dashboard payload/paint is never contested
      const timerId = setTimeout(fetchSetupStatus, 350);
      return () => {
        isMounted = false;
        clearTimeout(timerId);
      };
    }

    fetchSetupStatus();
    return () => { isMounted = false; };
  }, [selectedClient?.clientName, selectedClient?.masterSheetId, selectedClient?.clientSheetId, selectedClient?.setupMode, selectedClient?.setupStatus, isPreviewSetup]);

  const hasBudget = payload ? Boolean(payload.clientInfo?.hasBudget ?? payload.hasBudget) : true;
  const hasCash = payload ? Boolean(payload.clientInfo?.hasCash ?? payload.hasCash) : true;

  const rawSymbol =
    payload?.clientInfo?.currencySymbol ||
    payload?.currencySymbol ||
    keyData?.currencySymbol ||
    performanceData?.currencySymbol ||
    selectedClient?.currencySymbol ||
    (typeof window !== "undefined" ? window.currencySymbol || (function () { try { return localStorage.getItem("pulse_currency_symbol"); } catch { return null; } })() : null) ||
    "£";
  const currencySymbol =
    rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;

  const thousandsSeparator =
    payload?.clientInfo?.thousandsSeparator ||
    payload?.thousandsSeparator ||
    keyData?.thousandsSeparator ||
    performanceData?.thousandsSeparator ||
    selectedClient?.thousandsSeparator ||
    (currencySymbol === "€" ? "." : ",");

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.currencySymbol = currencySymbol;
      window.thousandsSeparator = thousandsSeparator;
      try {
        localStorage.setItem("pulse_currency_symbol", currencySymbol);
        localStorage.setItem("pulse_thousands_separator", thousandsSeparator);
      } catch { }
    }
  }, [currencySymbol, thousandsSeparator]);

  const isSeniorRestricted = Boolean(
    user?.isSenior ||
    user?.role === "Senior (Restricted)" ||
    String(user?.role || "").toLowerCase().includes("senior")
  );
  const isReadOnly = Boolean(user?.isReadOnly);
  const isAdminOrManager = Boolean(
    !isReadOnly && (user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager")
  );
  const isClientUser = !isAdminOrManager;

  // Guard budget views when client does not have budget enabled
  useEffect(() => {
    if (payload && !hasBudget && (activeView === "viewBudget" || activeView === "budgetVariance")) {
      setActiveView("month");
    }
  }, [payload, hasBudget, activeView]);

  // Guard cash views when client does not have cash enabled (AppData!W43 !== 'Yes')
  useEffect(() => {
    if (payload && !hasCash && (activeView === "cash" || activeView === "cashBreakdown")) {
      setActiveView("month");
    }
  }, [payload, hasCash, activeView]);

  // Guard salaries & dividends for senior restricted users
  useEffect(() => {
    if (isSeniorRestricted && (activeView === "salaries" || activeView === "dividends")) {
      setActiveView("month");
    }
  }, [isSeniorRestricted, activeView]);

  // Not authenticated: Show the pixel-accurate Pulse login screen immediately.
  // Never render PortalShell or MonthViewSkeleton unless the user is authenticated.
  if (!isAuthenticated || !user) {
    return (
      <>
        <Head>
          <title>Sign in to Pulse</title>
        </Head>
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
      </>
    );
  }

  // If the selected client is in setupMode (or an admin requested ?preview=setup) and full setupStatus
  // details are still fetching, render SetupHoldingGate in its clean loading state (NEVER PortalShell / MonthViewSkeleton!).
  const isSetupCheckPending = Boolean(
    selectedClient &&
    ((isClientUser && selectedClient.setupMode === true && setupStatus === null) ||
      (isPreviewSetup && setupStatus === null))
  );

  if (isSetupCheckPending) {
    return (
      <SetupHoldingGate
        clientName={selectedClient.clientName}
        masterSheetId={selectedClient.masterSheetId}
        clientSheetId={selectedClient.clientSheetId}
        clients={clients}
        onSelectClient={handleSelectClient}
        user={user}
        setupStatus={null}
        isLoading={true}
        onLogout={handleLogout}
        isPreview={isPreviewSetup && isAdminOrManager}
        onExitPreview={isPreviewSetup && isAdminOrManager ? () => setIsPreviewSetup(false) : null}
        oauthFeedback={oauthFeedback}
      />
    );
  }

  // Chooser state: If no client selected or choose is requested, show CompanyChooser
  if (clientsLoaded && !selectedClient) {
    return (
      <>
        <Head>
          <title>Select Company | Pulse</title>
        </Head>
        <CompanyChooser
          clients={clients}
          onSelectClient={handleSelectClient}
          user={user}
          onLogout={handleLogout}
        />
      </>
    );
  }

  // ── CLIENT USER SETUP MODE GATE ─────────────────────────────────────
  // If this client is in Setup Mode and the logged-in user is a ClientUser:
  if (selectedClient && isClientUser && setupStatus?.setupMode === true) {
    return (
      <SetupHoldingGate
        clientName={selectedClient.clientName}
        masterSheetId={selectedClient.masterSheetId}
        clientSheetId={selectedClient.clientSheetId}
        clients={clients}
        onSelectClient={handleSelectClient}
        user={user}
        setupStatus={setupStatus}
        onLogout={handleLogout}
        oauthFeedback={oauthFeedback}
      />
    );
  }

  // ── ADMIN / MANAGER SETUP PREVIEW ───────────────────────────────────
  // If an Admin or ClientManager requested to preview the client setup view:
  if (selectedClient && isAdminOrManager && isPreviewSetup && setupStatus) {
    return (
      <SetupHoldingGate
        clientName={selectedClient.clientName}
        masterSheetId={selectedClient.masterSheetId}
        clientSheetId={selectedClient.clientSheetId}
        clients={clients}
        onSelectClient={handleSelectClient}
        user={user}
        setupStatus={setupStatus}
        onLogout={handleLogout}
        isPreview={true}
        onExitPreview={() => setIsPreviewSetup(false)}
        oauthFeedback={oauthFeedback}
      />
    );
  }

  const resolvedHeaderClientName =
    selectedClient?.clientName ||
    (typeof router.query.client === "string" ? router.query.client : "");

  return (
    <>
      <Head>
        <title>{resolvedHeaderClientName ? `Pulse - ${resolvedHeaderClientName}` : "Pulse"}</title>
      </Head>

      <PortalShell
        clientName={resolvedHeaderClientName}
        clients={clients}
        clientsLoaded={clientsLoaded}
        onSelectClient={handleSelectClient}
        activeView={activeView}
        onSelectView={setActiveView}
        user={user}
        onLogout={handleLogout}
        hasBudget={hasBudget}
        hasCash={hasCash}
        setupStatus={setupStatus}
        onPreviewSetup={() => setIsPreviewSetup(true)}
        onRefreshSetupStatus={refreshSetupStatus}
        oauthEvent={oauthEvent}
        masterSheetId={selectedClient?.masterSheetId}
        clientSheetId={selectedClient?.clientSheetId}
      >
        <>
          {activeView === "month" && (
            <MonthView
              clientName={resolvedHeaderClientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              masterSheetId={selectedClient?.masterSheetId}
              payload={payload}
              keyData={keyData}
              performanceData={performanceData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingPayload}
              isLoadingPerformance={loadingPerformance}
              error={payloadError}
              perfError={perfError}
              onRefresh={handleRefreshPayload}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView !== "month" && !selectedClient ? (
            <MonthViewSkeleton />
          ) : (
            <>
              {activeView === "dashboard" && (
            <PerformanceFYView
              key={selectedClient?.clientSheetId || "dashboard"}
              clientName={selectedClient?.clientName || "Client"}
              data={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingPerformance}
              error={perfError}
              onRefresh={handleRefreshPerformance}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView === "ytd" && (
            <PerformanceYTDView
              key={selectedClient?.clientSheetId || "ytd"}
              clientName={selectedClient?.clientName || "Client"}
              data={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingPerformance}
              error={perfError}
              onRefresh={handleRefreshPerformance}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView === "perfBreakdown" && (
            <PerformanceBreakdownView
              clientName={selectedClient?.clientName || "Client"}
              data={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingPerformance || (loadingKeyData && !keyData)}
              error={perfError || keyDataError}
              onRefresh={handleRefreshPerformance}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView === "cash" && (
            <CashflowView
              clientName={selectedClient?.clientName || "Client"}
              data={cashflowData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingCashflow}
              error={cashError}
              onRefresh={handleRefreshCashflow}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView === "cashBreakdown" && (
            <CashflowBreakdownView
              clientName={selectedClient?.clientName || "Client"}
              data={cashflowData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingCashflow || (loadingKeyData && !keyData)}
              error={cashError || keyDataError}
              onRefresh={handleRefreshCashflow}
              isSenior={isSeniorRestricted}
            />
          )}

          {activeView === "jobs" && (
            <PortalJobsView
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "contractors" && (
            <PortalOutgoingsView
              category="contractors"
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "expenses" && (
            <PortalOutgoingsView
              category="expenses"
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "dividends" && (
            <PortalOutgoingsView
              category="dividends"
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "salaries" && (
            <PortalSalariesView
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "nbtofind" && (
            <PortalNBToFindView
              clientName={selectedClient?.clientName || "Client"}
              clientSheetId={selectedClient?.clientSheetId}
              data={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingKeyData}
              error={keyDataError}
              onRefresh={handleRefreshKeyData}
              isReadOnly={isReadOnly}
            />
          )}

          {activeView === "viewBudget" && (
            <BudgetView
              clientName={selectedClient?.clientName || "Client"}
              data={budgetData}
              allFYData={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingBudget || loadingPerformance}
              error={budgetError || perfError}
              onRefresh={handleRefreshBudget}
            />
          )}

          {activeView === "budgetVariance" && (
            <BudgetVarianceView
              clientName={selectedClient?.clientName || "Client"}
              data={budgetData}
              allFYData={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingBudget || loadingPerformance}
              error={budgetError || perfError}
              onRefresh={handleRefreshBudget}
            />
          )}

          {activeView === "scenarios" && (
            <ScenariosView
              key={selectedClient?.clientSheetId || "scenarios"}
              clientName={selectedClient?.clientName || "Client"}
              performanceData={performanceData}
              keyData={keyData}
              currencySymbol={currencySymbol}
              thousandsSeparator={thousandsSeparator}
              isLoading={loadingPerformance || loadingKeyData}
              error={perfError || keyDataError}
              onRefresh={() => {
                if (selectedClient) {
                  fetchPerformance(selectedClient, true);
                  fetchKeyData(selectedClient, true);
                }
              }}
              isSenior={isSeniorRestricted}
            />
          )}

          {!["month", "dashboard", "ytd", "perfBreakdown", "cash", "cashBreakdown", "jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind", "scenarios", "viewBudget", "budgetVariance"].includes(activeView) && (
            <div
              style={{
                background: "#ffffff",
                borderRadius: "12px",
                padding: "2.5rem 2rem",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
                border: "1px solid #e2e8f0",
                textAlign: "center"
              }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "12px",
                  background: "rgba(0, 71, 171, 0.08)",
                  color: "#0047AB",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 1rem auto",
                  fontSize: "20px"
                }}
              >
                ⚡
              </div>
              <h3 style={{ margin: "0 0 6px 0", fontSize: "1.25rem", fontWeight: 700, color: "#1e293b" }}>
                {getViewTitle(activeView)}
              </h3>
              <p style={{ margin: 0, color: "#64748b", fontSize: "0.95rem" }}>
                Ready to port for <strong>{selectedClient?.clientName}</strong> in next phase.
              </p>
            </div>
          )}
            </>
          )}
        </>
      </PortalShell>
    </>
  );
}

function getViewTitle(key) {
  const titles = {
    month: "Current month",
    dashboard: "Financial year performance",
    ytd: "YTD performance",
    perfBreakdown: "Performance breakdowns",
    cash: "Cashflow forecast",
    cashBreakdown: "Cash breakdowns",
    jobs: "Jobs",
    contractors: "Contractors",
    expenses: "Expenses",
    salaries: "Salaries",
    dividends: "Dividends",
    nbtofind: "New business to find",
    scenarios: "Scenario planning",
    viewBudget: "Budget overview",
    budgetVariance: "Budget variance analysis"
  };
  return titles[key] || "Client portal view";
}

import { getSsrSessionUser, getSsrInitialPortalData } from "../../services/ssrSession";
import { redisClient, ensureRedisConnected } from "../../services/redisClient";
import { getClientSetupStatusForPortal } from "../../services/setupService";
import { isUserAuthorizedForClient, maskResponseSheetIdsForUser } from "../../services/userPermissions";

export async function getServerSideProps(context) {
  const sessionUser = getSsrSessionUser(context.req);
  let initialSetupClient = null;
  let initialSetupStatus = null;
  let ssrPortalData = {
    initialClients: null,
    initialSelectedClient: null,
    initialPayload: null,
    initialPerformanceData: null,
  };

  if (sessionUser) {
    try {
      ssrPortalData = await getSsrInitialPortalData(context.req, sessionUser, context.query);

      const queryClient = typeof context.query?.client === "string" ? context.query.client.trim() : "";
      const authorizedQueryClient =
        queryClient && (sessionUser.isAdmin || isUserAuthorizedForClient(sessionUser, queryClient))
          ? queryClient
          : "";
      const isPreview = context.query?.preview === "setup";
      const assigned = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
      const singleAssigned =
        assigned.length === 1 && assigned[0] && assigned[0] !== "*"
          ? String(assigned[0]).trim()
          : "";
      const candidateClientName =
        authorizedQueryClient || ssrPortalData.initialSelectedClient?.clientName || singleAssigned;

      if (candidateClientName) {
        let parsedSetup = ssrPortalData.selectedSetupConfig || null;
        if (!parsedSetup && (isPreview || !ssrPortalData.initialSelectedClient)) {
          await ensureRedisConnected(400);
          if (redisClient?.isOpen) {
            const normKey = `pulse:setup:${candidateClientName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
            const rawSetup = await Promise.race([
              redisClient.get(normKey),
              new Promise((resolve) => setTimeout(() => resolve(null), 400)),
            ]);
            parsedSetup = rawSetup ? JSON.parse(rawSetup) : null;
          }
        }
        if (parsedSetup?.setupMode === true || ssrPortalData.initialSelectedClient?.setupMode === true || isPreview) {
          initialSetupStatus = await getClientSetupStatusForPortal({
            clientName: parsedSetup?.clientName || candidateClientName,
            masterSheetId: parsedSetup?.masterSheetId || "",
            clientSheetId: ssrPortalData.initialSelectedClient?.clientSheetId || ""
          });
          initialSetupClient = {
            ...(ssrPortalData.initialSelectedClient || {}),
            clientName: parsedSetup?.clientName || candidateClientName,
            setupMode: Boolean(initialSetupStatus?.setupMode),
            setupStatus: initialSetupStatus
          };
        }
      }
    } catch (_) { }
  }

  return {
    props: {
      initialUser: sessionUser || null,
      initialSetupClient: sessionUser ? maskResponseSheetIdsForUser(initialSetupClient, sessionUser) : initialSetupClient,
      initialSetupStatus: sessionUser ? maskResponseSheetIdsForUser(initialSetupStatus, sessionUser) : initialSetupStatus,
      initialClients: ssrPortalData.initialClients,
      initialSelectedClient: ssrPortalData.initialSelectedClient,
      initialPayload: sessionUser ? maskResponseSheetIdsForUser(ssrPortalData.initialPayload, sessionUser) : ssrPortalData.initialPayload,
      initialPerformanceData: sessionUser
        ? maskResponseSheetIdsForUser(ssrPortalData.initialPerformanceData, sessionUser)
        : ssrPortalData.initialPerformanceData,
    },
  };
}
