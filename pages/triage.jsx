import React, { useState, useEffect, useRef } from "react";

export default function TriageSystem() {
  const [mode, setMode] = useState("menu"); // menu, triage, learning
  const [sessionId, setSessionId] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [currentAlertIndex, setCurrentAlertIndex] = useState(0);
  const [currentAlert, setCurrentAlert] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [automationCommanderSheetId, setAutomationCommanderSheetId] = useState("");

  // Start triage session
  const startTriage = async () => {
    try {
      setIsLoading(true);
      setError("");

      // Get Automation Commander sheet ID from user
      if (!automationCommanderSheetId.trim()) {
        setError("Please enter the Automation Commander Sheet ID");
        setIsLoading(false);
        return;
      }

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_triage",
          automationCommanderSheetId: automationCommanderSheetId.trim(),
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSessionId(data.sessionId);
        setAlerts(data.totalAlerts);
        setMode("triage");
        setCurrentAlertIndex(0);
        loadNextAlert(data.sessionId, 0);
      } else {
        setError(data.error || "Failed to start triage");
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Load next alert
  const loadNextAlert = async (sid, index) => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_next_alert",
          sessionId: sid,
          alertIndex: index,
        }),
      });

      const data = await response.json();

      if (data.success && data.complete) {
        setMode("complete");
      } else if (data.success) {
        setCurrentAlert(data.alert);
        setAnalysis(data.analysis);
      } else {
        setError(data.error || "Failed to load alert");
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle user decision
  const handleDecision = async (action, correction = "") => {
    try {
      setIsLoading(true);

      // Record decision
      await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "record_decision",
          sessionId,
          alertIndex: currentAlertIndex,
          decision: {
            action,
            correction,
          },
        }),
      });

      // Load next alert
      const nextIndex = currentAlertIndex + 1;
      setCurrentAlertIndex(nextIndex);

      if (nextIndex >= alerts) {
        setMode("complete");
      } else {
        loadNextAlert(sessionId, nextIndex);
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Render menu
  if (mode === "menu") {
    return (
      <div style={styles.container}>
        <div style={styles.wrapper}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>Review and resolve financial automation discrepancies</p>

          <div style={styles.card}>
            <h2>Start Triage Session</h2>
            <p>Enter your Automation Commander Sheet ID to begin reviewing alerts.</p>

            <input
              type="text"
              placeholder="Enter Automation Commander Sheet ID"
              value={automationCommanderSheetId}
              onChange={(e) => setAutomationCommanderSheetId(e.target.value)}
              style={styles.input}
              disabled={isLoading}
            />

            {error && <div style={styles.errorBanner}>{error}</div>}

            <button
              onClick={startTriage}
              disabled={isLoading || !automationCommanderSheetId.trim()}
              style={{
                ...styles.button,
                opacity:
                  isLoading || !automationCommanderSheetId.trim() ? 0.5 : 1,
              }}
            >
              {isLoading ? "Loading..." : "Start Triage →"}
            </button>
          </div>

          <div style={styles.infoBox}>
            <h3>What This Does</h3>
            <p>
              This system reviews all discrepancies flagged in your Automation
              Commander and uses AI to suggest matches or corrections.
            </p>
            <p>You can approve, reject, or refine each recommendation.</p>
          </div>
        </div>
      </div>
    );
  }

  // Render triage
  if (mode === "triage" && currentAlert) {
    return (
      <div style={styles.container}>
        <div style={styles.wrapper}>
          <div style={styles.header}>
            <h1 style={styles.title}>Alert Triage</h1>
            <div style={styles.progressBar}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${((currentAlertIndex + 1) / alerts) * 100}%`,
                }}
              />
            </div>
            <p style={styles.progressText}>
              Alert {currentAlertIndex + 1} of {alerts}
            </p>
          </div>

          {/* Alert Summary */}
          <div style={styles.alertCard}>
            <h2 style={styles.alertTitle}>
              {currentAlert.type.toUpperCase()} Alert - {currentAlert.sheetName}
            </h2>
            <p style={styles.alertRow}>
              <strong>Row:</strong> {currentAlert.rowNumber}
            </p>

            {/* Discrepancies */}
            <div style={styles.discrepancyBox}>
              <h3>Discrepancies Detected:</h3>
              <ul>
                {currentAlert.discrepancies.map((disc, idx) => (
                  <li key={idx} style={styles.discrepancyItem}>
                    {disc}
                  </li>
                ))}
              </ul>
            </div>

            {/* Key Data */}
            <div style={styles.dataBox}>
              <h3>Key Data:</h3>
              <p>
                <strong>Client:</strong> {currentAlert.data[0] || "Unknown"}
              </p>
              <p>
                <strong>Amount:</strong> {currentAlert.data[4] || "N/A"}
              </p>
              <p>
                <strong>Date:</strong> {currentAlert.data[5] || "N/A"}
              </p>
            </div>
          </div>

          {/* Claude Analysis */}
          {analysis && (
            <div style={styles.analysisCard}>
              <h2>Claude's Analysis</h2>

              <div style={styles.confidenceBar}>
                <span>Confidence: {analysis.confidence}%</span>
                <div style={styles.confidenceBackground}>
                  <div
                    style={{
                      ...styles.confidenceFill,
                      width: `${analysis.confidence}%`,
                    }}
                  />
                </div>
              </div>

              <div style={styles.recommendationBox}>
                <h3>Recommendation: {analysis.recommendation}</h3>
                <p style={styles.reasoning}>{analysis.reasoning}</p>
              </div>

              {analysis.suggestedAction && (
                <div style={styles.actionBox}>
                  <h3>Suggested Action:</h3>
                  <p>{analysis.suggestedAction}</p>
                </div>
              )}

              {analysis.whyAutomationMissed && (
                <div style={styles.whyBox}>
                  <h3>Why Automation Missed This:</h3>
                  <p>{analysis.whyAutomationMissed}</p>
                </div>
              )}

              {analysis.questionsForUser && analysis.questionsForUser.length > 0 && (
                <div style={styles.questionsBox}>
                  <h3>Questions for You:</h3>
                  <ul>
                    {analysis.questionsForUser.map((q, idx) => (
                      <li key={idx}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* User Actions */}
          <div style={styles.actionButtons}>
            <button
              onClick={() => handleDecision("approve")}
              disabled={isLoading}
              style={{ ...styles.approveButton, opacity: isLoading ? 0.5 : 1 }}
            >
              ✓ Approve
            </button>

            <button
              onClick={() => handleDecision("reject")}
              disabled={isLoading}
              style={{ ...styles.rejectButton, opacity: isLoading ? 0.5 : 1 }}
            >
              ✗ Reject
            </button>

            <button
              onClick={() => handleDecision("investigate")}
              disabled={isLoading}
              style={{
                ...styles.investigateButton,
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              ? Investigate
            </button>

            <button
              onClick={() => handleDecision("refine")}
              disabled={isLoading}
              style={{ ...styles.refineButton, opacity: isLoading ? 0.5 : 1 }}
            >
              ✎ Refine
            </button>
          </div>

          {error && <div style={styles.errorBanner}>{error}</div>}
        </div>
      </div>
    );
  }

  // Render complete
  if (mode === "complete") {
    return (
      <div style={styles.container}>
        <div style={styles.wrapper}>
          <div style={styles.completionCard}>
            <div style={styles.completionIcon}>✓</div>
            <h1 style={styles.completionTitle}>Triage Complete!</h1>
            <p style={styles.completionText}>
              All {alerts} alerts have been reviewed and decisions recorded.
            </p>
            <p style={styles.completionSubtext}>
              Your decisions have been logged to the TriageLog sheet.
            </p>

            <button
              onClick={() => {
                setMode("menu");
                setSessionId(null);
                setCurrentAlertIndex(0);
              }}
              style={styles.resetButton}
            >
              ← Back to Menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

const styles = {
  container: {
    minHeight: "100vh",
    background: "linear-gradient(to bottom right, #0f172a, #1e293b, #0f172a)",
    color: "white",
    padding: "1rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  wrapper: {
    maxWidth: "1000px",
    margin: "0 auto",
  },
  header: {
    marginBottom: "2rem",
  },
  title: {
    fontSize: "2rem",
    fontWeight: "700",
    margin: "0 0 1rem 0",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: "0.875rem",
    margin: "0",
  },
  progressBar: {
    height: "3px",
    background: "#1e293b",
    borderRadius: "9999px",
    overflow: "hidden",
    marginTop: "1rem",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%)",
    transition: "width 0.5s ease",
  },
  progressText: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    margin: "0.5rem 0 0 0",
  },
  card: {
    background: "rgba(30, 41, 59, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "0.75rem",
    padding: "2rem",
    marginBottom: "2rem",
  },
  alertCard: {
    background: "rgba(30, 41, 59, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "0.75rem",
    padding: "1.5rem",
    marginBottom: "1.5rem",
  },
  alertTitle: {
    fontSize: "1.25rem",
    fontWeight: "600",
    color: "#22d3ee",
    margin: "0 0 1rem 0",
  },
  alertRow: {
    color: "#cbd5e1",
    margin: "0.5rem 0",
  },
  discrepancyBox: {
    background: "rgba(127, 29, 29, 0.2)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  discrepancyItem: {
    color: "#fca5a5",
    margin: "0.5rem 0",
  },
  dataBox: {
    background: "rgba(30, 58, 138, 0.2)",
    border: "1px solid rgba(59, 130, 246, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  analysisCard: {
    background: "rgba(30, 41, 59, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "0.75rem",
    padding: "1.5rem",
    marginBottom: "1.5rem",
  },
  confidenceBar: {
    marginBottom: "1rem",
  },
  confidenceBackground: {
    height: "6px",
    background: "#1e293b",
    borderRadius: "9999px",
    overflow: "hidden",
    marginTop: "0.5rem",
  },
  confidenceFill: {
    height: "100%",
    background: "linear-gradient(90deg, #10b981 0%, #06b6d4 100%)",
  },
  recommendationBox: {
    background: "rgba(6, 182, 212, 0.1)",
    border: "1px solid rgba(6, 182, 212, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  reasoning: {
    color: "#cbd5e1",
    margin: "0.5rem 0 0 0",
  },
  actionBox: {
    background: "rgba(59, 130, 246, 0.1)",
    border: "1px solid rgba(59, 130, 246, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  whyBox: {
    background: "rgba(168, 85, 247, 0.1)",
    border: "1px solid rgba(168, 85, 247, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  questionsBox: {
    background: "rgba(251, 146, 60, 0.1)",
    border: "1px solid rgba(251, 146, 60, 0.3)",
    borderRadius: "0.5rem",
    padding: "1rem",
    marginTop: "1rem",
  },
  input: {
    width: "100%",
    background: "#1e293b",
    color: "white",
    border: "1px solid #475569",
    borderRadius: "0.5rem",
    padding: "0.75rem",
    fontSize: "0.875rem",
    marginTop: "1rem",
    marginBottom: "1rem",
  },
  errorBanner: {
    background: "rgba(127, 29, 29, 0.3)",
    border: "1px solid rgba(239, 68, 68, 0.5)",
    borderRadius: "0.5rem",
    padding: "1rem",
    color: "#fca5a5",
    fontSize: "0.875rem",
    marginTop: "1rem",
  },
  button: {
    background: "linear-gradient(90deg, #2563eb 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    fontSize: "0.875rem",
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  actionButtons: {
    display: "flex",
    gap: "1rem",
    marginTop: "2rem",
    flexWrap: "wrap",
  },
  approveButton: {
    background: "linear-gradient(90deg, #10b981 0%, #059669 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    cursor: "pointer",
    flex: 1,
    minWidth: "120px",
  },
  rejectButton: {
    background: "linear-gradient(90deg, #ef4444 0%, #dc2626 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    cursor: "pointer",
    flex: 1,
    minWidth: "120px",
  },
  investigateButton: {
    background: "linear-gradient(90deg, #f59e0b 0%, #d97706 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    cursor: "pointer",
    flex: 1,
    minWidth: "120px",
  },
  refineButton: {
    background: "linear-gradient(90deg, #8b5cf6 0%, #7c3aed 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    cursor: "pointer",
    flex: 1,
    minWidth: "120px",
  },
  infoBox: {
    background: "rgba(30, 58, 138, 0.2)",
    border: "1px solid rgba(59, 130, 246, 0.3)",
    borderRadius: "0.75rem",
    padding: "1.5rem",
    marginTop: "2rem",
  },
  completionCard: {
    background: "rgba(5, 150, 105, 0.1)",
    border: "1px solid rgba(16, 185, 129, 0.3)",
    borderRadius: "0.75rem",
    padding: "2rem",
    textAlign: "center",
    marginTop: "2rem",
  },
  completionIcon: {
    fontSize: "3rem",
    marginBottom: "1rem",
  },
  completionTitle: {
    fontSize: "1.5rem",
    fontWeight: "700",
    marginBottom: "0.5rem",
  },
  completionText: {
    color: "#cbd5e1",
    marginBottom: "0.5rem",
  },
  completionSubtext: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    marginBottom: "1.5rem",
  },
  resetButton: {
    background: "linear-gradient(90deg, #2563eb 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 2rem",
    fontWeight: "600",
    cursor: "pointer",
  },
};
