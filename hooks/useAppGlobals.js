import React, { createContext, useContext, useState, useEffect, useRef } from "react";

const AppGlobalsContext = createContext(null);

export function AppGlobalsProvider({ children }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const [automationCommanderSheetId] = useState(AUTOMATION_COMMANDER_SHEET_ID);
  
  const outgoingsPullPendingRef = useRef(null);
  const [allClientsMap, setAllClientsMap] = useState({});

  const [managedClient, setManagedClientState] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pma_managed_client");
        return stored ? JSON.parse(stored) : null;
      } catch { return null; }
    }
    return null;
  });

  const setManagedClient = (clientOrName) => {
    if (!clientOrName) {
      setManagedClientState(null);
      if (typeof window !== "undefined") {
        try { localStorage.removeItem("pma_managed_client"); } catch {}
      }
      return;
    }
    let clientObj = typeof clientOrName === "string" ? { clientName: clientOrName } : { ...clientOrName };
    if (allClientsMap && clientObj.clientName && allClientsMap[clientObj.clientName]) {
      clientObj = { ...allClientsMap[clientObj.clientName], ...clientObj };
    }
    setManagedClientState(clientObj);
    if (typeof window !== "undefined") {
      try { localStorage.setItem("pma_managed_client", JSON.stringify(clientObj)); } catch {}
    }
  };

  // Keep managedClient sheet IDs in sync with allClientsMap
  useEffect(() => {
    if (managedClient?.clientName && allClientsMap && allClientsMap[managedClient.clientName]) {
      const match = allClientsMap[managedClient.clientName];
      if (match.clientSheetId !== managedClient.clientSheetId || match.masterSheetId !== managedClient.masterSheetId) {
        setManagedClientState(prev => prev ? ({ ...prev, ...match }) : null);
      }
    }
  }, [allClientsMap, managedClient?.clientName]);

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
    if (id === null || id === undefined || id === "") return;
    const rawId = String(id).trim();
    const cleanId = rawId.replace(/^#/, "");
    setAssignedAppIds(prev => {
      const next = new Set(prev);
      next.add(id);
      next.add(rawId);
      next.add(cleanId);
      if (!isNaN(Number(cleanId)) && cleanId !== "") next.add(Number(cleanId));
      try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
      return next;
    });
    if (clientName) {
      const cKey = String(clientName).trim();
      setAssignedByClient(prev => {
        const existing = prev[cKey] || prev[clientName] || [];
        const clientSet = new Set([...existing, id, rawId, cleanId]);
        if (!isNaN(Number(cleanId)) && cleanId !== "") clientSet.add(Number(cleanId));
        return { ...prev, [cKey]: clientSet };
      });
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_expense_assigned", automationCommanderSheetId, clientName: cKey, appId: cleanId }) })
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
    runDebug,
    managedClient, setManagedClient
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