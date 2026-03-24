import React, { useState } from "react";
import Head from "next/head";

// Helper function defined OUTSIDE component to prevent re-creation on each render
function getAlertSummary(alert) {
  if (alert.type === "invoice" || alert.flagType === "invoiceDashboardDiscr") {
    const inv = alert.summary;
    return `Invoice #${inv?.invoiceNo || inv?.reference || "?"} - £${inv?.amount?.toFixed(2) || "?"}`;
  } else if (alert.type === "expense" || alert.flagType === "expenseDashboardDiscr") {
    const exp = alert.summary;
    return `${exp?.description || "Expense"} - £${exp?.amount?.toFixed(2) || "?"}`;
  } else if (alert.type === "crm" || alert.flagType?.includes("crm")) {
    const crm = alert.data;
    return `${crm?.projectCode || "Project"} - £${crm?.revenue || "?"}`;
  }
  return "Alert";
}

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
  
  // NEW: Client selection states
  const [screen, setScreen] = useState("initial"); // initial | clientSelection | alertSelection | triageAnalysis
  const [clientsWithFlags, setClientsWithFlags] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientAlerts, setClientAlerts] = useState([]);
  const [currentClientAlertIndex, setCurrentClientAlertIndex] = useState(0);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");
  const [processedAlerts, setProcessedAlerts] = useState(new Set());

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

      console.log(`Setting state: totalAlerts=${data.totalAlerts}, clientsWithFlags=${data.clientsWithFlags?.length}`);
      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setClientsWithFlags(data.clientsWithFlags || []);
      setAcknowledgedNoAction(new Set());
      setProcessedAlerts(new Set());

      // Show client selection screen if there are alerts
      if ((data.totalAlerts || 0) > 0) {
        console.log(`${data.totalAlerts} actionable alerts found, showing client selection...`);
        setScreen("clientSelection");
      } else if ((data.noActionCount || 0) > 0) {
        console.log(`${data.noActionCount} no-action alerts found, showing no-action screen`);
        setShowNoAction(true);
      } else {
        console.log("No alerts found, showing complete screen");
        setTriageComplete(true);
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

  // NEW: Helper function to get flag name from flag key
  const getFlagName = (flagKey) => {
    const flagNames = {
      "invoiceDashboardDiscr": "Invoice dashboard discr",
      "invoiceAppDiscr": "Invoice app discr",
      "crmPipeDashDiscr": "CRM pipe dash discr",
      "crmPipeAppDiscr": "CRM pipe app discr",
      "crmConfDashDiscr": "CRM conf dash discr",
      "crmConfAppDiscr": "CRM conf app discr",
      "crmPipeSkippedBlank": "CRM pipe skipped with blank",
      "crmConfSkippedBlank": "CRM conf skipped with blank",
      "crmCopiedConfChecked": "CRM copied to conf box checked",
      "crmCopiedConfUnchecked": "CRM copied to conf box UNchecked",
      "crmCopiedConfDelete": "CRM copied to conf box DELETE",
      "retainerInvoicesCreated": "Retainer invoices created",
      "expenseDashboardDiscr": "Expense dashboard discr",
      "expenseAppDiscr": "Expense app discr",
      "expenseAdded": "Expense added",
      "expenseUnreconGaps": "Expense unrecon gaps",
      "invoiceStaleUnsentChanges": "Invoice stale unsent changes",
    };
    return flagNames[flagKey] || flagKey;
  };

  // NEW: Select a client and fetch its alerts
  const selectClient = async (client) => {
    try {
      console.log(`\n📍 selectClient called: ${client.clientName}`);
      
      setSelectedClient(client);
      setCurrentClientAlertIndex(0);
      setAcceptError("");
      
      console.log(`Selected client: ${client.clientName}`);
      console.log(`  masterSheetId: ${client.masterSheetId}`);
      console.log(`  clientSheetId: ${client.clientSheetId}`);
      
      // Fetch all alerts from Redis
      console.log(`  Fetching alerts from Redis (sessionId: ${sessionId})`);
      const response = await fetch(`/api/triage?action=get_alerts&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (!data.success || !data.alerts) {
        console.error(`❌ Failed to load alerts from Redis`);
        setAcceptError("Failed to load alerts");
        return;
      }
      
      console.log(`  ✅ Loaded ${data.alerts.length} total alerts from Redis`);
      
      // Filter alerts for this client and remove processed ones
      const filteredAlerts = data.alerts.filter(alert => 
        alert.clientName === client.clientName && !processedAlerts.has(`${alert.sheetName}-${alert.rowNumber}`)
      );
      
      console.log(`  📊 Found ${filteredAlerts.length} unprocessed alerts for ${client.clientName}`);
      console.log(`     (processedAlerts set: ${Array.from(processedAlerts).join(", ") || "empty"})`);
      
      setClientAlerts(filteredAlerts);
      
      if (filteredAlerts.length === 0) {
        // All alerts processed, show clear flags option
        console.log(`  → No unprocessed alerts, going to clearFlags screen`);
        setScreen("clearFlags");
      } else {
        console.log(`  → ${filteredAlerts.length} alerts ready, going to alertSelection screen`);
        setScreen("alertSelection");
      }
    } catch (err) {
      console.error(`❌ selectClient error: ${err.message}`);
      setAcceptError(`Failed to select client: ${err.message}`);
      console.error(err);
    }
  };

  // NEW: Select an alert and analyze it
  const selectAlert = async (alert) => {
    try {
      console.log(`\n📍 selectAlert called for: ${alert.sheetName}-${alert.rowNumber}`);
      console.log(`  Current screen before change: ${screen}`);
      console.log(`  selectedClient: ${selectedClient?.clientName}`);
      console.log(`  clientAlerts.length: ${clientAlerts.length}`);
      
      const alertIndex = clientAlerts.indexOf(alert);
      console.log(`  Alert index in clientAlerts: ${alertIndex}`);
      
      setCurrentClientAlertIndex(alertIndex);
      setAcceptError("");
      setIsAnalyzing(true);
      setClaudeAnalysis(""); // Clear previous analysis
      
      console.log(`  Setting screen to "triageAnalysis"`);
      // IMPORTANT: Go to analysis screen IMMEDIATELY to show loading state
      setScreen("triageAnalysis");
      
      console.log(`Analyzing alert: ${alert.sheetName}-${alert.rowNumber}`);
      
      // THEN analyze the alert
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
        console.error(`❌ Analysis failed: ${data.error}`);
        setClaudeAnalysis("Error generating options: " + (data.error || "Unknown error"));
        setIsAnalyzing(false);
        return;
      }
      
      console.log(`✅ Generated ${data.options?.length || 0} options`);
      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
      setIsAnalyzing(false);
    } catch (err) {
      console.error(`❌ selectAlert error: ${err.message}`);
      setAcceptError(`Failed to analyze alert: ${err.message}`);
      setIsAnalyzing(false);
      console.error(err);
    }
  };

  // NEW: Accept an option and write to sheet
  const acceptOption = async (option) => {
    const alert = clientAlerts[currentClientAlertIndex];
    
    try {
      setIsAccepting(true);
      setAcceptError("");
      
      console.log(`Accepting option: ${option.title}`);
      
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "accept_option",
          alert,
          option,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        setAcceptError(`Failed to write to sheet: ${data.error || "Unknown error"}`);
        return;
      }
      
      console.log(`✅ Option accepted! ${data.cellsWritten} cells written`);
      
      // Mark alert as processed
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(new Set([...processedAlerts, alertId]));
      
      // Remove from client alerts
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);
      
      if (updatedAlerts.length === 0) {
        // All alerts processed for this client
        setScreen("clearFlags");
      } else {
        // Go to next alert in this client
        setScreen("alertSelection");
        setCurrentClientAlertIndex(0);
      }
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
      console.error(err);
    } finally {
      setIsAccepting(false);
    }
  };

  // NEW: Clear all flags for a client by checking column BN
  const clearAllFlags = async () => {
    if (!selectedClient) return;
    
    try {
      setIsLoading(true);
      setAcceptError("");
      
      console.log(`Clearing all flags for ${selectedClient.clientName}`);
      
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_flags",
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        setAcceptError(`Failed to clear flags: ${data.error || "Unknown error"}`);
        return;
      }
      
      console.log(`✅ Flags cleared for ${selectedClient.clientName}`);
      
      // Go back to client selection
      setSelectedClient(null);
      setClientAlerts([]);
      setScreen("clientSelection");
    } catch (err) {
      setAcceptError(`Failed to clear flags: ${err.message}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
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
    optionButton: {
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: "0",
      textAlign: "left",
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

  // Screen 1b: Client Selection Screen
  if (screen === "clientSelection" && sessionId) {
    // Count actual alerts per client from the loaded alerts
    const alertCountByClient = {};
    // We don't have all alerts in state, but we have flag keys — count actionable flags only
    clientsWithFlags.forEach(client => {
      const actionableFlagCount = Object.entries(client.flags)
        .filter(([key, value]) => value && !["invoiceAppDiscr","crmPipeSkippedBlank","crmConfSkippedBlank","crmCopiedConfChecked","crmCopiedConfUnchecked","crmCopiedConfDelete","retainerInvoicesCreated","expenseAppDiscr","expenseAdded","expenseUnreconGaps","invoiceStaleUnsentChanges"].includes(key))
        .length;
      alertCountByClient[client.clientName] = actionableFlagCount;
    });

    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Client</h1>
          <p style={styles.subtitle}>Choose a client to review their alerts ({totalAlerts} total)</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
          
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {clientsWithFlags.map((client, idx) => (
              <button
                key={idx}
                onClick={() => selectClient(client)}
                style={{
                  ...styles.optionButton,
                  textAlign: "left",
                  padding: "16px",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  cursor: "pointer",
                  backgroundColor: "#f9f9f9",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.target.style.backgroundColor = "#f0f0f0";
                  e.target.style.borderColor = "#2196f3";
                }}
                onMouseLeave={(e) => {
                  e.target.style.backgroundColor = "#f9f9f9";
                  e.target.style.borderColor = "#ddd";
                }}
              >
                <div style={{ fontWeight: "bold", fontSize: "16px", marginBottom: "4px" }}>
                  {client.clientName}
                </div>
                <div style={{ fontSize: "13px", color: "#666" }}>
                  {alertCountByClient[client.clientName] || 0} actionable alert type(s)
                </div>
              </button>
            ))}
          </div>

          <button onClick={() => { setSessionId(""); setScreen("initial"); }} style={{ ...styles.buttonSecondary, marginTop: "20px" }}>
            ← Back
          </button>
        </div>
        </div>
      </>
    );
  }

  // Screen 1c: Alert Selection Screen
  if (screen === "alertSelection" && selectedClient) {
    // Group alerts by type
    const groupedAlerts = {};
    clientAlerts.forEach(alert => {
      const type = alert.flagType || alert.type || "unknown";
      if (!groupedAlerts[type]) {
        groupedAlerts[type] = [];
      }
      groupedAlerts[type].push(alert);
    });

    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Alert</h1>
          <p style={styles.subtitle}>{selectedClient.clientName} - {clientAlerts.length} alert(s)</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
          
          {Object.keys(groupedAlerts).length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#666" }}>
              No more alerts for this client
            </div>
          ) : (
            <div>
              {Object.keys(groupedAlerts).map((type) => (
                <div key={type} style={{ marginBottom: "20px" }}>
                  <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#2196f3", marginBottom: "10px" }}>
                    {getFlagName(type)}
                  </h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {groupedAlerts[type].map((alert, idx) => (
                      <button
                        key={idx}
                        onClick={() => selectAlert(alert)}
                        style={{
                          ...styles.optionButton,
                          textAlign: "left",
                          padding: "12px",
                          border: "1px solid #e0e0e0",
                          borderRadius: "4px",
                          cursor: "pointer",
                          backgroundColor: "#fff",
                          fontSize: "13px",
                          transition: "all 0.2s",
                        }}
                        onMouseEnter={(e) => {
                          e.target.style.backgroundColor = "#f5f5f5";
                          e.target.style.borderColor = "#2196f3";
                        }}
                        onMouseLeave={(e) => {
                          e.target.style.backgroundColor = "#fff";
                          e.target.style.borderColor = "#e0e0e0";
                        }}
                      >
                        {getAlertSummary(alert)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <button onClick={() => setScreen("clientSelection")} style={{ ...styles.buttonSecondary, marginTop: "20px" }}>
            ← Back to Clients
          </button>
        </div>
        </div>
      </>
    );
  }

  // Screen 1d: Clear Flags Screen
  if (screen === "clearFlags" && selectedClient) {
    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>All Done!</h1>
          <p style={styles.subtitle}>All alerts for {selectedClient.clientName} have been processed</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
          
          <div style={{ ...styles.successBanner, marginBottom: "20px" }}>
            All alerts have been reviewed and resolved. Click below to clear the flags for this client.
          </div>

          <div style={{ display: "flex", gap: "12px", flexDirection: "column" }}>
            <button
              onClick={clearAllFlags}
              disabled={isLoading}
              style={{
                ...styles.button,
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              {isLoading ? "Clearing Flags..." : "✓ Clear All Flags"}
            </button>
            <button onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
              ← Back to Clients
            </button>
          </div>
        </div>
        </div>
      </>
    );
  }

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

  // Screen 3b: Display individual alert with Claude analysis (NEW CLIENT-BASED FLOW)
  if (screen === "triageAnalysis" && selectedClient && clientAlerts.length > 0) {
    const alert = clientAlerts[currentClientAlertIndex];
    const progress = currentClientAlertIndex + 1;

    return (
      <>
        <Head>
          <title>Alert Triage System</title>
        </Head>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
        </div>

        <div style={styles.card}>
          <div style={styles.alertHeader}>
            <h2 style={styles.alertTitle}>{alert.clientName || alert.type || "Financial Alert"}</h2>
            <span style={styles.alertCounter}>{progress}/{clientAlerts.length}</span>
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

          {acceptError && (
            <div style={{ ...styles.errorBanner, marginBottom: "16px" }}>
              {acceptError}
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
                        {/* CRM match analysis - ONLY show for CRM/invoices, not expenses */}
                        {option.matchAnalysis && typeof option.matchAnalysis === 'object' && !option.allocationBreakdown && (
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
                            {option.recommendedActions.map((action, i) => (
                              <div key={i} style={{ fontSize: "13px", color: "#555", marginTop: i === 0 ? "8px" : "6px", paddingTop: i === 0 ? "8px" : "0", borderTop: i === 0 ? "1px solid #ddd" : "none" }}>
                                {i === 0 ? <strong style={{ color: "#059669" }}>✓ {action}</strong> : `• ${action}`}
                              </div>
                            ))}
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
                          onClick={() => acceptOption(option)}
                          disabled={isAccepting}
                          style={{
                            ...styles.decisionButton,
                            ...styles.approveButton,
                            marginTop: "12px",
                            width: "100%",
                            opacity: isAccepting ? 0.5 : 1,
                          }}
                        >
                          {isAccepting ? "Writing to sheet..." : `✓ Accept Option ${idx + 1}`}
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
            </div>
          )}

          {isAnalyzing && (
            <div style={{ ...styles.claudeAnalysis, textAlign: "center", color: "#666" }}>
              Generating options for this alert...
            </div>
          )}

          <div style={{ marginTop: "16px", display: "flex", gap: "12px" }}>
            <button onClick={() => { setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={styles.buttonSecondary}>
              ← Back to Alerts
            </button>
            <button
              onClick={() => {
                // Remove this alert from clientAlerts and go back to the list
                const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
                setClientAlerts(updatedAlerts);
                setCurrentClientAlertIndex(0);
                setScreen(updatedAlerts.length === 0 ? "clearFlags" : "alertSelection");
              }}
              style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#d97706" }}
            >
              ⏭ Skip Alert
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