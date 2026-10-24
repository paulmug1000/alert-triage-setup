import { useState, useCallback, useEffect } from "react";
import { useAppGlobals } from "./useAppGlobals";

export function useJobs(initialClient = null) {
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [jobsClient, setJobsClient] = useState(initialClient);
  const [jobsTab, setJobsTab] = useState("All");
  const [jobsSortBy, setJobsSortBy] = useState("startDateDesc");
  const [jobsData, setJobsData] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      if (cached?.data?.jobs) return cached.data.jobs;
    }
    return null;
  });
  const [jobsLoading, setJobsLoading] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      return !cached?.data?.jobs;
    }
    return false;
  });
  const [jobsExpanded, setJobsExpanded] = useState(() => new Set());
  const [jobsEditSplit, setJobsEditSplit] = useState(null);
  const [hasAccountingIntegration, setHasAccountingIntegration] = useState(() => {
    if (initialClient?.hasAccountingIntegration !== undefined) return Boolean(initialClient.hasAccountingIntegration);
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      if (cached?.data?.hasAccountingIntegration !== undefined) return Boolean(cached.data.hasAccountingIntegration);
    }
    return false;
  });

  useEffect(() => {
    if (jobsClient?.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(jobsClient.hasAccountingIntegration));
    }
  }, [jobsClient]);

  const [productLines, setProductLines] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      if (cached?.data?.productLines) return cached.data.productLines;
    }
    return [];
  });
  const [leadSources, setLeadSources] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      if (cached?.data?.leadSources) return cached.data.leadSources;
    }
    return [];
  });
  const [existingClients, setExistingClients] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "jobs_All");
      if (cached?.data?.existingClients) return cached.data.existingClients;
    }
    return [];
  });

  const loadJobsData = useCallback(async (client, tabName = "All", bypassCache = false) => {
    if (!client?.clientSheetId) return;

    if (client.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
    }

    const cacheKey = `jobs_${tabName}`;
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    // 1. Check in-memory PMA Client Cache (0ms instant render)
    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.jobs) {
      setJobsData(cached.data.jobs);
      if (cached.data.productLines) setProductLines(cached.data.productLines);
      if (cached.data.leadSources) setLeadSources(cached.data.leadSources);
      if (cached.data.existingClients) setExistingClients(cached.data.existingClients);
      if (cached.data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(cached.data.hasAccountingIntegration));
      else if (client.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
      setJobsLoading(false);
      // If cached data is fresh (< 120s), return immediately
      if (!cached.isStale) return;
    } else {
      setJobsLoading(true);
    }

    // 2. Await in-flight background prefetch if currently running
    if (!bypassCache && tabName === "All" && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`jobs_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, cacheKey);
          if (fresh?.data?.jobs) {
            setJobsData(fresh.data.jobs);
            if (fresh.data.productLines) setProductLines(fresh.data.productLines);
            if (fresh.data.leadSources) setLeadSources(fresh.data.leadSources);
            if (fresh.data.existingClients) setExistingClients(fresh.data.existingClients);
            if (fresh.data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(fresh.data.hasAccountingIntegration));
            else if (client.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
            setJobsLoading(false);
            return;
          }
        } catch {
          // Continue to fallback fetch below
        }
      }
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_client_jobs", clientSheetId: client.clientSheetId, tabName, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setJobsData(data.jobs);
        if (data.productLines) setProductLines(data.productLines);
        if (data.leadSources) setLeadSources(data.leadSources);
        if (data.existingClients) setExistingClients(data.existingClients);
        if (data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(data.hasAccountingIntegration));
        else if (client.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
        setCachedClientData(client.clientSheetId, cacheKey, data);
      }
    } catch (e) {
      console.error("loadJobsData error:", e);
    } finally {
      setJobsLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  return {
    jobsClient, setJobsClient,
    jobsTab, setJobsTab,
    jobsSortBy, setJobsSortBy,
    jobsData, setJobsData,
    jobsLoading,
    jobsExpanded, setJobsExpanded,
    jobsEditSplit, setJobsEditSplit,
    productLines, setProductLines,
    leadSources, setLeadSources,
    existingClients, setExistingClients,
    hasAccountingIntegration,
    loadJobsData
  };
}