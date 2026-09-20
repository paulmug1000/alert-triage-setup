import { useState, useRef } from "react";

export function useInvoices(assignedAppIds) {
  const [invoicesClient, setInvoicesClient] = useState(null);
  const [invoicesInbox, setInvoicesInbox] = useState([]);
  const [invoicesInboxLoading, setInvoicesInboxLoading] = useState(false);
  const [invoicesPlacing, setInvoicesPlacingState] = useState(null);
  const invoicesPlacingRef = useRef(null);
  
  const setInvoicesPlacing = (val) => { 
    invoicesPlacingRef.current = val; 
    setInvoicesPlacingState(val); 
  };
  
  const [invoicesJobs, setInvoicesJobs] = useState(null);
  const [invoicesJobsLoading, setInvoicesJobsLoading] = useState(false);
  const [invoicesShowAll, setInvoicesShowAll] = useState(false);
  const [invoicesSavingCell, setInvoicesSavingCell] = useState(null);
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [invoicesNewJob, setInvoicesNewJob] = useState(null);

  const loadInvoicesInbox = async (client) => {
    if (!client?.clientSheetId) return;
    try {
      setInvoicesInboxLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoices_inbox", clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        const pruned = (data.inbox || []).filter(inv => !assignedAppIds.has(inv.invoiceNo));
        setInvoicesInbox(pruned);
      }
    } catch(e) { 
      console.error("loadInvoicesInbox error:", e); 
    } finally { 
      setInvoicesInboxLoading(false); 
    }
  };

  const loadInvoicesJobs = async (client, showAll) => {
    if (!client?.clientSheetId) return;
    try {
      setInvoicesJobsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_invoice_jobs", clientSheetId: client.clientSheetId, showAll: !!showAll }),
      });
      const data = await res.json();
      if (data.success) setInvoicesJobs(data.jobs);
    } catch(e) { 
      console.error("loadInvoicesJobs error:", e); 
    } finally { 
      setInvoicesJobsLoading(false); 
    }
  };

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
    loadInvoicesInbox, loadInvoicesJobs
  };
}