import React, { useState, useEffect, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
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
  { id: "budgetOverview", label: "Budget overview" },
  { id: "salaries", label: "Salaries" },
  { id: "dividends", label: "Dividends" },
  { id: "nbToFind", label: "New business to find" },
];

export default function ViewsScreen({
  allClients,
  styles,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient
}) {
  const { user } = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : !!(user?.isAdmin || user?.role === "Admin");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allClients || []).find((c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()) || managedClient;
    }
    if (typeof window !== "undefined") {
      const saved = sessionStorage.getItem("pma_views_client");
      const found = saved ? (allClients || []).find((c) => c.clientName === saved) : null;
      if (found) return found;
    }
    return (allClients && allClients.length > 0) ? allClients[0] : null;
  });
  const [clientSearch, setClientSearch] = useState("");
  const [activeTab, setActiveTab] = useState("fyPerformance");

  // Data Caches by clientSheetId
  const [payloadCache, setPayloadCache] = useState({});
  const [perfCache, setPerfCache] = useState({});
  const [cashCache, setCashCache] = useState({});
  const [keyDataCache, setKeyDataCache] = useState({});
  const [budgetCache, setBudgetCache] = useState({});

  // Loading States
  const [loadingPayload, setLoadingPayload] = useState(false);
  const [loadingPerf, setLoadingPerf] = useState(false);
  const [loadingCash, setLoadingCash] = useState(false);
  const [loadingKeyData, setLoadingKeyData] = useState(false);
  const [loadingBudget, setLoadingBudget] = useState(false);

  // Error States
  const [payloadError, setPayloadError] = useState(null);
  const [perfError, setPerfError] = useState(null);
  const [cashError, setCashError] = useState(null);
  const [keyDataError, setKeyDataError] = useState(null);
  const [budgetError, setBudgetError] = useState(null);

  // Auto-select managedClient when active
  useEffect(() => {
    if (managedClient) {
      const match = (allClients || []).find((c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()) || managedClient;
      setSelectedClient(match);
    }
  }, [managedClient, allClients]);

  // Auto-select first client if none selected, or restore from sessionStorage
  useEffect(() => {
    if (!managedClient && !selectedClient && allClients && allClients.length > 0) {
      const saved = typeof window !== "undefined" ? sessionStorage.getItem("pma_views_client") : null;
      const found = saved ? allClients.find((c) => c.clientName === saved) : null;
      if (found) {
        setSelectedClient(found);
      } else {
        setSelectedClient(allClients[0]);
      }
    }
  }, [allClients, selectedClient, managedClient]);

  const handleSelectClient = (client) => {
    setSelectedClient(client);
    if (client && typeof window !== "undefined") {
      sessionStorage.setItem("pma_views_client", client.clientName);
    }
  };

  // --- API DATA FETCHERS ---
  const fetchPayload = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (payloadCache[cid] || getCachedClientData(cid, "portal_payload")?.data) : null;
    if (cached) {
      setPayloadCache((prev) => ({ ...prev, [cid]: cached }));
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
            setPayloadCache((prev) => ({ ...prev, [cid]: fresh }));
            setLoadingPayload(false);
            return fresh;
          }
        } catch {}
      }
    }

    setLoadingPayload(true);
    setPayloadError(null);
    try {
      const url = `/api/portal/payload?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.payload) {
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
  }, [payloadCache, getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchPerformance = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (perfCache[cid] || getCachedClientData(cid, "portal_perf")?.data) : null;
    if (cached) {
      setPerfCache((prev) => ({ ...prev, [cid]: cached }));
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
            setPerfCache((prev) => ({ ...prev, [cid]: fresh }));
            setLoadingPerf(false);
            return fresh;
          }
        } catch {}
      }
    }

    setLoadingPerf(true);
    setPerfError(null);
    try {
      const url = `/api/portal/performance?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
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
  }, [perfCache, getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchCashflow = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (cashCache[cid] || getCachedClientData(cid, "portal_cash")?.data) : null;
    if (cached) {
      setCashCache((prev) => ({ ...prev, [cid]: cached }));
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
            setCashCache((prev) => ({ ...prev, [cid]: fresh }));
            setLoadingCash(false);
            return fresh;
          }
        } catch {}
      }
    }

    setLoadingCash(true);
    setCashError(null);
    try {
      const url = `/api/portal/cash?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
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
  }, [cashCache, getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchKeyData = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (keyDataCache[cid] || getCachedClientData(cid, "portal_key_data")?.data) : null;
    if (cached) {
      setKeyDataCache((prev) => ({ ...prev, [cid]: cached }));
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
            setKeyDataCache((prev) => ({ ...prev, [cid]: fresh }));
            setLoadingKeyData(false);
            return fresh;
          }
        } catch {}
      }
    }

    setLoadingKeyData(true);
    setKeyDataError(null);
    try {
      const url = `/api/portal/key-data?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
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
  }, [keyDataCache, getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

  const fetchBudget = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cid = client.clientSheetId;
    const cleanId = cleanSheetId ? cleanSheetId(cid) : String(cid).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? (budgetCache[cid] || getCachedClientData(cid, "portal_budget")?.data) : null;
    if (cached) {
      setBudgetCache((prev) => ({ ...prev, [cid]: cached }));
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
            setBudgetCache((prev) => ({ ...prev, [cid]: fresh }));
            setLoadingBudget(false);
            return fresh;
          }
        } catch {}
      }
    }

    setLoadingBudget(true);
    setBudgetError(null);
    try {
      const url = `/api/portal/budget?clientSheetId=${encodeURIComponent(cid)}&clientName=${encodeURIComponent(client.clientName || "")}${bypassCache ? "&bypassCache=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
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
  }, [budgetCache, getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId]);

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

  const handleRefreshCurrentView = () => {
    if (!selectedClient) return;
    fetchPayload(selectedClient, true);

    if (activeTab === "fyPerformance") {
      fetchPerformance(selectedClient, true);
      fetchKeyData(selectedClient, true);
    } else if (activeTab === "cashflow") {
      fetchCashflow(selectedClient, true);
      fetchKeyData(selectedClient, true);
    } else if (activeTab === "budgetOverview") {
      fetchBudget(selectedClient, true);
      fetchPerformance(selectedClient, true);
      fetchKeyData(selectedClient, true);
    } else if (
      ["contractors", "expenses", "salaries", "dividends", "nbToFind"].includes(activeTab)
    ) {
      fetchKeyData(selectedClient, true);
    }
  };

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

  const filteredClients = (allClients || []).filter((c) =>
    (c.clientName || "").toLowerCase().includes(clientSearch.toLowerCase().trim())
  );

  return (
    <div style={{ padding: "20px 24px", maxWidth: "1500px", margin: "0 auto", fontFamily: "system-ui, -apple-system, sans-serif" }}>
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
          padding: "14px 20px",
          borderRadius: "12px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: "20px", fontWeight: "700", color: "#0f172a" }}>
            Client views
          </h1>

          {!managedClient && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label htmlFor="pma-views-client-selector" style={{ fontSize: "13px", fontWeight: "600", color: "#64748b" }}>
                Client:
              </label>
              <select
                id="pma-views-client-selector"
                value={selectedClient?.clientName || ""}
                onChange={(e) => {
                  const found = (allClients || []).find((c) => c.clientName === e.target.value);
                  if (found) handleSelectClient(found);
                }}
                style={{
                  padding: "8px 14px",
                  fontSize: "13.5px",
                  fontWeight: "600",
                  color: "#1e293b",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "8px",
                  cursor: "pointer",
                  outline: "none",
                  minWidth: "220px",
                }}
              >
                <option value="" disabled>-- Select a Client --</option>
                {(allClients || []).map((c) => (
                  <option key={c.clientName} value={c.clientName}>
                    {c.clientName}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Right Actions */}
        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              onClick={handleRefreshCurrentView}
              disabled={isCurrentViewLoading}
              className="triage-btn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#0284c7",
                background: "#e0f2fe",
                border: "1px solid #bae6fd",
                borderRadius: "8px",
                cursor: isCurrentViewLoading ? "not-allowed" : "pointer",
              }}
              title="Pull fresh live data from Google Sheet"
            >
              <span style={{ display: "inline-block", transform: isCurrentViewLoading ? "rotate(180deg)" : "none", transition: "transform 0.5s" }}>
                🔄
              </span>
              <span>{isCurrentViewLoading ? "Refreshing..." : "Refresh Live Data"}</span>
            </button>

            {isAdmin && (selectedClient.clientSheetId || selectedClient.masterSheetId) && (
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
            )}
          </div>
        )}
      </div>

      {/* Main Container Area */}
      {selectedClient && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", overflow: "hidden" }}>
          {/* Tabs Navigation Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: "#f8fafc",
              borderBottom: "1px solid #e2e8f0",
              padding: "0 12px",
              overflowX: "auto",
              scrollbarWidth: "none",
            }}
            className="client-views-tabs"
          >
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="no-click-spinner client-views-tab"
                  style={{
                    background: isActive ? "#ffffff" : "transparent",
                    border: "none",
                    borderTop: isActive ? "3px solid #0066cc" : "3px solid transparent",
                    borderLeft: isActive ? "1px solid #e2e8f0" : "1px solid transparent",
                    borderRight: isActive ? "1px solid #e2e8f0" : "1px solid transparent",
                    borderBottom: isActive ? "1px solid #ffffff" : "none",
                    color: isActive ? "#0066cc" : "#64748b",
                    fontWeight: isActive ? "700" : "500",
                    fontSize: "13.5px",
                    padding: "12px 18px",
                    cursor: "pointer",
                    marginBottom: "-1px",
                    borderRadius: isActive ? "8px 8px 0 0" : "0",
                    whiteSpace: "nowrap",
                    transition: "all 0.15s ease",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* View Content Display */}
          <div style={{ padding: "20px" }}>
            {activeTab === "fyPerformance" && (
              <PerformanceFYView
                key={selectedClient.clientSheetId || "fyPerformance"}
                clientName={selectedClient.clientName || "Client"}
                data={perfData}
                keyData={keyData}
                currencySymbol={currencySymbol}
                thousandsSeparator={thousandsSeparator}
                isLoading={loadingPerf}
                error={perfError}
                onRefresh={() => fetchPerformance(selectedClient, true)}
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
                isLoading={loadingCash}
                error={cashError}
                onRefresh={() => fetchCashflow(selectedClient, true)}
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
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={() => fetchKeyData(selectedClient, true)}
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
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={() => fetchKeyData(selectedClient, true)}
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
                isLoading={loadingBudget || loadingPerf}
                error={budgetError || perfError}
                onRefresh={() => {
                  fetchBudget(selectedClient, true);
                  fetchPerformance(selectedClient, true);
                }}
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
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={() => fetchKeyData(selectedClient, true)}
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
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={() => fetchKeyData(selectedClient, true)}
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
                isLoading={loadingKeyData}
                error={keyDataError}
                onRefresh={() => fetchKeyData(selectedClient, true)}
                isReadOnly={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
