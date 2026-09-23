import { useState, useEffect, useMemo } from "react";
import { ALERT_CATEGORY_FLAGS, EXPENSE_SUPPRESSIBLE } from "../utils/helpers";

export function useTriageEngine({
  automationCommanderSheetId,
  screen,
  setScreen,
  activeNav,
  assignedAppIds,
  assignedByClient,
  existingTaskBanner,
  setExistingTaskBanner,
  allClientsMap,
  isLoading,
  setIsLoading,
  error,
  setError,
  setBulkMode,
  setBulkSelected
}) {
  const [sessionId, setSessionId] = useState("");
  const [totalAlerts, setTotalAlerts] = useState(0);
  const [noActionCount, setNoActionCount] = useState(0);
  const [acknowledgedNoAction, setAcknowledgedNoAction] = useState(new Set());
  const [triageComplete, setTriageComplete] = useState(false);
  const [claudeAnalysis, setClaudeAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");

  const [clientsWithFlags, setClientsWithFlags] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientAlerts, setClientAlerts] = useState([]);
  const [currentClientAlertIndex, setCurrentClientAlertIndex] = useState(0);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");
  const [processedAlerts, setProcessedAlerts] = useState(new Set());

  const [showIgnoreModal, setShowIgnoreModal] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState("");
  const [isIgnoring, setIsIgnoring] = useState(false);
  const [selectingClient, setSelectingClient] = useState(null);
  const [previousIgnoreReason, setPreviousIgnoreReason] = useState(null);
  const [proactiveAlerts, setProactiveAlerts] = useState([]);
  const [proactiveCountsByClient, setProactiveCountsByClient] = useState({});
  const [proactiveLoading, setProactiveLoading] = useState(false);
  const [proactiveLoadedAt, setProactiveLoadedAt] = useState(0);

  const [fromCache, setFromCache] = useState(false);
  const [clientNoActionAlerts, setClientNoActionAlerts] = useState([]);
  const [resolvedNoActionFlags, setResolvedNoActionFlags] = useState(new Set());
  const [noActionAnalysis, setNoActionAnalysis] = useState({});
  const [noActionAnalysisLoading, setNoActionAnalysisLoading] = useState({});
  const [precomputedNoActionResults, setPrecomputedNoActionResults] = useState({});

  const checkExistingTask = async (alert) => {
    try {
      setExistingTaskBanner(null);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_existing_task", alert, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success && data.found) setExistingTaskBanner(data.task);
    } catch (e) { /* silent */ }
  };

  const refreshTriage = async (forceProactive = false) => {
    const isForced = forceProactive === true;
    try {
      setIsLoading(true);
      setRefreshStatus("Initializing...");
      setError("");
      setAcceptError("");
      setProactiveLoadedAt(0);
      setProactiveAlerts([]);

      let sweepHasMore = true;
      let sweepIdx = 0;
      while (sweepHasMore) {
        setRefreshStatus(`Scanning clients (batch ${Math.floor(sweepIdx / 3) + 1})...`);
        const sweepResp = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_triage", step: "sweep", startIdx: sweepIdx, automationCommanderSheetId, forceProactive: isForced }),
        });
        const sweepData = await sweepResp.json();
        if (!sweepResp.ok || !sweepData.success) throw new Error(sweepData.error || "Failed to sweep flags");
        sweepHasMore = sweepData.hasMore;
        sweepIdx = sweepData.nextIdx;
      }

      let hasMore = true;
      let buildCount = 1;
      while (hasMore) {
        setRefreshStatus(`Generating options (batch ${buildCount})...`);
        const buildResp = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_triage", step: "build", automationCommanderSheetId, isContinuation: buildCount > 1 }),
        });
        const buildData = await buildResp.json();
        if (!buildResp.ok || !buildData.success) throw new Error(buildData.error || "Failed to build options");
        hasMore = buildData.hasMore;
        buildCount++;
      }

      setRefreshStatus("Finalizing data...");
      const storeResp = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_triage", step: "store", automationCommanderSheetId }),
      });
      const data = await storeResp.json();

      if (!storeResp.ok || !data.success) {
        throw new Error(data.error || "Failed to finalize refresh data");
      }

      setSessionId(data.sessionId);
      setTotalAlerts(data.totalAlerts || 0);
      setNoActionCount(data.noActionCount || 0);
      setProactiveAlerts(data.proactiveAlerts || []);
      const pCounts = {};
      (data.proactiveAlerts || []).forEach(a => { pCounts[a.clientName] = (pCounts[a.clientName] || 0) + 1; });
      setProactiveCountsByClient(pCounts);
      setProactiveLoadedAt(Date.now());
      setClientsWithFlags(data.clientsWithFlags || []);
      setProcessedAlerts(new Set());
      setAcknowledgedNoAction(new Set());
      setSelectedClient(null);
      setClientAlerts([]);
      setScreen("clientSelection");
      setTriageComplete(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setRefreshStatus("");
    }
  };

  const startTriage = async () => {
    try {
      setIsLoading(true);
      setError("");

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
          setProactiveAlerts(preData.proactiveAlerts || []);
          const pCounts = {};
          (preData.proactiveAlerts || []).forEach(a => { pCounts[a.clientName] = (pCounts[a.clientName] || 0) + 1; });
          setProactiveCountsByClient(pCounts);
          setProactiveLoadedAt(Date.now());
          setClientsWithFlags(preData.clientsWithFlags || []);
          setAcknowledgedNoAction(new Set());
          setProcessedAlerts(new Set());

          if (preData.noActionAnalysisResults && Object.keys(preData.noActionAnalysisResults).length > 0) {
            const raw = preData.noActionAnalysisResults;
            const flat = {};
            Object.entries(raw).forEach(([keyOrClient, val]) => {
              if (keyOrClient.includes("___")) {
                flat[keyOrClient] = val;
              } else {
                Object.entries(val || {}).forEach(([flagType, results]) => {
                  flat[`${keyOrClient}___${flagType}`] = results;
                });
              }
            });
            setPrecomputedNoActionResults(flat);
            console.log(`  ✅ Pre-populated ${Object.keys(flat).length} noAction analysis results`);
          }

          setScreen("clientSelection");
          setTriageComplete(true);
          precomputedUsed = true;
        } else {
          console.log(`No fresh precomputed data available — running live triage`);
        }
      } catch (preErr) {
        console.log(`Precomputed check failed, falling back to live run: ${preErr.message}`);
      }

      if (precomputedUsed) return;
      console.log(`No fresh precomputed data available — triggering full refresh pipeline`);
      await refreshTriage();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const reloadFromCache = async () => {
    try {
      setIsLoading(true);
      setError("");
      setRefreshStatus("Loading from cache...");

      const preResponse = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_precomputed", automationCommanderSheetId }),
      });
      const preData = await preResponse.json();

      if (preData.success && preData.available) {
        setSessionId(preData.sessionId);
        setTotalAlerts(preData.totalAlerts || 0);
        setNoActionCount(preData.noActionCount || 0);
        setProactiveAlerts(preData.proactiveAlerts || []);
        const pCounts = {};
        (preData.proactiveAlerts || []).forEach(a => { pCounts[a.clientName] = (pCounts[a.clientName] || 0) + 1; });
        setProactiveCountsByClient(pCounts);
        setProactiveLoadedAt(Date.now());
        setClientsWithFlags(preData.clientsWithFlags || []);
        setAcknowledgedNoAction(new Set());
        setProcessedAlerts(new Set());

        if (preData.noActionAnalysisResults && Object.keys(preData.noActionAnalysisResults).length > 0) {
          const raw = preData.noActionAnalysisResults;
          const flat = {};
          Object.entries(raw).forEach(([keyOrClient, val]) => {
            if (keyOrClient.includes("___")) {
              flat[keyOrClient] = val;
            } else {
              Object.entries(val || {}).forEach(([flagType, results]) => {
                flat[`${keyOrClient}___${flagType}`] = results;
              });
            }
          });
          setPrecomputedNoActionResults(flat);
        }

        setScreen("clientSelection");
        setTriageComplete(true);
      } else {
        setError("Cache is empty or stale (>4 hours old). Please use '↻ Refresh' to run a full sweep.");
      }
    } catch (err) {
      setError("Failed to load from cache: " + err.message);
    } finally {
      setIsLoading(false);
      setRefreshStatus("");
    }
  };

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
      
      console.log(`  Fetching alerts from Redis (sessionId: ${sessionId})`);
      const response = await fetch(`/api/triage?action=get_alerts&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (!data.success || !data.alerts) {
        console.error(`❌ Failed to load alerts from Redis`);
        setAcceptError("Failed to load alerts");
        return;
      }
      
      console.log(`  ✅ Loaded ${data.alerts.length} total alerts from Redis`);
      
      const filteredAlerts = data.alerts.filter(alert => 
        alert.clientName === client.clientName && !processedAlerts.has(alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`)
      );
      
      const filteredNoAction = (data.noActionAlerts || []).filter(
        na => (na.clientName && na.clientName === client.clientName) || na.clientId === client.masterSheetId
      );
      
      if (data.proactiveAlerts) {
        setProactiveAlerts(data.proactiveAlerts);
        const pCounts = {};
        data.proactiveAlerts.forEach(a => { pCounts[a.clientName] = (pCounts[a.clientName] || 0) + 1; });
        setProactiveCountsByClient(pCounts);
        setProactiveLoadedAt(Date.now());
      }

      console.log(`  📊 Found ${filteredAlerts.length} unprocessed alerts for ${client.clientName}`);
      console.log(`  📋 Found ${filteredNoAction.length} non-actionable flags for ${client.clientName}`);
      
      setClientAlerts(filteredAlerts);
      setClientNoActionAlerts(filteredNoAction);
      setNoActionAnalysisLoading({});

      const sessionResolved = (data.resolvedNoActionFlags || []);
      const restoredResolved = new Set(
        sessionResolved
          .filter(key => key.startsWith(client.clientName + "___"))
          .map(key => key.slice(client.clientName.length + 3))
      );
      setResolvedNoActionFlags(restoredResolved);

      const precomputedForClient = {};
      console.log(`  Unpacking noActionAnalysis keys for ${client.clientName}:`, Object.keys(precomputedNoActionResults));
      Object.entries(precomputedNoActionResults).forEach(([key, result]) => {
        const sep = "___";
        const sepIdx = key.indexOf(sep);
        if (sepIdx !== -1) {
          const keyClient = key.slice(0, sepIdx);
          const keyFlag = key.slice(sepIdx + sep.length);
          if (keyClient === client.clientName) {
            const normalised = Array.isArray(result)
              ? { success: true, results: result, overallOk: result.every(r => r.status === "ok" || r.status === "info") }
              : result;
            precomputedForClient[keyFlag] = normalised;
            console.log(`    ✓ Matched precomputed result: ${keyFlag}`);
          }
        }
      });
      console.log(`  precomputedForClient keys:`, Object.keys(precomputedForClient));
      setNoActionAnalysis(precomputedForClient);
      
      if (filteredAlerts.length === 0) {
        const clientProactive = (data.proactiveAlerts || []).filter(a => a.clientName === client.clientName);
        const noActionAllDone = filteredNoAction.length === 0 ||
          filteredNoAction.every(na => restoredResolved.has(na.fingerprintHash || na.flagType));
        if (noActionAllDone && clientProactive.length === 0) {
          console.log(`  → No unprocessed alerts, all no-action flags resolved, and no proactive alerts, auto-clearing`);
          handlePostClear([], restoredResolved, client);
        } else {
          console.log(`  → No actionable alerts but ${filteredNoAction.length} non-actionable flag(s) or ${clientProactive.length} proactive alert(s) need resolving`);
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

  const selectAlert = async (alert) => {
    setBulkMode(false);
    setBulkSelected(new Set());
    try {
      console.log(`\n📍 selectAlert called for: ${alert.sheetName}-${alert.rowNumber}`);
      
      const alertIndex = clientAlerts.findIndex(a => a.sheetName === alert.sheetName && a.rowNumber === alert.rowNumber);
      if (alertIndex !== -1) {
        setCurrentClientAlertIndex(alertIndex);
      }
      setAcceptError("");
      setIsAnalyzing(true);
      setClaudeAnalysis(""); setPreviousIgnoreReason("");
      setFromCache(false);
      setShowIgnoreModal(false);
      setIgnoreReason("");
      
      setScreen("triageAnalysis");
      
      if (alert.options && alert.options.length > 0) {
        console.log(`✅ Using cached options instantly`);
        setFromCache(true);
        setClaudeAnalysis(JSON.stringify(alert.options, null, 2));
        setIsAnalyzing(false);
        checkExistingTask(alert);
        return;
      }

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
      const pir = data.previousIgnoreReason; 
      const formattedPir = pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null;
      setPreviousIgnoreReason(formattedPir);
      
      setClientAlerts(prev => {
        const newAlerts = [...prev];
        const idx = newAlerts.findIndex(a => a.sheetName === alert.sheetName && a.rowNumber === alert.rowNumber);
        if (idx !== -1) {
          newAlerts[idx] = { 
            ...newAlerts[idx], 
            options: data.options,
            previousIgnoreReason: formattedPir 
          };
        }
        return newAlerts;
      });

      setClaudeAnalysis(JSON.stringify(data.options || [], null, 2));
      setIsAnalyzing(false);
      checkExistingTask(alert);
    } catch (err) {
      console.error(`❌ selectAlert error: ${err.message}`);
      setAcceptError(`Failed to analyze alert: ${err.message}`);
      setIsAnalyzing(false);
    }
  };

  const acceptOption = async (option) => {
    const alert = clientAlerts[currentClientAlertIndex];
    try {
      setIsAccepting(true);
      setAcceptError("");
      console.log(`Accepting option: ${option.title}`);

      const action = option.matchType === "delete" ? "delete_job" : "accept_option";
      
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          alert,
          option,
          automationCommanderSheetId,
        }),
      });
      
      const data = await response.json();
      
      if (!data.success) {
        const isStale = response.status === 409;
        setAcceptError(isStale
          ? `⚠ ${data.error}`
          : `Failed to write to sheet: ${data.error || "Unknown error"}`);
        return;
      }
      
      console.log(`✅ Option accepted! ${data.cellsWritten} cells written`);
      
      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      const uniqueId = alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(new Set([...processedAlerts, uniqueId]));

      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }
      
      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);

      let acceptedFlagType = alert.flagType || alert.alertType || alert.type || "";
      if (acceptedFlagType === "invoice") acceptedFlagType = "invoiceDashboardDiscr";
      if (acceptedFlagType === "expense") acceptedFlagType = "expenseDashboardDiscr";
      if (acceptedFlagType === "crm") acceptedFlagType = "crmPipeAppDiscr";
      
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        const updatedFlags = { ...c.flags };
        if (updatedCounts[acceptedFlagType] > 0) updatedCounts[acceptedFlagType]--;
        if ((updatedCounts[acceptedFlagType] || 0) === 0) updatedFlags[acceptedFlagType] = false;
        return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
      }));
      
      if (updatedAlerts.length === 0) {
        if (allNoActionResolved()) {
          handlePostClear([], resolvedNoActionFlags);
        } else {
          setScreen("alertSelection");
          setCurrentClientAlertIndex(0);
        }
      } else {
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

  const allNoActionResolved = () => {
    const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || na.flagType));
    const proactiveDone = proactiveAlerts.filter(a => a.clientName === selectedClient?.clientName).length === 0;
    return infoDone && proactiveDone;
  };

  const autoClearFlags = async (remainingAlerts, resolvedNoActionFlagsOverride, clientOverride) => {
    const client = clientOverride || selectedClient;
    if (!client) return new Set();
    const resolvedSet = resolvedNoActionFlagsOverride || resolvedNoActionFlags;
    const activeNoActionAlerts = clientOverride ? [] : clientNoActionAlerts;

    const groups = computeFlagGroups(client, remainingAlerts);

    const invoiceBlockingFlags  = ["invoiceStaleUnsentChanges"];
    const crmBlockingFlags      = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"];

    const invoiceNoActionDone = invoiceBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => activeNoActionAlerts.filter(na => na.flagType === f).every(na => resolvedSet.has(na.fingerprintHash || na.flagType)));
    const crmNoActionDone = crmBlockingFlags
      .filter(f => activeNoActionAlerts.some(na => na.flagType === f))
      .every(f => activeNoActionAlerts.filter(na => na.flagType === f).every(na => resolvedSet.has(na.fingerprintHash || na.flagType)));

    const toZeroVisually = {
      invoice: groups.invoice,
      crm:     groups.crm,
      expense: groups.expense,
    };
    const visualGroups = Object.entries(toZeroVisually).filter(([, v]) => v).map(([k]) => k);

    const toClear = {
      invoice: groups.invoice && invoiceNoActionDone,
      crm:     groups.crm     && crmNoActionDone,
      expense: groups.expense,
    };
    const selected = Object.entries(toClear).filter(([, v]) => v).map(([k]) => k);

    const ACTIONABLE_FLAG_TYPE_MAP = {
      invoice: ["invoiceDashboardDiscr","retainerInvoicesCreated","retainerInvoicesDeleted","invoiceStaleUnsentChanges"],
      crm:     ["crmPipeDashDiscr","crmPipeAppDiscr","crmConfDashDiscr","crmConfAppDiscr"],
      expense: ["expenseDashboardDiscr","expenseAdded","expenseUnreconGaps"],
    };
    const FULL_FLAG_TYPE_MAP = {
      invoice: [...ACTIONABLE_FLAG_TYPE_MAP.invoice],
      crm:     [...ACTIONABLE_FLAG_TYPE_MAP.crm, "crmCopiedConfChecked","crmCopiedConfUnchecked","crmCopiedConfDelete"],
      expense: [...ACTIONABLE_FLAG_TYPE_MAP.expense],
    };

    if (visualGroups.length > 0) {
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== client.clientName) return c;
        const updatedFlags = { ...c.flags };
        const updatedCounts = { ...c.alertCounts };
        for (const group of visualGroups) {
          const flagList = selected.includes(group)
            ? FULL_FLAG_TYPE_MAP[group]
            : ACTIONABLE_FLAG_TYPE_MAP[group];
          for (const ft of (flagList || [])) {
            updatedFlags[ft] = false;
            updatedCounts[ft] = 0;
          }
        }
        return { ...c, flags: updatedFlags, alertCounts: updatedCounts };
      }));
    }

    return new Set(selected);
  };

  const handlePostClear = async (remainingAlerts, resolvedNoActionFlagsOverride, clientOverride) => {
    await autoClearFlags(remainingAlerts, resolvedNoActionFlagsOverride, clientOverride);
    setScreen("clientSelection");
  };

  const groupedAlerts = useMemo(() => {
    const g = {};
    const filteredAlerts = (clientAlerts || []).filter(alert => {
      const txId = alert.summary?.transactionId || alert.summary?.appId;
      if (txId && (assignedAppIds.has(txId) || assignedByClient[selectedClient?.clientName]?.has(txId))) return false;
      const invNo = alert.summary?.invoiceNo;
      if (invNo && (assignedAppIds.has(invNo) || assignedByClient[selectedClient?.clientName]?.has(invNo))) return false;
      return true;
    });
    filteredAlerts.forEach(alert => {
      const type = alert.flagType || alert.alertType || alert.type || "unknown";
      if (!g[type]) g[type] = [];
      g[type].push(alert);
    });
    return g;
  }, [clientAlerts, assignedAppIds, assignedByClient, selectedClient]);

  const liveAlertCount = useMemo(() => {
    const ACTIONABLE_FLAG_KEYS_SET = new Set([
      "invoiceDashboardDiscr", "expenseDashboardDiscr",
      "crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
    ]);
    const EXPENSE_TYPES = new Set(["expenseDashboardDiscr"]);
    const INVOICE_TYPES = new Set(["invoiceDashboardDiscr"]);

    return clientsWithFlags.reduce((total, c) => {
      const assignedSet = assignedByClient[c.clientName] || new Set();
      const expenseIds = c.activeExpenseIds || [];
      const invoiceIds = c.activeInvoiceIds || [];
      const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
      const validAssignedInv = invoiceIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
      
      let clientTotal = 0;

      Object.entries(c.flags || {}).forEach(([flagKey, isSet]) => {
        if (!isSet) return;
        
        let count = c.alertCounts?.[flagKey] || 0;

        if (ACTIONABLE_FLAG_KEYS_SET.has(flagKey)) {
          if (EXPENSE_TYPES.has(flagKey)) {
            count = Math.max(0, count - validAssignedExp);
          }
          if (INVOICE_TYPES.has(flagKey)) {
            count = Math.max(0, count - validAssignedInv);
          }
          clientTotal += count;
        } else {
          clientTotal += (count > 0 ? count : 0);
        }
      });

      return total + clientTotal;
    }, 0);
  }, [clientsWithFlags, assignedByClient, assignedAppIds]);

  const computeAlertCheckCount = (clientName, categoriesStr) => {
    const client = (clientsWithFlags || []).find(c => c.clientName === clientName);
    if (!client) return 0; 
    
    const assignedSet = assignedByClient[clientName] || new Set();
    let validAssignedExp = 0;
    let validAssignedInv = 0;
    if (client.activeExpenseIds && Array.isArray(client.activeExpenseIds)) {
      validAssignedExp = client.activeExpenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
    }
    if (client.activeInvoiceIds && Array.isArray(client.activeInvoiceIds)) {
      validAssignedInv = client.activeInvoiceIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
    }

    const categories = (categoriesStr || "").split(",").filter(Boolean);
    let total = 0;
    categories.forEach(cat => {
      (ALERT_CATEGORY_FLAGS[cat] || []).forEach(flagKey => {
        let count = client.alertCounts?.[flagKey] || 0;
        if (EXPENSE_SUPPRESSIBLE.has(flagKey)) count = Math.max(0, count - validAssignedExp);
        if (flagKey === "invoiceDashboardDiscr") count = Math.max(0, count - validAssignedInv);
        total += count;
      });
    });
    return total;
  };

  const computeFlagGroups = (client, remainingAlerts) => {
    if (!client) return { invoice: false, crm: false, expense: false };
    const f = client.flags || {};

    const invoiceAlertTypes = new Set(["invoiceDashboardDiscr", "invoiceStaleUnsentChanges", "retainerInvoicesCreated", "retainerInvoicesDeleted"]);
    const crmAlertTypes = new Set(["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr",
      "crmCopiedConfChecked", "crmCopiedConfUnchecked", "crmCopiedConfDelete"]);
    const expenseAlertTypes = new Set(["expenseDashboardDiscr", "expenseAdded", "expenseUnreconGaps"]);

    const remaining = remainingAlerts || [];
    const hasInvoiceFlag = !!(f.invoiceDashboardDiscr || f.invoiceStaleUnsentChanges || f.retainerInvoicesCreated || f.retainerInvoicesDeleted);
    const hasCRMFlag = !!(f.crmPipeDashDiscr || f.crmPipeAppDiscr || f.crmConfDashDiscr || f.crmConfAppDiscr ||
      f.crmCopiedConfChecked || f.crmCopiedConfUnchecked || f.crmCopiedConfDelete);
    const hasExpenseFlag = !!(f.expenseDashboardDiscr || f.expenseAdded || f.expenseUnreconGaps);

    const remainingInvoice = remaining.some(a => invoiceAlertTypes.has(a.flagType || a.type));
    const remainingCRM = remaining.some(a => crmAlertTypes.has(a.flagType || a.type));
    const remainingExpense = remaining.some(a => expenseAlertTypes.has(a.flagType || a.type));

    return {
      invoice: hasInvoiceFlag && !remainingInvoice,
      crm: hasCRMFlag && !remainingCRM,
      expense: hasExpenseFlag && !remainingExpense,
    };
  };

  const analyzeNoActionFlag = async (na) => {
    const key = na.fingerprintHash || na.flagType;
    if (!selectedClient || noActionAnalysisLoading[key]) return;
    setNoActionAnalysisLoading(prev => ({ ...prev, [key]: true }));
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_noaction_flag",
          flagType: na.flagType,
          clientSheetId: selectedClient.clientSheetId,
          masterSheetId: selectedClient.masterSheetId,
          automationCommanderSheetId,
          clientName: selectedClient.clientName,
          targetLine: na.flagDetail,
        }),
      });
      const data = await resp.json();
      setNoActionAnalysis(prev => ({ ...prev, [key]: data }));
    } catch (e) {
      setNoActionAnalysis(prev => ({ ...prev, [key]: { success: false, error: e.message } }));
    } finally {
      setNoActionAnalysisLoading(prev => ({ ...prev, [key]: false }));
    }
  };

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

      const alertId = `${alert.sheetName}-${alert.rowNumber}`;
      const uniqueId = alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`;
      setProcessedAlerts(new Set([...processedAlerts, uniqueId]));

      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
        }).catch(() => {});
      }

      const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
      setClientAlerts(updatedAlerts);
      setCurrentClientAlertIndex(0);

      let ignoredFlagType = alert.flagType || alert.alertType || alert.type || "";
      if (ignoredFlagType === "invoice") ignoredFlagType = "invoiceDashboardDiscr";
      if (ignoredFlagType === "expense") ignoredFlagType = "expenseDashboardDiscr";
      if (ignoredFlagType === "crm") ignoredFlagType = "crmPipeAppDiscr";
      
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        const updatedFlags = { ...c.flags };
        if (updatedCounts[ignoredFlagType] > 0) updatedCounts[ignoredFlagType]--;
        if ((updatedCounts[ignoredFlagType] || 0) === 0) updatedFlags[ignoredFlagType] = false;
        return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
      }));

      if (updatedAlerts.length === 0) {
        if (allNoActionResolved()) {
          handlePostClear([], resolvedNoActionFlags);
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

  const loadProactiveAlerts = async () => {
    try {
      setProactiveLoading(true);
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_proactive_alerts", automationCommanderSheetId }),
      });
      const data = await response.json();
      if (data.success) {
        setProactiveAlerts(data.alerts || []);
        setProactiveCountsByClient(data.countsByClient || {});
      }
      setProactiveLoadedAt(Date.now());
    } catch (err) {
      console.error("Failed to load proactive alerts:", err);
    } finally {
      setProactiveLoading(false);
    }
  };

  useEffect(() => {
    if (triageComplete && totalAlerts === 0 && noActionCount === 0
        && proactiveLoadedAt > 0 && proactiveAlerts.length > 0
        && activeNav !== "tasks" && activeNav !== "overview"
        && screen === "initial") { 
      console.log(`📋 Proactive alerts loaded (${proactiveAlerts.length}), redirecting to clientSelection`);
      setScreen("clientSelection");
    }
  }, [proactiveAlerts, proactiveLoadedAt, triageComplete, totalAlerts, noActionCount, activeNav, screen, setScreen]);

  return {
    sessionId, setSessionId, totalAlerts, setTotalAlerts, noActionCount, setNoActionCount,
    acknowledgedNoAction, setAcknowledgedNoAction, triageComplete, setTriageComplete,
    claudeAnalysis, setClaudeAnalysis, isAnalyzing, setIsAnalyzing, refreshStatus, setRefreshStatus,
    clientsWithFlags, setClientsWithFlags, selectedClient, setSelectedClient, clientAlerts, setClientAlerts,
    currentClientAlertIndex, setCurrentClientAlertIndex, isAccepting, setIsAccepting, acceptError, setAcceptError,
    processedAlerts, setProcessedAlerts, showIgnoreModal, setShowIgnoreModal, ignoreReason, setIgnoreReason,
    isIgnoring, setIsIgnoring, selectingClient, setSelectingClient, previousIgnoreReason, setPreviousIgnoreReason,
    proactiveAlerts, setProactiveAlerts, proactiveCountsByClient, setProactiveCountsByClient,
    proactiveLoading, setProactiveLoading, proactiveLoadedAt, setProactiveLoadedAt, fromCache, setFromCache,
    clientNoActionAlerts, setClientNoActionAlerts, resolvedNoActionFlags, setResolvedNoActionFlags,
    noActionAnalysis, setNoActionAnalysis, noActionAnalysisLoading, setNoActionAnalysisLoading,
    precomputedNoActionResults, setPrecomputedNoActionResults,
    refreshTriage, startTriage, reloadFromCache, selectClient, selectAlert, acceptOption,
    allNoActionResolved, autoClearFlags, handlePostClear, groupedAlerts, liveAlertCount,
    computeAlertCheckCount, analyzeNoActionFlag, ignoreAlert, loadProactiveAlerts, checkExistingTask,
    setScreen, isLoading, existingTaskBanner, setExistingTaskBanner
  };
}