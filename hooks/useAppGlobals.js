import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";

const AppGlobalsContext = createContext(null);

export function AppGlobalsProvider({ children }) {
  const AUTOMATION_COMMANDER_SHEET_ID = "default";
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

  const allClientsMapRef = useRef(allClientsMap);
  useEffect(() => {
    allClientsMapRef.current = allClientsMap;
  }, [allClientsMap]);

  const setManagedClient = useCallback((clientOrName) => {
    if (!clientOrName) {
      setManagedClientState(null);
      if (typeof window !== "undefined") {
        try { localStorage.removeItem("pma_managed_client"); } catch {}
      }
      return;
    }
    let clientObj = typeof clientOrName === "string" ? { clientName: clientOrName } : { ...clientOrName };
    const curMap = allClientsMapRef.current;
    if (curMap && clientObj.clientName && curMap[clientObj.clientName]) {
      clientObj = { ...curMap[clientObj.clientName], ...clientObj };
    }
    setManagedClientState(clientObj);
    if (typeof window !== "undefined") {
      try { localStorage.setItem("pma_managed_client", JSON.stringify(clientObj)); } catch {}
    }
  }, []);

  // Keep managedClient sheet IDs in sync with allClientsMap
  useEffect(() => {
    if (managedClient?.clientName && allClientsMap) {
      const targetName = managedClient.clientName.toLowerCase();
      const match = allClientsMap[managedClient.clientName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === targetName);
      if (match && (match.clientSheetId !== managedClient.clientSheetId || match.masterSheetId !== managedClient.masterSheetId)) {
        setManagedClientState(prev => prev ? ({ ...prev, ...match }) : match);
      }
    }
  }, [allClientsMap, managedClient?.clientName, managedClient?.clientSheetId, managedClient?.masterSheetId]);

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

  // ── PMA GLOBAL CLIENT DATA CACHE & PRIORITIZED BACKGROUND QUEUE ─────────
  const clientCacheRef = useRef({});
  const inFlightPrefetchesRef = useRef(new Map());
  const managedClientRef = useRef(managedClient);
  const queueRef = useRef([]);
  const queuedTaskMapRef = useRef(new Map());
  const isProcessingQueueRef = useRef(false);
  const activeClientIdRef = useRef(null);
  const foregroundActiveCountRef = useRef(0);
  const queueTimerRef = useRef(null);

  useEffect(() => {
    managedClientRef.current = managedClient;
  }, [managedClient]);

  const cleanSheetId = useCallback((idOrUrl) => {
    if (!idOrUrl) return "";
    const str = String(idOrUrl).trim();
    const match = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : str;
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

  // ── SEQUENTIAL BACKGROUND QUEUE RUNNER ─────────────────────────────────────
  const runNextQueueTask = useCallback(async () => {
    if (isProcessingQueueRef.current) return;

    const currentClientId = activeClientIdRef.current;
    if (!currentClientId) {
      queueRef.current = [];
      queuedTaskMapRef.current.clear();
      return;
    }

    // If user is actively performing a foreground fetch, pause background tasks
    if (foregroundActiveCountRef.current > 0) {
      if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
      queueTimerRef.current = setTimeout(() => {
        runNextQueueTask();
      }, 500);
      return;
    }

    if (queueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;

    try {
      // Sort: highest priority first (2 = Core, 3 = Views, 4 = Deep Edit)
      queueRef.current.sort((a, b) => a.priority - b.priority);
      const task = queueRef.current.shift();
      if (!task) return;
      queuedTaskMapRef.current.delete(task.key);

      // Verify task still belongs to current active client
      if (task.clientSheetId !== activeClientIdRef.current) {
        return;
      }

      // If data is already cached and fresh, skip it
      if (task.dataType) {
        const cached = getCachedClientData(task.clientSheetId, task.dataType);
        if (cached && !cached.isStale) {
          return;
        }
      }

      // Execute this single task in isolation (zero concurrency = zero 429 quota exhaustion)
      const promise = (async () => {
        try {
          return await task.fetcher();
        } catch (err) {
          console.warn(`[Background Preload] Task failed for ${task.key}:`, err?.message);
        } finally {
          inFlightPrefetchesRef.current.delete(task.key);
        }
      })();

      inFlightPrefetchesRef.current.set(task.key, promise);
      await promise;
    } finally {
      isProcessingQueueRef.current = false;

      // If more tasks remain for this client, schedule next one with polite 1.2s pacing gap
      if (queueRef.current.length > 0 && activeClientIdRef.current === currentClientId) {
        if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
        queueTimerRef.current = setTimeout(() => {
          runNextQueueTask();
        }, 1200);
      }
    }
  }, [getCachedClientData]);

  const scheduleNextQueueTask = useCallback(() => {
    if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
    queueTimerRef.current = setTimeout(() => {
      runNextQueueTask();
    }, 100);
  }, [runNextQueueTask]);

  // ── INSTANT USER PRIORITY PROMOTION ────────────────────────────────────────
  // When a user navigates to ANY screen, this immediately promotes any queued task
  // to run INSTANTLY with maximum priority while pausing the background runner.
  const getInFlightPrefetch = useCallback((key) => {
    // 1. Is it currently in flight right now?
    if (inFlightPrefetchesRef.current.has(key)) {
      return inFlightPrefetchesRef.current.get(key);
    }

    // 2. Is it waiting in the background queue? Promote and execute NOW!
    const queuedTask = queuedTaskMapRef.current.get(key);
    if (queuedTask) {
      queuedTaskMapRef.current.delete(key);
      queueRef.current = queueRef.current.filter((t) => t.key !== key);

      foregroundActiveCountRef.current++;
      const promise = (async () => {
        try {
          return await queuedTask.fetcher();
        } catch (err) {
          console.warn(`[Promoted Fetch Error] ${key}:`, err?.message);
          throw err;
        } finally {
          inFlightPrefetchesRef.current.delete(key);
          foregroundActiveCountRef.current = Math.max(0, foregroundActiveCountRef.current - 1);
          // Resume remaining background tasks after foreground fetch completes
          scheduleNextQueueTask();
        }
      })();

      inFlightPrefetchesRef.current.set(key, promise);
      return promise;
    }

    return null;
  }, [scheduleNextQueueTask]);

  const safeFetchOnce = useCallback((key, fetcher, isPriority = false) => {
    if (inFlightPrefetchesRef.current.has(key)) {
      return inFlightPrefetchesRef.current.get(key);
    }

    if (queuedTaskMapRef.current.has(key)) {
      queuedTaskMapRef.current.delete(key);
      queueRef.current = queueRef.current.filter((t) => t.key !== key);
    }

    if (isPriority) {
      foregroundActiveCountRef.current++;
    }

    const p = (async () => {
      try {
        return await fetcher();
      } catch (err) {
        console.warn(`[PMA Fetch Warning] ${key}:`, err?.message);
        throw err;
      } finally {
        inFlightPrefetchesRef.current.delete(key);
        if (isPriority) {
          foregroundActiveCountRef.current = Math.max(0, foregroundActiveCountRef.current - 1);
          scheduleNextQueueTask();
        }
      }
    })();

    inFlightPrefetchesRef.current.set(key, p);
    return p;
  }, [scheduleNextQueueTask]);

  const prioritizeFetch = useCallback(async (key, fetcher, clientSheetId = null, dataType = null) => {
    if (clientSheetId && dataType) {
      const cached = getCachedClientData(clientSheetId, dataType);
      if (cached && !cached.isStale) return cached.data;
    }
    const inFlight = getInFlightPrefetch(key);
    if (inFlight) return await inFlight;

    foregroundActiveCountRef.current++;
    const p = (async () => {
      try {
        return await fetcher();
      } catch (err) {
        console.warn(`[Prioritize Fetch Error] ${key}:`, err?.message);
        throw err;
      } finally {
        inFlightPrefetchesRef.current.delete(key);
        foregroundActiveCountRef.current = Math.max(0, foregroundActiveCountRef.current - 1);
        scheduleNextQueueTask();
      }
    })();

    inFlightPrefetchesRef.current.set(key, p);
    return await p;
  }, [getCachedClientData, getInFlightPrefetch, scheduleNextQueueTask]);

  // ── BACKGROUND PRELOADER (SEQUENTIAL & PACED) ──────────────────────────────
  const preloadClientData = useCallback((client) => {
    if (!client?.clientSheetId) return;
    const cleanClientId = cleanSheetId(client.clientSheetId);
    const cleanMasterId = client.masterSheetId ? cleanSheetId(client.masterSheetId) : null;
    const clientName = client.clientName || "";

    // Set active client and reset any previous client's queue
    activeClientIdRef.current = cleanClientId;
    if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
    queueRef.current = [];
    queuedTaskMapRef.current.clear();

    const enqueue = (key, priority, dataType, fetcher) => {
      const cached = getCachedClientData(cleanClientId, dataType);
      if (cached && !cached.isStale) return;
      if (inFlightPrefetchesRef.current.has(key)) return;

      const task = {
        key,
        priority,
        clientSheetId: cleanClientId,
        dataType,
        fetcher
      };
      queueRef.current.push(task);
      queuedTaskMapRef.current.set(key, task);
    };

    // ── PRIORITY 2: Core screens (Jobs, Contractors, Invoices, Retainers)
    enqueue(`jobs_${cleanClientId}`, 2, "jobs_All", async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_client_jobs", clientSheetId: cleanClientId, tabName: "All" })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "jobs_All", d);
      return d;
    });

    enqueue(`outgoings_${cleanClientId}`, 2, "outgoings", async () => {
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
      enqueue(`outgoings_inbox_${cleanMasterId}`, 2, "outgoings_inbox", async () => {
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

    enqueue(`inv_jobs_${cleanClientId}`, 2, "invoice_jobs_active", async () => {
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
      enqueue(`inv_inbox_${cleanMasterId}`, 2, "invoices_inbox", async () => {
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

    enqueue(`retainer_jobs_${cleanClientId}`, 2, "retainer_jobs", async () => {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_retainer_jobs", clientSheetId: cleanClientId })
      });
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "retainer_jobs", d);
      return d;
    });

    // ── PRIORITY 3: Pulse Views (Payload, Performance, Key Data, Cashflow, Budget Overview)
    enqueue(`portal_payload_${cleanClientId}`, 3, "portal_payload", async () => {
      const res = await fetch(
        `/api/portal/payload?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
      );
      const d = await res.json();
      if (d.success && d.payload) setCachedClientData(cleanClientId, "portal_payload", d.payload);
      return d;
    });

    enqueue(`portal_perf_${cleanClientId}`, 3, "portal_perf", async () => {
      const res = await fetch(
        `/api/portal/performance?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
      );
      const d = await res.json();
      if (d.success && d.data) setCachedClientData(cleanClientId, "portal_perf", d.data);
      return d;
    });

    enqueue(`portal_key_${cleanClientId}`, 3, "portal_key_data", async () => {
      const res = await fetch(
        `/api/portal/key-data?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
      );
      const d = await res.json();
      if (d.success && d.data) setCachedClientData(cleanClientId, "portal_key_data", d.data);
      return d;
    });

    enqueue(`portal_cash_${cleanClientId}`, 3, "portal_cash", async () => {
      const res = await fetch(
        `/api/portal/cash?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
      );
      const d = await res.json();
      if (d.success && d.data) setCachedClientData(cleanClientId, "portal_cash", d.data);
      return d;
    });

    enqueue(`portal_budget_${cleanClientId}`, 3, "portal_budget", async () => {
      const res = await fetch(
        `/api/portal/budget?clientSheetId=${encodeURIComponent(cleanClientId)}&clientName=${encodeURIComponent(clientName)}`
      );
      const d = await res.json();
      if (d.success && d.data) setCachedClientData(cleanClientId, "portal_budget", d.data);
      return d;
    });

    // ── PRIORITY 4: Deep Edit Screens (Salaries, Expenses, New Business to Find, Budget, Cash)
    if (cleanMasterId) {
      enqueue(`salaries_${cleanClientId}`, 4, "salaries", async () => {
        const res = await fetch(
          `/api/pma/salaries?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(cleanMasterId)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
        );
        const d = await res.json();
        if (d.success) setCachedClientData(cleanClientId, "salaries", d);
        return d;
      });
    }

    enqueue(`expenses_${cleanClientId}`, 4, "expenses", async () => {
      const res = await fetch(
        `/api/pma/expenses?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
      );
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "expenses", d);
      return d;
    });

    enqueue(`nbtofind_${cleanClientId}`, 4, "nbtofind", async () => {
      const res = await fetch(
        `/api/pma/nbtofind?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
      );
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "nbtofind", d);
      return d;
    });

    enqueue(`budget_${cleanClientId}`, 4, "budget", async () => {
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

    enqueue(`cash_${cleanClientId}`, 4, "cash", async () => {
      const res = await fetch(
        `/api/pma/cash?clientName=${encodeURIComponent(clientName)}&clientSheetId=${encodeURIComponent(cleanClientId)}`
      );
      const d = await res.json();
      if (d.success) setCachedClientData(cleanClientId, "cash", d);
      return d;
    });

    // Start sequential processing loop
    scheduleNextQueueTask();
  }, [cleanSheetId, getCachedClientData, setCachedClientData, scheduleNextQueueTask]);

  // Automatically trigger background preloading whenever managedClient changes
  useEffect(() => {
    if (managedClient?.clientSheetId) {
      preloadClientData(managedClient);
    } else {
      activeClientIdRef.current = null;
      if (queueTimerRef.current) clearTimeout(queueTimerRef.current);
      queueRef.current = [];
      queuedTaskMapRef.current.clear();
    }
  }, [managedClient, preloadClientData]);

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
    prioritizeFetch,
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