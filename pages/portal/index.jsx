import React, { useState, useEffect, useCallback, useRef } from "react";
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
import CompanyChooser from "../../components/portal/CompanyChooser";
import Spinner from "../../components/Spinner";

export default function PortalPage() {
  const router = useRouter();
  const auth = useAuth();
  const { isAuthenticated, authChecking, user, logout } = auth;

  const [clients, setClients] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const clientsFetchedRef = useRef(false);
  const [activeView, setActiveView] = useState("month");

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

  // Month View live payload state
  const [payload, setPayload] = useState(null);
  const [loadingPayload, setLoadingPayload] = useState(false);
  const [payloadError, setPayloadError] = useState(null);

  // Performance Views data state (FY, YTD, Breakdowns)
  const [performanceData, setPerformanceData] = useState(null);
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

  const fetchPayload = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (!isSilent) {
      setLoadingPayload(true);
      setPayloadError(null);
    }
    try {
      const url = `/api/portal/payload?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.payload) {
        setPayload(data.payload);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load client data");
      }
    } catch (err) {
      console.error("Payload fetch error:", err);
      if (!isSilent) {
        setPayloadError(err.message || "Failed to connect to client sheet");
      }
    } finally {
      if (!isSilent) {
        setLoadingPayload(false);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedClient?.clientSheetId) {
      setPayload(null);
      fetchPayload(selectedClient, false);
    }
  }, [selectedClient, fetchPayload]);

  const handleRefreshPayload = () => {
    if (selectedClient) {
      fetchPayload(selectedClient, true);
    }
  };

  const fetchPerformance = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (!isSilent) {
      setLoadingPerformance(true);
      setPerfError(null);
    }
    try {
      const url = `/api/portal/performance?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setPerformanceData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load performance data");
      }
    } catch (err) {
      console.error("Performance fetch error:", err);
      if (!isSilent) {
        setPerfError(err.message || "Failed to connect to client sheet");
      }
    } finally {
      if (!isSilent) {
        setLoadingPerformance(false);
      }
    }
  }, []);

  // Fetch performance data when switching to a performance view
  useEffect(() => {
    if (["dashboard", "ytd", "perfBreakdown", "scenarios"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!performanceData) {
        fetchPerformance(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, performanceData, fetchPerformance]);

  // Invalidate performance cache when selected client changes
  useEffect(() => {
    setPerformanceData(null);
  }, [selectedClient]);

  const handleRefreshPerformance = () => {
    if (selectedClient) {
      fetchPerformance(selectedClient, true);
    }
  };

  const fetchCashflow = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (!isSilent) {
      setLoadingCashflow(true);
      setCashError(null);
    }
    try {
      const url = `/api/portal/cash?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setCashflowData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load cashflow data");
      }
    } catch (err) {
      console.error("Cashflow fetch error:", err);
      if (!isSilent) {
        setCashError(err.message || "Failed to connect to client sheet");
      }
    } finally {
      if (!isSilent) {
        setLoadingCashflow(false);
      }
    }
  }, []);

  // Fetch cashflow data when switching to a cash view
  useEffect(() => {
    if (["cash", "cashBreakdown"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!cashflowData) {
        fetchCashflow(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, cashflowData, fetchCashflow]);

  // Invalidate cashflow cache on client change
  useEffect(() => {
    setCashflowData(null);
  }, [selectedClient]);

  const handleRefreshCashflow = () => {
    if (selectedClient) {
      fetchCashflow(selectedClient, true);
    }
  };

  const fetchKeyData = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (!isSilent) {
      setLoadingKeyData(true);
      setKeyDataError(null);
    }
    try {
      const url = `/api/portal/key-data?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setKeyData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load key data");
      }
    } catch (err) {
      console.error("Key data fetch error:", err);
      if (!isSilent) {
        setKeyDataError(err.message || "Failed to connect to client sheet");
      }
    } finally {
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
      if (!keyData) {
        fetchKeyData(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, keyData, fetchKeyData]);

  // Invalidate key data cache on client change
  useEffect(() => {
    setKeyData(null);
  }, [selectedClient]);

  const handleRefreshKeyData = () => {
    if (selectedClient) {
      fetchKeyData(selectedClient, true);
    }
  };

  const fetchBudget = useCallback(async (client, bypassCache = false, isSilent = false) => {
    if (!client || !client.clientSheetId) return;
    if (!isSilent) {
      setLoadingBudget(true);
      setBudgetError(null);
    }
    try {
      const url = `/api/portal/budget?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setBudgetData(data.data);
      } else if (!isSilent) {
        throw new Error(data.error || "Failed to load budget data");
      }
    } catch (err) {
      console.error("Budget fetch error:", err);
      if (!isSilent) {
        setBudgetError(err.message || "Failed to connect to client sheet");
      }
    } finally {
      if (!isSilent) {
        setLoadingBudget(false);
      }
    }
  }, []);

  // Fetch budget when switching to viewBudget or budgetVariance
  useEffect(() => {
    if (["viewBudget", "budgetVariance"].includes(activeView) && selectedClient?.clientSheetId) {
      if (!budgetData) {
        fetchBudget(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, budgetData, fetchBudget]);

  // For Scenarios, we ensure both performance and key data are loaded
  useEffect(() => {
    if (activeView === "scenarios" && selectedClient?.clientSheetId) {
      if (!performanceData) fetchPerformance(selectedClient, false);
      if (!keyData) fetchKeyData(selectedClient, false);
    }
  }, [activeView, selectedClient, performanceData, keyData, fetchPerformance, fetchKeyData]);

  // Background preloading queue: once payload is loaded, preload remaining sections in staggered sequence
  useEffect(() => {
    if (!payload || !selectedClient?.clientSheetId) return;

    const t1 = setTimeout(() => {
      if (!performanceData && !loadingPerformance) {
        fetchPerformance(selectedClient, false);
      }
    }, 250);

    const t2 = setTimeout(() => {
      if (!keyData && !loadingKeyData) {
        fetchKeyData(selectedClient, false);
      }
    }, 600);

    const t3 = setTimeout(() => {
      if (!cashflowData && !loadingCashflow) {
        fetchCashflow(selectedClient, false);
      }
    }, 1000);

    const t4 = setTimeout(() => {
      const clientHasBudget = Boolean(payload?.clientInfo?.hasBudget ?? payload?.hasBudget);
      if (clientHasBudget && !budgetData && !loadingBudget) {
        fetchBudget(selectedClient, false);
      }
    }, 1400);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [payload, selectedClient, performanceData, keyData, cashflowData, budgetData, loadingPerformance, loadingKeyData, loadingCashflow, loadingBudget, fetchPerformance, fetchKeyData, fetchCashflow, fetchBudget]);

  // Invalidate budget cache on client change
  useEffect(() => {
    setBudgetData(null);
  }, [selectedClient]);

  const handleRefreshBudget = () => {
    if (selectedClient) {
      fetchBudget(selectedClient, true);
    }
  };

  // 60-Second Background Auto-Refresh (matching original GAS WebApp REFRESH_INTERVAL = 60000)
  useEffect(() => {
    if (!selectedClient?.clientSheetId) return;

    const intervalId = setInterval(() => {
      // Silently refresh current payload and active view data in background with bypassCache=true
      // so latest numbers from sheets/integrations are kept up to date
      fetchPayload(selectedClient, true, true);

      if (["dashboard", "ytd", "perfBreakdown", "scenarios"].includes(activeView)) {
        fetchPerformance(selectedClient, true, true);
      }
      if (["cash", "cashBreakdown"].includes(activeView)) {
        fetchCashflow(selectedClient, true, true);
      }
      if (["jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind", "cashBreakdown", "scenarios", "perfBreakdown"].includes(activeView)) {
        fetchKeyData(selectedClient, true, true);
      }
      if (["viewBudget", "budgetVariance"].includes(activeView)) {
        fetchBudget(selectedClient, true, true);
      }
    }, 60000);

    return () => clearInterval(intervalId);
  }, [selectedClient, activeView, fetchPayload, fetchPerformance, fetchCashflow, fetchKeyData, fetchBudget]);

  // Fast client restore on mount from localStorage to eliminate waterfall delay
  useEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) return;
    try {
      if (router.query.choose === "true") return;
      const savedObj = localStorage.getItem("pulse_portal_active_client_obj");
      if (savedObj) {
        const parsed = JSON.parse(savedObj);
        if (parsed?.clientSheetId) {
          setSelectedClient((curr) => {
            if (!curr || curr.clientSheetId !== parsed.clientSheetId) {
              return parsed;
            }
            return curr;
          });
        }
      }
    } catch (e) {}
  }, [isAuthenticated, router.query.choose]);

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

          // Check if client specified in legacy URL query or localStorage
          const queryClient = router.query.client;
          let initial = null;

          if (queryClient) {
            initial = data.clients.find(
              (c) => c.clientName.toLowerCase() === String(queryClient).toLowerCase()
            );
          }

          const isChooseRequested = router.query.choose === "true";
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
              // Priority 1: Match currently selected client (e.g. from fast restore)
              if (selectedClient?.clientSheetId) {
                initial = data.clients.find(
                  (c) => c.clientSheetId === selectedClient.clientSheetId || c.clientName?.toLowerCase() === selectedClient.clientName?.toLowerCase()
                );
              }
              // Priority 2: Check query client
              if (!initial && queryClient) {
                initial = data.clients.find(
                  (c) => c.clientName.toLowerCase() === String(queryClient).toLowerCase()
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

          setSelectedClient(initial);
          if (initial && typeof window !== "undefined") {
            localStorage.setItem("pulse_portal_client", initial.clientName);
            localStorage.setItem("pulse_portal_active_client_obj", JSON.stringify(initial));
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
  }, [isAuthenticated, router.query.client, router.query.choose, user, selectedClient]);

  // Clean URL: Strip any legacy ?client=... or ?choose=... so the address bar stays clean (/pulse)
  useEffect(() => {
    if (router.query.client || router.query.choose) {
      const nextQuery = { ...router.query };
      delete nextQuery.client;
      delete nextQuery.choose;
      router.replace({ pathname: "/pulse", query: nextQuery }, undefined, { shallow: true });
    }
  }, [router, router.query.client, router.query.choose]);

  const handleLogout = async () => {
    clientsFetchedRef.current = false;
    setClientsLoaded(false);
    setSelectedClient(null);
    setPayload(null);
    setClients([]);
    if (typeof window !== "undefined") {
      localStorage.removeItem("pulse_portal_client");
      localStorage.removeItem("pulse_portal_active_client_obj");
    }
    await logout();
  };

  const handleSelectClient = (client) => {
    setSelectedClient(client);
    if (client) {
      if (typeof window !== "undefined") {
        localStorage.setItem("pulse_portal_client", client.clientName);
        localStorage.setItem("pulse_portal_active_client_obj", JSON.stringify(client));
      }
    } else {
      if (typeof window !== "undefined") {
        localStorage.removeItem("pulse_portal_client");
        localStorage.removeItem("pulse_portal_active_client_obj");
      }
    }
    // Clean URL: Keep URL as clean /pulse
    if (router.query.client || router.query.choose) {
      const nextQuery = { ...router.query };
      delete nextQuery.client;
      delete nextQuery.choose;
      router.replace({ pathname: "/pulse", query: nextQuery }, undefined, { shallow: true });
    }
  };

  const hasBudget = payload ? Boolean(payload.clientInfo?.hasBudget ?? payload.hasBudget) : false;

  const isSeniorRestricted = Boolean(
    user?.isSenior ||
    user?.role === "Senior (Restricted)" ||
    String(user?.role || "").toLowerCase().includes("senior")
  );

  // Guard budget views when client does not have budget enabled
  useEffect(() => {
    if (payload && !hasBudget && (activeView === "viewBudget" || activeView === "budgetVariance")) {
      setActiveView("month");
    }
  }, [payload, hasBudget, activeView]);

  // Guard salaries & dividends for senior restricted users
  useEffect(() => {
    if (isSeniorRestricted && (activeView === "salaries" || activeView === "dividends")) {
      setActiveView("month");
    }
  }, [isSeniorRestricted, activeView]);

  // Auth checking loading state
  if (authChecking) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          gap: "12px",
          fontFamily: "'Kumbh Sans', sans-serif"
        }}
      >
        <Spinner size={32} color="#0047AB" />
        <span style={{ color: "#0047AB", fontWeight: 600, fontSize: "15px" }}>Please wait - loading</span>
      </div>
    );
  }

  // Not authenticated: Show the pixel-accurate Pulse login screen
  if (!isAuthenticated) {
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

  // Steady initial loading state: show 'Please wait - loading' until clients are determined,
  // and if a client is selected, until their initial payload arrives (or errors)
  if (!clientsLoaded || (selectedClient && !payload && !payloadError)) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          gap: "12px",
          fontFamily: "'Kumbh Sans', sans-serif"
        }}
      >
        <Spinner size={32} color="#0047AB" />
        <span style={{ color: "#0047AB", fontWeight: 600, fontSize: "15px" }}>Please wait - loading</span>
      </div>
    );
  }

  // Chooser state: If no client selected or choose is requested, show CompanyChooser
  if (!selectedClient) {
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

  return (
    <>
      <Head>
        <title>{selectedClient?.clientName ? `Pulse - ${selectedClient.clientName}` : "Pulse"}</title>
      </Head>

      <PortalShell
        clientName={selectedClient?.clientName}
        clients={clients}
        onSelectClient={handleSelectClient}
        activeView={activeView}
        onSelectView={setActiveView}
        user={user}
        onLogout={handleLogout}
        hasBudget={hasBudget}
      >
          <>
            {activeView === "month" && (
              <MonthView
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                masterSheetId={selectedClient?.masterSheetId}
                payload={payload}
                keyData={keyData}
                isLoading={loadingPayload}
                error={payloadError}
                onRefresh={handleRefreshPayload}
                isSenior={isSeniorRestricted}
              />
            )}

            {activeView === "dashboard" && (
              <PerformanceFYView
                clientName={selectedClient?.clientName || "Client"}
                data={performanceData}
                keyData={keyData}
                isLoading={loadingPerformance}
                error={perfError}
                onRefresh={handleRefreshPerformance}
                isSenior={isSeniorRestricted}
              />
            )}

            {activeView === "ytd" && (
              <PerformanceYTDView
                clientName={selectedClient?.clientName || "Client"}
                data={performanceData}
                keyData={keyData}
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
                isLoading={loadingPerformance || (loadingKeyData && !keyData)}
                error={perfError || keyDataError}
                onRefresh={() => {
                  handleRefreshPerformance();
                  handleRefreshKeyData();
                }}
                isSenior={isSeniorRestricted}
              />
            )}

            {activeView === "cash" && (
              <CashflowView
                clientName={selectedClient?.clientName || "Client"}
                data={cashflowData}
                keyData={keyData}
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
                isLoading={loadingCashflow || (loadingKeyData && !keyData)}
                error={cashError || keyDataError}
                onRefresh={() => {
                  handleRefreshCashflow();
                  handleRefreshKeyData();
                }}
                isSenior={isSeniorRestricted}
              />
            )}

            {activeView === "jobs" && (
              <PortalJobsView
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "contractors" && (
              <PortalOutgoingsView
                category="contractors"
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "expenses" && (
              <PortalOutgoingsView
                category="expenses"
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "dividends" && (
              <PortalOutgoingsView
                category="dividends"
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "salaries" && (
              <PortalSalariesView
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "nbtofind" && (
              <PortalNBToFindView
                clientName={selectedClient?.clientName || "Client"}
                clientSheetId={selectedClient?.clientSheetId}
                data={keyData}
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={handleRefreshKeyData}
              />
            )}

            {activeView === "viewBudget" && (
              <BudgetView
                clientName={selectedClient?.clientName || "Client"}
                data={budgetData}
                allFYData={performanceData}
                keyData={keyData}
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
                isLoading={loadingBudget || loadingPerformance}
                error={budgetError || perfError}
                onRefresh={handleRefreshBudget}
              />
            )}

            {activeView === "scenarios" && (
              <ScenariosView
                clientName={selectedClient?.clientName || "Client"}
                performanceData={performanceData}
                keyData={keyData}
                isLoading={loadingPerformance || loadingKeyData}
                error={perfError || keyDataError}
                onRefresh={() => {
                  if (selectedClient) {
                    fetchPerformance(selectedClient, true);
                    fetchKeyData(selectedClient, true);
                  }
                }}
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
      </PortalShell>
    </>
  );
}

function getViewTitle(key) {
  const titles = {
    month: "Current Month",
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
  return titles[key] || "Client Portal View";
}
