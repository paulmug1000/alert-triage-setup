import { useState, useCallback, useEffect, useRef } from "react";

const STORAGE_KEY_PREFIX = "pulse_activity_swr_v1:";

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
        if (hasExisting) {
          setIsRefreshing(true);
        } else {
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

        // Save to persistent localStorage for 0ms load next time
        try {
          if (updatedData) {
            const storageKey = `${STORAGE_KEY_PREFIX}${targetClient}:${targetRoutine ? "routine" : "normal"}`;
            localStorage.setItem(storageKey, JSON.stringify(updatedData));
          }
        } catch {
          // Local storage quota or unavailable fallback
        }
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
