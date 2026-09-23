import React from "react";
import Spinner from "./Spinner";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";

export default function ClientSelectionView({
  styles,
  isLoading,
  error,
  getFlagName,
  PROACTIVE_TYPE_LABELS,
  setScreen,
  loadIgnoredAlerts
}) {
  const {
    refreshStatus, acceptError, clientsWithFlags, proactiveAlerts,
    proactiveCountsByClient, proactiveLoadedAt, selectingClient,
    selectClient, reloadFromCache, refreshTriage
  } = useTriage();

  const {
    allClientsMap, assignedByClient, assignedAppIds, showDebugPanel, setShowDebugPanel,
    debugClientName, setDebugClientName, runDebug, debugLoading, setDebugLoading,
    automationCommanderSheetId, setDebugResult, debugResult
  } = useAppGlobals();
  const ACTIONABLE_FLAG_KEYS = [
    "invoiceDashboardDiscr", "expenseDashboardDiscr",
    "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
  ];

  const activeClients = clientsWithFlags.filter(c => Object.values(c.flags || {}).some(v => v));

  // State 1: All alerts and flags have been resolved
  if (activeClients.length === 0 && proactiveAlerts.length === 0 && proactiveLoadedAt > 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>All Done</h1>
          <p style={styles.subtitle}>All alerts and flags have been resolved</p>
        </div>
        <div style={styles.card}>
          <div style={styles.successBanner}>✓ No outstanding alerts or flags</div>
          <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
            <button className="triage-btn" onClick={reloadFromCache} disabled={isLoading} style={{ ...styles.buttonSecondary, opacity: isLoading ? 0.5 : 1 }}>
              ⚡ Reload
            </button>
            <button className="triage-btn" onClick={() => refreshTriage(true)} disabled={isLoading} style={{ ...styles.buttonSecondary, opacity: isLoading ? 0.5 : 1 }}>
              {isLoading ? <><Spinner />{refreshStatus || "Refreshing..."}</> : "↻ Refresh"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 2: Checking for proactive alerts
  if (activeClients.length === 0 && proactiveLoadedAt === 0) {
    return (
      <div style={styles.container}>
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#888" }}>
          <Spinner size={28} color="#0066cc" />
          <div style={{ marginTop: "12px", fontSize: "14px" }}>Checking for alerts...</div>
        </div>
      </div>
    );
  }

  // State 3: Main Alerts List
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Alerts</h1>
        <p style={styles.subtitle}>
          Choose a client to review their alerts (
          {clientsWithFlags.reduce((total, c) => {
            const assignedSet = assignedByClient[c.clientName] || new Set();
            const expenseIds = c.activeExpenseIds || [];
            const invoiceIds = c.activeInvoiceIds || [];
            const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
            const validAssignedInv = invoiceIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
            let clientTotal = 0;
            Object.entries(c.flags || {}).forEach(([flagKey, isSet]) => {
              if (!isSet) return;
              let count = c.alertCounts?.[flagKey] || 0;
              if (ACTIONABLE_FLAG_KEYS.includes(flagKey)) {
                if (flagKey === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
                if (flagKey === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
                clientTotal += count;
              } else {
                clientTotal += (count > 0 ? count : 1);
              }
            });
            return total + clientTotal;
          }, 0) + proactiveAlerts.length} total)
        </p>
      </div>

      <div style={styles.card}>
        <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>Alerts</h2>
        {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {isLoading ? (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "#666" }}>
            <Spinner size={32} color="#0066cc" />
            <div style={{ fontSize: "15px", fontWeight: "600", color: "#333", marginTop: "12px", marginBottom: "6px" }}>
              Refreshing data...
            </div>
            <div style={{ fontSize: "13px", color: "#888" }}>
              {refreshStatus || "Reading latest flags and alerts from your sheets"}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {(() => {
              const proactiveOnlyNames = Object.keys(proactiveCountsByClient).filter(
                name => proactiveCountsByClient[name] > 0 && !clientsWithFlags.some(c => c.clientName === name)
              );
              const combinedClientList = [
                ...clientsWithFlags,
                ...proactiveOnlyNames.map(name => {
                  const info = allClientsMap[name] || {};
                  return { clientName: name, masterSheetId: info.masterSheetId, clientSheetId: info.clientSheetId, flags: {}, alertCounts: {} };
                }),
              ];
              return combinedClientList;
            })().filter(client => {
              const assignedSet = assignedByClient[client.clientName] || new Set();
              const expenseIds = client.activeExpenseIds || [];
              const invoiceIds = client.activeInvoiceIds || [];
              const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
              const validAssignedInv = invoiceIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
              
              const hasVisibleActionable = ACTIONABLE_FLAG_KEYS.some(key => {
                if (!client.flags?.[key]) return false;
                let count = client.alertCounts?.[key] || 0;
                if (key === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
                if (key === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
                return count > 0;
              });
              const hasInfoFlags = Object.entries(client.flags || {}).some(([key, val]) => val && !ACTIONABLE_FLAG_KEYS.includes(key) && (client.alertCounts?.[key] || 0) > 0);
              return hasVisibleActionable || hasInfoFlags || proactiveCountsByClient[client.clientName] > 0;
            }).map((client, idx) => {
              const assignedSet = assignedByClient[client.clientName] || new Set();
              const expenseIds = client.activeExpenseIds || [];
              const invoiceIds = client.activeInvoiceIds || [];
              const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
              const validAssignedInv = invoiceIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
              
              const actionableLines = ACTIONABLE_FLAG_KEYS
                .filter(key => client.flags?.[key])
                .map(key => {
                  let count = client.alertCounts?.[key] || 0;
                  if (key === "expenseDashboardDiscr") count = Math.max(0, count - validAssignedExp);
                  if (key === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
                  if (count === 0) return null;
                  const label = getFlagName(key);
                  return `${label} (${count} alert${count !== 1 ? "s" : ""})`;
                })
                .filter(Boolean);

              const infoLines = Object.entries(client.flags || {})
                .filter(([key, val]) => val && !ACTIONABLE_FLAG_KEYS.includes(key) && (client.alertCounts?.[key] || 0) > 0)
                .map(([key]) => {
                  const count = client.alertCounts?.[key] || 0;
                  const label = getFlagName(key);
                  return `${label} (${count} alert${count !== 1 ? "s" : ""})`;
                });

              const proactiveLines = Object.entries(
                (proactiveAlerts || []).filter(a => a.clientName === client.clientName).reduce((acc, a) => {
                  const label = PROACTIVE_TYPE_LABELS[a.alertType] || a.alertType || "Alert";
                  acc[label] = (acc[label] || 0) + 1;
                  return acc;
                }, {})
              ).map(([label, count]) => `${label} (${count} alert${count !== 1 ? "s" : ""})`);

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
                  {proactiveLines.map((line, i) => (
                    <div key={i} style={{ fontSize: "13px", color: "#d97706", marginBottom: "2px" }}>
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
              onClick={reloadFromCache}
              disabled={isLoading}
              style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: isLoading ? 0.5 : 1 }}
              title="Pull latest data from cache"
            >
              ⚡ Reload
            </button>
            <button className="triage-btn"
              onClick={() => refreshTriage(true)}
              disabled={isLoading}
              style={{ ...styles.buttonSecondary, fontSize: "13px", padding: "6px 14px", opacity: isLoading ? 0.5 : 1 }}
              title="Run full alert sweep"
            >
              {isLoading ? <><Spinner />{refreshStatus || "Refreshing..."}</> : "↻ Refresh"}
            </button>
          </div>
        </div>

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

    </div>
  );
}