import { useState, useCallback, useEffect, useRef } from "react";

const STORAGE_KEY_PREFIX = "pulse_activity_swr_v1:";

function prepareCompactActivitySnapshot(data, targetClient) {
  if (!data) return null;
  // If targetClient is not ALL, data is single client
  if (targetClient && targetClient !== "ALL") {
    const events = (data.events || []).slice(0, 50).map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      timestampMs: e.timestampMs,
      relativeTime: e.relativeTime,
      clientName: e.clientName,
      category: e.category,
      source: e.source,
      action: e.action,
      summary: e.summary,
      isRoutine: e.isRoutine,
      userEmail: e.userEmail,
      author: e.author,
      structuredDetails: e.structuredDetails ? {
        type: e.structuredDetails.type,
        pmaAction: e.structuredDetails.pmaAction,
        pulseAction: e.structuredDetails.pulseAction
      } : undefined
    }));
    return {
      clientName: targetClient,
      totalEvents: data.totalEvents || events.length,
      events,
      cachedAt: data.cachedAt
    };
  }

  // ALL clients: compact each client's latest events for instant card rendering
  const compactClients = {};
  for (const [cName, cInfo] of Object.entries(data.clients || {})) {
    compactClients[cName] = {
      totalEvents: cInfo.totalEvents || (cInfo.events || []).length,
      events: (cInfo.events || []).slice(0, 20).map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        timestampMs: e.timestampMs,
        relativeTime: e.relativeTime,
        clientName: e.clientName,
        category: e.category,
        source: e.source,
        action: e.action,
        summary: e.summary,
        isRoutine: e.isRoutine,
        userEmail: e.userEmail,
        author: e.author,
        structuredDetails: e.structuredDetails ? {
          type: e.structuredDetails.type,
          pmaAction: e.structuredDetails.pmaAction,
          pulseAction: e.structuredDetails.pulseAction
        } : undefined
      }))
    };
  }

  return {
    clients: compactClients,
    allEvents: (data.allEvents || []).slice(0, 50).map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      timestampMs: e.timestampMs,
      relativeTime: e.relativeTime,
      clientName: e.clientName,
      category: e.category,
      source: e.source,
      action: e.action,
      summary: e.summary,
      isRoutine: e.isRoutine
    })),
    cachedAt: data.cachedAt
  };
}

export function useActivity(automationCommanderSheetId, allOutgoingsClients) {
  // 1. Synchronous 0ms load from localStorage on very first mount
  const [activityData, setActivityData] = useState(() => {
    if (typeof window === "undefined") return { clients: {}, allEvents: [], cachedAt: null };
    try {
      const saved = localStorage.getItem(`${STORAGE_KEY_PREFIX}ALL:normal`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && (parsed.allEvents?.length > 0 || Object.keys(parsed.clients || {}).length > 0)) {
          return parsed;
        }
      }
    } catch {
      // LocalStorage fallback
    }
    return { clients: {}, allEvents: [], cachedAt: null };
  });

  const [selectedClient, setSelectedClient] = useState("ALL");
  const [includeRoutine, setIncludeRoutine] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [expandedEvents, setExpandedEvents] = useState(new Set());

  // Keep live references so loadActivity can stay completely stable
  const activityDataRef = useRef(activityData);
  activityDataRef.current = activityData;
  const selectedClientRef = useRef(selectedClient);
  selectedClientRef.current = selectedClient;
  const includeRoutineRef = useRef(includeRoutine);
  includeRoutineRef.current = includeRoutine;
  const automationCommanderSheetIdRef = useRef(automationCommanderSheetId);
  automationCommanderSheetIdRef.current = automationCommanderSheetId;
  const allOutgoingsClientsRef = useRef(allOutgoingsClients);
  allOutgoingsClientsRef.current = allOutgoingsClients;

  // 2. Load cached data from localStorage when client or routine filter changes
  useEffect(() => {
    try {
      const storageKey = `${STORAGE_KEY_PREFIX}${selectedClient}:${includeRoutine ? "routine" : "normal"}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && (parsed.allEvents?.length > 0 || Object.keys(parsed.clients || {}).length > 0)) {
          setActivityData(parsed);
        }
      }
    } catch {
      // LocalStorage access fallback
    }
  }, [selectedClient, includeRoutine]);

  const toggleExpand = useCallback((eventId) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);

  const loadActivity = useCallback(
    async (options = {}) => {
      const currentSelectedClient = selectedClientRef.current;
      const currentIncludeRoutine = includeRoutineRef.current;
      const currentSheetId = automationCommanderSheetIdRef.current;
      const currentClients = allOutgoingsClientsRef.current;
      const currentData = activityDataRef.current;

      const targetClient = options.clientName !== undefined ? options.clientName : currentSelectedClient;
      const targetRoutine = options.includeRoutine !== undefined ? options.includeRoutine : currentIncludeRoutine;
      const isForce = !!options.forceRefresh;

      try {
        const hasExisting = (currentData?.allEvents?.length > 0) || (Object.keys(currentData?.clients || {}).length > 0);
        if (isForce) {
          setIsRefreshing(true);
        } else if (!hasExisting) {
          setIsLoading(true);
        }

        setError("");

        const payload = {
          action: "get_activity",
          automationCommanderSheetId: currentSheetId,
          clientName: targetClient,
          includeRoutine: targetRoutine,
          forceRefresh: isForce,
          clients: (currentClients || []).map(c => ({
            clientName: c.clientName,
            clientSheetId: c.clientSheetId,
            masterSheetId: c.masterSheetId
          }))
        };

        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const json = await res.json();
        if (!json.success) {
          throw new Error(json.error || "Failed to load activity");
        }

        let updatedData;
        if (targetClient && targetClient !== "ALL") {
          // Single client response
          const clientResult = json.data || {};
          setActivityData((prev) => {
            updatedData = {
              ...prev,
              clients: {
                ...prev.clients,
                [targetClient]: {
                  events: clientResult.events || [],
                  totalEvents: clientResult.totalEvents || 0
                }
              },
              cachedAt: clientResult.cachedAt || prev.cachedAt || new Date().toISOString()
            };
            return updatedData;
          });
        } else {
          // All clients response
          updatedData = json.data || { clients: {}, allEvents: [], cachedAt: null };
          setActivityData(updatedData);
        }


        // Save compact snapshot to persistent localStorage for 0ms load next time
        try {
          if (updatedData) {
            const storageKey = `${STORAGE_KEY_PREFIX}${targetClient}:${targetRoutine ? "routine" : "normal"}`;
            const compactSnapshot = prepareCompactActivitySnapshot(updatedData, targetClient);
            localStorage.setItem(storageKey, JSON.stringify(compactSnapshot));
          }
        } catch {
          // Local storage quota or unavailable fallback
        }

        return updatedData;
      } catch (err) {
        console.error("loadActivity error:", err);
        setError(err.message || "Failed to load activity feed");
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    []
  );

  return {
    activityData,
    selectedClient,
    setSelectedClient,
    includeRoutine,
    setIncludeRoutine,
    isLoading,
    isRefreshing,
    error,
    expandedEvents,
    toggleExpand,
    loadActivity
  };
}
