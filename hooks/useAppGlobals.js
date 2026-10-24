import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";

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

  // ── PMA GLOBAL CLIENT DATA CACHE ──────────────────────────────────────────
  const clientCacheRef = useRef({});
  const inFlightPrefetchesRef = useRef(new Map());
  const managedClientRef = useRef(managedClient);

  useEffect(() => {
    managedClientRef.current = managedClient;
  }, [managedClient]);

  const cleanSheetId = useCallback((idOrUrl) => {
    if (!idOrUrl) return "";
    const str = String(idOrUrl).trim();
    const match = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : str;
  }, []);

  const getInFlightPrefetch = useCallback((key) => {
    return inFlightPrefetchesRef.current.get(key) || null;
  }, []);

  const safeFetchOnce = useCallback((key, fetcher) => {
    if (inFlightPrefetchesRef.current.has(key)) {
      return inFlightPrefetchesRef.current.get(key);
    }
    const p = (async () => {
      try {
        return await fetcher();
      } catch (err) {
        console.warn(`[PMA Fetch Warning] ${key}:`, err?.message);
        throw err;
      } finally {
        inFlightPrefetchesRef.current.delete(key);
      }
    })();
    inFlightPrefetchesRef.current.set(key, p);
    return p;
  }, []);

  const getCachedClientData = useCallback((clientSheetId, dataType, maxAgeMs = 600000) => {
    if (!clientSheetId || !dataType) return null;
    const cleanId = cleanSheetId(clientSheetId);
    const entry = clientCacheRef.current[cleanId]?.[dataType];
    if (!entry) return null;
    const age = Date.now() - (entry.timestamp || 0);
    return {
      data: entry.data,
      timestamp: entry.timestamp,
      isStale: age > maxAgeMs
    };
  }, [cleanSheetId]);

  const setCachedClientData = useCallback((clientSheetId, dataType, data) => {
    if (!clientSheetId || !dataType || data === undefined) return;
    const cleanId = cleanSheetId(clientSheetId);
    if (!clientCacheRef.current[cleanId]) {
      clientCacheRef.current[cleanId] = {};
    }
    clientCacheRef.current[cleanId][dataType] = { data, timestamp: Date.now() };
    clientCacheRef.current[cleanId].lastAccessed = Date.now();

    // LRU Eviction: Keep max 12 clients cached to avoid memory bloat
    const clientKeys = Object.keys(clientCacheRef.current);
    if (clientKeys.length > 12) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const k of clientKeys) {
        const t = clientCacheRef.current[k]?.lastAccessed || 0;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey && oldestKey !== cleanId) {
        delete clientCacheRef.current[oldestKey];
      }
    }
  }, [cleanSheetId]);

  const invalidateCachedClientData = useCallback((clientSheetId, dataType = null) => {
    if (!clientSheetId) return;
    const cleanId = cleanSheetId(clientSheetId);
    if (dataType) {
      if (clientCacheRef.current[cleanId]) {
        delete clientCacheRef.current[cleanId][dataType];
      }
    } else {
      delete clientCacheRef.current[cleanId];
    }
  }, [cleanSheetId]);

  // ── BACKGROUND PRELOADER ON MANAGE CLIENT (STAGGERED CONCURRENCY) ───────────
  const preloadClientData = useCallback((client) => {
    if (!client?.clientSheetId) return;
    const cleanClientId = cleanSheetId(client.clientSheetId);
    const cleanMasterId = client.masterSheetId ? cleanSheetId(client.masterSheetId) : null;
    const clientName = client.clientName || "";

    // Helper to safely execute a fetch once without duplicating
    const fetchOnce = (key, fetcher) => safeFetchOnce(key, fetcher);

    // ── TIER 1: Core screens (Jobs, Contractors, Invoices, Retainers) - 0ms immediate
    fetchOnce(`jobs_${cleanClientId}`, async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_client_jobs", clientSheetId: cleanClientId, tabName: "All" })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "jobs_All", d);
      return d;
    });

    fetchOnce(`outgoings_${cleanClientId}`, async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_outgoings", clientSheetId: cleanClientId })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "outgoings", d);
      return d;
    });

    if (cleanMasterId) {
      fetchOnce(`outgoings_inbox_${cleanMasterId}`, async () => {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings_inbox", clientSheetId: cleanClientId, masterSheetId: cleanMasterId })
        });
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "outgoings_inbox", d);
        return d;
      });
    }

    fetchOnce(`inv_jobs_${cleanClientId}`, async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoice_jobs", clientSheetId: cleanClientId, showAll: false })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "invoice_jobs_active", d);
      return d;
    });

    if (cleanMasterId) {
      fetchOnce(`inv_inbox_${cleanMasterId}`, async () => {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_invoices_inbox", clientSheetId: cleanClientId, masterSheetId: cleanMasterId })
        });
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "invoices_inbox", d);
        return d;
      });
    }

    fetchOnce(`retainer_jobs_${cleanClientId}`, async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_retainer_jobs", clientSheetId: cleanClientId })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "retainer_jobs", d);
      return d;
    });

    // ── TIER 2: Pulse Views (Payload, Performance, Key Data, Cashflow, Budget Overview) - 500ms delay
    setTimeout(() => {
      if (cleanSheetId(managedClientRef.current?.clientSheetId) !== cleanClientId) return;

      fetchOnce(`portal_payload_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/portal/payload?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
        );
        const d = await res.json();
        if (d.success && d.payload) setCachedClientData(cleanClientId, "portal_payload", d.payload);
        return d;
      });

      fetchOnce(`portal_perf_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/portal/performance?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
        );
        const d = await res.json();
        if (d.success && d.data) setCachedClientData(cleanClientId, "portal_perf", d.data);
        return d;
      });

      fetchOnce(`portal_key_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/portal/key-data?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
        );
        const d = await res.json();
        if (d.success && d.data) setCachedClientData(cleanClientId, "portal_key_data", d.data);
        return d;
      });

      fetchOnce(`portal_cash_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/portal/cash?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
        );
        const d = await res.json();
        if (d.success && d.data) setCachedClientData(cleanClientId, "portal_cash", d.data);
        return d;
      });

      fetchOnce(`portal_budget_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/portal/budget?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
        );
        const d = await res.json();
        if (d.success && d.data) setCachedClientData(cleanClientId, "portal_budget", d.data);
        return d;
      });
    }, 500);

    // ── TIER 3: Deep Edit Screens (Salaries, Expenses, New Business to Find, Budget) - 1200ms delay
    setTimeout(() => {
      if (cleanSheetId(managedClientRef.current?.clientSheetId) !== cleanClientId) return;

      if (cleanMasterId) {
        fetchOnce(`salaries_${cleanClientId}`, async () => {
          const res = await fetch(
            `/api/pma/salaries?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(cleanMasterId)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
          );
          const d = await res.json();
          if (d.success) setCachedClientData(cleanClientId, "salaries", d);
          return d;
        });
      }

      fetchOnce(`expenses_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/pma/expenses?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
        );
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "expenses", d);
        return d;
      });

      fetchOnce(`nbtofind_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/pma/nbtofind?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
        );
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "nbtofind", d);
        return d;
      });

      fetchOnce(`budget_${cleanClientId}`, async () => {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_client_view_data",
            clientSheetId: cleanClientId,
            masterSheetId: cleanMasterId || undefined,
            clientName: clientName || undefined,
            tab: "budget",
          }),
        });
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "budget", d);
        return d;
      });

      fetchOnce(`cash_${cleanClientId}`, async () => {
        const res = await fetch(
          `/api/pma/cash?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
        );
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "cash", d);
        return d;
      });
    }, 1200);
  }, [cleanSheetId, safeFetchOnce, setCachedClientData]);

  // Automatically trigger background preloading whenever managedClient changes
  useEffect(() => {
    if (managedClient?.clientSheetId) {
      preloadClientData(managedClient);
    }
  }, [managedClient?.clientSheetId, managedClient?.masterSheetId, preloadClientData]);

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
    managedClient, setManagedClient,
    getCachedClientData,
    setCachedClientData,
    invalidateCachedClientData,
    preloadClientData,
    getInFlightPrefetch,
    safeFetchOnce,
    cleanSheetId
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