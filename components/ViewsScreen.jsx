import React, { useState, useEffect, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import EditClientSelector from "./EditClientSelector";
import PerformanceFYView from "./portal/PerformanceFYView";
import CashflowView from "./portal/CashflowView";
import PortalOutgoingsView from "./portal/PortalOutgoingsView";
import PortalSalariesView from "./portal/PortalSalariesView";
import PortalNBToFindView from "./portal/PortalNBToFindView";
import BudgetView from "./portal/BudgetView";

const TABS = [
  { id: "fyPerformance", label: "FY performance" },
  { id: "cashflow", label: "Cashflow forecast" },
  { id: "contractors", label: "Contractors" },
  { id: "expenses", label: "Expenses" },
  { id: "salaries", label: "Salaries" },
  { id: "dividends", label: "Dividends" },
  { id: "nbToFind", label: "New business to find" },
  { id: "budgetOverview", label: "Budget overview" },
];

export default function ViewsScreen({
  allClients,
  styles,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient,
  activeTab: propActiveTab,
  onSelectTab,
  initialClient,
  onSelectClient,
}) {
  const { user } = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : !!(user?.isAdmin || user?.role === "Admin");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [selectedClient, setSelectedClient] = useState(() => {
    const target = managedClient || initialClient;
    if (target) {
      return (allClients || []).find((c) => c.clientName?.toLowerCase() === target.clientName?.toLowerCase()) || target;
    }
    return null;
  });
  const [internalActiveTab, setInternalActiveTab] = useState("fyPerformance");
  const activeTab = propActiveTab || internalActiveTab;
  const setActiveTab = (tabId) => {
    setInternalActiveTab(tabId);
    onSelectTab?.(tabId);
  };
  const activeTabLabel = TABS.find((t) => t.id === activeTab)?.label || "Client views";

  // Data Caches by clientSheetId
  const [payloadCache, setPayloadCache] = useState({});
  const [perfCache, setPerfCache] = useState({});
  const [cashCache, setCashCache] = useState({});
  const [keyDataCache, setKeyDataCache] = useState({});
  const [budgetCache, setBudgetCache] = useState({});
  const cacheRef = useRef({
    payload: {},
    perf: {},
    cash: {},
    keyData: {},
    budget: {},
  });

  // Loading States
  const [loadingPayload, setLoadingPayload] = useState(false);
  const [loadingPerf, setLoadingPerf] = useState(false);
  const [loadingCash, setLoadingCash] = useState(false);
  const [loadingKeyData, setLoadingKeyData] = useState(false);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Error States
  const [payloadError, setPayloadError] = useState(null);
  const [perfError, setPerfError] = useState(null);
  const [cashError, setCashError] = useState(null);
  const [keyDataError, setKeyDataError] = useState(null);
  const [budgetError, setBudgetError] = useState(null);

  // Auto-select managedClient or initialClient when active
  useEffect(() => {
    const target = managedClient || initialClient;
    if (target) {
      const match = (allClients || []).find((c) => c.clientName?.toLowerCase() === target.clientName?.toLowerCase()) || target;
      setSelectedClient(match);
    }
  }, [managedClient, initialClient, allClients]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      onSelectClient?.(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_views_client");
      }
    }
  };

  const handleSelectClient = (client) => {
    setSelectedClient(client);
    onSelectClient?.(client);
    if (client && typeof window !== "undefined") {
      sessionStorage.setItem("pma_views_client", client.clientName);
    }
  };

  // --- API DATA FETCHERS ---
  const fetchPayload = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cacheRef.current.payload[cid] || getCachedClientData(cid, "portal_payload")?.data) : null;
    if (cached) {
      cacheRef.current.payload[cid] = cached;
      setPayloadCache((prev) => (prev[cid] === cached ? prev : { ...prev, [cid]: cached }));
      setLoadingPayload(false);
      return cached;
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`portal_payload_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(cid, "portal_payload")?.data;
          if (fresh) {
            cacheRef.current.payload[cid] = fresh;
            setPayloadCache((prev) => (prev[cid] === fresh ? prev : { ...prev, [cid]: fresh }));
            setLoadingPayload(false);
            return fresh;
          }
        } catch { }
      }
    }

    setLoadingPayload(true);
    setPayloadError(null);
    try {
      const url = `/api/portal/payload?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true&_t=${Date.now()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.payload) {
        cacheRef.current.payload[cid] = data.payload;
        setCachedClientData(cid, "portal_payload", data.payload);
        setPayloadCache((prev) => ({ ...prev, [cid]: data.payload }));
        return data.payload;
      }
    } catch (err) {
      console.error("Payload fetch error:", err);
      setPayloadError(err.message || "Failed to load client payload");
    } finally {
      setLoadingPayload(false);
    }
  }, [getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchPerformance = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cacheRef.current.perf[cid] || getCachedClientData(cid, "portal_perf")?.data) : null;
    if (cached) {
      cacheRef.current.perf[cid] = cached;
      setPerfCache((prev) => (prev[cid] === cached ? prev : { ...prev, [cid]: cached }));
      setLoadingPerf(false);
      return cached;
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`portal_perf_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(cid, "portal_perf")?.data;
          if (fresh) {
            cacheRef.current.perf[cid] = fresh;
            setPerfCache((prev) => (prev[cid] === fresh ? prev : { ...prev, [cid]: fresh }));
            setLoadingPerf(false);
            return fresh;
          }
        } catch { }
      }
    }

    setLoadingPerf(true);
    setPerfError(null);
    try {
      const url = `/api/portal/performance?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true&_t=${Date.now()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        cacheRef.current.perf[cid] = data.data;
        setCachedClientData(cid, "portal_perf", data.data);
        setPerfCache((prev) => ({ ...prev, [cid]: data.data }));
        return data.data;
      } else {
        throw new Error(data.error || "Failed to load performance data");
      }
    } catch (err) {
      console.error("Performance fetch error:", err);
      setPerfError(err.message || "Failed to load performance data");
    } finally {
      setLoadingPerf(false);
    }
  }, [getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchCashflow = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cacheRef.current.cash[cid] || getCachedClientData(cid, "portal_cash")?.data) : null;
    if (cached) {
      cacheRef.current.cash[cid] = cached;
      setCashCache((prev) => (prev[cid] === cached ? prev : { ...prev, [cid]: cached }));
      setLoadingCash(false);
      return cached;
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`portal_cash_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(cid, "portal_cash")?.data;
          if (fresh) {
            cacheRef.current.cash[cid] = fresh;
            setCashCache((prev) => (prev[cid] === fresh ? prev : { ...prev, [cid]: fresh }));
            setLoadingCash(false);
            return fresh;
          }
        } catch { }
      }
    }

    setLoadingCash(true);
    setCashError(null);
    try {
      const url = `/api/portal/cash?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true&_t=${Date.now()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        cacheRef.current.cash[cid] = data.data;
        setCachedClientData(cid, "portal_cash", data.data);
        setCashCache((prev) => ({ ...prev, [cid]: data.data }));
        return data.data;
      } else {
        throw new Error(data.error || "Failed to load cashflow data");
      }
    } catch (err) {
      console.error("Cashflow fetch error:", err);
      setCashError(err.message || "Failed to load cashflow data");
    } finally {
      setLoadingCash(false);
    }
  }, [getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchKeyData = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cacheRef.current.keyData[cid] || getCachedClientData(cid, "portal_key_data")?.data) : null;
    if (cached) {
      cacheRef.current.keyData[cid] = cached;
      setKeyDataCache((prev) => (prev[cid] === cached ? prev : { ...prev, [cid]: cached }));
      setLoadingKeyData(false);
      return cached;
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`portal_key_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(cid, "portal_key_data")?.data;
          if (fresh) {
            cacheRef.current.keyData[cid] = fresh;
            setKeyDataCache((prev) => (prev[cid] === fresh ? prev : { ...prev, [cid]: fresh }));
            setLoadingKeyData(false);
            return fresh;
          }
        } catch { }
      }
    }

    setLoadingKeyData(true);
    setKeyDataError(null);
    try {
      const url = `/api/portal/key-data?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true&_t=${Date.now()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        cacheRef.current.keyData[cid] = data.data;
        setCachedClientData(cid, "portal_key_data", data.data);
        setKeyDataCache((prev) => ({ ...prev, [cid]: data.data }));
        return data.data;
      } else {
        throw new Error(data.error || "Failed to load key data");
      }
    } catch (err) {
      console.error("Key data fetch error:", err);
      setKeyDataError(err.message || "Failed to load key data");
    } finally {
      setLoadingKeyData(false);
    }
  }, [getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchBudget = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cacheRef.current.budget[cid] || getCachedClientData(cid, "portal_budget")?.data) : null;
    if (cached) {
      cacheRef.current.budget[cid] = cached;
      setBudgetCache((prev) => (prev[cid] === cached ? prev : { ...prev, [cid]: cached }));
      setLoadingBudget(false);
      return cached;
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`portal_budget_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(cid, "portal_budget")?.data;
          if (fresh) {
            cacheRef.current.budget[cid] = fresh;
            setBudgetCache((prev) => (prev[cid] === fresh ? prev : { ...prev, [cid]: fresh }));
            setLoadingBudget(false);
            return fresh;
          }
        } catch { }
      }
    }

    setLoadingBudget(true);
    setBudgetError(null);
    try {
      const url = `/api/portal/budget?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? `&bypassCache=true&_t=${Date.now()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        cacheRef.current.budget[cid] = data.data;
        setCachedClientData(cid, "portal_budget", data.data);
        setBudgetCache((prev) => ({ ...prev, [cid]: data.data }));
        return data.data;
      } else {
        throw new Error(data.error || "Failed to load budget data");
      }
    } catch (err) {
      console.error("Budget fetch error:", err);
      setBudgetError(err.message || "Failed to load budget data");
    } finally {
      setLoadingBudget(false);
    }
  }, [getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  // Load needed data based on active tab and selected client
  useEffect(() => {
    if (!selectedClient?.clientSheetId) return;

    // Always fetch payload for currency symbol & settings
    fetchPayload(selectedClient);

    if (activeTab === "fyPerformance") {
      fetchPerformance(selectedClient);
      fetchKeyData(selectedClient);
    } else if (activeTab === "cashflow") {
      fetchCashflow(selectedClient);
      fetchKeyData(selectedClient);
    } else if (activeTab === "budgetOverview") {
      fetchBudget(selectedClient);
      fetchPerformance(selectedClient);
      fetchKeyData(selectedClient);
    } else if (
      ["contractors", "expenses", "salaries", "dividends", "nbToFind"].includes(activeTab)
    ) {
      fetchKeyData(selectedClient);
    }
  }, [selectedClient, activeTab, fetchPayload, fetchPerformance, fetchCashflow, fetchKeyData, fetchBudget]);

  const handleRefreshCurrentView = useCallback(async (tabOverride) => {
    if (!selectedClient) return;
    const tab = typeof tabOverride === "string" ? tabOverride : activeTab;
    setIsRefreshing(true);
    const minSpin = new Promise((r) => setTimeout(r, 600));
    try {
      const tasks = [minSpin, fetchPayload(selectedClient, true)];
      if (tab === "fyPerformance") {
        tasks.push(fetchPerformance(selectedClient, true), fetchKeyData(selectedClient, true));
      } else if (tab === "cashflow") {
        tasks.push(fetchCashflow(selectedClient, true), fetchKeyData(selectedClient, true));
      } else if (tab === "budgetOverview") {
        tasks.push(
          fetchBudget(selectedClient, true),
          fetchPerformance(selectedClient, true),
          fetchKeyData(selectedClient, true)
        );
      } else if (["contractors", "expenses", "salaries", "dividends", "nbToFind"].includes(tab)) {
        tasks.push(fetchKeyData(selectedClient, true));
      }
      await Promise.all(tasks);
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedClient, activeTab, fetchPayload, fetchPerformance, fetchCashflow, fetchKeyData, fetchBudget]);

  const cid = selectedClient?.clientSheetId;
  const payload = cid ? (payloadCache[cid] || getCachedClientData(cid, "portal_payload")?.data) : null;
  const perfData = cid ? (perfCache[cid] || getCachedClientData(cid, "portal_perf")?.data) : null;
  const cashData = cid ? (cashCache[cid] || getCachedClientData(cid, "portal_cash")?.data) : null;
  const keyData = cid ? (keyDataCache[cid] || getCachedClientData(cid, "portal_key_data")?.data) : null;
  const budgetData = cid ? (budgetCache[cid] || getCachedClientData(cid, "portal_budget")?.data) : null;

  const rawSymbol =
    payload?.clientInfo?.currencySymbol ||
    payload?.currencySymbol ||
    keyData?.currencySymbol ||
    perfData?.currencySymbol ||
    selectedClient?.currencySymbol ||
    "£";
  const currencySymbol =
    rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;

  const thousandsSeparator =
    payload?.clientInfo?.thousandsSeparator ||
    payload?.thousandsSeparator ||
    keyData?.thousandsSeparator ||
    perfData?.thousandsSeparator ||
    selectedClient?.thousandsSeparator ||
    (currencySymbol === "€" ? "." : ",");

  const isCurrentViewLoading =
    activeTab === "fyPerformance"
      ? (loadingPerf && !perfData) || (loadingPayload && !payload)
      : activeTab === "cashflow"
        ? (loadingCash && !cashData) || (loadingPayload && !payload)
        : activeTab === "budgetOverview"
          ? ((loadingBudget && !budgetData) || (loadingPerf && !perfData) || (loadingPayload && !payload))
          : ((loadingKeyData && !keyData) || (loadingPayload && !payload));

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box", fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      {/* Top Header & Client Chooser Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
          flexWrap: "wrap",
          gap: "14px",
          background: "#ffffff",
          padding: "16px 20px",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {selectedClient && !managedClient && (allClients || []).length > 1 && (
            <button
              type="button"
              onClick={handleBackToClients}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer",
                padding: "6px 12px",
                fontSize: "16px",
                color: "#475569",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#f1f5f9";
                e.currentTarget.style.borderColor = "#94a3b8";
                e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#cbd5e1";
                e.currentTarget.style.color = "#475569";
              }}
              title="Back to client list"
            >
              ←
            </button>
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
              <span>{activeTabLabel}</span>
            </h1>
            {selectedClient && (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            )}
          </div>
        </div>

        {/* Right Actions */}
        {selectedClient && isAdmin && (selectedClient.clientSheetId || selectedClient.masterSheetId) && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <a
              href={`https://docs.google.com/spreadsheets/d/${activeTab === "budgetOverview" && selectedClient.masterSheetId ? selectedClient.masterSheetId : selectedClient.clientSheetId}/edit`}
              target="_blank"
              rel="noreferrer"
              className="triage-btn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#15803d",
                background: "#dcfce7",
                border: "1px solid #bbf7d0",
                borderRadius: "8px",
                textDecoration: "none",
              }}
              title={activeTab === "budgetOverview" ? "Open Master Sheet in Google Sheets" : "Open Client Sheet in Google Sheets"}
            >
              <span>📊</span>
              <span>Open in Sheets</span>
            </a>
          </div>
        )}
      </div>

      {/* Client Selection Screen (when no client chosen) */}
      {!selectedClient && (
        <EditClientSelector
          clients={allClients || []}
          onSelectClient={(c) => handleSelectClient(c)}
          title="Select a client to view their dashboard:"
        />
      )}

      {/* Main Container Area */}
      {selectedClient && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", overflow: "hidden" }}>
          {/* View Content Display */}
          <div className="pma-views-content-inner" style={{ padding: "20px" }}>
            {activeTab === "fyPerformance" && (
              <PerformanceFYView
                key={selectedClient.clientSheetId || "fyPerformance"}
                clientName={selectedClient.clientName || "Client"}
                data={perfData}
                keyData={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingPerf || loadingKeyData || isRefreshing}
                error={perfError}
                onRefresh={() => handleRefreshCurrentView("fyPerformance")}
                isSenior={false}
              />
            )}

            {activeTab === "cashflow" && (
              <CashflowView
                key={selectedClient.clientSheetId || "cashflow"}
                clientName={selectedClient.clientName || "Client"}
                data={cashData}
                keyData={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingCash || loadingKeyData || isRefreshing}
                error={cashError}
                onRefresh={() => handleRefreshCurrentView("cashflow")}
                isSenior={false}
              />
            )}

            {activeTab === "contractors" && (
              <PortalOutgoingsView
                key={`${selectedClient.clientSheetId}_contractors`}
                category="contractors"
                clientName={selectedClient.clientName || "Client"}
                clientSheetId={selectedClient.clientSheetId}
                data={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingKeyData || isRefreshing}
                error={keyDataError}
                onRefresh={() => handleRefreshCurrentView("contractors")}
                isReadOnly={false}
              />
            )}

            {activeTab === "expenses" && (
              <PortalOutgoingsView
                key={`${selectedClient.clientSheetId}_expenses`}
                category="expenses"
                clientName={selectedClient.clientName || "Client"}
                clientSheetId={selectedClient.clientSheetId}
                data={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingKeyData || isRefreshing}
                error={keyDataError}
                onRefresh={() => handleRefreshCurrentView("expenses")}
                isReadOnly={false}
              />
            )}

            {activeTab === "budgetOverview" && (
              <BudgetView
                key={selectedClient.clientSheetId || "budgetOverview"}
                clientName={selectedClient.clientName || "Client"}
                data={budgetData}
                allFYData={perfData}
                keyData={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingBudget || loadingPerf || loadingKeyData || isRefreshing}
                error={budgetError || perfError}
                onRefresh={() => handleRefreshCurrentView("budgetOverview")}
              />
            )}

            {activeTab === "salaries" && (
              <PortalSalariesView
                key={selectedClient.clientSheetId || "salaries"}
                clientName={selectedClient.clientName || "Client"}
                clientSheetId={selectedClient.clientSheetId}
                data={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingKeyData || isRefreshing}
                error={keyDataError}
                onRefresh={() => handleRefreshCurrentView("salaries")}
                isReadOnly={false}
              />
            )}

            {activeTab === "dividends" && (
              <PortalOutgoingsView
                key={`${selectedClient.clientSheetId}_dividends`}
                category="dividends"
                clientName={selectedClient.clientName || "Client"}
                clientSheetId={selectedClient.clientSheetId}
                data={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingKeyData || isRefreshing}
                error={keyDataError}
                onRefresh={() => handleRefreshCurrentView("dividends")}
                isReadOnly={false}
              />
            )}

            {activeTab === "nbToFind" && (
              <PortalNBToFindView
                key={selectedClient.clientSheetId || "nbToFind"}
                clientName={selectedClient.clientName || "Client"}
                clientSheetId={selectedClient.clientSheetId}
                data={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingKeyData || isRefreshing}
                error={keyDataError}
                onRefresh={() => handleRefreshCurrentView("nbToFind")}
                isReadOnly={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
