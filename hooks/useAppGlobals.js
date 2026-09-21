import React, { createContext, useContext, useState, useEffect, useRef } from "react";

const AppGlobalsContext = createContext(null);

export function AppGlobalsProvider({ children }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const [automationCommanderSheetId] = useState(AUTOMATION_COMMANDER_SHEET_ID);
  
  const outgoingsPullPendingRef = useRef(null);
  const [allClientsMap, setAllClientsMap] = useState({});
  
  const [assignedAppIds, setAssignedAppIds] = useState(() => {
    try {
      const stored = localStorage.getItem("pulse_assignedAppIds");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const [assignedByClient, setAssignedByClient] = useState({});
  
  useEffect(() => {
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_assigned_expenses", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setAssignedByClient(Object.fromEntries(
            Object.entries(d.assignedByClient || {}).map(([k, v]) => [k, new Set(v)])
          ));
        }
      })
      .catch(e => console.error("get_assigned_expenses error:", e));
  }, [automationCommanderSheetId]);

  const addAssignedAppId = (id, clientName) => {
    setAssignedAppIds(prev => {
      const next = new Set([...prev, id]);
      try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
      return next;
    });
    if (clientName) {
      setAssignedByClient(prev => {
        const clientSet = new Set([...(prev[clientName] || []), id]);
        return { ...prev, [clientName]: clientSet };
      });
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_expense_assigned", automationCommanderSheetId, clientName, appId: id }) })
        .catch(e => console.error("mark_expense_assigned error:", e));
    }
  };

  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [debugClientName, setDebugClientName] = useState("");
  const [debugResult, setDebugResult] = useState(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const runDebug = async () => {
    try {
      setDebugLoading(true);
      setDebugResult(null);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "debug_triage_state",
          clientName: debugClientName.trim() || undefined,
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      setDebugResult(data);
    } catch (e) {
      setDebugResult({ success: false, error: e.message });
    } finally {
      setDebugLoading(false);
    }
  };

  const value = {
    automationCommanderSheetId,
    assignedAppIds, setAssignedAppIds,
    assignedByClient, setAssignedByClient,
    addAssignedAppId,
    outgoingsPullPendingRef,
    allClientsMap, setAllClientsMap,
    showDebugPanel, setShowDebugPanel,
    debugClientName, setDebugClientName,
    debugResult, setDebugResult,
    debugLoading, setDebugLoading,
    runDebug
  };

  return (
    <AppGlobalsContext.Provider value={value}>
      {children}
    </AppGlobalsContext.Provider>
  );
}

export function useAppGlobals() {
  const context = useContext(AppGlobalsContext);
  if (!context) {
    throw new Error("useAppGlobals must be used within an AppGlobalsProvider");
  }
  return context;
}