import React from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaAlertsSkeleton } from "./Skeleton";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useAuth } from "../hooks/useAuth";
import { isUserAuthorizedForClient, ADMIN_ONLY_FLAG_KEYS, ADMIN_ONLY_PROACTIVE_TYPES } from "../utils/helpers";

export default function ClientSelectionView({
  styles,
  isLoading,
  error,
  getFlagName,
  PROACTIVE_TYPE_LABELS,
  setScreen,
  loadIgnoredAlerts,
  user,
  managedClient,
  onClearManagedClient,
  isSingleClientUser = false
}) {
  const auth = useAuth();
  const currentUser = user || auth.user;
  const isAdmin = !!(currentUser?.isAdmin || currentUser?.role === "Admin");

  const isFlagVisible = (flagKey) => isAdmin || !ADMIN_ONLY_FLAG_KEYS.has(flagKey);
  const isProactiveVisible = (alertType) => isAdmin || !ADMIN_ONLY_PROACTIVE_TYPES.has(alertType);

  const {
    refreshStatus, acceptError, clientsWithFlags, proactiveAlerts,
    proactiveCountsByClient, proactiveLoadedAt, selectingClient,
    selectClient, reloadFromCache, refreshTriage
  } = useTriage();

  let authorizedClientsWithFlags = (clientsWithFlags || []).filter(c =>
    isUserAuthorizedForClient(currentUser, c.clientName)
  );
  if (managedClient?.clientName) {
    authorizedClientsWithFlags = authorizedClientsWithFlags.filter(c =>
      c.clientName?.toLowerCase() === managedClient.clientName.toLowerCase()
    );
  }

  let authorizedProactiveAlerts = (proactiveAlerts || []).filter(a =>
    isUserAuthorizedForClient(currentUser, a.clientName) && isProactiveVisible(a.alertType)
  );
  if (managedClient?.clientName) {
    authorizedProactiveAlerts = authorizedProactiveAlerts.filter(a =>
      a.clientName?.toLowerCase() === managedClient.clientName.toLowerCase()
    );
  }

  const authorizedProactiveCountsByClient = Object.fromEntries(
    Object.entries(
      (authorizedProactiveAlerts || []).reduce((acc, a) => {
        acc[a.clientName] = (acc[a.clientName] || 0) + 1;
        return acc;
      }, {})
    ).filter(([name]) => isUserAuthorizedForClient(currentUser, name))
  );

  const {
    allClientsMap, assignedByClient, assignedAppIds, showDebugPanel, setShowDebugPanel,
    debugClientName, setDebugClientName, runDebug, debugLoading, setDebugLoading,
    automationCommanderSheetId, setDebugResult, debugResult
  } = useAppGlobals();
  const ACTIONABLE_FLAG_KEYS = [
    "invoiceDashboardDiscr", "expenseDashboardDiscr",
    "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
  ];

  const getValidAssignedCounts = (client) => {
    if (!client) return { validAssignedExp: 0, validAssignedInv: 0 };
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
      if (normClient && (assignedAppIds.has(`${normClient}::${clean}`) || assignedAppIds.has(`${normClient}::${s}`))) return true;
      return false;
    };
    const expenseIds = client.activeExpenseIds || [];
    const invoiceIds = client.activeInvoiceIds || [];
    return {
      validAssignedExp: expenseIds.filter(isIdMatch).length,
      validAssignedInv: invoiceIds.filter(isIdMatch).length,
    };
  };

  const totalAlertsCount = authorizedClientsWithFlags.reduce((total, c) => {
    const { validAssignedExp, validAssignedInv } = getValidAssignedCounts(c);
    let clientTotal = 0;
    Object.entries(c.flags || {}).forEach(([flagKey, isSet]) => {
      if (!isSet || !isFlagVisible(flagKey)) return;
      let count = c.alertCounts?.[flagKey] || 0;
      if (ACTIONABLE_FLAG_KEYS.includes(flagKey)) {
        if (flagKey === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
        if (flagKey === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
        clientTotal += count;
      } else {
        clientTotal += (count > 0 ? count : 0);
      }
    });
    return total + clientTotal;
  }, 0) + authorizedProactiveAlerts.length;

  // State 1: All alerts have been resolved
  if (totalAlertsCount === 0 && proactiveLoadedAt > 0) {
    return (
      <div className="pma-page-container" style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alerts{managedClient ? ` — ${managedClient.clientName}` : ""}</h1>
          <p style={styles.subtitle}>
            {managedClient ? `All alerts for ${managedClient.clientName} have been resolved` : "All alerts have been resolved"}
          </p>
        </div>
        <div style={styles.card}>
          <div style={styles.successBanner}>
            ✓ {managedClient ? `No outstanding alerts for ${managedClient.clientName}` : "No outstanding alerts"}
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button className="triage-btn" onClick={reloadFromCache} disabled={isLoading} style={{ ...styles.buttonSecondary, opacity: isLoading ? 0.5 : 1 }}>
              ⚡ Reload
            </button>
            {isAdmin && (
              <button className="triage-btn" onClick={() => refreshTriage(true)} disabled={isLoading} style={{ ...styles.buttonSecondary, opacity: isLoading ? 0.5 : 1 }}>
                {isLoading ? <><Spinner />{refreshStatus || "Refreshing..."}</> : "↻ Refresh"}
              </button>
            )}
            {!isSingleClientUser && managedClient && onClearManagedClient && (
              <button className="triage-btn" onClick={onClearManagedClient} style={{ ...styles.buttonSecondary }}>
                ← View all clients
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // State 2: Checking for alerts
  if (totalAlertsCount === 0 && proactiveLoadedAt === 0) {
    return <PmaAlertsSkeleton />;
  }

  // State 3: Main Alerts List
  return (
    <div className="pma-page-container" style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Alerts{managedClient ? ` — ${managedClient.clientName}` : ""}</h1>
        <p style={styles.subtitle}>
          {managedClient
            ? `${totalAlertsCount} alert${totalAlertsCount !== 1 ? "s" : ""} requiring attention for ${managedClient.clientName}`
            : `Select a client to review alert details (${totalAlertsCount} total)`}
        </p>
      </div>

      <div style={styles.card}>

        {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {isLoading ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px", color: "#64748b", fontSize: "13px", fontFamily: "'Kumbh Sans', sans-serif" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "14px",
                  height: "14px",
                  border: "2px solid #cbd5e1",
                  borderTopColor: "#0047AB",
                  borderRadius: "50%",
                  animation: "pulse-spin 0.8s linear infinite",
                }}
              />
              <span>{refreshStatus || "Updating alerts..."}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {[
                { nameW: "150px", lines: ["240px", "190px"] },
                { nameW: "180px", lines: ["280px", "210px", "160px"] },
                { nameW: "130px", lines: ["220px"] },
                { nameW: "165px", lines: ["260px", "175px"] },
              ].map((c, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "16px 18px",
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    background: "#f8fafc",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Skeleton width={c.nameW} height="16px" />
                    <Skeleton width="50px" height="15px" borderRadius="10px" />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "2px" }}>
                    {c.lines.map((w, l) => (
                      <div key={l} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ color: "#94a3b8", fontSize: "14px", lineHeight: "1" }}>•</span>
                        <Skeleton className="pulse-skeleton-blue" width={w} height="13px" borderRadius="3px" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {(() => {
              const proactiveOnlyNames = Object.keys(authorizedProactiveCountsByClient).filter(
                name => (authorizedProactiveCountsByClient[name] || 0) > 0 && !authorizedClientsWithFlags.some(c => c.clientName === name)
              );
              const combinedClientList = [
                ...authorizedClientsWithFlags,
                ...proactiveOnlyNames.map(name => {
                  let info = allClientsMap[name];
                  if (!info?.clientSheetId) {
                    info = Object.values(allClientsMap || {}).find(c => c.clientName?.toLowerCase() === name.toLowerCase()) || {};
                  }
                  return { clientName: name, masterSheetId: info.masterSheetId, clientSheetId: info.clientSheetId, flags: {}, alertCounts: {} };
                }),
              ].filter(c => isUserAuthorizedForClient(currentUser, c.clientName));
              return combinedClientList;
            })().filter(client => {
              const { validAssignedExp, validAssignedInv } = getValidAssignedCounts(client);

              const hasVisibleActionable = ACTIONABLE_FLAG_KEYS.some(key => {
                if (!client.flags?.[key] || !isFlagVisible(key)) return false;
                let count = client.alertCounts?.[key] || 0;
                if (key === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
                if (key === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
                return count > 0;
              });
              const hasInfoFlags = Object.entries(client.flags || {}).some(([key, val]) => val && isFlagVisible(key) && !ACTIONABLE_FLAG_KEYS.includes(key) && (client.alertCounts?.[key] || 0) > 0);
              return hasVisibleActionable || hasInfoFlags || (authorizedProactiveCountsByClient[client.clientName] || 0) > 0;
            }).map((client, idx) => {
              const { validAssignedExp, validAssignedInv } = getValidAssignedCounts(client);

              const actionableLines = ACTIONABLE_FLAG_KEYS
                .filter(key => client.flags?.[key] && isFlagVisible(key))
                .map(key => {
                  let count = client.alertCounts?.[key] || 0;
                  if (key === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
                  if (key === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
                  if (count === 0) return null;
                  const label = getFlagName(key);
                  return {
                    text: `${label} (${count} alert${count !== 1 ? "s" : ""})`,
                    isAdminOnly: ADMIN_ONLY_FLAG_KEYS.has(key),
                  };
                })
                .filter(Boolean);

              const infoLines = Object.entries(client.flags || {})
                .filter(([key, val]) => val && isFlagVisible(key) && !ACTIONABLE_FLAG_KEYS.includes(key) && (client.alertCounts?.[key] || 0) > 0)
                .map(([key]) => {
                  const count = client.alertCounts?.[key] || 0;
                  const label = getFlagName(key);
                  return {
                    text: `${label} (${count} alert${count !== 1 ? "s" : ""})`,
                    isAdminOnly: ADMIN_ONLY_FLAG_KEYS.has(key),
                  };
                });

              const proactiveMap = (authorizedProactiveAlerts || []).filter(a => a.clientName === client.clientName).reduce((acc, a) => {
                const label = PROACTIVE_TYPE_LABELS[a.alertType] || a.alertType || "Alert";
                if (!acc[label]) acc[label] = { count: 0, isAdminOnly: ADMIN_ONLY_PROACTIVE_TYPES.has(a.alertType) };
                acc[label].count += 1;
                return acc;
              }, {});

              const proactiveLines = Object.entries(proactiveMap).map(([label, info]) => ({
                text: `${label} (${info.count} alert${info.count !== 1 ? "s" : ""})`,
                isAdminOnly: info.isAdminOnly,
              }));

              const hasManager = client.hasClientManager !== undefined
                ? !!client.hasClientManager
                : !!(allClientsMap[client.clientName]?.hasClientManager);

              return (
                <button
                  key={idx}
                  onClick={() => selectClient(client)}
                  className="triage-client-card pma-alert-card no-click-spinner"
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
                  <div className="pma-alert-card-title" style={{ fontWeight: "700", fontSize: "15px", marginBottom: "5px", display: "flex", alignItems: "center", gap: "8px", color: "#0f172a" }}>
                    {selectingClient === client.clientName && <Spinner size={13} />}
                    {client.clientName}
                  </div>
                  {[...actionableLines, ...infoLines, ...proactiveLines].map((lineItem, i) => (
                    <div key={i} className="pma-alert-card-line" style={{ fontSize: "12.5px", color: "#1976d2", marginBottom: "2px", display: "flex", alignItems: "center" }}>
                      <span>• {lineItem.text}</span>
                      {isAdmin && lineItem.isAdminOnly && hasManager && (
                        <span
                          title="Visible to Admins only"
                          style={{
                            display: "inline-block",
                            marginLeft: "6px",
                            padding: "1px 5px",
                            fontSize: "9px",
                            fontWeight: "700",
                            textTransform: "uppercase",
                            letterSpacing: "0.4px",
                            borderRadius: "10px",
                            backgroundColor: "#f1f5f9",
                            color: "#64748b",
                            border: "1px solid #cbd5e1",
                            lineHeight: "12px",
                          }}
                        >
                          Admin
                        </span>
                      )}
                    </div>
                  ))}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #eee", display: "flex", justifyContent: isAdmin ? "space-between" : "flex-end", alignItems: "center" }}>
          {isAdmin && (
            <button className="triage-btn"
              onClick={() => { setScreen("ignoredAlerts"); loadIgnoredAlerts(); }}
              style={styles.linkButton}
            >
              View ignored alerts →
            </button>
          )}
          <div style={{ display: "flex", gap: "8px" }}>
            {isAdmin && (
              <button className="triage-btn"
                onClick={() => setShowDebugPanel(v => !v)}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#888" }}
              >
                🔍 Debug
              </button>
            )}
            <button className="triage-btn"
              onClick={reloadFromCache}
              disabled={isLoading}
              style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: isLoading ? 0.5 : 1 }}
              title="Pull latest data from cache"
            >
              ⚡ Reload
            </button>
            {isAdmin && (
              <button className="triage-btn"
                onClick={() => refreshTriage(true)}
                disabled={isLoading}
                style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: isLoading ? 0.5 : 1 }}
                title="Run full alert sweep"
              >
                {isLoading ? <><Spinner />{refreshStatus || "Refreshing..."}</> : "↻ Refresh"}
              </button>
            )}
          </div>
        </div>

        {isAdmin && showDebugPanel && (
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
                  const res = await fetch("/api/triage", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "cleanup_alert_memory", automationCommanderSheetId })
                  });
                  setDebugResult(await res.json());
                } catch (e) { setDebugResult({ error: e.message }); }
                finally { setDebugLoading(false); }
              }} disabled={debugLoading}
                style={{ background: "#dc2626", color: "white", border: "none", borderRadius: "4px", padding: "6px 10px", fontSize: "12px", cursor: "pointer" }}>
                🧹 Dedupe
              </button>
              <button className="triage-btn" onClick={async () => {
                setDebugLoading(true);
                try {
                  const res = await fetch("/api/triage", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "rehash_alert_memory", automationCommanderSheetId })
                  });
                  setDebugResult(await res.json());
                } catch (e) { setDebugResult({ error: e.message }); }
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

    </div>
  );
}