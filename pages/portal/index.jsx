import React, { useState, useEffect, useCallback } from "react";
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
import Spinner from "../../components/Spinner";

export default function PortalPage() {
  const router = useRouter();
  const auth = useAuth();
  const { isAuthenticated, authChecking, user, logout } = auth;

  const [clients, setClients] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [loadingClients, setLoadingClients] = useState(false);
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

  const fetchPayload = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoadingPayload(true);
    setPayloadError(null);
    try {
      const url = `/api/portal/payload?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.payload) {
        setPayload(data.payload);
      } else {
        throw new Error(data.error || "Failed to load client data");
      }
    } catch (err) {
      console.error("Payload fetch error:", err);
      setPayloadError(err.message || "Failed to connect to client sheet");
    } finally {
      setLoadingPayload(false);
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

  const fetchPerformance = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoadingPerformance(true);
    setPerfError(null);
    try {
      const url = `/api/portal/performance?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setPerformanceData(data.data);
      } else {
        throw new Error(data.error || "Failed to load performance data");
      }
    } catch (err) {
      console.error("Performance fetch error:", err);
      setPerfError(err.message || "Failed to connect to client sheet");
    } finally {
      setLoadingPerformance(false);
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

  const fetchCashflow = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoadingCashflow(true);
    setCashError(null);
    try {
      const url = `/api/portal/cash?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setCashflowData(data.data);
      } else {
        throw new Error(data.error || "Failed to load cashflow data");
      }
    } catch (err) {
      console.error("Cashflow fetch error:", err);
      setCashError(err.message || "Failed to connect to client sheet");
    } finally {
      setLoadingCashflow(false);
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

  const fetchKeyData = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoadingKeyData(true);
    setKeyDataError(null);
    try {
      const url = `/api/portal/key-data?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setKeyData(data.data);
      } else {
        throw new Error(data.error || "Failed to load key data");
      }
    } catch (err) {
      console.error("Key data fetch error:", err);
      setKeyDataError(err.message || "Failed to connect to client sheet");
    } finally {
      setLoadingKeyData(false);
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

  const fetchBudget = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoadingBudget(true);
    setBudgetError(null);
    try {
      const url = `/api/portal/budget?clientSheetId=${encodeURIComponent(client.clientSheetId)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        setBudgetData(data.data);
      } else {
        throw new Error(data.error || "Failed to load budget data");
      }
    } catch (err) {
      console.error("Budget fetch error:", err);
      setBudgetError(err.message || "Failed to connect to client sheet");
    } finally {
      setLoadingBudget(false);
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

  // Background preload of keyData for deep dive popovers and breakdowns
  useEffect(() => {
    if (
      ["dashboard", "ytd", "month", "cash", "perfBreakdown", "cashBreakdown"].includes(activeView) &&
      selectedClient?.clientSheetId
    ) {
      if (!keyData && !loadingKeyData) {
        fetchKeyData(selectedClient, false);
      }
    }
  }, [activeView, selectedClient, keyData, loadingKeyData, fetchKeyData]);

  // Invalidate budget cache on client change
  useEffect(() => {
    setBudgetData(null);
  }, [selectedClient]);

  const handleRefreshBudget = () => {
    if (selectedClient) {
      fetchBudget(selectedClient, true);
    }
  };

  // Fetch authorized clients for portal
  useEffect(() => {
    if (!isAuthenticated) return;

    let isMounted = true;
    setLoadingClients(true);

    fetch("/api/portal/clients")
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.success && Array.isArray(data.clients)) {
          setClients(data.clients);

          // Check if client specified in URL query
          const queryClient = router.query.client;
          let initial = null;

          if (queryClient) {
            initial = data.clients.find(
              (c) => c.clientName.toLowerCase() === String(queryClient).toLowerCase()
            );
          }

          // Or check localStorage
          if (!initial && typeof window !== "undefined") {
            const saved = localStorage.getItem("pulse_portal_client");
            if (saved) {
              initial = data.clients.find(
                (c) => c.clientName.toLowerCase() === saved.toLowerCase()
              );
            }
          }

          // Default fallback: choose APPTEST for admins, or the first available client
          if (!initial) {
            initial =
              data.clients.find((c) => c.clientName.toUpperCase() === "APPTEST") ||
              data.clients[0] ||
              null;
          }

          setSelectedClient(initial);
        }
      })
      .catch((err) => {
        console.error("Failed to load portal clients:", err);
      })
      .finally(() => {
        if (isMounted) setLoadingClients(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, router.query.client]);

  const handleSelectClient = (client) => {
    setSelectedClient(client);
    if (typeof window !== "undefined") {
      localStorage.setItem("pulse_portal_client", client.clientName);
    }
  };

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
        <span style={{ color: "#0047AB", fontWeight: 600, fontSize: "15px" }}>Loading Pulse...</span>
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

  return (
    <>
      <Head>
        <title>{selectedClient ? `${selectedClient.clientName} - Pulse` : "Pulse"}</title>
      </Head>

      <PortalShell
        clientName={selectedClient?.clientName}
        clients={clients}
        onSelectClient={handleSelectClient}
        activeView={activeView}
        onSelectView={setActiveView}
        user={user}
        onLogout={logout}
      >
        {loadingClients && !selectedClient ? (
          <div style={{ textAlign: "center", padding: "4rem 0" }}>
            <Spinner size={32} color="#0047AB" />
            <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
              Connecting to client workspace...
            </p>
          </div>
        ) : (
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
                isLoading={loadingBudget}
                error={budgetError}
                onRefresh={handleRefreshBudget}
              />
            )}

            {activeView === "budgetVariance" && (
              <BudgetVarianceView
                clientName={selectedClient?.clientName || "Client"}
                data={budgetData}
                isLoading={loadingBudget}
                error={budgetError}
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
        )}
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
