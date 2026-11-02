import React, { useEffect, useState } from "react";
import Spinner from "./Spinner";
import Skeleton from "./Skeleton";
import { useIgnoredAlerts } from "../hooks/useIgnoredAlerts";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";

export default function IgnoredAlertsView({ styles }) {
  const { automationCommanderSheetId } = useAppGlobals();
  const { acceptError, setAcceptError, setScreen } = useTriage();
  const { ignoredAlerts, isLoadingIgnored, isUnignoring, unignoreAlert, loadIgnoredAlerts } = useIgnoredAlerts(automationCommanderSheetId, setAcceptError);
  const [isFixingHashes, setIsFixingHashes] = useState(false);

  useEffect(() => {
    loadIgnoredAlerts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="pma-page-container" style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Ignored alerts</h1>
        <p style={styles.subtitle}>Alerts permanently excluded from triage</p>
      </div>

      <div style={styles.card}>
        {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

        {isLoadingIgnored ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "8px 0" }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ padding: "14px 16px", border: "1px solid #e2e8f0", borderRadius: "6px", background: "#f8fafc", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px" }}>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                  <Skeleton width="65%" height="15px" />
                  <Skeleton width="40%" height="12px" />
                </div>
                <Skeleton width="90px" height="30px" borderRadius="6px" />
              </div>
            ))}
          </div>
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
                      opacity: isUnignoring === a.fingerprintHash ? 0.6 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    {isUnignoring === a.fingerprintHash ? <><Spinner size={11} /> Restoring...</> : "↩ Un-ignore"}
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
            ← Back to clients
          </button>
          <button className="triage-btn"
            disabled={isFixingHashes}
            onClick={async () => {
              setIsFixingHashes(true);
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
              finally { setIsFixingHashes(false); }
            }}
            style={{ ...styles.buttonSecondary, fontSize: "13px", display: "inline-flex", alignItems: "center", gap: "6px", opacity: isFixingHashes ? 0.7 : 1 }}
            title="Fix ignored alerts that reappeared after a system update"
          >
            {isFixingHashes ? <><Spinner size={12} /> Fixing hashes...</> : "🔧 Fix stale hashes"}
          </button>
        </div>
      </div>
    </div>
  );
}
