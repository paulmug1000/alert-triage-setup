import React, { useState, useEffect } from "react";

// Helper function defined OUTSIDE component to prevent re-creation on each render
function getAlertSummary(alert) {
  if (alert.type === "invoice" || alert.flagType === "invoiceDashboardDiscr") {
    const inv = alert.summary;
    const vatLabel = inv?.vatIncluded && inv.vatIncluded > 0 ? " +VAT" : " (no VAT)";
    return `Invoice #${inv?.invoiceNo || inv?.reference || "?"} - £${inv?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "expense" || alert.flagType === "expenseDashboardDiscr") {
    const exp = alert.summary;
    const vat = parseFloat(String(exp?.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
    const vatLabel = vat > 0 ? " +VAT" : " (no VAT)";
    return `${exp?.description || "Expense"} - £${exp?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "crm" || alert.flagType?.includes("crm")) {
    const crm = alert.data;
    const flagType = alert.alertType || alert.flagType || "";

    // App discr (crmConfAppDiscr / crmPipeAppDiscr): job exists in sheet but not CRM
    //   → read from sheetData (EF:EQ): 0=Client, 1=Job, 2=ProjectCode, 3=Revenue
    // Dash discr (crmConfDashDiscr / crmPipeDashDiscr): job exists in CRM but not sheet
    //   → read from crmData (X:AJ): 0=Client, 1=Job, 2=ProjectCode, 3=Revenue
    const isAppDiscr = flagType === "crmConfAppDiscr" || flagType === "crmPipeAppDiscr";
    const src = isAppDiscr ? crm?.sheetData : crm?.crmData;
    const client = src?.[0] || "";
    const job    = src?.[1] || "";
    const code   = src?.[2] || "";
    return `${client}${job ? " — " + job : ""}${code ? " (" + code + ")" : ""}` || "CRM alert";
  return "Alert";
}

// Inline spinner SVG — shown inside buttons during async operations
function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24" fill="none"
      style={{ display: "inline-block", verticalAlign: "middle", marginRight: "6px", animation: "triage-spin 0.7s linear infinite" }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Global styles injected once — handles :hover/:active which React inline styles can't do
const GLOBAL_STYLES = `
  @keyframes triage-spin { to { transform: rotate(360deg); } }
  .triage-btn { transition: filter 0.15s, transform 0.1s, background 0.15s, box-shadow 0.15s !important; }
  .triage-btn:hover:not(:disabled) { filter: brightness(0.92); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
  .triage-btn:active:not(:disabled) { transform: scale(0.97); filter: brightness(0.85); }
  .triage-btn:disabled { cursor: not-allowed !important; opacity: 0.55 !important; }
  .triage-btn-primary:hover:not(:disabled) { background: #0055aa !important; }
  .triage-client-card { transition: background 0.12s, border-color 0.12s, box-shadow 0.12s !important; }
  .triage-client-card:hover { background: #f0f4ff !important; border-color: #2196f3 !important; box-shadow: 0 2px 8px rgba(33,150,243,0.15) !important; }
  .triage-client-card:active { background: #e3ecff !important; transform: scale(0.995); }
`;

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
  const [screen, setScreen] = useState("initial"); // initial | clientSelection | alertSelection | triageAnalysis | ignoredAlerts
  const [clientsWithFlags, setClientsWithFlags] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientAlerts, setClientAlerts] = useState([]);
  const [currentClientAlertIndex, setCurrentClientAlertIndex] = useState(0);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");
  const [processedAlerts, setProcessedAlerts] = useState(new Set());

  // AlertMemory: ignore modal + ignored alerts screen
  const [showIgnoreModal, setShowIgnoreModal] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState("");
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [selectingClient, setSelectingClient] = useState(null); // clientName being loaded

  // Inject global button/interaction styles once on mount, and set page title/favicon
  useEffect(() => {
    // Set title and favicon directly — reliable across all screen transitions
    document.title = "Triage System";
    let favicon = document.querySelector("link[rel~='icon']");
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }
    favicon.href = "https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png";

    const id = "triage-global-styles";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = GLOBAL_STYLES;
      document.head.appendChild(el);
    }
  }, []);
  const [ignoredAlerts, setIgnoredAlerts] = useState([]);
  const [isLoadingIgnored, setIsLoadingIgnored] = useState(false);
  const [isUnignoring, setIsUnignoring] = useState(null);
  const [fromCache, setFromCache] = useState(false);

  // Clear flags: which flag groups to clear
  const [flagsToClear, setFlagsToClear] = useState({ invoice: false, crm: false, expense: false });

  // Non-actionable flags for the selected client
  const [clientNoActionAlerts, setClientNoActionAlerts] = useState([]);
  const [resolvedNoActionFlags, setResolvedNoActionFlags] = useState(new Set());

  // Rich analysis for noaction flags (crmCopiedConfChecked, crmCopiedConfUnchecked, retainerInvoicesCreated)
  const [noActionAnalysis, setNoActionAnalysis] = useState({}); // keyed by flagType, for current client only
  const [noActionAnalysisLoading, setNoActionAnalysisLoading] = useState({}); // keyed by flagType
  const [precomputedNoActionResults, setPrecomputedNoActionResults] = useState({}); // keyed by "clientName___flagType", never wiped

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

  // Manual refresh — skips precomputed cache and runs a live start_triage
  const refreshTriage = async () => {
    try {
      setIsLoading(true);
      setError("");
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_triage",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.error || "Failed to refresh triage data");
        return;
      }

      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setClientsWithFlags(data.clientsWithFlags || []);
      setProcessedAlerts(new Set());
      setAcknowledgedNoAction(new Set());
      setSelectedClient(null);
      setClientAlerts([]);

      if ((data.clientsWithFlags || []).length > 0) {
        setScreen("clientSelection");
      } else {
        setTriageComplete(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const startTriage = async () => {
    try {
      setIsLoading(true);
      setError("");

      // ── Step 1: Check for fresh precomputed data from cron job ──────────
      console.log("Checking for precomputed triage data...");
      let precomputedUsed = false;
      try {
        const preResponse = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_precomputed", automationCommanderSheetId }),
        });
        const preData = await preResponse.json();

        if (preData.success && preData.available) {
          console.log(`✅ Using precomputed data (${preData.computedMinutesAgo} min old, ${preData.totalAlerts} alerts)`);
          setSessionId(preData.sessionId);
          setTotalAlerts(preData.totalAlerts || 0);
          setNoActionCount(preData.noActionCount || 0);
          setClientsWithFlags(preData.clientsWithFlags || []);
          setAcknowledgedNoAction(new Set());
          setProcessedAlerts(new Set());

          // Store precomputed noAction analysis results in persistent state (keyed by "clientName___flagType")
          // This survives client switches — unpacked per-client on selection
          if (preData.noActionAnalysisResults && Object.keys(preData.noActionAnalysisResults).length > 0) {
            setPrecomputedNoActionResults(preData.noActionAnalysisResults);
            console.log(`  ✅ Pre-populated ${Object.keys(preData.noActionAnalysisResults).length} noAction analysis results`);
          }

          // Go to clientSelection if any clients have flags (actionable or noAction-only).
          // The old showNoAction path is bypassed — noAction flags are handled within clientSelection.
          if ((preData.clientsWithFlags || []).length > 0) {
            setScreen("clientSelection");
          } else {
            setTriageComplete(true);
          }
          precomputedUsed = true;
        } else {
          console.log(`No fresh precomputed data available — running live triage`);
        }
      } catch (preErr) {
        console.log(`Precomputed check failed, falling back to live run: ${preErr.message}`);
      }

      if (precomputedUsed) return;

      // ── Step 2: Fall back to live start_triage ───────────────────────────
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

      if ((data.clientsWithFlags || []).length > 0) {
        console.log(`${(data.clientsWithFlags || []).length} client(s) with flags, showing client selection...`);
        setScreen("clientSelection");
      } else {
        console.log("No clients with flags, showing complete screen");
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
      setSelectingClient(client.clientName);
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
      
      // Filter non-actionable alerts for this client by masterSheetId
      const filteredNoAction = (data.noActionAlerts || []).filter(
        na => na.clientId === client.masterSheetId
      );

      console.log(`  📊 Found ${filteredAlerts.length} unprocessed alerts for ${client.clientName}`);
      console.log(`  📋 Found ${filteredNoAction.length} non-actionable flags for ${client.clientName}`);
      
      setClientAlerts(filteredAlerts);
      setClientNoActionAlerts(filteredNoAction);
      setNoActionAnalysisLoading({});      // reset loading state

      // Restore resolved noAction flags from Redis session for this client
      const sessionResolved = (data.resolvedNoActionFlags || []);
      const restoredResolved = new Set(
        sessionResolved
          .filter(key => key.startsWith(client.clientName + "___"))
          .map(key => key.slice(client.clientName.length + 3))
      );
      setResolvedNoActionFlags(restoredResolved);

      // Seed analysis results from precomputed data for this client only
      // precomputedNoActionResults is keyed as "clientName___flagType" and never wiped
      const precomputedForClient = {};
      console.log(`  Unpacking noActionAnalysis keys for ${client.clientName}:`, Object.keys(precomputedNoActionResults));
      Object.entries(precomputedNoActionResults).forEach(([key, result]) => {
        const sep = "___";
        const sepIdx = key.indexOf(sep);
        if (sepIdx !== -1) {
          const keyClient = key.slice(0, sepIdx);
          const keyFlag = key.slice(sepIdx + sep.length);
          if (keyClient === client.clientName) {
            precomputedForClient[keyFlag] = result;
            console.log(`    ✓ Matched precomputed result: ${keyFlag}`);
          }
        }
      });
      console.log(`  precomputedForClient keys:`, Object.keys(precomputedForClient));
      setNoActionAnalysis(precomputedForClient);
      
      if (filteredAlerts.length === 0) {
        // No actionable alerts — only go to clearFlags if no-action flags are all resolved too
        if (filteredNoAction.length === 0 || filteredNoAction.every(na => resolvedNoActionFlags.has(na.flagType))) {
          console.log(`  → No unprocessed alerts and all no-action flags resolved, going to clearFlags screen`);
          setFlagsToClear(computeFlagGroups(client, []));
          setScreen("clearFlags");
        } else {
          console.log(`  → No actionable alerts but ${filteredNoAction.length} non-actionable flag(s) need resolving`);
          setScreen("alertSelection");
        }
      } else {
        console.log(`  → ${filteredAlerts.length} alerts ready, going to alertSelection screen`);
        setScreen("alertSelection");
      }
    } catch (err) {
      console.error(`❌ selectClient error: ${err.message}`);
      setAcceptError(`Failed to select client: ${err.message}`);
      console.error(err);
    } finally {
      setSelectingClient(null);
    }
  };

  // NEW: Select an alert and analyze it
  const selectAlert = async (alert) => {
    try {
      console.log(`\n📍 selectAlert called for: ${alert.sheetName}-${alert.rowNumber}`);
      
      const alertIndex = clientAlerts.indexOf(alert);
      setCurrentClientAlertIndex(alertIndex);
      setAcceptError("");
      setIsAnalyzing(true);
      setClaudeAnalysis("");
      setFromCache(false);
      setShowIgnoreModal(false);
      setIgnoreReason("");
      
      setScreen("triageAnalysis");
      
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
      
      console.log(`✅ Generated ${data.options?.length || 0} options${data.fromCache ? " (from cache)" : ""}`);
      setFromCache(!!data.fromCache);
      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
      setIsAnalyzing(false);
    } catch (err) {
      console.error(`❌ selectAlert error: ${err.message}`);
      setAcceptError(`Failed to analyze alert: ${err.message}`);
      setIsAnalyzing(false);
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

      // Update Redis session so reloads reflect resolved state (fire-and-forget)
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }
      
      // Remove from client alerts
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);
      
      if (updatedAlerts.length === 0) {
        // All actionable alerts processed — go to clearFlags only if no-action flags are all resolved
        if (allNoActionResolved()) {
          setFlagsToClear(computeFlagGroups(selectedClient, []));
          setScreen("clearFlags");
        } else {
          // Still have unresolved non-actionable flags — go back to alertSelection to show them
          setScreen("alertSelection");
          setCurrentClientAlertIndex(0);
        }
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

  // Returns true when all non-actionable flags for the current client are resolved
  const allNoActionResolved = () =>
    clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.flagType));

  // Auto-trigger triage on mount — skips the home screen entirely
  useEffect(() => {
    startTriage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute which flag groups (invoice/crm/expense) are active for a client
  // Used to pre-check the right toggles on the Clear Flags screen
  const computeFlagGroups = (client, remainingAlerts) => {
    if (!client) return { invoice: false, crm: false, expense: false };
    const f = client.flags || {};

    // A group is pre-checked only if:
    // (a) the client has flags in that group, AND
    // (b) there are no remaining unprocessed alerts for that group
    const invoiceAlertTypes = new Set(["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated"]);
    const crmAlertTypes = new Set(["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
      "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"]);
    const expenseAlertTypes = new Set(["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"]);

    const remaining = remainingAlerts || [];
    const hasInvoiceFlag = !!(f.invoiceDashboardDiscr || f.invoiceAppDiscr || f.invoiceStaleUnsentChanges || f.retainerInvoicesCreated);
    const hasCRMFlag = !!(f.crmPipeDashDiscr || f.crmPipeAppDiscr || f.crmConfDashDiscr || f.crmConfAppDiscr ||
      f.crmPipeSkippedBlank || f.crmConfSkippedBlank || f.crmCopiedConfChecked || f.crmCopiedConfUnchecked || f.crmCopiedConfDelete);
    const hasExpenseFlag = !!(f.expenseDashboardDiscr || f.expenseAppDiscr || f.expenseAdded || f.expenseUnreconGaps);

    const remainingInvoice = remaining.some(a => invoiceAlertTypes.has(a.flagType || a.type));
    const remainingCRM = remaining.some(a => crmAlertTypes.has(a.flagType || a.type));
    const remainingExpense = remaining.some(a => expenseAlertTypes.has(a.flagType || a.type));

    return {
      invoice: hasInvoiceFlag && !remainingInvoice,
      crm: hasCRMFlag && !remainingCRM,
      expense: hasExpenseFlag && !remainingExpense,
    };
  };

  // Clear selected flag groups by writing directly to DataChgAlert cells
  const clearSelectedFlags = async () => {
    if (!selectedClient) return;

    const selected = Object.entries(flagsToClear)
      .filter(([, checked]) => checked)
      .map(([group]) => group);

    if (selected.length === 0) {
      setAcceptError("Please select at least one flag group to clear.");
      return;
    }

    try {
      setIsLoading(true);
      setAcceptError("");

      console.log(`Clearing flags for ${selectedClient.clientName}: ${selected.join(", ")}`);

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_flags",
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
          flagsToClear: selected,
          clientName: selectedClient.clientName,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        setAcceptError(`Failed to clear flags: ${data.error || "Unknown error"}`);
        return;
      }

      console.log(`✅ Flags cleared for ${selectedClient.clientName}: ${data.cellsWritten?.join(", ")}`);

      // Map cleared groups back to individual flag keys
      const FLAG_GROUP_KEYS = {
        invoice: ["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated"],
        crm: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
              "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked",
              "crmCopiedConfUnchecked", "crmCopiedConfDelete"],
        expense: ["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"],
      };
      const clearedKeys = new Set(selected.flatMap(group => FLAG_GROUP_KEYS[group] || []));

      // Update Redis session and precomputed cache so reloads reflect the cleared state
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_session_flags",
            sessionId,
            clientName: selectedClient.clientName,
            clearedFlagKeys: [...clearedKeys],
          }),
        }).catch(() => {});
      }

      // Zero out the cleared flag keys on the selected client only.
      // Do NOT remove any clients from the list — the list only refreshes from the
      // server on reload. Removing clients here causes other clients to vanish too.
      setClientsWithFlags(prev =>
        prev.map(client => {
          if (client.clientName !== selectedClient.clientName) return client;
          const updatedFlags = { ...client.flags };
          clearedKeys.forEach(key => { updatedFlags[key] = false; });
          return { ...client, flags: updatedFlags };
        })
      );

      // Go back to client selection
      setSelectedClient(null);
      setClientAlerts([]);
      setFlagsToClear({ invoice: false, crm: false, expense: false });
      setScreen("clientSelection");
    } catch (err) {
      setAcceptError(`Failed to clear flags: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Analyze a rich non-actionable flag (CRM copied / retainer invoices)
  const analyzeNoActionFlag = async (flagType) => {
    if (!selectedClient || noActionAnalysisLoading[flagType]) return;
    setNoActionAnalysisLoading(prev => ({ ...prev, [flagType]: true }));
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_noaction_flag",
          flagType,
          clientSheetId: selectedClient.clientSheetId,
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
          clientName: selectedClient.clientName,
        }),
      });
      const data = await resp.json();
      setNoActionAnalysis(prev => ({ ...prev, [flagType]: data }));
    } catch (e) {
      setNoActionAnalysis(prev => ({ ...prev, [flagType]: { success: false, error: e.message } }));
    } finally {
      setNoActionAnalysisLoading(prev => ({ ...prev, [flagType]: false }));
    }
  };

  // AlertMemory: ignore current alert permanently
  const ignoreAlert = async () => {
    const alert = clientAlerts[currentClientAlertIndex];
    try {
      setIsIgnoring(true);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ignore_alert",
          alert,
          ignoreReason,
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to ignore alert: ${data.error || "Unknown error"}`);
        return;
      }

      console.log(`✅ Alert ignored`);
      setShowIgnoreModal(false);
      setIgnoreReason("");

      // Mark as processed so it won't reappear if selectClient reloads from Redis
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(prev => new Set([...prev, alertId]));

      // Update Redis session so reloads reflect resolved state (fire-and-forget)
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }

      // Remove from client alerts list
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);
      setCurrentClientAlertIndex(0);

      if (updatedAlerts.length === 0) {
        // Same gate as acceptOption — only go to clearFlags if no-action flags resolved too
        if (allNoActionResolved()) {
          setFlagsToClear(computeFlagGroups(selectedClient, []));
          setScreen("clearFlags");
        } else {
          setScreen("alertSelection");
        }
      } else {
        setScreen("alertSelection");
      }
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsIgnoring(false);
    }
  };

  // AlertMemory: load all ignored alerts for the ignored alerts screen
  const loadIgnoredAlerts = async () => {
    try {
      setIsLoadingIgnored(true);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_ignored_alerts",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to load ignored alerts: ${data.error || "Unknown error"}`);
        return;
      }

      setIgnoredAlerts(data.ignoredAlerts || []);
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsLoadingIgnored(false);
    }
  };

  // AlertMemory: un-ignore an alert so it reappears in future triage runs
  const unignoreAlert = async (fingerprintHash) => {
    try {
      setIsUnignoring(fingerprintHash);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unignore_alert",
          fingerprintHash,
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to un-ignore alert: ${data.error || "Unknown error"}`);
        return;
      }

      // Remove from local list
      setIgnoredAlerts(prev => prev.filter(a => a.fingerprintHash !== fingerprintHash));
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsUnignoring(null);
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
    cacheBadge: {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      background: "#e8f5e9",
      color: "#2e7d32",
      border: "1px solid #a5d6a7",
      borderRadius: "4px",
      padding: "3px 8px",
      fontSize: "12px",
      fontWeight: "600",
      marginLeft: "8px",
    },
    modalOverlay: {
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    },
    modalCard: {
      background: "white",
      borderRadius: "8px",
      padding: "24px",
      width: "440px",
      maxWidth: "90vw",
      boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    },
    modalTitle: {
      fontSize: "16px",
      fontWeight: "700",
      color: "#1a1a1a",
      margin: "0 0 8px 0",
    },
    modalSubtitle: {
      fontSize: "13px",
      color: "#666",
      margin: "0 0 16px 0",
      lineHeight: "1.5",
    },
    modalTextarea: {
      width: "100%",
      border: "1px solid #ddd",
      borderRadius: "6px",
      padding: "10px",
      fontSize: "13px",
      fontFamily: "inherit",
      resize: "vertical",
      minHeight: "80px",
      boxSizing: "border-box",
    },
    modalButtons: {
      display: "flex",
      gap: "10px",
      marginTop: "16px",
      justifyContent: "flex-end",
    },
    ignoreButton: {
      background: "#ef6c00",
      color: "white",
      border: "none",
      borderRadius: "6px",
      padding: "9px 18px",
      fontWeight: "600",
      fontSize: "13px",
      cursor: "pointer",
    },
    ignoredAlertCard: {
      background: "#fff8f2",
      border: "1px solid #ffe0b2",
      borderRadius: "6px",
      padding: "14px 16px",
      marginBottom: "10px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: "12px",
    },
    ignoredAlertMeta: {
      fontSize: "12px",
      color: "#999",
      marginTop: "4px",
    },
    unignoreButton: {
      background: "#1976d2",
      color: "white",
      border: "none",
      borderRadius: "6px",
      padding: "6px 14px",
      fontWeight: "600",
      fontSize: "12px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      flexShrink: 0,
    },
    linkButton: {
      background: "none",
      border: "none",
      color: "#0066cc",
      fontSize: "13px",
      cursor: "pointer",
      padding: "0",
      textDecoration: "underline",
    },
    flagToggleRow: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "12px 14px",
      borderRadius: "6px",
      border: "1px solid #e0e0e0",
      marginBottom: "8px",
      cursor: "pointer",
      background: "#fafafa",
      userSelect: "none",
    },
    flagToggleRowActive: {
      background: "#e8f5e9",
      borderColor: "#a5d6a7",
    },
    flagToggleLabel: {
      flex: 1,
      fontSize: "14px",
      fontWeight: "600",
      color: "#1a1a1a",
    },
    flagToggleSub: {
      fontSize: "12px",
      color: "#888",
      fontWeight: "400",
      marginTop: "2px",
    },
    flagCheckbox: {
      width: "18px",
      height: "18px",
      accentColor: "#4caf50",
      cursor: "pointer",
      flexShrink: 0,
    },
  };

  // Screen: Ignored Alerts
  if (screen === "ignoredAlerts") {
    return (
      <>
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
                  <div key={a.fingerprintHash} style={styles.ignoredAlertCard}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a" }}>
                        {a.alertSummary || "(no summary)"}
                      </div>
                      <div style={styles.ignoredAlertMeta}>
                        {a.clientName} · {a.alertType} · Ignored {a.lastSeen}
                      </div>
                      {a.ignoreReason && (
                        <div style={{ fontSize: "12px", color: "#888", marginTop: "4px", fontStyle: "italic" }}>
                          Reason: {a.ignoreReason}
                        </div>
                      )}
                    </div>
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
                ))}
              </div>
            )}

            <button className="triage-btn"
              onClick={() => { setAcceptError(""); setScreen("clientSelection"); }}
              style={{ ...styles.buttonSecondary, marginTop: "20px" }}
            >
              ← Back to Clients
            </button>
          </div>
        </div>
      </>
    );
  }

  // Screen 1b: Client Selection Screen
  if (screen === "clientSelection" && sessionId) {
    const ACTIONABLE_FLAG_KEYS = [
      "invoiceDashboardDiscr", "expenseDashboardDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
    ];

    // If all clients have had their flags zeroed out, show complete screen
    const activeClients = clientsWithFlags.filter(c => Object.values(c.flags || {}).some(v => v));
    if (activeClients.length === 0) {
      return (
        <>
          <div style={styles.container}>
            <div style={styles.header}>
              <h1 style={styles.title}>All Done</h1>
              <p style={styles.subtitle}>All alerts and flags have been resolved</p>
            </div>
            <div style={styles.card}>
              <div style={styles.successBanner}>✓ No outstanding alerts or flags</div>
              <button className="triage-btn" onClick={refreshTriage} disabled={isLoading} style={{ ...styles.buttonSecondary, marginTop: "16px", opacity: isLoading ? 0.5 : 1 }}>
                {isLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
              </button>
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Client</h1>
          <p style={styles.subtitle}>Choose a client to review their alerts ({totalAlerts} total)</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

          {isLoading ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: "#666" }}>
              <Spinner size={32} color="#0066cc" />
              <div style={{ fontSize: "15px", fontWeight: "600", color: "#333", marginTop: "12px", marginBottom: "6px" }}>
                Refreshing data...
              </div>
              <div style={{ fontSize: "13px", color: "#888" }}>
                Reading latest flags and alerts from your sheets
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {clientsWithFlags.filter(client =>
                Object.values(client.flags || {}).some(v => v)
              ).map((client, idx) => {
                const actionableLines = ACTIONABLE_FLAG_KEYS
                  .filter(key => client.flags?.[key])
                  .map(key => {
                    const count = client.alertCounts?.[key];
                    const label = getFlagName(key);
                    return count
                      ? `${label} (${count} alert${count !== 1 ? "s" : ""})`
                      : label;
                  });

                const infoLines = Object.entries(client.flags || {})
                  .filter(([key, val]) => val && !ACTIONABLE_FLAG_KEYS.includes(key))
                  .map(([key]) => getFlagName(key));

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
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button className="triage-btn"
              onClick={() => {
                setScreen("ignoredAlerts");
                loadIgnoredAlerts();
              }}
              style={styles.linkButton}
            >
              View ignored alerts →
            </button>
            <button className="triage-btn"
              onClick={refreshTriage}
              disabled={isLoading}
              style={{
                ...styles.buttonSecondary,
                fontSize: "13px",
                padding: "6px 14px",
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              {isLoading ? <><Spinner />Refreshing...</> : "↻ Refresh"}
            </button>
          </div>
        </div>
        </div>
      </>
    );
  }

  // Screen 1c: Alert Selection Screen
  if (screen === "alertSelection" && selectedClient) {
    // Group actionable alerts by type
    const groupedAlerts = {};
    clientAlerts.forEach(alert => {
      const type = alert.flagType || alert.alertType || alert.type || "unknown";
      if (!groupedAlerts[type]) groupedAlerts[type] = [];
      groupedAlerts[type].push(alert);
    });

    const noActionDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.flagType));
    const allActionableDone = clientAlerts.length === 0;
    const canProceed = allActionableDone && noActionDone;

    return (
      <>
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Select Alert</h1>
          <p style={styles.subtitle}>{selectedClient.clientName} - {clientAlerts.length} alert(s)</p>
        </div>

        <div style={styles.card}>
          {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}
          
          {/* Actionable alerts */}
          {Object.keys(groupedAlerts).length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#666", marginBottom: "8px" }}>
              {clientNoActionAlerts.length > 0
                ? "All actionable alerts resolved ✓"
                : "No more alerts for this client"}
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
                      <button className="triage-btn"
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

          {/* Non-actionable flags section */}
          {clientNoActionAlerts.length > 0 && (
            <div style={styles.noActionSection}>
              <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#666", marginBottom: "10px" }}>
                Informational Flags
                <span style={{ fontWeight: "400", marginLeft: "8px", fontSize: "12px" }}>
                  ({resolvedNoActionFlags.size}/{clientNoActionAlerts.length} resolved)
                </span>
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {clientNoActionAlerts.map((na) => {
                  const isResolved = resolvedNoActionFlags.has(na.flagType);
                  const isRichFlag = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated"].includes(na.flagType);
                  const analysis = noActionAnalysis[na.flagType];
                  const isLoading = noActionAnalysisLoading[na.flagType];

                  if (isRichFlag && !isResolved) {
                    // Rich analysis card
                    const overallOk = analysis?.overallOk;
                    const hasIssues = analysis && !analysis.overallOk;
                    const borderColor = !analysis ? "#e0e0e0" : overallOk ? "#c8e6c9" : "#ffccbc";
                    const bgColor = !analysis ? "#fff" : overallOk ? "#f1f8f2" : "#fff8f6";

                    return (
                      <div key={na.flagType} style={{ border: `1px solid ${borderColor}`, borderRadius: "6px", background: bgColor, padding: "12px" }}>
                        {/* Header row */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: analysis ? "10px" : "0" }}>
                          <span style={{ fontSize: "13px", fontWeight: "600", color: "#444" }}>
                            {na.flagName || getFlagName(na.flagType)}
                          </span>
                          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                            {!analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na.flagType)}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                              >
                                🔍 Analyse
                              </button>
                            )}
                            {isLoading && (
                              <span style={{ fontSize: "12px", color: "#888", padding: "5px 10px", display: "inline-flex", alignItems: "center" }}><Spinner size={12} />Analysing…</span>
                            )}
                            {analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na.flagType)}
                                style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 8px" }}
                              >
                                ↻ Re-run
                              </button>
                            )}
                            <button className="triage-btn"
                              onClick={() => {
                                setResolvedNoActionFlags(prev => new Set([...prev, na.flagType]));
                                // Zero out this flag in clientsWithFlags so the pill disappears on the client selection screen
                                setClientsWithFlags(prev => prev.map(c => {
                                  if (c.clientName !== selectedClient?.clientName) return c;
                                  return { ...c, flags: { ...c.flags, [na.flagType]: false } };
                                }));
                                if (sessionId && selectedClient) {
                                  // Persist to Redis session and clear from precomputed cache
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType }),
                                  }).catch(() => {});
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: [na.flagType] }),
                                  }).catch(() => {});
                                }
                              }}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                            >
                              ✓ Mark resolved
                            </button>
                          </div>
                        </div>

                        {/* Analysis results */}
                        {analysis && !isLoading && (
                          <div>
                            {/* Overall status banner */}
                            <div style={{
                              padding: "6px 10px",
                              borderRadius: "4px",
                              marginBottom: "8px",
                              fontSize: "12px",
                              fontWeight: "600",
                              background: overallOk ? "#e8f5e9" : "#fbe9e7",
                              color: overallOk ? "#2e7d32" : "#bf360c",
                            }}>
                              {overallOk ? "✓ Everything looks correct" : "⚠ Issues found — review below"}
                            </div>

                            {/* Per-job results */}
                            {(analysis.results || []).map((r, ri) => (
                              <div key={ri} style={{
                                marginBottom: "8px",
                                padding: "8px 10px",
                                borderRadius: "4px",
                                border: `1px solid ${r.status === "ok" ? "#c8e6c9" : r.status === "issue" ? "#ffccbc" : "#e0e0e0"}`,
                                background: r.status === "ok" ? "#f9fef9" : r.status === "issue" ? "#fff8f6" : "#fafafa",
                              }}>
                                {/* Job header */}
                                {(r.jobName || r.projectCode) && (
                                  <div style={{ fontSize: "12px", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                                    {r.clientName && (
                                      <span style={{ fontWeight: "400", color: "#666" }}>{r.clientName} — </span>
                                    )}
                                    {r.jobName || r.projectCode}
                                    {r.projectCode && r.jobName && (
                                      <span style={{ fontWeight: "400", color: "#888", marginLeft: "6px" }}>({r.projectCode})</span>
                                    )}
                                    {r.periodLabel && (
                                      <span style={{ fontWeight: "400", color: "#666", marginLeft: "6px" }}> — {r.periodLabel}</span>
                                    )}
                                    {r.parentSheetRow && (
                                      <span style={{ fontWeight: "400", color: "#aaa", marginLeft: "6px", fontSize: "11px" }}>Confirmed row {r.parentSheetRow}</span>
                                    )}
                                  </div>
                                )}
                                {/* Info message (no job breakdown) */}
                                {r.message && (!r.checks || r.checks.length === 0) && (
                                  <div style={{ fontSize: "12px", color: "#666" }}>{r.message}</div>
                                )}
                                {/* Check lines */}
                                {(r.checks || []).map((chk, ci) => (
                                  <div key={ci} style={{ fontSize: "12px", color: chk.ok ? "#2e7d32" : "#c62828", marginTop: "2px" }}>
                                    {chk.message}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* API error */}
                        {analysis && !analysis.success && (
                          <div style={{ fontSize: "12px", color: "#c62828", marginTop: "6px" }}>
                            Error: {analysis.error}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Simple flag (no rich analysis) or resolved
                  return (
                    <div
                      key={na.flagType}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "4px",
                        border: `1px solid ${isResolved ? "#c8e6c9" : "#e0e0e0"}`,
                        background: isResolved ? "#f1f8f2" : "#fff",
                        gap: "12px",
                      }}
                    >
                      <span style={{
                        fontSize: "13px",
                        color: isResolved ? "#2e7d32" : "#555",
                        textDecoration: isResolved ? "line-through" : "none",
                      }}>
                        {na.flagName || getFlagName(na.flagType)}
                      </span>
                      {isResolved ? (
                        <span style={{ fontSize: "12px", color: "#2e7d32", fontWeight: "600", whiteSpace: "nowrap" }}>
                          ✓ Resolved
                        </span>
                      ) : (
                        <button className="triage-btn"
                          onClick={() => {
                                setResolvedNoActionFlags(prev => new Set([...prev, na.flagType]));
                                // Zero out this flag in clientsWithFlags so the pill disappears on the client selection screen
                                setClientsWithFlags(prev => prev.map(c => {
                                  if (c.clientName !== selectedClient?.clientName) return c;
                                  return { ...c, flags: { ...c.flags, [na.flagType]: false } };
                                }));
                                if (sessionId && selectedClient) {
                                  // Persist to Redis session and clear from precomputed cache
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType }),
                                  }).catch(() => {});
                                  fetch("/api/triage", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: [na.flagType] }),
                                  }).catch(() => {});
                                }
                              }}
                          style={{
                            ...styles.buttonSecondary,
                            fontSize: "12px",
                            padding: "5px 10px",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          Mark resolved
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bottom button row — always visible */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
            <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
              ← Back to Clients
            </button>
            <button className="triage-btn"
              onClick={() => {
                setFlagsToClear(computeFlagGroups(selectedClient, clientAlerts));
                setScreen("clearFlags");
              }}
              style={styles.buttonSecondary}
            >
              Clear Flags →
            </button>
          </div>
        </div>
        </div>
      </>
    );
  }

  // Screen 1d: Clear Flags Screen
  if (screen === "clearFlags" && selectedClient) {
    const allChecked = flagsToClear.invoice && flagsToClear.crm && flagsToClear.expense;
    const noneChecked = !flagsToClear.invoice && !flagsToClear.crm && !flagsToClear.expense;
    const anyActive = flagsToClear.invoice || flagsToClear.crm || flagsToClear.expense;

    const FLAG_GROUPS = [
      {
        key: "invoice",
        label: "Invoice flags",
        sub: "Clears AS2 in DataChgAlert",
        flags: ["invoiceDashboardDiscr", "invoiceAppDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated"],
      },
      {
        key: "crm",
        label: "CRM flags",
        sub: "Clears AT2 and AU2 in DataChgAlert",
        flags: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
                "crmPipeSkippedBlank", "crmConfSkippedBlank", "crmCopiedConfChecked",
                "crmCopiedConfUnchecked", "crmCopiedConfDelete"],
      },
      {
        key: "expense",
        label: "Expense flags",
        sub: "Clears AV2 in DataChgAlert",
        flags: ["expenseDashboardDiscr", "expenseAppDiscr", "expenseAdded", "expenseUnreconGaps"],
      },
    ];

    return (
      <>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Clear Flags</h1>
            <p style={styles.subtitle}>{selectedClient.clientName} — select which flags to clear</p>
          </div>

          <div style={styles.card}>
            {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

            <div style={{ ...styles.successBanner, marginBottom: "20px" }}>
              Select which flag groups to clear in the client's DataChgAlert sheet. Groups with unresolved alerts are unchecked by default.
            </div>

            {/* Select All / None toggle */}
            <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
              <button className="triage-btn"
                onClick={() => setFlagsToClear({ invoice: true, crm: true, expense: true })}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}
              >
                Select All
              </button>
              <button className="triage-btn"
                onClick={() => setFlagsToClear({ invoice: false, crm: false, expense: false })}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}
              >
                Select None
              </button>
            </div>

            {/* Per-group toggles */}
            {FLAG_GROUPS.map(group => {
              const isChecked = flagsToClear[group.key];
              const hasActiveFlags = group.flags.some(f => selectedClient.flags?.[f]);
              return (
                <div
                  key={group.key}
                  style={{
                    ...styles.flagToggleRow,
                    ...(isChecked ? styles.flagToggleRowActive : {}),
                  }}
                  onClick={() => setFlagsToClear(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => {}}
                    style={styles.flagCheckbox}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={styles.flagToggleLabel}>
                      {group.label}
                      {hasActiveFlags && (
                        <span style={{ marginLeft: "8px", fontSize: "11px", color: "#e65100", fontWeight: "700" }}>
                          ● active
                        </span>
                      )}
                    </div>
                    <div style={styles.flagToggleSub}>{group.sub}</div>
                  </div>
                </div>
              );
            })}

            <div style={{ display: "flex", gap: "12px", flexDirection: "column", marginTop: "20px" }}>
              <button className="triage-btn triage-btn-primary"
                onClick={clearSelectedFlags}
                disabled={isLoading || noneChecked}
                style={{
                  ...styles.button,
                  opacity: isLoading || noneChecked ? 0.5 : 1,
                }}
              >
                {isLoading
                  ? <><Spinner color="white" />Clearing...</>
                  : allChecked
                  ? "✓ Clear All Flags"
                  : anyActive
                  ? "✓ Clear Selected Flags"
                  : "Select flags to clear"}
              </button>
              <button className="triage-btn" onClick={() => setScreen("clientSelection")} style={styles.buttonSecondary}>
                ← Back to Clients
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Screen 1: Loading state (shown while startTriage runs on mount)
  if (!sessionId && !triageComplete) {
    return (
      <>
        <div style={styles.container}>
          <div style={styles.header}>
            <h1 style={styles.title}>Alert Triage System</h1>
            <p style={styles.subtitle}>Review and resolve financial automation alerts</p>
          </div>
          <div style={styles.card}>
            {error ? (
              <>
                <div style={styles.errorBanner}>{error}</div>
                <button className="triage-btn"
                  onClick={startTriage}
                  disabled={isLoading}
                  style={{ ...styles.button, marginTop: "12px", opacity: isLoading ? 0.5 : 1 }}
                >
                  {isLoading ? <><Spinner color="white" />Loading...</> : "Retry →"}
                </button>
              </>
            ) : (
              <p style={styles.loadingText}>
                {isLoading ? <><Spinner color="white" />Loading alerts...</> : "Initialising..."}
              </p>
            )}
          </div>
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
          {isLoading ? (
            <div style={{ textAlign: "center", padding: "32px 16px" }}>
              <Spinner size={32} color="#0066cc" />
              <div style={{ fontSize: "15px", fontWeight: "600", color: "#333", marginTop: "12px", marginBottom: "6px" }}>
                Checking for new alerts...
              </div>
              <div style={{ fontSize: "13px", color: "#888" }}>
                Reading latest flags from your sheets
              </div>
            </div>
          ) : (
            <>
              <div style={styles.successBanner}>
                No discrepancies detected. Your financial automation system is running smoothly!
              </div>
              <div style={styles.buttonGroup}>
                <button className="triage-btn triage-btn-primary" onClick={startTriage} style={styles.button}>
                  ↻ Refresh
                </button>
              </div>
            </>
          )}
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
        <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
        </div>

        <div style={styles.card}>
          <div style={styles.alertHeader}>
            <h2 style={styles.alertTitle}>
              {alert.clientName || alert.type || "Financial Alert"}
              {fromCache && (
                <span style={styles.cacheBadge}>⚡ Cached</span>
              )}
            </h2>
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
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{(() => {
                      const vat = parseFloat(String(alert.summary.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
                      return vat > 0 ? " +VAT" : " (no VAT)";
                    })()}</div>
                    {alert.summary.date && <div><strong>Date:</strong> {alert.summary.date}</div>}
                    {alert.summary.accountName && <div><strong>Account Name:</strong> {alert.summary.accountName}</div>}
                    {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                    {alert.summary.transactionId && <div><strong>Transaction ID:</strong> {alert.summary.transactionId}</div>}
                  </>
                ) : (
                  // Invoice display
                  <>
                    <div><strong>Invoice:</strong> {alert.summary.invoiceNo}</div>
                    <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{alert.summary.vatIncluded && alert.summary.vatIncluded > 0 ? " +VAT" : " (no VAT)"}</div>
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
                              <div style={{
                                marginTop: "6px", fontSize: "13px",
                                color: String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "#059669" : "#dc2626"
                              }}>
                                {String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "✓" : "✗"} {option.allocationBreakdown.expenseCanFit}
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
                        <button className="triage-btn triage-btn-primary"
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
                          {isAccepting ? <><Spinner color="white" />Writing to sheet...</> : `✓ Accept Option ${idx + 1}`}
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
            <button className="triage-btn" onClick={() => { setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={styles.buttonSecondary}>
              ← Back to Alerts
            </button>
            <button className="triage-btn"
              onClick={() => {
                const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
                setClientAlerts(updatedAlerts);
                setCurrentClientAlertIndex(0);
                setScreen(updatedAlerts.length === 0 ? "clearFlags" : "alertSelection");
              }}
              style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#d97706" }}
            >
              ⏭ Skip Alert
            </button>
            <button className="triage-btn"
              onClick={() => setShowIgnoreModal(true)}
              style={{ ...styles.buttonSecondary, color: "#c62828", borderColor: "#ef9a9a" }}
            >
              🚫 Ignore Forever
            </button>
          </div>

          {/* Ignore reason modal */}
          {showIgnoreModal && (
            <div style={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowIgnoreModal(false); }}>
              <div style={styles.modalCard}>
                <h3 style={styles.modalTitle}>Permanently Ignore Alert</h3>
                <p style={styles.modalSubtitle}>
                  This alert will be hidden from all future triage runs unless its underlying data changes.
                  Optionally add a reason for your records.
                </p>
                <textarea
                  value={ignoreReason}
                  onChange={(e) => setIgnoreReason(e.target.value)}
                  placeholder="Reason for ignoring (optional)..."
                  style={styles.modalTextarea}
                  autoFocus
                />
                <div style={styles.modalButtons}>
                  <button className="triage-btn"
                    onClick={() => { setShowIgnoreModal(false); setIgnoreReason(""); }}
                    style={styles.buttonSecondary}
                  >
                    Cancel
                  </button>
                  <button className="triage-btn"
                    onClick={ignoreAlert}
                    disabled={isIgnoring}
                    style={{ ...styles.ignoreButton, opacity: isIgnoring ? 0.5 : 1 }}
                  >
                    {isIgnoring ? <><Spinner />Ignoring...</> : "🚫 Confirm Ignore"}
                  </button>
                </div>
              </div>
            </div>
          )}
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
              <button className="triage-btn" onClick={() => setShowNoAction(false)} style={styles.buttonSecondary}>
                ← Back to Actionable Alerts
              </button>
            )}
            {allAcknowledged && (
              <button className="triage-btn"
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