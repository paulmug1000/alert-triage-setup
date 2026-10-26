import { useState, useRef, useCallback } from "react";
import { useAppGlobals } from "./useAppGlobals";

export function useOutgoings(assignedAppIds, assignedByClient, setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, automationCommanderSheetId, initialClient = null) {
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [outgoingsData, setOutgoingsData] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings");
      if (cached?.data?.contractors && cached?.data?.months) return cached.data;
    }
    return null;
  });
  const [outgoingsLoading, setOutgoingsLoading] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "outgoings");
      return !cached?.data?.contractors;
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
  const [directCostsJobs, setDirectCostsJobs] = useState(null);
  const [directCostsLoading, setDirectCostsLoading] = useState(false);
  const [directCostsShowAll, setDirectCostsShowAll] = useState(false);
  const [directCostsSavingCell, setDirectCostsSavingCell] = useState(null);

  const loadOutgoings = async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    setOutgoingsClient(client);

    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");
    const cleanMasterId = client.masterSheetId ? (cleanSheetId ? cleanSheetId(client.masterSheetId) : String(client.masterSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")) : null;

    // Check client cache for grid & inbox (0ms instant render)
    const cachedGrid = !bypassCache ? getCachedClientData(client.clientSheetId, "outgoings") : null;
    const cachedInbox = !bypassCache ? getCachedClientData(client.clientSheetId, "outgoings_inbox") : null;

    if (cachedGrid?.data?.contractors && cachedGrid?.data?.months) {
      setOutgoingsData({ contractors: cachedGrid.data.contractors, months: cachedGrid.data.months });
      const now = new Date();
      const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const currentIdx = (cachedGrid.data.months || []).findIndex(m => (m.isoMonth || "").startsWith(curIso));
      if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
    }
    if (cachedInbox?.data?.inbox) {
      const serverAssigned = assignedByClient[client.clientName] || new Set();
      const currentAssigned = new Set([...assignedAppIds, ...serverAssigned]);
      const freshInbox = (cachedInbox.data.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
      setOutgoingsInbox(freshInbox);
    }

    const hasBothCached = !!(cachedGrid?.data?.contractors && cachedInbox?.data?.inbox);
    if (hasBothCached) {
      setOutgoingsLoading(false);
      if (!cachedGrid.isStale && !cachedInbox.isStale) return;
    } else {
      setOutgoingsLoading(true);
    }

    // Await in-flight prefetch if currently running
    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlightGrid = getInFlightPrefetch(`outgoings_${cleanId}`);
      const inFlightInbox = cleanMasterId ? getInFlightPrefetch(`outgoings_inbox_${cleanMasterId}`) : null;
      if (inFlightGrid || inFlightInbox) {
        try {
          await Promise.all([inFlightGrid, inFlightInbox].filter(Boolean));
          const freshGrid = getCachedClientData(client.clientSheetId, "outgoings");
          const freshInbox = getCachedClientData(client.clientSheetId, "outgoings_inbox");
          if (freshGrid?.data?.contractors && freshGrid?.data?.months) {
            setOutgoingsData({ contractors: freshGrid.data.contractors, months: freshGrid.data.months });
            const now = new Date();
            const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
            const currentIdx = freshGrid.data.months.findIndex(m => (m.isoMonth || "").startsWith(curIso));
            if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
            if (freshInbox?.data?.inbox) {
              const serverAssigned = assignedByClient[client.clientName] || new Set();
              const currentAssigned = new Set([...assignedAppIds, ...serverAssigned]);
              setOutgoingsInbox((freshInbox.data.inbox || []).filter(exp => !currentAssigned.has(exp.appId)));
            }
            setOutgoingsLoading(false);
            return;
          }
        } catch {
          // Fall through to manual fetch
        }
      }
    }

    try {
      const [gridRes, inboxRes] = await Promise.all([
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings", clientSheetId: client.clientSheetId, bypassCache }),
        }),
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId, bypassCache }),
        }),
      ]);
      const [gridData, inboxData] = await Promise.all([gridRes.json(), inboxRes.json()]);
      if (gridData.success) {
        setCachedClientData(client.clientSheetId, "outgoings", gridData);
        setOutgoingsData({ contractors: gridData.contractors, months: gridData.months });
        const now = new Date();
        const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const currentIdx = gridData.months.findIndex(m => (m.isoMonth || "").startsWith(curIso));
        if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
      }
      if (inboxData.success) {
        setCachedClientData(client.clientSheetId, "outgoings_inbox", inboxData);
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

          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "prune_assigned_expenses", automationCommanderSheetId,
              clientName: client.clientName, validAppIds: [...allInboxIds] }) })
            .catch(e => console.error("prune_assigned_expenses error:", e));

          const serverAssigned = assignedByClient[client.clientName] || new Set();
          const currentAssigned = new Set([
            ...Array.from(assignedAppIds).filter(id => allInboxIds.has(id)),
            ...Array.from(serverAssigned).filter(id => allInboxIds.has(id))
          ]);
          const freshInbox = (inboxData.inbox || []).filter(exp => !currentAssigned.has(exp.appId));
          setOutgoingsInbox(freshInbox);
        }
      }
    } catch(e) { console.error("loadOutgoings error:", e); }
    finally {
      setOutgoingsLoading(false);
      setDirectCostsJobs(null);
    }
  };

  const loadDirectCostsJobs = async (client, showAll, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cacheKey = showAll ? "direct_costs_jobs_all" : "direct_costs_jobs_active";
    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.jobs) {
      setDirectCostsJobs(cached.data.jobs);
      setDirectCostsLoading(false);
      if (!cached.isStale) return;
    } else {
      setDirectCostsLoading(true);
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
    loadOutgoings, loadDirectCostsJobs
  };
}