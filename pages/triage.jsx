import React, { useState } from "react";
import Head from "next/head";

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
  const [alerts, setAlerts] = useState([]);
  const [currentAlertIndex, setCurrentAlertIndex] = useState(0);
  const [claudeAnalysis, setClaudeAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [userDecision, setUserDecision] = useState(null);

  const fetchAndAnalyzeAlerts = async (sessionId) => {
    try {
      setIsAnalyzing(true);
      
      // Fetch alerts from Redis via API
      const response = await fetch(`/api/triage?action=get_alerts&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (!data.success || !data.alerts) {
        setError("Failed to load alerts");
        return;
      }
      
      console.log(`📋 Loaded ${data.alerts.length} alerts from Redis`);
      setAlerts(data.alerts);
      setCurrentAlertIndex(0);
      setAlertsLoaded(true);
      
      // Start analyzing the first alert
      if (data.alerts.length > 0) {
        await analyzeAlert(data.alerts[0]);
      }
    } catch (err) {
      setError(`Failed to load alerts: ${err.message}`);
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const analyzeAlert = async (alert) => {
    try {
      setIsAnalyzing(true);
      setClaudeAnalysis("");
      
      console.log(`🔍 Generating options for alert:`, alert.flagType);
      
      // Call API to get matching options
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_alert",
          alert,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        setClaudeAnalysis("Error generating options: " + (data.error || "Unknown error"));
        return;
      }
      
      console.log(`✅ Options generated:`, data.options?.length || 0);
      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
    } catch (err) {
      setClaudeAnalysis(`Error generating options: ${err.message}`);
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAlertDecision = async (decision) => {
    const alert = alerts[currentAlertIndex];
    
    console.log(`📝 Recording decision for alert: ${decision}`, alert);
    
    try {
      // TODO: Log decision to TriageLog sheet
      setUserDecision(decision);
      
      // Move to next alert
      if (currentAlertIndex < alerts.length - 1) {
        const nextAlert = alerts[currentAlertIndex + 1];
        setCurrentAlertIndex(currentAlertIndex + 1);
        setUserDecision(null);
        await analyzeAlert(nextAlert);
      } else {
        // All alerts processed
        setTriageComplete(true);
      }
    } catch (err) {
      setError(`Failed to record decision: ${err.message}`);
    }
  };

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
        console.log("No alerts found, showing complete screen");
        setTriageComplete(true);
      } else if ((data.totalAlerts || 0) > 0) {
        // Show actionable alerts first
        console.log(`${data.totalAlerts} actionable alerts found, fetching from Redis...`);
        setShowNoAction(false);
        // Fetch alerts after state is set
        setTimeout(() => fetchAndAnalyzeAlerts(data.sessionId), 100);
      } else {
        // Only no-action alerts
        console.log(`${data.noActionCount} no-action alerts found, showing no-action screen`);
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
    setAlerts([]);
    setCurrentAlertIndex(0);
    setClaudeAnalysis("");
    setAlertsLoaded(false);
    setUserDecision(null);
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
    alertCard: {
      background: "#f9f9f9",
      border: "1px solid #ddd",
      borderRadius: "8px",
      padding: "24px",
      marginBottom: "20px",
    },
    alertHeader: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "20px",
      paddingBottom: "16px",
      borderBottom: "1px solid #e0e0e0",
    },
    alertTitle: {
      fontSize: "18px",
      fontWeight: "600",
      color: "#1a1a1a",
      margin: "0",
    },
    alertCounter: {
      fontSize: "14px",
      color: "#666",
      fontWeight: "500",
    },
    alertMetadata: {
      fontSize: "13px",
      color: "#666",
      marginBottom: "16px",
      padding: "12px",
      background: "white",
      borderRadius: "6px",
      borderLeft: "3px solid #0066cc",
    },
    alertSummary: {
      background: "#fff9e6",
      padding: "14px",
      borderRadius: "6px",
      borderLeft: "4px solid #ff9800",
      marginBottom: "20px",
    },
    claudeAnalysis: {
      background: "white",
      border: "1px solid #e0e0e0",
      borderRadius: "6px",
      padding: "16px",
      marginBottom: "20px",
      lineHeight: "1.6",
      color: "#333",
      fontSize: "14px",
    },
    decisionButtons: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "12px",
      marginTop: "20px",
    },
    optionCard: {
      background: "#f5f5f5",
      border: "1px solid #ddd",
      borderRadius: "6px",
      padding: "12px",
    },
    optionTitle: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#0066cc",
      marginBottom: "8px",
    },
    optionDetail: {
      fontSize: "13px",
      color: "#333",
      marginBottom: "6px",
      lineHeight: "1.4",
    },
    optionSummary: {
      fontSize: "13px",
      color: "#666",
      marginTop: "8px",
      fontStyle: "italic",
    },
    decisionButtons: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: "12px",
      marginTop: "20px",
    },
    decisionButton: {
      padding: "12px 16px",
      borderRadius: "6px",
      border: "none",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "all 0.2s",
    },
    approveButton: {
      background: "#4caf50",
      color: "white",
    },
    rejectButton: {
      background: "#f44336",
      color: "white",
    },
    investigateButton: {
      background: "#2196f3",
      color: "white",
    },
  };

  // Screen 1: Initial state - show start button
  if (!sessionId && !triageComplete) {
    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
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
      </>
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

  // Screen 3a: Alerts loading
  if (sessionId && !showNoAction && totalAlerts > 0 && !alertsLoaded) {
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
          </div>

          <p style={{ color: "#333", marginBottom: "20px" }}>
            Claude is analyzing your {totalAlerts} actionable alert{totalAlerts !== 1 ? "s" : ""} and will provide recommendations.
          </p>

          <p style={styles.loadingText}>Loading alerts from system...</p>
        </div>
      </div>
    );
  }

  // Screen 3b: Display individual alert with Claude analysis
  if (sessionId && !showNoAction && alertsLoaded && alerts.length > 0) {
    const alert = alerts[currentAlertIndex];
    const progress = currentAlertIndex + 1;

    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>Alert {progress} of {totalAlerts}</p>
        </div>

        <div style={styles.card}>
          <div style={styles.alertHeader}>
            <h2 style={styles.alertTitle}>{alert.clientName || alert.type || "Financial Alert"}</h2>
            <span style={styles.alertCounter}>{progress}/{totalAlerts}</span>
          </div>

          {alert.flagType && (
            <div style={{ ...styles.alertMetadata, fontSize: "15px", fontWeight: "600", padding: "14px", marginBottom: "16px" }}>
              {alert.flagType}
            </div>
          )}

          {alert.summary && (
            <div style={{ ...styles.alertSummary, marginBottom: "20px" }}>
              <h3 style={{ fontSize: "13px", fontWeight: "700", marginBottom: "8px", color: "#1a1a1a", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {alert.type === "expense" ? "Unmatched Expense" : "Unmatched Invoice"}
              </h3>
              <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#333" }}>
                {alert.type === "expense" ? (
                  // Expense display
                  <>
                    {alert.summary.reference && <div><strong>Reference:</strong> {alert.summary.reference}</div>}
                    {alert.summary.description && <div><strong>Description:</strong> {alert.summary.description}</div>}
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}</div>
                    {alert.summary.date && <div><strong>Date:</strong> {alert.summary.date}</div>}
                    {alert.summary.accountName && <div><strong>Account Name:</strong> {alert.summary.accountName}</div>}
                    {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                    {alert.summary.transactionId && <div><strong>Transaction ID:</strong> {alert.summary.transactionId}</div>}
                  </>
                ) : (
                  // Invoice display
                  <>
                    <div><strong>Invoice:</strong> {alert.summary.invoiceNo}</div>
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{alert.summary.vatIncluded && alert.summary.vatIncluded > 0 ? ' + VAT' : ''}</div>
                    <div><strong>Client:</strong> {alert.summary.client}</div>
                    {alert.summary.job && <div><strong>Description:</strong> {alert.summary.job}</div>}
                    {alert.summary.sentDate && <div><strong>Sent:</strong> {alert.summary.sentDate}</div>}
                    {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                  </>
                )}
              </div>
            </div>
          )}

          {claudeAnalysis && (
            <div>
              <h3 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>
                Potential Actions
              </h3>
              {(() => {
                try {
                  const options = JSON.parse(claudeAnalysis);
                  if (Array.isArray(options)) {
                    return options.map((option, idx) => (
                      <div key={idx} style={{ ...styles.optionCard, marginBottom: "16px" }}>
                        <div style={styles.optionTitle}>
                          Option {idx + 1}: {option.title}
                        </div>
                        {option.jobName && (
                          <div style={styles.optionDetail}>
                            <strong>Job:</strong> {option.jobName} (Row {option.jobRow})
                          </div>
                        )}
                        {/* CRM matching details */}
                        {option.matchingDetails && typeof option.matchingDetails === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#f5f3ff", borderLeft: "3px solid #7c3aed" }}>
                            <strong style={{ color: "#5b21b6" }}>CRM Job Matching Details:</strong>
                            {option.matchingDetails.unmatchedJobSummary && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>Unmatched Job (CRM):</strong>
                                <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px" }}>
                                  {option.matchingDetails.unmatchedJobSummary.projectCode && <div>Code: {option.matchingDetails.unmatchedJobSummary.projectCode}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.clientName && <div>Client: {option.matchingDetails.unmatchedJobSummary.clientName}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.jobName && <div>Job: {option.matchingDetails.unmatchedJobSummary.jobName}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.revenue && <div>Revenue: {option.matchingDetails.unmatchedJobSummary.revenue}</div>}
                                  {option.matchingDetails.unmatchedJobSummary.startDate && <div>Dates: {option.matchingDetails.unmatchedJobSummary.startDate} → {option.matchingDetails.unmatchedJobSummary.endDate}</div>}
                                </div>
                              </div>
                            )}
                            {option.matchingDetails.matchedJobDetails && (
                              <div style={{ marginTop: "8px", fontSize: "13px", color: "#333" }}>
                                <strong>Matched Job ({option.matchType === 'create_new' ? 'Would Create New' : 'In Sheet'}):</strong>
                                {option.matchType === 'create_new' ? (
                                  <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px", color: "#7c3aed" }}>
                                    Create new job matching the CRM details above
                                  </div>
                                ) : (
                                  <div style={{ marginLeft: "12px", fontSize: "12px", marginTop: "4px" }}>
                                    {option.matchingDetails.matchedJobDetails.projectCode && <div>Code: {option.matchingDetails.matchedJobDetails.projectCode}</div>}
                                    {option.matchingDetails.matchedJobDetails.clientName && <div>Client: {option.matchingDetails.matchedJobDetails.clientName}</div>}
                                    {option.matchingDetails.matchedJobDetails.jobName && <div>Job: {option.matchingDetails.matchedJobDetails.jobName}</div>}
                                    {option.matchingDetails.matchedJobDetails.revenue && <div>Revenue: {option.matchingDetails.matchedJobDetails.revenue}</div>}
                                    {option.matchingDetails.matchedJobDetails.startDate && <div>Dates: {option.matchingDetails.matchedJobDetails.startDate} → {option.matchingDetails.matchedJobDetails.endDate}</div>}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {/* CRM match analysis */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                            <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                            {option.matchAnalysis.matchConfidence && (
                              <div style={{ marginTop: "6px", fontSize: "13px" }}>
                                <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                              </div>
                            )}
                            {option.matchAnalysis.clientNameMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Client Name:</strong> {option.matchAnalysis.clientNameMatch}
                              </div>
                            )}
                            {option.matchAnalysis.jobNameMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Job Name:</strong> {option.matchAnalysis.jobNameMatch}
                              </div>
                            )}
                            {option.matchAnalysis.revenueMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Revenue:</strong> {option.matchAnalysis.revenueMatch}
                              </div>
                            )}
                            {option.matchAnalysis.dateRangeMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Dates:</strong> {option.matchAnalysis.dateRangeMatch}
                              </div>
                            )}
                            {option.matchAnalysis.projectCodeMatch && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Project Code:</strong> {option.matchAnalysis.projectCodeMatch}
                              </div>
                            )}
                            {option.matchAnalysis.reasonForChoice && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                                <strong>Why:</strong> {option.matchAnalysis.reasonForChoice}
                              </div>
                            )}
                            {option.matchAnalysis.discrepancies && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                                <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                              </div>
                            )}
                            {option.matchAnalysis.whyItDidntAutoMatch && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#666" }}>
                                <strong>Why no auto-match:</strong> {option.matchAnalysis.whyItDidntAutoMatch}
                              </div>
                            )}
                          </div>
                        )}
                        {/* NEW FORMAT: Display allocation breakdown for expenses */}
                        {option.allocationBreakdown && typeof option.allocationBreakdown === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                            <strong style={{ color: "#1e40af" }}>Direct Cost Allocation:</strong>
                            {option.allocationBreakdown.jobDirectCostBudget && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>Total Budget:</strong> {option.allocationBreakdown.jobDirectCostBudget}
                              </div>
                            )}
                            {option.allocationBreakdown.allocatedExpenses && Array.isArray(option.allocationBreakdown.allocatedExpenses) && option.allocationBreakdown.allocatedExpenses.length > 0 && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                                <strong>Allocated Expenses:</strong>
                                <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                  {option.allocationBreakdown.allocatedExpenses.map((exp, i) => (
                                    <li key={i} style={{ color: "#444", marginBottom: "2px" }}>{exp}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {option.allocationBreakdown.totalAllocated && (
                              <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                                <strong>Total Allocated:</strong> {option.allocationBreakdown.totalAllocated}
                              </div>
                            )}
                            {option.allocationBreakdown.placeholderExpenses && Array.isArray(option.allocationBreakdown.placeholderExpenses) && option.allocationBreakdown.placeholderExpenses.length > 0 && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#b45309" }}>
                                <strong>Pending Placeholders:</strong>
                                <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                  {option.allocationBreakdown.placeholderExpenses.map((exp, i) => (
                                    <li key={i} style={{ color: "#92400e", marginBottom: "2px" }}>{exp}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {option.allocationBreakdown.remainingBudget && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#059669", fontWeight: "bold" }}>
                                Remaining Budget: {option.allocationBreakdown.remainingBudget}
                              </div>
                            )}
                            {option.allocationBreakdown.expenseCanFit && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#059669" }}>
                                ✓ {option.allocationBreakdown.expenseCanFit}
                              </div>
                            )}
                          </div>
                        )}
                        {/* NEW FORMAT: Display match analysis */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                            <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                            {option.matchAnalysis.matchConfidence && (
                              <div style={{ marginTop: "6px", fontSize: "13px" }}>
                                <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                              </div>
                            )}
                            {option.matchAnalysis.vendorAnalysis && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Vendor:</strong> {option.matchAnalysis.vendorAnalysis}
                              </div>
                            )}
                            {option.matchAnalysis.placeholderMatch && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Placeholder Match:</strong> {option.matchAnalysis.placeholderMatch}
                              </div>
                            )}
                            {option.matchAnalysis.budgetFit && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                                <strong>Budget Fit:</strong> {option.matchAnalysis.budgetFit}
                              </div>
                            )}
                            {option.matchAnalysis.reasonForChoice && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                                {option.matchAnalysis.reasonForChoice}
                              </div>
                            )}
                            {option.matchAnalysis.discrepancies && (
                              <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                                <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                              </div>
                            )}
                          </div>
                        )}
                        {option.facts && typeof option.facts === 'object' && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "13px", color: "#555" }}>
                              {option.facts.jobType && <li><strong>Type:</strong> {option.facts.jobType}</li>}
                              {option.facts.totalRevenue && <li><strong>Total revenue:</strong> £{option.facts.totalRevenue.toLocaleString()}</li>}
                              {option.facts.startDate && <li><strong>Start date:</strong> {option.facts.startDate}</li>}
                              {option.facts.endDate && <li><strong>End date:</strong> {option.facts.endDate}</li>}
                              {option.facts.existingInvoices && <li><strong>Existing invoices:</strong> {option.facts.existingInvoices}</li>}
                              {option.facts.remainingToInvoice && <li><strong>Left to invoice:</strong> £{option.facts.remainingToInvoice.toLocaleString()}</li>}
                              {option.facts.invoiceMatchStatus && <li><strong>{option.facts.invoiceMatchStatus}</strong></li>}
                            </ul>
                          </div>
                        )}
                        {option.facts && option.facts.discrepancies && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #ddd" }}>
                            <strong style={{ color: "#d97706" }}>⚠️ {option.facts.discrepancies}</strong>
                          </div>
                        )}
                        {option.businessLogic && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <strong>Why this works:</strong>
                            <div style={{ marginTop: "4px", color: "#555", fontStyle: "italic" }}>{option.businessLogic}</div>
                          </div>
                        )}
                        {option.recommendedActions && Array.isArray(option.recommendedActions) && option.recommendedActions.length > 0 && (
                          <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                            <strong>Actions:</strong>
                            <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0" }}>
                              {option.recommendedActions.map((action, i) => (
                                <li key={i} style={{ fontSize: "13px", color: "#555" }}>{action}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {/* Fallback for old format fields */}
                        {option.jobStatus && (
                          <div style={styles.optionDetail}>
                            <strong>Status:</strong> {option.jobStatus}
                          </div>
                        )}
                        {option.existingInvoices && option.existingInvoices.length > 0 && (
                          <div style={styles.optionDetail}>
                            <strong>Existing invoices:</strong>
                            {option.existingInvoices.map((inv, i) => (
                              <div key={i} style={{ marginLeft: "16px", fontSize: "13px" }}>
                                {inv.date} - {inv.amount} ({inv.ref})
                              </div>
                            ))}
                          </div>
                        )}
                        {option.remainingToInvoice && (
                          <div style={styles.optionDetail}>
                            <strong>Remaining to invoice:</strong> {option.remainingToInvoice}
                          </div>
                        )}
                        {option.summary && !option.businessLogic && (
                          <div style={styles.optionSummary}>{option.summary}</div>
                        )}
                        <button
                          onClick={() => handleAlertDecision("accept_option_" + idx)}
                          style={{
                            ...styles.decisionButton,
                            ...styles.approveButton,
                            marginTop: "12px",
                            width: "100%",
                          }}
                        >
                          ✓ Accept Option {idx + 1}
                        </button>
                      </div>
                    ));
                  }
                } catch (e) {
                  // Show as plain text if not JSON
                  return (
                    <div style={styles.claudeAnalysis}>
                      {claudeAnalysis.split('\n').map((line, idx) => (
                        <div key={idx}>{line || <br />}</div>
                      ))}
                    </div>
                  );
                }
              })()}
              <button
                onClick={() => handleAlertDecision("reject_all")}
                style={{
                  ...styles.decisionButton,
                  ...styles.rejectButton,
                  width: "100%",
                }}
              >
                ✗ Reject All Options
              </button>
            </div>
          )}

          {isAnalyzing && (
            <div style={{ ...styles.claudeAnalysis, textAlign: "center", color: "#666" }}>
              Generating options for this alert...
            </div>
          )}

          <div style={{ marginTop: "16px" }}>
            <button onClick={resetTriage} style={styles.buttonSecondary}>
              Start Over
            </button>
          </div>
        </div>
      </div>
      </>
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