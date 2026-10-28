import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaHomeSkeleton } from "./Skeleton";
import { isUserAuthorizedForClient, ADMIN_ONLY_FLAG_KEYS, ADMIN_ONLY_PROACTIVE_TYPES, getFlagName } from "../utils/helpers";
import { getCrmToolType } from "../utils/integrationsBadge";

function resolveCrmStatus(crmTool, statusObj = {}) {
  const crmToolKey = getCrmToolType(crmTool, statusObj.integrations);
  const normCrm = String(crmTool || "").trim().toLowerCase();
  const isGoogleSheet = normCrm.includes("sheet") || normCrm.includes("google") || crmToolKey === "googlesheet";
  const isExcel = normCrm.includes("excel") || normCrm.includes("microsoft") || crmToolKey === "excel";

  const toolKey = isGoogleSheet ? "googlesheet" : isExcel ? "excel" : (crmToolKey !== "none" ? crmToolKey : normCrm);
  const specificStatus = statusObj.integrations?.[toolKey] || {};
  const generalStatus = statusObj.crmStatus || {};

  const isConnected = Boolean(specificStatus.connected || generalStatus.connected);
  const reconnectNeeded = Boolean(
    specificStatus.reconnectRequired ||
    generalStatus.reconnectRequired ||
    specificStatus.status === "reconnect_required" ||
    generalStatus.status === "reconnect_required"
  );

  const isHealthy = isConnected && !reconnectNeeded;
  const displayCrm = isGoogleSheet
    ? "Google Sheet"
    : isExcel
      ? "Excel"
      : crmTool && crmTool !== "None"
        ? crmTool
        : toolKey !== "none"
          ? (toolKey.charAt(0).toUpperCase() + toolKey.slice(1))
          : "None";

  const hasCrm = displayCrm !== "None" && displayCrm !== "";

  return {
    hasCrm,
    displayCrm,
    isHealthy,
    toolKey,
  };
}

const ACTIONABLE_FLAG_KEYS = [
  "invoiceDashboardDiscr",
  "expenseDashboardDiscr",
  "crmPipeDashDiscr",
  "crmPipeAppDiscr",
  "crmConfDashDiscr",
  "crmConfAppDiscr",
];

export default function HomeView({
  clients = [],
  clientsWithFlags = [],
  proactiveAlerts = [],
  proactiveCountsByClient = {},
  assignedByClient = {},
  assignedAppIds = new Set(),
  navTaskCount = 0,
  user,
  isAdmin = false,
  onGoToAlerts,
  onGoToTasks,
  onGoToSetup,
  onGoToIntegrations,
  onSelectClientAlerts,
  isLoadingAlerts = false,
  triageComplete = false,
  managedClient,
  onClearManagedClient,
  integrationsData: propIntegrationsData = null
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [localIntegrationsData, setLocalIntegrationsData] = useState([]);
  const integrationsData = (Array.isArray(propIntegrationsData) && propIntegrationsData.length > 0)
    ? propIntegrationsData
    : localIntegrationsData;
  const [integrationsLoading, setIntegrationsLoading] = useState(
    !(Array.isArray(propIntegrationsData) && propIntegrationsData.length > 0)
  );

  // Optimistic cached alert count from previous session (hydrated in useEffect for SSR safety)
  const [cachedTotalAlerts, setCachedTotalAlerts] = useState(null);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("pulse_cached_total_alerts");
      if (stored != null) setCachedTotalAlerts(Number(stored));
    } catch { }
  }, []);

  // Filter clients to those the current user has access to
  const effectiveClients = (clients && clients.length > 0) ? clients : integrationsData;
  const authorizedClients = useMemo(() => {
    let list = (effectiveClients || []).filter((c) => isUserAuthorizedForClient(user, c.clientName));
    if (managedClient?.clientName) {
      list = list.filter((c) => c.clientName?.toLowerCase() === managedClient.clientName.toLowerCase());
    }
    return list;
  }, [effectiveClients, user, managedClient]);

  // Fetch integration and setup statuses only if not already provided by parent TriageSystem
  useEffect(() => {
    if (Array.isArray(propIntegrationsData)) {
      if (propIntegrationsData.length > 0) setIntegrationsLoading(false);
      return;
    }
    let isMounted = true;
    setIntegrationsLoading(true);
    fetch("/api/integrations/status?all=true")
      .then((res) => res.json())
      .then((data) => {
        if (isMounted && data.success && Array.isArray(data.allClients)) {
          setLocalIntegrationsData(data.allClients);
        }
      })
      .catch((err) => {
        console.warn("HomeView: failed to fetch integration statuses:", err.message);
      })
      .finally(() => {
        if (isMounted) setIntegrationsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [propIntegrationsData]);

  // Map integrations data by client name
  const clientIntegrationsMap = useMemo(() => {
    const map = {};
    for (const item of integrationsData) {
      if (item.clientName) {
        map[item.clientName.toLowerCase()] = item;
      }
    }
    return map;
  }, [integrationsData]);

  const authorizedProactiveAlerts = useMemo(() => {
    return (proactiveAlerts || []).filter(
      (a) =>
        isUserAuthorizedForClient(user, a.clientName) &&
        (isAdmin || !ADMIN_ONLY_PROACTIVE_TYPES.has(a.alertType))
    );
  }, [proactiveAlerts, user, isAdmin]);

  // Calculate alert counts per client
  const clientAlertCounts = useMemo(() => {
    const counts = {};
    for (const c of clientsWithFlags || []) {
      if (!isUserAuthorizedForClient(user, c.clientName)) continue;
      const normClient = String(c.clientName || "").trim().toLowerCase();
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
        if (normClient && (assignedAppIds.has(`${normClient}::${clean}`) || assignedAppIds.has(`${normClient}::${s}`))) return true;
        return false;
      };
      const expenseIds = c.activeExpenseIds || [];
      const invoiceIds = c.activeInvoiceIds || [];
      const validAssignedExp = expenseIds.filter(isIdMatch).length;
      const validAssignedInv = invoiceIds.filter(isIdMatch).length;

      let clientTotal = 0;
      Object.entries(c.flags || {}).forEach(([flagKey, isSet]) => {
        if (!isSet || (!isAdmin && ADMIN_ONLY_FLAG_KEYS.has(flagKey))) return;
        let count = c.alertCounts?.[flagKey] || 0;
        if (ACTIONABLE_FLAG_KEYS.includes(flagKey)) {
          if (flagKey === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
          if (flagKey === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
          clientTotal += count;
        } else {
          clientTotal += count > 0 ? count : 0;
        }
      });
      counts[c.clientName] = (counts[c.clientName] || 0) + clientTotal;
    }

    // Add proactive alerts
    for (const a of authorizedProactiveAlerts) {
      if (a.clientName) {
        counts[a.clientName] = (counts[a.clientName] || 0) + 1;
      }
    }

    return counts;
  }, [clientsWithFlags, authorizedProactiveAlerts, user, isAdmin, assignedByClient, assignedAppIds]);

  // Total alerts needing processing across all authorized clients (or managed client)
  const totalAlertsCount = useMemo(() => {
    if (managedClient?.clientName) {
      const target = managedClient.clientName.toLowerCase();
      const matchKey = Object.keys(clientAlertCounts).find(k => k.toLowerCase() === target);
      return matchKey ? (clientAlertCounts[matchKey] || 0) : (clientAlertCounts[managedClient.clientName] || 0);
    }
    return Object.values(clientAlertCounts).reduce((acc, count) => acc + count, 0);
  }, [clientAlertCounts, managedClient]);

  // Sync latest confirmed alert count to localStorage (only when not in managedClient mode)
  useEffect(() => {
    if (!managedClient && triageComplete && !isLoadingAlerts && totalAlertsCount != null) {
      setCachedTotalAlerts(totalAlertsCount);
      try {
        localStorage.setItem("pulse_cached_total_alerts", String(totalAlertsCount));
        localStorage.setItem("pulse_cached_alert_badge", String(totalAlertsCount));
      } catch { }
    }
  }, [triageComplete, isLoadingAlerts, totalAlertsCount, managedClient]);

  // Clients that are not yet fully set up
  const clientsPendingSetup = useMemo(() => {
    return authorizedClients.filter((c) => {
      const statusObj = clientIntegrationsMap[c.clientName.toLowerCase()];
      if (!statusObj) return false;
      const isSetupMode = Boolean(statusObj.setupMode || statusObj.isSetupMode);
      const missingRequired = statusObj.allRequiredToolsConnected === false;
      return isSetupMode || missingRequired;
    });
  }, [authorizedClients, clientIntegrationsMap]);

  // Filtered clients for the client summary table
  const filteredClients = useMemo(() => {
    return authorizedClients.filter((c) =>
      c.clientName?.toLowerCase().includes(searchTerm.toLowerCase().trim())
    );
  }, [authorizedClients, searchTerm]);

  if (effectiveClients.length === 0 && !managedClient) {
    return <PmaHomeSkeleton />;
  }

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box", fontFamily: "'Kumbh Sans', system-ui, -apple-system, sans-serif" }}>
      {/* Page Header */}
      <div
        style={{
          marginBottom: "20px",
          background: "#FFFFFF",
          padding: "16px 20px",
          borderRadius: "10px",
          border: "1px solid #E2E8F0",
          boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px"
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "700", color: "#0F172A" }}>
            Home{managedClient ? ` — ${managedClient.clientName}` : ""}
          </h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            {managedClient
              ? `Overview of alerts, tasks, and integrations for ${managedClient.clientName}`
              : "Overview of alerts, tasks, setup status and integrations"}
          </p>
        </div>
      </div>

      {/* Top Summary Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px", marginBottom: "28px" }}>
        {/* 1. Alert Summary Card */}
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            border: "1px solid #E2E8F0",
            padding: "20px 22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            transition: "box-shadow 0.15s ease",
          }}
        >
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.6px", color: "#64748B" }}>
                Alerts needing processing
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: totalAlertsCount > 0 ? "rgba(239, 68, 68, 0.12)" : "rgba(34, 197, 94, 0.12)",
                  color: totalAlertsCount > 0 ? "#DC2626" : "#16A34A",
                  fontSize: "14px",
                  fontWeight: "700",
                }}
              >
                {totalAlertsCount > 0 ? "!" : "✓"}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "8px" }}>
              {isLoadingAlerts && cachedTotalAlerts === null && !managedClient ? (
                <div style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "2px 0" }}>
                  <Skeleton width="55px" height="36px" borderRadius="6px" />
                  <Skeleton width="85px" height="14px" />
                </div>
              ) : (
                <>
                  <span style={{ fontSize: "36px", fontWeight: "800", color: (((!managedClient && !triageComplete && cachedTotalAlerts !== null ? cachedTotalAlerts : totalAlertsCount) > 0)) ? "#DC2626" : "#0F172A", lineHeight: 1 }}>
                    {!managedClient && !triageComplete && cachedTotalAlerts !== null ? cachedTotalAlerts : totalAlertsCount}
                  </span>
                  <span style={{ fontSize: "14px", color: "#64748B", fontWeight: "500", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    total {(!managedClient && !triageComplete && cachedTotalAlerts !== null ? cachedTotalAlerts : totalAlertsCount) === 1 ? "alert" : "alerts"}
                    {!managedClient && isLoadingAlerts && cachedTotalAlerts !== null && (
                      <span style={{ fontSize: "12px", color: "#94A3B8" }}>(syncing...)</span>
                    )}
                  </span>
                </>
              )}
            </div>

            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#64748B", lineHeight: "1.4" }}>
              {totalAlertsCount === 0 && !isLoadingAlerts
                ? (managedClient?.clientName
                  ? `All alerts for ${managedClient.clientName} are currently clear.`
                  : "There are no active alerts across your clients.")
                : (managedClient?.clientName
                  ? `Active discrepancies and proactive alerts for ${managedClient.clientName}.`
                  : `Total active discrepancies and proactive alerts across all ${authorizedClients.length} clients.`)}
            </p>
          </div>

          <a
            href={managedClient?.clientName ? `/pma/alerts?client=${encodeURIComponent(managedClient.clientName)}` : "/pma/alerts"}
            className="triage-btn"
            onClick={(e) => {
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                e.preventDefault();
                onGoToAlerts?.();
              }
            }}
            style={{
              background: "#0047AB",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "8px",
              padding: "10px 16px",
              fontSize: "13.5px",
              fontWeight: "600",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              width: "100%",
              textDecoration: "none",
              boxSizing: "border-box"
            }}
          >
            <span>Go to alerts</span>
            <span style={{ fontSize: "14px" }}>→</span>
          </a>
        </div>

        {/* 2. Task Summary Card */}
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            border: "1px solid #E2E8F0",
            padding: "20px 22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            transition: "box-shadow 0.15s ease",
          }}
        >
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.6px", color: "#64748B" }}>
                Active tasks
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: navTaskCount > 0 ? "rgba(245, 158, 11, 0.12)" : "rgba(34, 197, 94, 0.12)",
                  color: navTaskCount > 0 ? "#D97706" : "#16A34A",
                  fontSize: "14px",
                  fontWeight: "700",
                }}
              >
                {navTaskCount > 0 ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                  </svg>
                ) : "✓"}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "8px" }}>
              <span style={{ fontSize: "36px", fontWeight: "800", color: navTaskCount > 0 ? "#D97706" : "#0F172A", lineHeight: 1 }}>
                {navTaskCount}
              </span>
              <span style={{ fontSize: "14px", color: "#64748B", fontWeight: "500" }}>
                active {navTaskCount === 1 ? "task" : "tasks"}
              </span>
            </div>

            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#64748B", lineHeight: "1.4" }}>
              {navTaskCount === 0
                ? "No active follow-up tasks."
                : "Deferred items and follow-up tasks awaiting action."}
            </p>
          </div>

          <a
            href={managedClient?.clientName ? `/pma?nav=tasks&client=${encodeURIComponent(managedClient.clientName)}` : "/pma?nav=tasks"}
            className="triage-btn"
            onClick={(e) => {
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                e.preventDefault();
                onGoToTasks?.();
              }
            }}
            style={{
              background: "#F8FAFC",
              color: "#1E293B",
              border: "1px solid #CBD5E1",
              borderRadius: "8px",
              padding: "10px 16px",
              fontSize: "13.5px",
              fontWeight: "600",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              width: "100%",
              textDecoration: "none",
              boxSizing: "border-box"
            }}
          >
            <span>Go to tasks</span>
            <span style={{ fontSize: "14px" }}>→</span>
          </a>
        </div>
      </div>

      {/* 3. Setup Section */}
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "22px", marginBottom: "28px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                Setup status
              </h2>
              {clientsPendingSetup.length > 0 && (
                <span style={{ background: "#FEF3C7", color: "#B45309", border: "1px solid #FCD34D", padding: "1px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>
                  {clientsPendingSetup.length} pending
                </span>
              )}
            </div>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#64748B" }}>
              Clients that are in Setup Mode or have missing tool connections.
            </p>
          </div>


          <a
            href={managedClient?.clientName ? `/pma?nav=setup&client=${encodeURIComponent(managedClient.clientName)}` : "/pma?nav=setup"}
            className="triage-btn"
            onClick={(e) => {
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                e.preventDefault();
                onGoToSetup && onGoToSetup();
              }
            }}
            style={{
              background: "#F1F5F9",
              color: "#334155",
              border: "1px solid #CBD5E1",
              borderRadius: "6px",
              padding: "6px 12px",
              fontSize: "12.5px",
              fontWeight: "600",
              cursor: "pointer",
              textDecoration: "none",
              display: "inline-block"
            }}
          >
            Manage client setup →
          </a>
        </div>

        {integrationsLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
            {[1, 2, 3].map((card) => (
              <div
                key={card}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #f1f5f9",
                  borderRadius: "8px",
                  padding: "16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Skeleton width="110px" height="14px" />
                  <Skeleton width="75px" height="16px" borderRadius="4px" />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <Skeleton width="85%" height="12px" />
                  <Skeleton width="65%" height="12px" />
                </div>
                <Skeleton width="100%" height="32px" borderRadius="6px" style={{ marginTop: "4px" }} />
              </div>
            ))}
          </div>
        ) : clientsPendingSetup.length === 0 ? (
          <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: "8px", padding: "14px 16px", color: "#166534", fontSize: "13.5px", display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "16px", fontWeight: "bold" }}>✓</span>
            <span>All clients are fully set up.</span>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
            {clientsPendingSetup.map((c) => {
              const statusObj = clientIntegrationsMap[c.clientName.toLowerCase()] || {};
              const accTool = statusObj.accountingTool || "None";
              const crmTool = statusObj.crmTool || "None";
              const isSetupMode = Boolean(statusObj.setupMode || statusObj.isSetupMode);
              const crmInfo = resolveCrmStatus(crmTool, statusObj);
              const accHealthy = Boolean(
                statusObj.accountingStatus?.connected &&
                !statusObj.accountingStatus?.reconnectRequired &&
                statusObj.accountingStatus?.status !== "reconnect_required"
              );

              return (
                <div
                  key={c.clientName}
                  style={{
                    background: "#FFFBEB",
                    border: "1px solid #FDE68A",
                    borderRadius: "8px",
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "10px",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "6px", marginBottom: "6px" }}>
                      <span style={{ fontWeight: "700", fontSize: "14px", color: "#78350F" }}>
                        {c.clientName}
                      </span>
                      {isSetupMode && (
                        <span style={{ background: "#FEF3C7", color: "#B45309", border: "1px solid #FCD34D", padding: "1px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: "700" }}>
                          🛠️ Setup mode
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "12px", color: "#92400E", lineHeight: "1.5" }}>
                      <div>Accounting: {accTool} {accHealthy ? "● Connected" : accTool !== "None" ? "○ Needs connection" : ""}</div>
                      <div>
                        CRM: {crmInfo.displayCrm !== "None" ? crmInfo.displayCrm : "None"}{" "}
                        {crmInfo.hasCrm
                          ? (crmInfo.isHealthy ? "● Connected" : "○ Needs connection")
                          : ""}
                      </div>
                    </div>
                  </div>

                  <a
                    href={`/pma?nav=setup&client=${encodeURIComponent(c.clientName)}`}
                    className="triage-btn"
                    onClick={(e) => {
                      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                        e.preventDefault();
                        onGoToSetup && onGoToSetup(c.clientName);
                      }
                    }}
                    style={{
                      background: "#FFFFFF",
                      color: "#92400E",
                      border: "1px solid #FCD34D",
                      borderRadius: "6px",
                      padding: "6px 12px",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer",
                      textAlign: "center",
                      textDecoration: "none",
                      display: "inline-block"
                    }}
                  >
                    Open in setup →
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Client Summary Section */}
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "22px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                Client summary
              </h2>
              <span style={{ background: "#F1F5F9", color: "#475569", border: "1px solid #CBD5E1", padding: "1px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>
                {authorizedClients.length} clients
              </span>
            </div>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#64748B" }}>
              Overview of all clients, active alerts, and integrations status.
            </p>
          </div>

          {/* Client Search */}
          <div style={{ minWidth: "220px" }}>
            <input
              type="text"
              placeholder="Search clients..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: "100%",
                padding: "7px 12px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #CBD5E1",
                outline: "none",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
          </div>
        </div>

        {/* Compact Table */}
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
            <thead>
              <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569", fontSize: "11.5px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={{ padding: "10px 14px", fontWeight: "700" }}>Client</th>
                <th style={{ padding: "10px 14px", fontWeight: "700" }}>Setup Status</th>
                <th style={{ padding: "10px 14px", fontWeight: "700" }}>Active Alerts</th>
                <th style={{ padding: "10px 14px", fontWeight: "700" }}>Integrations</th>
                <th style={{ padding: "10px 14px", fontWeight: "700", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "24px", textAlign: "center", color: "#94A3B8" }}>
                    No clients match your filter.
                  </td>
                </tr>
              ) : (
                filteredClients.map((client) => {
                  const statusObj = clientIntegrationsMap[client.clientName.toLowerCase()] || {};
                  const isSetup = Boolean(statusObj.setupMode || statusObj.isSetupMode);
                  const alertCount = clientAlertCounts[client.clientName] || 0;
                  const accTool = statusObj.accountingTool || "None";
                  const crmTool = statusObj.crmTool || "None";
                  const accHealthy = Boolean(
                    statusObj.accountingStatus?.connected &&
                    !statusObj.accountingStatus?.reconnectRequired &&
                    statusObj.accountingStatus?.status !== "reconnect_required"
                  );
                  const crmInfo = resolveCrmStatus(crmTool, statusObj);

                  return (
                    <tr
                      key={client.clientName}
                      style={{
                        borderBottom: "1px solid #F1F5F9",
                        transition: "background 0.1s ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#F8FAFC"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      {/* Client Name */}
                      <td style={{ padding: "10px 14px", fontWeight: "600", color: "#0F172A" }}>
                        {client.clientName}
                      </td>

                      {/* Setup status */}
                      <td style={{ padding: "10px 14px" }}>
                        {isSetup ? (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: "12px",
                              fontSize: "11px",
                              fontWeight: "700",
                              background: "#FEF3C7",
                              color: "#B45309",
                              border: "1px solid #FCD34D",
                            }}
                          >
                            🛠️ Setup mode
                          </span>
                        ) : (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: "12px",
                              fontSize: "11px",
                              fontWeight: "700",
                              background: "#DCFCE7",
                              color: "#15803D",
                              border: "1px solid #86EFAC",
                            }}
                          >
                            ● Live
                          </span>
                        )}
                      </td>

                      {/* Active Alerts */}
                      <td style={{ padding: "10px 14px" }}>
                        {alertCount > 0 ? (
                          <button
                            type="button"
                            className="triage-btn"
                            onClick={() => onSelectClientAlerts && onSelectClientAlerts(client.clientName)}
                            title="Click to view alerts for this client"
                            style={{
                              background: "#FEE2E2",
                              color: "#DC2626",
                              border: "1px solid #FCA5A5",
                              borderRadius: "12px",
                              padding: "2px 9px",
                              fontSize: "11.5px",
                              fontWeight: "700",
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <span>{alertCount}</span>
                            <span style={{ fontSize: "10px" }}>alerts →</span>
                          </button>
                        ) : (
                          <span style={{ color: "#94A3B8", fontSize: "12px" }}>0 alerts</span>
                        )}
                      </td>

                      {/* Integrations Status */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                          {/* Accounting badge */}
                          {accTool !== "None" ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "600",
                                background: accHealthy ? "#ECFDF5" : "#FEF2F2",
                                color: accHealthy ? "#047857" : "#B91C1C",
                                border: `1px solid ${accHealthy ? "#A7F3D0" : "#FECACA"}`,
                              }}
                              title={`Accounting: ${accTool} (${accHealthy ? "Connected" : "Disconnected"})`}
                            >
                              <span>{accHealthy ? "●" : "○"}</span>
                              <span>{accTool}</span>
                            </span>
                          ) : (
                            <span style={{ fontSize: "11px", color: "#94A3B8" }}>No accounting</span>
                          )}

                          {/* CRM badge */}
                          {crmInfo.hasCrm ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "600",
                                background: crmInfo.isHealthy ? "#ECFDF5" : "#FEF2F2",
                                color: crmInfo.isHealthy ? "#047857" : "#B91C1C",
                                border: `1px solid ${crmInfo.isHealthy ? "#A7F3D0" : "#FECACA"}`,
                              }}
                              title={`CRM: ${crmInfo.displayCrm} (${crmInfo.isHealthy ? "Connected" : "Disconnected"})`}
                            >
                              <span>{crmInfo.isHealthy ? "●" : "○"}</span>
                              <span>{crmInfo.displayCrm}</span>
                            </span>
                          ) : null}
                        </div>
                      </td>

                      {/* Actions */}
                      <td style={{ padding: "10px 14px", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                          {alertCount > 0 && (
                            <a
                              href={`/pma/alerts?client=${encodeURIComponent(client.clientName)}`}
                              className="triage-btn"
                              onClick={(e) => {
                                if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                                  e.preventDefault();
                                  onSelectClientAlerts && onSelectClientAlerts(client.clientName);
                                }
                              }}
                              style={{
                                background: "#F1F5F9",
                                color: "#0047AB",
                                border: "1px solid #CBD5E1",
                                borderRadius: "4px",
                                padding: "3px 8px",
                                fontSize: "11px",
                                fontWeight: "600",
                                cursor: "pointer",
                                textDecoration: "none",
                                display: "inline-block"
                              }}
                            >
                              Alerts
                            </a>
                          )}
                          <a
                            href={`/pma?nav=setup&client=${encodeURIComponent(client.clientName)}`}
                            className="triage-btn"
                            onClick={(e) => {
                              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                                e.preventDefault();
                                onGoToSetup && onGoToSetup(client.clientName);
                              }
                            }}
                            style={{
                              background: "#F8FAFC",
                              color: "#475569",
                              border: "1px solid #CBD5E1",
                              borderRadius: "4px",
                              padding: "3px 8px",
                              fontSize: "11px",
                              fontWeight: "600",
                              cursor: "pointer",
                              textDecoration: "none",
                              display: "inline-block"
                            }}
                          >
                            Setup
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
