import { useState, useRef, useCallback, useEffect } from "react";
import { useAppGlobals } from "./useAppGlobals";

export function useInvoices(assignedAppIds, initialClient = null) {
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [invoicesClient, setInvoicesClient] = useState(initialClient);
  const [invoicesInbox, setInvoicesInbox] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "invoices_inbox");
      if (cached?.data?.inbox) {
        return (cached.data.inbox || []).filter(inv => !assignedAppIds?.has(inv.invoiceNo));
      }
    }
    return [];
  });
  const [invoicesInboxLoading, setInvoicesInboxLoading] = useState(false);
  const [invoicesPlacing, setInvoicesPlacingState] = useState(null);
  const invoicesPlacingRef = useRef(null);
  
  const setInvoicesPlacing = (val) => { 
    invoicesPlacingRef.current = val; 
    setInvoicesPlacingState(val); 
  };
  
  const [invoicesJobs, setInvoicesJobs] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "invoice_jobs_active");
      if (cached?.data?.jobs) return cached.data.jobs;
    }
    return null;
  });
  const [invoicesJobsLoading, setInvoicesJobsLoading] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "invoice_jobs_active");
      return !cached?.data?.jobs;
    }
    return false;
  });
  const [invoicesShowAll, setInvoicesShowAll] = useState(false);
  const [invoicesSavingCell, setInvoicesSavingCell] = useState(null);
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [invoicesNewJob, setInvoicesNewJob] = useState(null);
  const [hasAccountingIntegration, setHasAccountingIntegration] = useState(() => {
    if (initialClient?.clientSheetId) {
      const cleanId = cleanSheetId ? cleanSheetId(initialClient.clientSheetId) : initialClient.clientSheetId;
      const cached = getCachedClientData(cleanId, "invoice_jobs_active");
      if (cached?.data?.hasAccountingIntegration !== undefined) return Boolean(cached.data.hasAccountingIntegration);
      if (initialClient.hasAccountingIntegration !== undefined) return Boolean(initialClient.hasAccountingIntegration);
    }
    return false;
  });

  useEffect(() => {
    if (invoicesClient?.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(invoicesClient.hasAccountingIntegration));
    }
  }, [invoicesClient]);

  const loadInvoicesInbox = useCallback(async (client, bypassCache = false) => {
    if (!client?.clientSheetId) return;
    const cacheKey = "invoices_inbox";
    const cleanMasterId = client.masterSheetId ? (cleanSheetId ? cleanSheetId(client.masterSheetId) : String(client.masterSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1")) : null;

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.inbox) {
      const pruned = (cached.data.inbox || []).filter(inv => !assignedAppIds.has(inv.invoiceNo));
      setInvoicesInbox(pruned);
      setInvoicesInboxLoading(false);
      if (!cached.isStale) return;
    } else {
      setInvoicesInboxLoading(true);
    }

    if (!bypassCache && cleanMasterId && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`inv_inbox_${cleanMasterId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, cacheKey);
          if (fresh?.data?.inbox) {
            setInvoicesInbox((fresh.data.inbox || []).filter(inv => !assignedAppIds.has(inv.invoiceNo)));
            setInvoicesInboxLoading(false);
            return;
          }
        } catch {}
      }
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoices_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setCachedClientData(client.clientSheetId, cacheKey, data);
        const pruned = (data.inbox || []).filter(inv => !assignedAppIds.has(inv.invoiceNo));
        setInvoicesInbox(pruned);
      }
    } catch(e) { 
      console.error("loadInvoicesInbox error:", e); 
    } finally { 
      setInvoicesInboxLoading(false); 
    }
  }, [assignedAppIds, cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  const loadInvoicesJobs = useCallback(async (client, showAll, silent = false, bypassCache = false) => {
    if (!client?.clientSheetId) return;

    if (client.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
    }

    const cacheKey = showAll ? "invoice_jobs_all" : "invoice_jobs_active";
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : String(client.clientSheetId).replace(/.*\/d\/([a-zA-Z0-9-_]+).*/, "$1");

    const cached = (!bypassCache && !silent) ? getCachedClientData(client.clientSheetId, cacheKey) : null;
    if (cached?.data?.jobs) {
      setInvoicesJobs(cached.data.jobs);
      if (cached.data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(cached.data.hasAccountingIntegration));
      else if (client.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
      if (!silent) setInvoicesJobsLoading(false);
      if (!cached.isStale) return;
    } else if (!silent) {
      setInvoicesJobsLoading(true);
    }

    if (!bypassCache && !showAll && !silent && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`inv_jobs_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, cacheKey);
          if (fresh?.data?.jobs) {
            setInvoicesJobs(fresh.data.jobs);
            if (fresh.data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(fresh.data.hasAccountingIntegration));
            else if (client.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
            setInvoicesJobsLoading(false);
            return;
          }
        } catch {}
      }
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoice_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        setCachedClientData(client.clientSheetId, cacheKey, data);
        setInvoicesJobs(data.jobs);
        if (data.hasAccountingIntegration !== undefined) {
          setHasAccountingIntegration(Boolean(data.hasAccountingIntegration));
        } else if (client.hasAccountingIntegration !== undefined) {
          setHasAccountingIntegration(Boolean(client.hasAccountingIntegration));
        }
      }
    } catch(e) { 
      console.error("loadInvoicesJobs error:", e); 
    } finally { 
      if (!silent) setInvoicesJobsLoading(false); 
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  return {
    invoicesClient, setInvoicesClient,
    invoicesInbox, setInvoicesInbox,
    invoicesInboxLoading,
    invoicesPlacing, setInvoicesPlacing, invoicesPlacingRef,
    invoicesJobs, setInvoicesJobs,
    invoicesJobsLoading,
    invoicesShowAll, setInvoicesShowAll,
    invoicesSavingCell, setInvoicesSavingCell,
    invoicesEditSlot, setInvoicesEditSlot,
    invoicesNewJob, setInvoicesNewJob,
    hasAccountingIntegration,
    loadInvoicesInbox, loadInvoicesJobs
  };
}