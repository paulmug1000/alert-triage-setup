import { useState, useRef, useCallback } from "react";
import { useAppGlobals } from "./useAppGlobals";

export function useOutgoings(assignedAppIds, assignedByClient, setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, automationCommanderSheetId, initialClient = null) {
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const hasValidContractors = (cData) =>
    Boolean(
      cData?.contractors &&
      cData?.months &&
      (cData.contractors.length === 0 || cData.contractors[0]?.deliveryPct !== undefined)
    );

  const [outgoingsData, setOutgoingsData] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings");
      if (hasValidContractors(cached?.data)) return cached.data;
    }
    return null;
  });
  const [outgoingsLoading, setOutgoingsLoading] = useState(() => {
    if (initialClient) {
      if (!initialClient.clientSheetId) return true;
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings");
      return !hasValidContractors(cached?.data);
    }
    return false;
  });
  const [outgoingsClient, setOutgoingsClient] = useState(initialClient);
  const [outgoingsMonthOffset, setOutgoingsMonthOffset] = useState(0);
  const [outgoingsEditCell, setOutgoingsEditCell] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);
  const [outgoingsInbox, setOutgoingsInbox] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings_inbox");
      if (cached?.data?.inbox) return cached.data.inbox;
    }
    return [];
  });
  const [outgoingsInboxLoading, setOutgoingsInboxLoading] = useState(() => {
    if (initialClient) {
      if (!initialClient.clientSheetId) return true;
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings_inbox");
      return !cached?.data?.inbox;
    }
    return false;
  });
  const [outgoingsPlacing, setOutgoingsPlacingState] = useState(null);
  const outgoingsPlacingRef = useRef(null);
  
  const setOutgoingsPlacing = (val) => { 
    outgoingsPlacingRef.current = val; 
    setOutgoingsPlacingState(val); 
  };
  
  const [outgoingsEstimate, setOutgoingsEstimate] = useState(null);
  const [outgoingsNewVendor, setOutgoingsNewVendor] = useState(null);
  const [vendorsSubTab, setVendorsSubTab] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const sub = p.get("subtab");
      if (sub === "directCosts" || sub === "contractors") return sub;
    }
    return "contractors";
  });
  const [directCostsJobs, setDirectCostsJobs] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "direct_costs_jobs_active");
      if (cached?.data?.jobs) return cached.data.jobs;
    }
    return null;
  });
  const [directCostsLoading, setDirectCostsLoading] = useState(false);
  const [directCostsShowAll, setDirectCostsShowAll] = useState(false);
  const [directCostsSavingCell, setDirectCostsSavingCell] = useState(null);
  const [outgoingsError, setOutgoingsError] = useState("");

  const loadOutgoings = async (client, bypassCache = false) => {
    if (!client) return;
    if (outgoingsClient?.clientSheetId !== client.clientSheetId) {
      setDirectCostsJobs(null);
    }
    setOutgoingsClient(client);
    setOutgoingsError("");
    if (!client.clientSheetId) {
      setOutgoingsLoading(true);
      setOutgoingsInboxLoading(true);
      return;
    }

    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");
    const cleanMasterId = client.masterSheetId ? (cleanSheetId ? cleanSheetId(client.masterSheetId) : String(client.masterSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")) : null;

    // Check client cache for grid & inbox (0ms instant render)
    const cachedGrid = !bypassCache ? getCachedClientData(client.clientSheetId, "outgoings") : null;
    const cachedInbox = !bypassCache ? getCachedClientData(client.clientSheetId, "outgoings_inbox") : null;

    const hasGridCached = hasValidContractors(cachedGrid?.data);
    const hasInboxCached = Boolean(cachedInbox?.data?.inbox);

    if (hasGridCached) {
      setOutgoingsData({
        contractors: cachedGrid.data.contractors,
        months: cachedGrid.data.months,
        directCostsMode: cachedGrid.data.directCostsMode || cachedInbox?.data?.directCostsMode || client?.directCostsMode || "Contractors",
      });
      const now = new Date();
      const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const currentIdx = (cachedGrid.data.months || []).findIndex(m => (m.isoMonth || "").startsWith(curIso));
      if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
      setOutgoingsLoading(false);
    } else {
      setOutgoingsLoading(true);
    }

    if (hasInboxCached) {
      const serverAssigned = assignedByClient[client.clientName] || new Set();
      const currentAssigned = new Set([...assignedAppIds, ...serverAssigned]);
      const freshInbox = (cachedInbox.data.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
      setOutgoingsInbox(freshInbox);
      setOutgoingsInboxLoading(false);
    } else {
      setOutgoingsInboxLoading(true);
    }

    const needGridFetch = bypassCache || !hasGridCached || cachedGrid?.isStale;
    const needInboxFetch = bypassCache || !hasInboxCached || cachedInbox?.isStale;
    if (!needGridFetch && !needInboxFetch) return;

    const applyGridData = (gridData) => {
      if (gridData?.success) {
        setCachedClientData(client.clientSheetId, "outgoings", gridData);
        setOutgoingsData(prev => ({
          contractors: gridData.contractors,
          months: gridData.months,
          directCostsMode: gridData.directCostsMode || prev?.directCostsMode || client?.directCostsMode || "Contractors",
        }));
        const now = new Date();
        const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const currentIdx = (gridData.months || []).findIndex(m => (m.isoMonth || "").startsWith(curIso));
        if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
      } else if (!hasGridCached) {
        setOutgoingsError(gridData?.error || "Failed to load expenses data.");
      }
    };

    const applyInboxData = (inboxData) => {
      if (!inboxData?.success) return;
      setCachedClientData(client.clientSheetId, "outgoings_inbox", inboxData);
      if (inboxData.directCostsMode) {
        setOutgoingsData(prev => prev ? { ...prev, directCostsMode: prev.directCostsMode || inboxData.directCostsMode } : prev);
      }
      if (inboxData.locked) {
        console.warn("Outgoings inbox: GAS lock active -", inboxData.lockMessage);
        const serverAssigned = assignedByClient[client.clientName] || new Set();
        const currentAssigned = new Set([...assignedAppIds, ...serverAssigned]);
        const freshInbox = (inboxData.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
        setOutgoingsInbox(freshInbox);
      } else {
        const allInboxIds = new Set((inboxData.inbox || []).map(e => e.appId));

        setAssignedByClient(prev => {
          const next = { ...prev };
          const existingIds = prev[client.clientName] || new Set();
          const pruned = new Set([...existingIds].filter(id => allInboxIds.has(id)));
          if (pruned.size > 0) next[client.clientName] = pruned;
          else delete next[client.clientName];

          setAssignedAppIds(prevGlobal => {
            const nextGlobal = new Set(prevGlobal);
            const cNorm = client.clientName ? String(client.clientName).trim().toLowerCase() : "";
            for (const id of existingIds) {
              if (!allInboxIds.has(id)) {
                nextGlobal.delete(id);
                const clean = String(id).replace(/^#/, "");
                nextGlobal.delete(clean);
                if (cNorm) nextGlobal.delete(`${cNorm}::${clean}`);
              }
            }
            try {
              const stored = localStorage.getItem("pulse_assignedAppIds");
              if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  for (const id of existingIds) {
                    if (!allInboxIds.has(id)) {
                      const clean = String(id).replace(/^#/, "");
                      delete parsed[id];
                      delete parsed[clean];
                      if (cNorm) delete parsed[`${cNorm}::${clean}`];
                    }
                  }
                  localStorage.setItem("pulse_assignedAppIds", JSON.stringify(parsed));
                }
              }
            } catch {}
            return nextGlobal;
          });

          return next;
        });

        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "prune_assigned_expenses",
            automationCommanderSheetId,
            clientName: client.clientName,
            validAppIds: [...allInboxIds],
          }),
        }).catch(e => console.error("prune_assigned_expenses error:", e));

        const serverAssigned = assignedByClient[client.clientName] || new Set();
        const currentAssigned = new Set([
          ...Array.from(assignedAppIds).filter(id => allInboxIds.has(id)),
          ...Array.from(serverAssigned).filter(id => allInboxIds.has(id)),
        ]);
        const freshInbox = (inboxData.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
        setOutgoingsInbox(freshInbox);
      }
    };

    const runGridTask = async () => {
      if (!needGridFetch) return;
      try {
        if (!bypassCache && typeof getInFlightPrefetch === "function") {
          const inFlightGrid = getInFlightPrefetch(`outgoings_${cleanId}`);
          if (inFlightGrid) {
            await inFlightGrid.catch(() => null);
            const freshGrid = getCachedClientData(client.clientSheetId, "outgoings");
            if (hasValidContractors(freshGrid?.data)) {
              applyGridData(freshGrid.data);
              return;
            }
          }
        }
        const gridRes = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings", clientSheetId: client.clientSheetId, bypassCache }),
        });
        const gridData = await gridRes.json().catch(() => ({ success: false, error: `Server returned status ${gridRes.status}` }));
        applyGridData(gridData);
      } catch (e) {
        console.error("loadOutgoings grid error:", e);
        if (!hasGridCached) setOutgoingsError(e?.message || "Network error while loading expenses.");
      } finally {
        setOutgoingsLoading(false);
      }
    };

    const runInboxTask = async () => {
      if (!needInboxFetch) return;
      try {
        if (!bypassCache && cleanMasterId && typeof getInFlightPrefetch === "function") {
          const inFlightInbox = getInFlightPrefetch(`outgoings_inbox_${cleanMasterId}`);
          if (inFlightInbox) {
            await inFlightInbox.catch(() => null);
            const freshInbox = getCachedClientData(client.clientSheetId, "outgoings_inbox");
            if (freshInbox?.data?.inbox) {
              applyInboxData(freshInbox.data);
              return;
            }
          }
        }
        const inboxRes = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId, bypassCache }),
        });
        const inboxData = await inboxRes.json().catch(() => ({ success: false, error: `Server returned status ${inboxRes.status}` }));
        applyInboxData(inboxData);
      } catch (e) {
        console.error("loadOutgoings inbox error:", e);
      } finally {
        setOutgoingsInboxLoading(false);
      }
    };

    await Promise.allSettled([runGridTask(), runInboxTask()]);
  };

  const loadDirectCostsJobs = async (client, showAll, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cacheKey = showAll ? "direct_costs_jobs_all" : "direct_costs_jobs_active";
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");
    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.jobs) {
      setDirectCostsJobs(cached.data.jobs);
      setDirectCostsLoading(false);
      if (!cached.isStale) return;
    } else {
      setDirectCostsLoading(true);
    }

    if (!bypassCache && !showAll && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`direct_costs_jobs_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, cacheKey);
          if (fresh?.data?.jobs) {
            setDirectCostsJobs(fresh.data.jobs);
            setDirectCostsLoading(false);
            return;
          }
        } catch {}
      }
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_direct_costs_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setCachedClientData(client.clientSheetId, cacheKey, data);
        setDirectCostsJobs(data.jobs);
      }
    } catch(e) { console.error("loadDirectCostsJobs error:", e); }
    finally { setDirectCostsLoading(false); }
  };

  return {
    outgoingsData, setOutgoingsData,
    outgoingsLoading, setOutgoingsLoading,
    outgoingsInboxLoading, setOutgoingsInboxLoading,
    outgoingsClient, setOutgoingsClient,
    outgoingsMonthOffset, setOutgoingsMonthOffset,
    outgoingsEditCell, setOutgoingsEditCell,
    directCostsEditSlot, setDirectCostsEditSlot,
    outgoingsInbox, setOutgoingsInbox,
    outgoingsPlacing, setOutgoingsPlacing, outgoingsPlacingRef,
    outgoingsEstimate, setOutgoingsEstimate,
    outgoingsNewVendor, setOutgoingsNewVendor,
    vendorsSubTab, setVendorsSubTab,
    directCostsJobs, setDirectCostsJobs,
    directCostsLoading, setDirectCostsLoading,
    directCostsShowAll, setDirectCostsShowAll,
    directCostsSavingCell, setDirectCostsSavingCell,
    outgoingsError, setOutgoingsError,
    loadOutgoings, loadDirectCostsJobs
  };
}