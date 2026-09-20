import React, { useEffect } from "react";
import { useIgnoredAlerts } from "../hooks/useIgnoredAlerts";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";

export default function IgnoredAlertsView({ styles }) {
  const { automationCommanderSheetId } = useAppGlobals();
  const { acceptError, setAcceptError, setScreen } = useTriage();
  const { ignoredAlerts, isLoadingIgnored, isUnignoring, unignoreAlert, loadIgnoredAlerts } = useIgnoredAlerts(automationCommanderSheetId, setAcceptError);

  useEffect(() => {
    loadIgnoredAlerts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Ignored Alerts</h1>
        <p style={styles.subtitle}>Alerts permanently excluded from triage</p>
      </div>

      <div style={styles.card}>
        {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

        {isLoadingIgnored ? (
          <p style={styles.loadingText}>Loading ignored alerts...</p>
        ) : ignoredAlerts.length === 0 ? (
          <div style={{ textAlign: "center", padding: "24px", color: "#666" }}>
            No ignored alerts yet.
          </div>
        ) : (
          <div>
            {ignoredAlerts.map((a) => (
              <div key={a.fingerprintHash} style={{
                ...styles.ignoredAlertCard,
                ...(a.status === "superseded" ? { background: "#fff8f2", borderColor: "#fed7aa" } : {}),
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a" }}>
                    {a.alertSummary || "(no summary)"}
                  </div>
                  <div style={styles.ignoredAlertMeta}>
                    {a.clientName} · {a.alertType} · {a.status === "superseded" ? "⚠ Data changed since ignored" : `Ignored ${a.lastSeen}`}
                  </div>
                  {a.ignoreReason && (
                    <div style={{ fontSize: "12px", color: "#888", marginTop: "4px", fontStyle: "italic" }}>
                      Reason: {a.ignoreReason}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
                  <button className="triage-btn"
                    onClick={() => unignoreAlert(a.fingerprintHash)}
                    disabled={isUnignoring === a.fingerprintHash}
                    style={{
                      ...styles.unignoreButton,
                      opacity: isUnignoring === a.fingerprintHash ? 0.5 : 1,
                    }}
                  >
                    {isUnignoring === a.fingerprintHash ? "Restoring..." : "↩ Un-ignore"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: "20px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button className="triage-btn"
            onClick={() => { setAcceptError(""); setScreen("clientSelection"); }}
            style={styles.buttonSecondary}
          >
            ← Back to Clients
          </button>
          <button className="triage-btn"
            onClick={async () => {
              try {
                setAcceptError("");
                const r = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "rehash_ignored_alerts", automationCommanderSheetId }) });
                const d = await r.json();
                if (d.success) {
                  setAcceptError(`✓ Rehashed: ${d.updated} of ${d.total} ignored alerts updated. Click Refresh to reload.`);
                } else {
                  setAcceptError(`Failed: ${d.error}`);
                }
              } catch (e) { setAcceptError(`Error: ${e.message}`); }
            }}
            style={{ ...styles.buttonSecondary, fontSize: "13px" }}
            title="Fix ignored alerts that reappeared after a system update"
          >
            🔧 Fix stale hashes
          </button>
        </div>
      </div>
    </div>
  );
}