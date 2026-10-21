import React, { createContext, useContext, useState, useEffect, useRef } from "react";

const AppGlobalsContext = createContext(null);

export function AppGlobalsProvider({ children }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
  const [automationCommanderSheetId] = useState(AUTOMATION_COMMANDER_SHEET_ID);
  
  const outgoingsPullPendingRef = useRef(null);
  const [allClientsMap, setAllClientsMap] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("pulse_cached_all_clients");
        if (stored) {
          const list = JSON.parse(stored);
          if (Array.isArray(list) && list.length > 0) {
            const map = {};
            for (const c of list) {
              if (c.clientName) map[c.clientName] = c;
            }
            return map;
          }
        }
      } catch {}
    }
    return {};
  });

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

  // Optimistic assignment cache TTL: 15 minutes max to avoid permanent alert suppression
  const ASSIGNED_APP_ID_TTL_MS = 15 * 60 * 1000;

  const [assignedAppIds, setAssignedAppIds] = useState(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("pulse_assignedAppIds");
      if (!stored) return new Set();
      const parsed = JSON.parse(stored);
      // Legacy unversioned flat array: wipe out immediately so stale IDs never suppress active alerts
      if (Array.isArray(parsed)) {
        try { localStorage.removeItem("pulse_assignedAppIds"); } catch {}
        return new Set();
      }
      if (parsed && typeof parsed === "object") {
        const now = Date.now();
        const validSet = new Set();
        const validMap = {};
        for (const [key, ts] of Object.entries(parsed)) {
          if (typeof ts === "number" && (now - ts < ASSIGNED_APP_ID_TTL_MS)) {
            validMap[key] = ts;
            const parts = key.split("::");
            const id = parts.length > 1 ? parts[1] : parts[0];
            const clean = id.replace(/^#/, "");
            validSet.add(key); // e.g. "anrpr::6550-2"
            validSet.add(id);
            validSet.add(clean);
            if (!isNaN(Number(clean)) && clean !== "") validSet.add(Number(clean));
          }
        }
        try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify(validMap)); } catch {}
        return validSet;
      }
      return new Set();
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
    const now = Date.now();
    const cNorm = clientName ? String(clientName).trim().toLowerCase() : "";
    const scopedKey = cNorm ? `${cNorm}::${cleanId}` : cleanId;

    setAssignedAppIds(prev => {
      const next = new Set(prev);
      next.add(id);
      next.add(rawId);
      next.add(cleanId);
      next.add(scopedKey);
      if (cNorm) next.add(`${cNorm}::${rawId}`);
      if (!isNaN(Number(cleanId)) && cleanId !== "") next.add(Number(cleanId));

      try {
        let existingMap = {};
        const stored = localStorage.getItem("pulse_assignedAppIds");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            existingMap = parsed;
          }
        }
        const pruned = {};
        for (const [k, ts] of Object.entries(existingMap)) {
          if (typeof ts === "number" && (now - ts < ASSIGNED_APP_ID_TTL_MS)) {
            pruned[k] = ts;
          }
        }
        pruned[scopedKey] = now;
        localStorage.setItem("pulse_assignedAppIds", JSON.stringify(pruned));
      } catch {}

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

  const clearAssignedAppIds = () => {
    setAssignedAppIds(new Set());
    setAssignedByClient({});
    if (typeof window !== "undefined") {
      try { localStorage.removeItem("pulse_assignedAppIds"); } catch {}
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
    clearAssignedAppIds,
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