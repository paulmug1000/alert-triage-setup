import React, { useState } from "react";

export default function TriageSystem({ onBack }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const [automationCommanderSheetId] = useState(AUTOMATION_COMMANDER_SHEET_ID);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [totalAlerts, setTotalAlerts] = useState(0);
  const [noActionCount, setNoActionCount] = useState(0);
  const [showNoAction, setShowNoAction] = useState(false);
  const [acknowledgedNoAction, setAcknowledgedNoAction] = useState(new Set());
  const [triageComplete, setTriageComplete] = useState(false);

  const startTriage = async () => {
    try {
      setIsLoading(true);
      setError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_triage",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();

      console.log("📥 Response from /api/triage:", JSON.stringify(data, null, 2));

      // Check both HTTP status and API success flag
      if (!response.ok || !data.success) {
        const errorMsg = data.error || "Failed to start triage";
        console.error("Triage API error:", errorMsg);
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      console.log(`Setting state: totalAlerts=${data.totalAlerts}, noActionCount=${data.noActionCount}`);
      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setAcknowledgedNoAction(new Set());

      // Only show "complete" if truly no alerts AND we got a valid response
      if ((data.totalAlerts || 0) === 0 && (data.noActionCount || 0) === 0) {
        setTriageComplete(true);
      } else if ((data.totalAlerts || 0) > 0) {
        // Show actionable alerts first
        setShowNoAction(false);
      } else {
        // Only no-action alerts
        setShowNoAction(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleAckNoAction = (index) => {
    const newAcknowledged = new Set(acknowledgedNoAction);
    if (newAcknowledged.has(index)) {
      newAcknowledged.delete(index);
    } else {
      newAcknowledged.add(index);
    }
    setAcknowledgedNoAction(newAcknowledged);

    // Check if all acknowledged
    if (newAcknowledged.size === noActionCount) {
      setTriageComplete(true);
    }
  };

  const goToNoAction = () => {
    setShowNoAction(true);
  };

  const resetTriage = () => {
    setSessionId("");
    setTotalAlerts(0);
    setNoActionCount(0);
    setShowNoAction(false);
    setAcknowledgedNoAction(new Set());
    setTriageComplete(false);
    setError("");
  };

  const styles = {
    container: {
      maxWidth: "900px",
      margin: "0 auto",
      padding: "20px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    },
    header: {
      marginBottom: "30px",
      textAlign: "center",
    },
    title: {
      fontSize: "28px",
      fontWeight: "700",
      color: "#1a1a1a",
      margin: "0 0 8px 0",
    },
    subtitle: {
      fontSize: "14px",
      color: "#666",
      margin: "0",
    },
    card: {
      background: "#fff",
      border: "1px solid #e0e0e0",
      borderRadius: "8px",
      padding: "24px",
      marginBottom: "20px",
    },
    button: {
      background: "#0066cc",
      color: "white",
      border: "none",
      padding: "12px 24px",
      borderRadius: "6px",
      fontSize: "16px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "background 0.2s",
    },
    buttonSecondary: {
      background: "#f0f0f0",
      color: "#1a1a1a",
      border: "1px solid #ddd",
      padding: "10px 16px",
      borderRadius: "6px",
      fontSize: "14px",
      fontWeight: "500",
      cursor: "pointer",
    },
    errorBanner: {
      background: "#fee",
      color: "#c00",
      padding: "12px 16px",
      borderRadius: "6px",
      marginBottom: "16px",
      fontSize: "14px",
      border: "1px solid #fcc",
    },
    successBanner: {
      background: "#efe",
      color: "#060",
      padding: "12px 16px",
      borderRadius: "6px",
      marginBottom: "16px",
      fontSize: "14px",
      border: "1px solid #cfc",
    },
    loadingText: {
      color: "#666",
      fontSize: "14px",
      margin: "16px 0 0 0",
    },
    noActionSection: {
      background: "#f9f9f9",
      border: "1px solid #ddd",
      borderRadius: "8px",
      padding: "20px",
      marginTop: "20px",
    },
    noActionItem: {
      background: "white",
      border: "1px solid #e0e0e0",
      borderRadius: "6px",
      padding: "16px",
      marginBottom: "12px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    },
    noActionLabel: {
      flex: 1,
    },
    noActionTitle: {
      fontWeight: "600",
      color: "#1a1a1a",
      marginBottom: "4px",
    },
    noActionDesc: {
      fontSize: "13px",
      color: "#666",
    },
    checkmark: {
      width: "24px",
      height: "24px",
      borderRadius: "4px",
      border: "2px solid #0066cc",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      marginLeft: "12px",
      fontSize: "14px",
      fontWeight: "bold",
    },
    checkmarkChecked: {
      background: "#0066cc",
      color: "white",
    },
    statsBox: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "16px",
      marginBottom: "20px",
    },
    stat: {
      background: "#f9f9f9",
      padding: "16px",
      borderRadius: "6px",
      textAlign: "center",
    },
    statNumber: {
      fontSize: "24px",
      fontWeight: "700",
      color: "#0066cc",
      margin: "0 0 4px 0",
    },
    statLabel: {
      fontSize: "13px",
      color: "#666",
      margin: "0",
    },
    buttonGroup: {
      display: "flex",
      gap: "12px",
      marginTop: "16px",
    },
  };

  // Screen 1: Initial state - show start button
  if (!sessionId && !triageComplete) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage</h1>
          <p style={styles.subtitle}>Review and resolve financial automation alerts</p>
        </div>

        <div style={styles.card}>
          {error && <div style={styles.errorBanner}>{error}</div>}

          <p style={{ color: "#333", marginBottom: "20px" }}>
            This system will review all flagged alerts from your automation commander and help you resolve them with AI assistance.
          </p>

          <button
            onClick={startTriage}
            disabled={isLoading}
            style={{
              ...styles.button,
              opacity: isLoading ? 0.5 : 1,
            }}
          >
            {isLoading ? "Loading Alerts..." : "Start Triage →"}
          </button>

          {isLoading && (
            <p style={styles.loadingText}>Scanning automation commander for alerts...</p>
          )}
        </div>

        {onBack && (
          <button onClick={onBack} style={styles.buttonSecondary}>
            ← Back to Menu
          </button>
        )}
      </div>
    );
  }

  // Screen 2: Triage complete with no alerts
  if (triageComplete && totalAlerts === 0 && noActionCount === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>✓ All Clear</h1>
          <p style={styles.subtitle}>No alerts to triage</p>
        </div>

        <div style={styles.card}>
          <div style={styles.successBanner}>
            No discrepancies detected. Your financial automation system is running smoothly!
          </div>

          <div style={styles.buttonGroup}>
            <button onClick={resetTriage} style={styles.button}>
              Run Triage Again
            </button>
            {onBack && (
              <button onClick={onBack} style={styles.buttonSecondary}>
                ← Back to Menu
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Screen 3: Actionable alerts pending
  if (sessionId && !showNoAction && totalAlerts > 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Actionable Alerts</h1>
          <p style={styles.subtitle}>Alerts requiring your review and decision</p>
        </div>

        <div style={styles.card}>
          <div style={styles.statsBox}>
            <div style={styles.stat}>
              <p style={styles.statNumber}>{totalAlerts}</p>
              <p style={styles.statLabel}>Alerts to Review</p>
            </div>
            {noActionCount > 0 && (
              <div style={styles.stat}>
                <p style={styles.statNumber}>{noActionCount}</p>
                <p style={styles.statLabel}>Info-Only Alerts</p>
              </div>
            )}
          </div>

          <p style={{ color: "#333", marginBottom: "20px" }}>
            Claude is analyzing your {totalAlerts} actionable alert{totalAlerts !== 1 ? "s" : ""} and will provide recommendations.
          </p>

          <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px" }}>
            Implementation coming next: Each alert will be displayed one at a time with Claude's analysis, and you can approve, reject, or investigate further.
          </p>

          {noActionCount > 0 && (
            <button onClick={goToNoAction} style={styles.button}>
              Skip to Info-Only Alerts →
            </button>
          )}

          <div style={{ marginTop: "16px" }}>
            <button onClick={resetTriage} style={styles.buttonSecondary}>
              Start Over
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Screen 4: No-action alerts for acknowledgement
  if (showNoAction && noActionCount > 0) {
    const allAcknowledged = acknowledgedNoAction.size === noActionCount;

    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Info-Only Alerts</h1>
          <p style={styles.subtitle}>These require no action - acknowledge to clear</p>
        </div>

        <div style={styles.noActionSection}>
          <h2 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: "600" }}>
            {acknowledgedNoAction.size} of {noActionCount} Acknowledged
          </h2>

          {/* TODO: Replace with actual no-action alerts from API response */}
          <div style={styles.noActionItem}>
            <div style={styles.noActionLabel}>
              <div style={styles.noActionTitle}>Invoice app discr</div>
              <div style={styles.noActionDesc}>No action required - informational only</div>
            </div>
            <div
              style={{
                ...styles.checkmark,
                ...(acknowledgedNoAction.has(0) ? styles.checkmarkChecked : {}),
              }}
              onClick={() => toggleAckNoAction(0)}
            >
              {acknowledgedNoAction.has(0) ? "✓" : ""}
            </div>
          </div>

          {allAcknowledged && (
            <div style={styles.successBanner}>
              All info-only alerts acknowledged. Ready to complete triage!
            </div>
          )}

          <div style={styles.buttonGroup}>
            {totalAlerts > 0 && (
              <button onClick={() => setShowNoAction(false)} style={styles.buttonSecondary}>
                ← Back to Actionable Alerts
              </button>
            )}
            {allAcknowledged && (
              <button
                onClick={() => setTriageComplete(true)}
                style={styles.button}
              >
                Complete Triage ✓
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}