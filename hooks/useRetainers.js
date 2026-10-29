import { useState, useCallback } from "react";
import { useAppGlobals } from "./useAppGlobals";

export function useRetainers(initialClient = null) {
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [retainersClient, setRetainersClient] = useState(initialClient);
  const [retainersJobs, setRetainersJobs] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "retainer_jobs");
      if (cached?.data?.jobs) return cached.data.jobs;
    }
    return null;
  });
  const [retainersJobsLoading, setRetainersJobsLoading] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "retainer_jobs");
      return !cached?.data?.jobs;
    }
    return false;
  });
  const [isTidying, setIsTidying] = useState(false);
  const [showTidyConfirm, setShowTidyConfirm] = useState(false);
  const [tidyResult, setTidyResult] = useState(null);
  const [retainersEditJob, setRetainersEditJob] = useState(null);
  const [expandedRetainerJobs, setExpandedRetainerJobs] = useState(() => new Set());
  const [showCreateRetainerModal, setShowCreateRetainerModal] = useState(false);
  const [retainerAlertResolution, setRetainerAlertResolution] = useState(null);
  const [retainerSplitInvoice, setRetainerSplitInvoice] = useState(null);

  const loadRetainersJobs = useCallback(async (client, bypassCache = false, silent = false) => {
    if (!client?.clientSheetId) return;
    const cacheKey = "retainer_jobs";
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.jobs) {
      setRetainersJobs(cached.data.jobs);
      setRetainersJobsLoading(false);
      if (!cached.isStale) return;
    } else {
      if (!silent) setRetainersJobsLoading(true);
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`retainer_jobs_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, cacheKey);
          if (fresh?.data?.jobs) {
            setRetainersJobs(fresh.data.jobs);
            setRetainersJobsLoading(false);
            return;
          }
        } catch {}
      }
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_retainer_jobs", clientSheetId: client.clientSheetId, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setCachedClientData(client.clientSheetId, cacheKey, data);
        setRetainersJobs(data.jobs);
      }
    } catch(e) { 
      console.error("loadRetainersJobs error:", e); 
    } finally { 
      setRetainersJobsLoading(false); 
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  const handleTidyRetainers = async () => {
    setShowTidyConfirm(false);
    setIsTidying(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tidy_up_retainers", clientSheetId: retainersClient.clientSheetId, masterSheetId: retainersClient.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setTidyResult({ success: true, moves: data.moves });
        loadRetainersJobs(retainersClient);
      } else {
        setTidyResult({ success: false, error: data.error });
      }
    } catch(e) {
      setTidyResult({ success: false, error: e.message });
    } finally {
      setIsTidying(false);
    }
  };

  return {
    retainersClient, setRetainersClient,
    retainersJobs, setRetainersJobs,
    retainersJobsLoading, setRetainersJobsLoading,
    isTidying, setIsTidying,
    showTidyConfirm, setShowTidyConfirm,
    tidyResult, setTidyResult,
    retainersEditJob, setRetainersEditJob,
    expandedRetainerJobs, setExpandedRetainerJobs,
    showCreateRetainerModal, setShowCreateRetainerModal,
    retainerAlertResolution, setRetainerAlertResolution,
    retainerSplitInvoice, setRetainerSplitInvoice,
    loadRetainersJobs, handleTidyRetainers
  };
}