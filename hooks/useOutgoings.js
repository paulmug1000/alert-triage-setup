import { useState, useRef } from "react";

export function useOutgoings(assignedAppIds, assignedByClient, setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, automationCommanderSheetId) {
  const [outgoingsData, setOutgoingsData] = useState(null);
  const [outgoingsLoading, setOutgoingsLoading] = useState(false);
  const [outgoingsClient, setOutgoingsClient] = useState(null);
  const [outgoingsMonthOffset, setOutgoingsMonthOffset] = useState(0);
  const [outgoingsEditCell, setOutgoingsEditCell] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);
  const [outgoingsInbox, setOutgoingsInbox] = useState([]);
  const [outgoingsPlacing, setOutgoingsPlacingState] = useState(null);
  const outgoingsPlacingRef = useRef(null);
  
  const setOutgoingsPlacing = (val) => { 
    outgoingsPlacingRef.current = val; 
    setOutgoingsPlacingState(val); 
  };
  
  const [outgoingsEstimate, setOutgoingsEstimate] = useState(null);
  const [outgoingsNewVendor, setOutgoingsNewVendor] = useState(null);
  const [vendorsSubTab, setVendorsSubTab] = useState("contractors");
  const [directCostsJobs, setDirectCostsJobs] = useState(null);
  const [directCostsLoading, setDirectCostsLoading] = useState(false);
  const [directCostsShowAll, setDirectCostsShowAll] = useState(false);
  const [directCostsSavingCell, setDirectCostsSavingCell] = useState(null);

  const loadOutgoings = async (client) => {
    if (!client?.clientSheetId) return;
    try {
      setOutgoingsLoading(true);
      setOutgoingsClient(client);
      const [gridRes, inboxRes] = await Promise.all([
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings", clientSheetId: client.clientSheetId }),
        }),
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_outgoings_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId }),
        }),
      ]);
      const [gridData, inboxData] = await Promise.all([gridRes.json(), inboxRes.json()]);
      if (gridData.success) {
        setOutgoingsData({ contractors: gridData.contractors, months: gridData.months });
        const now = new Date();
        const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const currentIdx = gridData.months.findIndex(m => (m.isoMonth || "").startsWith(curIso));
        if (currentIdx >= 0) setOutgoingsMonthOffset(Math.max(0, currentIdx - 3));
      }
      if (inboxData.success) {
        if (inboxData.locked) {
          console.warn("Outgoings inbox: GAS lock active —", inboxData.lockMessage);
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
              for (const id of existingIds) {
                if (!allInboxIds.has(id)) nextGlobal.delete(id);
              }
              try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...nextGlobal])); } catch {}
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
      setVendorsSubTab("contractors");
      setDirectCostsJobs(null);
      setDirectCostsShowAll(false);
    }
  };

  const loadDirectCostsJobs = async (client, showAll) => {
    if (!client?.clientSheetId) return;
    try {
      setDirectCostsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_direct_costs_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll }),
      });
      const data = await res.json();
      if (data.success) setDirectCostsJobs(data.jobs);
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