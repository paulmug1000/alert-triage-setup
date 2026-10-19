import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";
import InvoicesEditModal from "./InvoicesEditModal";
import InvoicesNewJobModal from "./InvoicesNewJobModal";
import EditClientSelector from "./EditClientSelector";
import { useInvoices } from "../hooks/useInvoices";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";
import { useAuth } from "../hooks/useAuth";
import { isPlaceholderInvoice } from "../utils/helpers";

const formatCurrency = (val) => {
  const s = String(val || "").trim();
  if (!s) return "";
  const hasSymbol = /^[£$€]/.test(s);
  const symbol = hasSymbol ? s.charAt(0) : "£";
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return symbol + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const getStatusPill = (status) => {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  if (s === "draft") return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
  if (s === "sent" || s === "received") return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
};

const rowHasInvoice = (r) => r.invoiceSlots && r.invoiceSlots.some(s => {
  const hasRef = !!(s.ref && String(s.ref).trim() !== "");
  const hasAmt = !!(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
  return hasRef || hasAmt;
});

const parseDateString = (dStr) => {
  if (!dStr) return null;
  const s = String(dStr).trim();
  if (!s || s === "-") return null;

  // Try YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    if (!isNaN(d.getTime())) return d;
  }

  // Try DD-Mon-YY or DD-Mon-YYYY (e.g. 15-Jan-25 or 15-Jan-2025)
  const dmyMatch = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[-\/ ](\d{2,4})$/);
  if (dmyMatch) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mIdx = months[dmyMatch[2].toLowerCase()];
    if (mIdx !== undefined) {
      const yr = dmyMatch[3].length === 2 ? 2000 + parseInt(dmyMatch[3], 10) : parseInt(dmyMatch[3], 10);
      const d = new Date(yr, mIdx, parseInt(dmyMatch[1], 10));
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Fallback to Date constructor
  const native = new Date(s);
  if (!isNaN(native.getTime())) return native;

  return null;
};

const formatDisplayDate = (dateObj) => {
  if (!dateObj || isNaN(dateObj.getTime())) return "-";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(dateObj.getDate()).padStart(2, "0");
  const month = months[dateObj.getMonth()];
  const year = dateObj.getFullYear();
  return `${day}-${month}-${year}`;
};

const calculateExpectedPaymentDate = (sentDateStr, daysToPay) => {
  const sent = parseDateString(sentDateStr);
  if (!sent) return "-";
  const days = parseInt(String(daysToPay).replace(/[^\d.-]/g, ""), 10);
  const addDays = (!isNaN(days) && days > 0) ? days : 30;
  const payDate = new Date(sent.getTime() + addDays * 86400000);
  return formatDisplayDate(payDate);
};

const INVOICE_SORT_OPTIONS = [
  { value: "inv_desc", label: "Invoice no. (descending)" },
  { value: "inv_asc", label: "Invoice no. (ascending)" },
  { value: "client_name", label: "Client name" },
  { value: "sent_desc", label: "Sent date (descending)" },
  { value: "sent_asc", label: "Sent date (ascending)" },
  { value: "pay_desc", label: "Payment date (descending)" },
  { value: "pay_asc", label: "Payment date (ascending)" },
  { value: "status", label: "Status" },
];

export default function InvoicesView({
  allOutgoingsClients,
  styles,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient,
  initialClient
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));

  const { assignedAppIds, setAssignedAppIds, outgoingsPullPendingRef, addAssignedAppId } = useAppGlobals();
  const { clientsWithFlags, setClientsWithFlags } = useTriage();

  const {
    invoicesClient, setInvoicesClient,
    invoicesInbox, setInvoicesInbox,
    invoicesInboxLoading,
    invoicesPlacing, setInvoicesPlacing, invoicesPlacingRef,
    invoicesJobs, setInvoicesJobs,
    invoicesJobsLoading,
    invoicesShowAll, setInvoicesShowAll,
    invoicesSavingCell, setInvoicesSavingCell,
    loadInvoicesInbox, loadInvoicesJobs
  } = useInvoices(assignedAppIds);

  const prevInitialClientRef = React.useRef(null);
  // Auto-select managedClient when in manage mode, or initialClient when passed, or clear when cancelled
  useEffect(() => {
    if (managedClient) {
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()) || managedClient;
      setInvoicesClient(clientObj);
      loadInvoicesInbox(clientObj);
      loadInvoicesJobs(clientObj, false);
      setInvoicesShowAll(false);
    } else if (initialClient && initialClient !== prevInitialClientRef.current) {
      prevInitialClientRef.current = initialClient;
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === initialClient.clientName?.toLowerCase()) || initialClient;
      setInvoicesClient(clientObj);
      loadInvoicesInbox(clientObj);
      loadInvoicesJobs(clientObj, false);
      setInvoicesShowAll(false);
    } else if (!managedClient && !initialClient) {
      setInvoicesClient(null);
      setInvoicesInbox([]);
      setInvoicesJobs(null);
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const [viewMode, setViewMode] = useState("modern");
  const [invoicesSubTab, setInvoicesSubTab] = useState("byJob"); // "byJob" | "byInvoiceNo"
  const [jobsSearchTerm, setJobsSearchTerm] = useState("");
  const [invoiceSearchTerm, setInvoiceSearchTerm] = useState("");
  const [invoiceSortOrder, setInvoiceSortOrder] = useState("inv_desc");
  const [expandedRetainerKeys, setExpandedRetainerKeys] = useState(() => new Set());
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [invoicesNewJob, setInvoicesNewJob] = useState(null);
  const [clientMismatchPrompt, setClientMismatchPrompt] = useState(null);
  const [updateJobNameChecked, setUpdateJobNameChecked] = useState(false);
  const [newJobNameInput, setNewJobNameInput] = useState("");

  const toggleRetainerExpand = (key) => {
    setExpandedRetainerKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredInvoicesJobs = React.useMemo(() => {
    const list = invoicesJobs || [];
    if (!jobsSearchTerm.trim()) return list;
    const q = jobsSearchTerm.toLowerCase().trim();
    return list.filter(j => {
      const matchClient = (j.client || "").toLowerCase().includes(q);
      const matchJob = (j.jobName || "").toLowerCase().includes(q);
      const matchCode = (j.projectCode || "").toLowerCase().includes(q);
      const matchSlots = (j.rows || []).some(r =>
        (r.invoiceSlots || []).some(s => (s.ref || "").toLowerCase().includes(q))
      );
      return matchClient || matchJob || matchCode || matchSlots;
    });
  }, [invoicesJobs, jobsSearchTerm]);

  const allInvoices = React.useMemo(() => {
    if (!invoicesJobs || !Array.isArray(invoicesJobs)) return [];
    const list = [];
    invoicesJobs.forEach(job => {
      (job.rows || []).forEach(r => {
        (r.invoiceSlots || []).forEach(slot => {
          const hasRef = !!(slot.ref && String(slot.ref).trim() !== "");
          const hasAmt = !!(slot.amount && parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) > 0);
          if (hasRef || hasAmt) {
            const sentDateStr = slot.sentDate || "";
            const expectedPaymentDate = calculateExpectedPaymentDate(sentDateStr, slot.daysToPay);
            const sentDateObj = parseDateString(sentDateStr);
            const expectedPayDateObj = parseDateString(expectedPaymentDate);

            list.push({
              id: `${r.rowNum}-${slot.slotNum}-${slot.ref || ""}`,
              rowNum: r.rowNum,
              slotNum: slot.slotNum,
              client: r.client || job.client || "",
              jobName: r.jobName || job.jobName || "",
              projectCode: r.projectCode || job.projectCode || "",
              invoiceNo: String(slot.ref || "").trim(),
              amount: slot.amount || 0,
              description: slot.description || "",
              sentDate: sentDateStr,
              sentDateObj,
              daysToPay: slot.daysToPay,
              expectedPaymentDate,
              expectedPayDateObj,
              status: slot.status || "",
              slot,
            });
          }
        });
      });
    });
    return list;
  }, [invoicesJobs]);

  const filteredAndSortedInvoices = React.useMemo(() => {
    let list = allInvoices;
    if (invoiceSearchTerm.trim()) {
      const q = invoiceSearchTerm.toLowerCase().trim();
      list = list.filter(inv =>
        (inv.invoiceNo || "").toLowerCase().includes(q) ||
        (inv.client || "").toLowerCase().includes(q) ||
        (inv.jobName || "").toLowerCase().includes(q) ||
        (inv.projectCode || "").toLowerCase().includes(q) ||
        (inv.description || "").toLowerCase().includes(q) ||
        (inv.status || "").toLowerCase().includes(q) ||
        (inv.sentDate || "").toLowerCase().includes(q) ||
        (inv.expectedPaymentDate || "").toLowerCase().includes(q) ||
        String(inv.amount || "").toLowerCase().includes(q)
      );
    }

    return [...list].sort((a, b) => {
      switch (invoiceSortOrder) {
        case "inv_desc":
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        case "inv_asc":
          return String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        case "client_name": {
          const cComp = String(a.client || "").localeCompare(String(b.client || ""), undefined, { sensitivity: "base" });
          if (cComp !== 0) return cComp;
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        case "sent_desc": {
          const ta = a.sentDateObj ? a.sentDateObj.getTime() : -Infinity;
          const tb = b.sentDateObj ? b.sentDateObj.getTime() : -Infinity;
          if (ta !== tb) return tb - ta;
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        case "sent_asc": {
          const ta = a.sentDateObj ? a.sentDateObj.getTime() : Infinity;
          const tb = b.sentDateObj ? b.sentDateObj.getTime() : Infinity;
          if (ta !== tb) return ta - tb;
          return String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        case "pay_desc": {
          const ta = a.expectedPayDateObj ? a.expectedPayDateObj.getTime() : -Infinity;
          const tb = b.expectedPayDateObj ? b.expectedPayDateObj.getTime() : -Infinity;
          if (ta !== tb) return tb - ta;
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        case "pay_asc": {
          const ta = a.expectedPayDateObj ? a.expectedPayDateObj.getTime() : Infinity;
          const tb = b.expectedPayDateObj ? b.expectedPayDateObj.getTime() : Infinity;
          if (ta !== tb) return ta - tb;
          return String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        case "status": {
          const sComp = String(a.status || "").localeCompare(String(b.status || ""), undefined, { sensitivity: "base" });
          if (sComp !== 0) return sComp;
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
        }
        default:
          return String(b.invoiceNo || "").localeCompare(String(a.invoiceNo || ""), undefined, { numeric: true, sensitivity: "base" });
      }
    });
  }, [allInvoices, invoiceSearchTerm, invoiceSortOrder]);

  const executePlacement = async (promptData, shouldUpdateClientName, shouldUpdateJobName = false, customJobName = "") => {
    const { job, inv, isNewRow, rowNum, slotNum, jobLastRow, savingKey } = promptData;
    setClientMismatchPrompt(null);
    setInvoicesPlacing(null);
    setInvoicesSavingCell(savingKey);

    if (addAssignedAppId) {
      addAssignedAppId(inv.invoiceNo, invoicesClient?.clientName);
      if (inv.reference && inv.reference !== inv.invoiceNo) {
        addAssignedAppId(inv.reference, invoicesClient?.clientName);
      }
    } else {
      setAssignedAppIds(prevSet => {
        const next = new Set(prevSet); next.add(inv.invoiceNo);
        try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch { }
        return next;
      });
    }
    setInvoicesInbox(prev => prev.filter(e => e.invoiceNo !== inv.invoiceNo));

    setClientsWithFlags(prev => prev.map(c => {
      if (c.clientName !== invoicesClient?.clientName) return c;
      const updatedCounts = { ...c.alertCounts };
      if (updatedCounts["invoiceDashboardDiscr"] > 0) updatedCounts["invoiceDashboardDiscr"]--;
      return { ...c, alertCounts: updatedCounts };
    }));

    const jobRowNums = job?.rows ? job.rows.map(r => r.rowNum) : (rowNum ? [rowNum] : []);
    const effectiveClientName = shouldUpdateClientName ? String(inv.client || "").trim() : job.client;
    const effectiveJobName = shouldUpdateJobName && customJobName ? String(customJobName).trim() : job.jobName;

    try {
      if (isNewRow) {
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "assign_invoice_to_job",
            clientSheetId: invoicesClient?.clientSheetId,
            clientName: invoicesClient?.clientName || invoicesClient?.name || "",
            masterSheetId: invoicesClient?.masterSheetId || "",
            createNewRow: true,
            jobLastRow,
            jobClient: effectiveClientName,
            jobName: job.jobName,
            invoice: inv,
            updateClientName: shouldUpdateClientName,
            newClientName: shouldUpdateClientName ? effectiveClientName : undefined,
            updateJobName: shouldUpdateJobName && !!customJobName,
            newJobName: effectiveJobName,
            jobRowNums,
          }),
        });
        const data = await res.json();
        if (!data.success) {
          alert(data.error || "Failed to add new row for invoice");
          await loadInvoicesJobs(invoicesClient, invoicesShowAll);
          return;
        }
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        await loadInvoicesJobs(invoicesClient, invoicesShowAll);
      } else {
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "assign_invoice_to_job",
            clientSheetId: invoicesClient?.clientSheetId,
            clientName: invoicesClient?.clientName || invoicesClient?.name || "",
            rowNum, slotNum, invoice: inv,
            jobClient: effectiveClientName,
            jobName: job.jobName,
            updateClientName: shouldUpdateClientName,
            newClientName: shouldUpdateClientName ? effectiveClientName : undefined,
            updateJobName: shouldUpdateJobName && !!customJobName,
            newJobName: effectiveJobName,
            jobRowNums,
          }),
        });
        const data = await res.json();
        if (!data.success) {
          alert(data.error || "Failed to place invoice");
          await loadInvoicesJobs(invoicesClient, invoicesShowAll);
          return;
        }
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        if (data.rowShifted || (shouldUpdateJobName && effectiveJobName !== job.jobName)) {
          // If rows shifted on the sheet or job name changed, reload the live jobs list
          await loadInvoicesJobs(invoicesClient, invoicesShowAll);
        } else {
          setInvoicesJobs(prev => prev && prev.map(j => {
            if (j.jobName !== job.jobName || j.client !== job.client) return j;
            const updatedClient = shouldUpdateClientName ? effectiveClientName : j.client;
            const updatedJob = shouldUpdateJobName && effectiveJobName ? effectiveJobName : j.jobName;
            return {
              ...j,
              client: updatedClient,
              jobName: updatedJob,
              rows: j.rows.map(r => {
                const baseR = {
                  ...r,
                  client: shouldUpdateClientName ? updatedClient : r.client,
                  jobName: shouldUpdateJobName && effectiveJobName ? updatedJob : r.jobName,
                };
                if (r.rowNum !== rowNum) return baseR;
                return {
                  ...baseR,
                  invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== slotNum ? sl : {
                    ...sl,
                    amount: inv.amount || 0,
                    ref: inv.invoiceNo || "",
                    sentDate: inv.sentDate || "",
                    status: inv.status || "Sent",
                  }),
                };
              }),
            };
          }));
        }
      }
    } catch (e) {
      console.error("assign_invoice_to_job error:", e);
    } finally {
      setInvoicesSavingCell(null);
    }
  };

  const noInvClient = !invoicesClient;

  return (
    <>
      {clientMismatchPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setClientMismatchPrompt(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e3a8a", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>🏢 Client Name Difference</span>
              </h3>
              <button onClick={() => setClientMismatchPrompt(null)} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
            </div>
            <p style={{ fontSize: "13px", color: "#555", lineHeight: "1.5", marginTop: 0, marginBottom: "14px" }}>
              The client name on the invoice differs from the client name on the sheet for <strong>{clientMismatchPrompt.job.jobName}</strong>:
            </p>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "12px", marginBottom: "14px", fontSize: "13px" }}>
              <div style={{ marginBottom: "6px" }}>
                <span style={{ color: "#64748b", fontWeight: "600", display: "inline-block", width: "70px" }}>Sheet:</span>
                <strong style={{ color: "#334155" }}>{clientMismatchPrompt.sheetClientName}</strong>
              </div>
              <div>
                <span style={{ color: "#64748b", fontWeight: "600", display: "inline-block", width: "70px" }}>Invoice:</span>
                <strong style={{ color: "#2563eb" }}>{clientMismatchPrompt.invoiceClientName}</strong>
              </div>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "14px" }}>
              {isAdmin
                ? "Updating will change the client name across all rows for this job in the Confirmed sheet."
                : "Updating will change the client name for this job in the Confirmed sheet."}
            </div>

            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "12px", marginBottom: "16px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: "600", color: "#1e293b", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={updateJobNameChecked}
                  onChange={e => setUpdateJobNameChecked(e.target.checked)}
                  style={{ accentColor: "#2563eb", cursor: "pointer" }}
                />
                Also update job name
              </label>
              {updateJobNameChecked && (
                <div style={{ marginTop: "8px" }}>
                  <div style={{ fontSize: "11px", color: "#64748b", marginBottom: "4px" }}>
                    Current sheet name: <strong>{clientMismatchPrompt.job.jobName}</strong>
                    {clientMismatchPrompt.inv.job && clientMismatchPrompt.inv.job !== clientMismatchPrompt.job.jobName && (
                      <span> · Invoice suggests: <strong>{clientMismatchPrompt.inv.job}</strong></span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={newJobNameInput}
                    onChange={e => setNewJobNameInput(e.target.value)}
                    placeholder="Enter new job name"
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "13px",
                      boxSizing: "border-box",
                      backgroundColor: "#ffffff"
                    }}
                  />
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <button className="triage-btn"
                onClick={() => executePlacement(clientMismatchPrompt, true, updateJobNameChecked, newJobNameInput)}
                style={{ background: "#2563eb", color: "white", border: "none", padding: "10px 14px", borderRadius: "6px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
              >
                ✓ Update sheet to &ldquo;{clientMismatchPrompt.invoiceClientName}&rdquo;
              </button>
              <button className="triage-btn"
                onClick={() => executePlacement(clientMismatchPrompt, false, updateJobNameChecked, newJobNameInput)}
                style={{ ...styles.buttonSecondary, padding: "10px 14px", fontSize: "13px", textAlign: "center" }}
              >
                Keep existing name &ldquo;{clientMismatchPrompt.sheetClientName}&rdquo;
              </button>
              <button className="triage-btn"
                onClick={() => setClientMismatchPrompt(null)}
                style={{ padding: "8px 14px", fontSize: "12px", color: "#64748b", background: "none", border: "none", cursor: "pointer", textAlign: "center" }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {invoicesEditSlot && (
        <InvoicesEditModal
          editSlot={invoicesEditSlot}
          invoicesClient={invoicesClient}
          isAdmin={isAdmin}
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onUpdateInvoiceJobs={(rNum, sNum, newData) => {
            setInvoicesJobs(prev => prev && prev.map(j => ({
              ...j,
              rows: j.rows.map(r => r.rowNum !== rNum ? r : {
                ...r,
                invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== sNum ? sl : { ...sl, ...newData })
              }),
            })));
          }}
        />
      )}
      {invoicesNewJob && (
        <InvoicesNewJobModal
          newJobData={invoicesNewJob}
          invoicesClient={invoicesClient}
          onClose={() => setInvoicesNewJob(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onSuccess={async (inv) => {
            if (addAssignedAppId) {
              addAssignedAppId(inv.invoiceNo, invoicesClient?.clientName);
              if (inv.reference && inv.reference !== inv.invoiceNo) {
                addAssignedAppId(inv.reference, invoicesClient?.clientName);
              }
            } else {
              setAssignedAppIds(prevSet => {
                const next = new Set(prevSet); next.add(inv.invoiceNo);
                try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch { }
                return next;
              });
            }
            setInvoicesInbox(prev => prev.filter(e => e.invoiceNo !== inv.invoiceNo));
            setClientsWithFlags(prev => prev.map(c => {
              if (c.clientName !== invoicesClient?.clientName) return c;
              const updatedCounts = { ...c.alertCounts };
              if (updatedCounts["invoiceDashboardDiscr"] > 0) updatedCounts["invoiceDashboardDiscr"]--;
              return { ...c, alertCounts: updatedCounts };
            }));
            await loadInvoicesJobs(invoicesClient, invoicesShowAll);
          }}
        />
      )}

      <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
            marginBottom: "20px",
            background: "#ffffff",
            padding: "16px 20px",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {invoicesClient && (
              <button
                type="button"
                onClick={() => {
                  if (managedClient && onClearManagedClient) {
                    onClearManagedClient();
                  } else {
                    setInvoicesClient(null);
                    setInvoicesInbox([]);
                    setInvoicesJobs(null);
                  }
                }}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: "pointer",
                  padding: "6px 12px",
                  fontSize: "16px",
                  color: "#475569",
                  lineHeight: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f1f5f9";
                  e.currentTarget.style.borderColor = "#94a3b8";
                  e.currentTarget.style.color = "#0f172a";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#ffffff";
                  e.currentTarget.style.borderColor = "#cbd5e1";
                  e.currentTarget.style.color = "#475569";
                }}
                title="Back to client list"
              >
                ←
              </button>
            )}
            <div>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>Invoices</span>
              </h1>
              {invoicesClient ? (
                <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {invoicesClient.clientName}
                </div>
              ) : (
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                  Select a client to view and edit invoices
                </p>
              )}
            </div>
          </div>

          {invoicesClient && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setViewMode(prev => prev === "modern" ? "legacy" : "modern")}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: viewMode === "legacy" ? "#0f172a" : "#ffffff",
                    color: viewMode === "legacy" ? "#ffffff" : "#334155",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                  title={viewMode === "modern" ? "Switch to traditional spreadsheet view" : "Switch to improved modern view"}
                >
                  <span>{viewMode === "modern" ? "📋 Legacy view" : "✨ Modern view"}</span>
                </button>
              )}
              <button
                className="triage-btn"
                onClick={() => {
                  loadInvoicesInbox(invoicesClient);
                  loadInvoicesJobs(invoicesClient, invoicesShowAll);
                }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}
                title="Refresh jobs and invoices from live sheets"
              >
                ↻ Refresh
              </button>
            </div>
          )}
        </div>

        {noInvClient && (
          <EditClientSelector
            clients={allOutgoingsClients || []}
            onSelectClient={(c) => {
              setInvoicesClient(c);
              loadInvoicesInbox(c);
              loadInvoicesJobs(c, false);
              setInvoicesShowAll(false);
            }}
            loading={invoicesJobsLoading || invoicesInboxLoading}
            title="Select a client to view and edit invoices:"
            renderExtra={(c) => {
              const hasFlag = clientsWithFlags?.some(
                f => f.clientName === c.clientName && f.flags?.invoiceDashboardDiscr
              );
              if (!hasFlag) return null;
              return (
                <span style={{ fontSize: "11px", background: "#f59e0b", color: "#fff", borderRadius: "10px", padding: "1px 7px", fontWeight: "600" }}>
                  Invoices to assign
                </span>
              );
            }}
          />
        )}

        {!noInvClient && (
          <>
            {/* Subtabs: By job / By invoice no. */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", borderBottom: "1px solid #e0e0e0" }}>
              <button
                type="button"
                onClick={() => setInvoicesSubTab("byJob")}
                style={{
                  padding: "8px 16px",
                  background: "none",
                  border: "none",
                  borderBottom: invoicesSubTab === "byJob" ? "2px solid #0066cc" : "2px solid transparent",
                  color: invoicesSubTab === "byJob" ? "#0066cc" : "#666",
                  fontWeight: invoicesSubTab === "byJob" ? "700" : "500",
                  fontSize: "14px",
                  cursor: "pointer"
                }}
              >
                By job
              </button>
              <button
                type="button"
                onClick={() => {
                  setInvoicesSubTab("byInvoiceNo");
                  setInvoicesPlacing(null);
                  if (!invoicesShowAll && invoicesClient) {
                    setInvoicesShowAll(true);
                    loadInvoicesJobs(invoicesClient, true);
                  }
                }}
                style={{
                  padding: "8px 16px",
                  background: "none",
                  border: "none",
                  borderBottom: invoicesSubTab === "byInvoiceNo" ? "2px solid #0066cc" : "2px solid transparent",
                  color: invoicesSubTab === "byInvoiceNo" ? "#0066cc" : "#666",
                  fontWeight: invoicesSubTab === "byInvoiceNo" ? "700" : "500",
                  fontSize: "14px",
                  cursor: "pointer"
                }}
              >
                By invoice no.
              </button>
            </div>

            {invoicesSubTab === "byJob" && (
              <div style={{ background: "#fff", border: `1px solid ${invoicesInbox.length > 0 ? "#ffc107" : "#e0e0e0"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px" }}>
                <div style={{ fontSize: "13px", fontWeight: "700", color: invoicesInbox.length > 0 ? "#e65100" : "#888", marginBottom: invoicesInbox.length > 0 ? "6px" : "0" }}>
                  {invoicesInboxLoading ? "Loading..." : invoicesInbox.length > 0
                    ? `Unmatched invoices (${invoicesInbox.length}) - click to select, then click a slot to place`
                    : "No unmatched invoices"}
                </div>
                {invoicesInbox.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {invoicesInbox.map(inv => {
                      const isPlacing = invoicesPlacing?.invoiceNo === inv.invoiceNo;
                      return (
                        <div key={inv.invoiceNo}
                          style={{
                            padding: "8px 12px", borderRadius: "8px",
                            background: isPlacing ? "#1a56db" : "#fff8e1",
                            color: isPlacing ? "#fff" : "#333",
                            border: `1px solid ${isPlacing ? "#1a56db" : "#ffe082"}`,
                            fontSize: "12px", minWidth: "160px"
                          }}>
                          <div onClick={() => setInvoicesPlacing(isPlacing ? null : inv)} style={{ cursor: "pointer" }}>
                            <div style={{ fontWeight: "700" }}>#{inv.invoiceNo} - £{inv.amount.toFixed(2)}</div>
                            <div style={{ opacity: 0.85 }}>{inv.client}{inv.job ? ` - ${inv.job}` : ""}</div>
                            <div style={{ opacity: 0.7 }}>{inv.sentDate}{inv.status ? ` · ${inv.status}` : ""}</div>
                          </div>
                          <button onClick={e => { e.stopPropagation(); setInvoicesNewJob({ inv }); }}
                            title="Create new job for this invoice"
                            style={{
                              marginTop: "6px", fontSize: "10px", padding: "2px 8px",
                              background: isPlacing ? "rgba(255,255,255,0.2)" : "#f0f0f0",
                              border: `1px solid ${isPlacing ? "rgba(255,255,255,0.4)" : "#ccc"}`,
                              borderRadius: "4px", cursor: "pointer",
                              color: isPlacing ? "#fff" : "#555", whiteSpace: "nowrap"
                            }}>
                            + New job
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {invoicesJobsLoading && (
              <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
            )}
            {!invoicesJobsLoading && invoicesJobs && (
              <>
                {invoicesSubTab === "byJob" && (
                  <>
                    {/* Description Banner & Toggle */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "10px",
                        padding: "10px 16px",
                        background: invoicesShowAll ? "#f8fafc" : "#eff6ff",
                        border: `1px solid ${invoicesShowAll ? "#e2e8f0" : "#bfdbfe"}`,
                        borderRadius: "8px",
                        marginBottom: "12px"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: invoicesShowAll ? "#334155" : "#1e40af" }}>
                        <span style={{ fontSize: "15px" }}>ℹ️</span>
                        <span>
                          {invoicesShowAll ? (
                            <>Showing <strong>all confirmed jobs</strong> ({invoicesJobs.length} jobs). Jobs that have already been fully invoiced are visible.</>
                          ) : (
                            <>By default showing jobs with <strong>revenue left to invoice</strong> ({invoicesJobs.length} jobs). Fully invoiced jobs are hidden.</>
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !invoicesShowAll;
                          setInvoicesShowAll(next);
                          loadInvoicesJobs(invoicesClient, next);
                        }}
                        disabled={invoicesJobsLoading}
                        style={{
                          padding: "5px 12px",
                          background: "#ffffff",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          color: "#1e293b",
                          cursor: "pointer",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                          transition: "all 0.15s ease"
                        }}
                      >
                        {invoicesShowAll ? "Show only uninvoiced jobs" : "Show all jobs"}
                      </button>
                    </div>

                    {/* Search Bar for Jobs */}
                    <div style={{ marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                      <div style={{ position: "relative", width: "100%", maxWidth: "340px" }}>
                        <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: "14px", pointerEvents: "none" }}>🔍</span>
                        <input
                          type="text"
                          placeholder="Search jobs..."
                          value={jobsSearchTerm}
                          onChange={e => setJobsSearchTerm(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "7px 10px 7px 32px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            fontSize: "13px",
                            outline: "none",
                            boxSizing: "border-box",
                            backgroundColor: "#ffffff",
                          }}
                        />
                        {jobsSearchTerm && (
                          <button
                            type="button"
                            onClick={() => setJobsSearchTerm("")}
                            style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "14px" }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>

                    {/* ========================================================================= */}
                    {/* MODERN VIEW                                                               */}
                    {/* ========================================================================= */}
                    {viewMode === "modern" && (
                      <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1200px" }}>
                          <thead>
                            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                              <th style={{ padding: "10px 10px", width: "36px", textAlign: "center" }}></th>
                              <th style={{ padding: "10px 12px", width: "160px", textAlign: "left" }}>Client</th>
                              <th style={{ padding: "10px 12px", width: "200px", textAlign: "left" }}>Job Name</th>
                              <th style={{ padding: "10px 10px", width: "80px", textAlign: "left" }}>Code</th>
                              <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Type</th>
                              <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Revenue</th>
                              <th style={{ padding: "10px 10px", width: "100px", textAlign: "left" }}>Direct Costs</th>
                              <th style={{ padding: "10px 10px", width: "150px", textAlign: "left" }}>Dates</th>
                              <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 1</th>
                              <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 2</th>
                              <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 3</th>
                              <th style={{ padding: "10px 8px", width: "40px", textAlign: "center" }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInvoicesJobs.length === 0 ? (
                              <tr>
                                <td colSpan={12} style={{ padding: "36px", textAlign: "center", color: "#64748b" }}>
                                  No matching jobs found.
                                </td>
                              </tr>
                            ) : (
                              filteredInvoicesJobs.map((job) => {
                                const jobKey = `${job.client}|||${job.jobName}`;
                                const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
                                const hasMultipleRows = job.rows && job.rows.length > 1;
                                const isRetainerExpanded = expandedRetainerKeys.has(jobKey);
                                const isPlacing = !!invoicesPlacing;

                                let visibleRows;
                                if (isRetainer) {
                                  visibleRows = (isRetainer && !isRetainerExpanded) ? [job.rows[0]] : job.rows;
                                } else {
                                  // Project job: only show multiple rows if invoices go over multiple rows
                                  const lastRowWithInvoiceIdx = job.rows.reduce((maxIdx, r, idx) => rowHasInvoice(r) ? idx : maxIdx, 0);
                                  let neededIdx = lastRowWithInvoiceIdx;
                                  if (isPlacing) {
                                    const firstRowWithSpaceIdx = job.rows.findIndex(r => r.invoiceSlots.some(s => (!s.ref || String(s.ref).trim() === "") && !s.amount));
                                    if (firstRowWithSpaceIdx > neededIdx) {
                                      neededIdx = firstRowWithSpaceIdx;
                                    }
                                  }
                                  visibleRows = job.rows.slice(0, neededIdx + 1);
                                }

                                const jobTotalInvoiced = job.rows.reduce((sum, r) => sum + r.invoiceSlots.reduce((s, slot) => {
                                  const isReal = slot.ref && !isPlaceholderInvoice(slot.ref, slot.status);
                                  return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) || 0) : 0);
                                }, 0), 0);
                                const jobRevenue = parseFloat(String(job.rows[0]?.revenue || "").replace(/[£$€,\s]/g, "")) || 0;
                                const uninvoiced = jobRevenue - jobTotalInvoiced;
                                const jobHasEmptySlot = visibleRows.some(jr => jr.invoiceSlots.some(s => (!s.ref || String(s.ref).trim() === "") && !s.amount));
                                const jobLastRow = job.rows[job.rows.length - 1]?.rowNum;

                                return visibleRows.map((jr, rIdx) => {
                                  const isLastRowOfJob = rIdx === visibleRows.length - 1;
                                  const isChildRow = rIdx > 0;

                                  return (
                                    <tr
                                      key={jr.rowNum}
                                      style={{
                                        borderBottom: (isLastRowOfJob) ? "1px solid #e2e8f0" : "1px solid #f1f5f9",
                                        backgroundColor: isChildRow ? "#f8fafc" : "#ffffff",
                                        transition: "background-color 0.1s ease"
                                      }}
                                    >
                                      {/* Expand/Collapse Chevron (for Retainers) */}
                                      <td style={{ padding: "8px 6px", textAlign: "center", verticalAlign: "top" }}>
                                        {rIdx === 0 && isRetainer && hasMultipleRows && (
                                          <button
                                            type="button"
                                            onClick={() => toggleRetainerExpand(jobKey)}
                                            style={{
                                              background: "none",
                                              border: "none",
                                              color: "#64748b",
                                              cursor: "pointer",
                                              padding: "2px 4px",
                                              fontSize: "11px",
                                              lineHeight: 1
                                            }}
                                            title={isRetainerExpanded ? "Collapse retainer months" : `Expand all ${job.rows.length} retainer months`}
                                          >
                                            {isRetainerExpanded ? "▼" : "▶"}
                                          </button>
                                        )}
                                      </td>

                                      {/* Client */}
                                      <td style={{ padding: "8px 12px", verticalAlign: "top", fontWeight: "600", color: "#0f172a" }}>
                                        {rIdx === 0 ? jr.client : ""}
                                      </td>

                                      {/* Job Name */}
                                      <td style={{ padding: "8px 12px", verticalAlign: "top" }}>
                                        {rIdx === 0 ? (
                                          <div style={{ fontWeight: "600", color: "#1e293b" }}>{jr.jobName}</div>
                                        ) : (
                                          <div style={{ fontSize: "11px", color: "#64748b", paddingLeft: "8px" }}>
                                            {isRetainer ? `↳ Month ${rIdx + 1}` : (isAdmin ? `↳ Row ${rIdx + 1}` : `↳ Part ${rIdx + 1}`)}
                                          </div>
                                        )}
                                      </td>

                                      {/* Project Code */}
                                      <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#64748b", fontSize: "11px" }}>
                                        {rIdx === 0 ? (jr.projectCode || "-") : ""}
                                      </td>

                                      {/* Type */}
                                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                        {rIdx === 0 ? (
                                          isRetainer ? (
                                            <button
                                              type="button"
                                              onClick={() => hasMultipleRows && toggleRetainerExpand(jobKey)}
                                              style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "4px",
                                                padding: "2px 8px",
                                                borderRadius: "12px",
                                                background: "#f0fdf4",
                                                color: "#166534",
                                                border: "1px solid #bbf7d0",
                                                fontSize: "11px",
                                                fontWeight: "600",
                                                cursor: hasMultipleRows ? "pointer" : "default"
                                              }}
                                              title={hasMultipleRows ? (isRetainerExpanded ? "Collapse" : "Expand all months") : undefined}
                                            >
                                              <span>Retainer</span>
                                              {hasMultipleRows && (
                                                <span style={{ fontSize: "10px", color: "#15803d" }}>
                                                  {isRetainerExpanded ? "▲" : `(${job.rows.length}m)`}
                                                </span>
                                              )}
                                            </button>
                                          ) : (
                                            <span
                                              style={{
                                                display: "inline-block",
                                                padding: "2px 8px",
                                                borderRadius: "12px",
                                                background: "#eff6ff",
                                                color: "#1d4ed8",
                                                border: "1px solid #bfdbfe",
                                                fontSize: "11px",
                                                fontWeight: "600"
                                              }}
                                            >
                                              Project
                                            </span>
                                          )
                                        ) : (
                                          <span style={{ fontSize: "10px", color: "#94a3b8" }}>
                                            {isRetainer ? `mo. ${rIdx + 1}` : (isAdmin ? `row ${rIdx + 1}` : `part ${rIdx + 1}`)}
                                          </span>
                                        )}
                                      </td>

                                      {/* Revenue */}
                                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                        {rIdx === 0 ? (
                                          <div>
                                            <div style={{ fontWeight: "600", color: "#0f172a" }}>{formatCurrency(jr.revenue) || jr.revenue}</div>
                                            {uninvoiced > 0 && (
                                              <div style={{ display: "inline-block", marginTop: "3px", padding: "1px 6px", borderRadius: "4px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", fontSize: "10px", fontWeight: "600" }}>
                                                £{uninvoiced.toLocaleString("en-GB", { minimumFractionDigits: 2 })} left
                                              </div>
                                            )}
                                          </div>
                                        ) : (
                                          <div style={{ color: "#94a3b8", fontSize: "11px" }}>-</div>
                                        )}
                                      </td>

                                      {/* Direct Costs */}
                                      <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#475569" }}>
                                        {rIdx === 0 ? (formatCurrency(jr.directCosts) || jr.directCosts || "-") : ""}
                                      </td>

                                      {/* Dates */}
                                      <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: "11px", color: "#475569", whiteSpace: "nowrap" }}>
                                        <div>{jr.startDate || "-"}</div>
                                        <div style={{ color: "#94a3b8" }}>{jr.endDate ? `to ${jr.endDate}` : ""}</div>
                                      </td>

                                      {/* Invoice Slots 1, 2, 3 */}
                                      {jr.invoiceSlots.map((s) => {
                                        const refUpper = String(s.ref || "").trim().toUpperCase();
                                        const statusUpper = String(s.status || "").trim().toUpperCase();
                                        const isPlaceholder = isPlaceholderInvoice(s.ref, s.status) ||
                                          refUpper.startsWith("PLACE") ||
                                          refUpper.includes("PLACEHOLDER") ||
                                          refUpper.startsWith("MANUAL") ||
                                          statusUpper.includes("PLACEHOLDER") ||
                                          (!s.ref && !!s.amount);
                                        const isGenuinelyBlank = (!s.ref || String(s.ref).trim() === "") && !s.amount;
                                        const isEmpty = isGenuinelyBlank || isPlaceholder;
                                        const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                                        const isSaving = invoicesSavingCell === cellSavingKey;

                                        return (
                                          <td
                                            key={s.slotNum}
                                            onClick={async () => {
                                              if (isSaving) return;
                                              if (isPlacing && isEmpty) {
                                                const inv = invoicesPlacingRef.current;
                                                if (!inv) return;
                                                const sheetClient = String(job.client || "").trim();
                                                const invClient = String(inv.client || "").trim();
                                                const hasMismatch = !!(sheetClient && invClient && sheetClient.toLowerCase() !== invClient.toLowerCase());
                                                const promptPayload = {
                                                  job, inv, isNewRow: false, rowNum: jr.rowNum, slotNum: s.slotNum,
                                                  sheetClientName: sheetClient, invoiceClientName: invClient,
                                                  savingKey: cellSavingKey,
                                                };
                                                if (hasMismatch) {
                                                  setUpdateJobNameChecked(!!(inv.job && inv.job.trim().toLowerCase() !== (job.jobName || "").trim().toLowerCase()));
                                                  setNewJobNameInput(inv.job || job.jobName || "");
                                                  setClientMismatchPrompt(promptPayload);
                                                } else {
                                                  executePlacement(promptPayload, false);
                                                }
                                              } else if (!isPlacing && !isGenuinelyBlank) {
                                                setInvoicesEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s, jobClient: job.client, jobName: job.jobName });
                                              }
                                            }}
                                            style={{
                                              padding: "6px 8px",
                                              verticalAlign: "top",
                                              cursor: isSaving ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default"
                                            }}
                                          >
                                            <div
                                              style={{
                                                borderRadius: "6px",
                                                padding: "6px 8px",
                                                minHeight: "44px",
                                                display: "flex",
                                                flexDirection: "column",
                                                justifyContent: "center",
                                                transition: "all 0.15s ease",
                                                background: isSaving
                                                  ? "#f8fafc"
                                                  : (isPlacing && isEmpty)
                                                    ? "#eff6ff"
                                                    : isGenuinelyBlank
                                                      ? "transparent"
                                                      : "#ffffff",
                                                border: (isPlacing && isEmpty && !isSaving)
                                                  ? "1.5px dashed #2563eb"
                                                  : isGenuinelyBlank
                                                    ? "1px dashed #e2e8f0"
                                                    : "1px solid #e2e8f0",
                                                boxShadow: (!isGenuinelyBlank && !isSaving) ? "0 1px 2px rgba(0,0,0,0.03)" : "none"
                                              }}
                                            >
                                              {isSaving ? (
                                                <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#64748b", fontSize: "11px" }}>
                                                  <Spinner size={12} color="#2563eb" /> Saving...
                                                </div>
                                              ) : isGenuinelyBlank ? (
                                                isPlacing ? (
                                                  <div style={{ color: "#1d4ed8", fontWeight: "700", textAlign: "center", fontSize: "11px" }}>
                                                    + Place invoice
                                                  </div>
                                                ) : (
                                                  <div style={{ color: "#cbd5e1", textAlign: "center", fontSize: "12px" }}>—</div>
                                                )
                                              ) : (
                                                <div>
                                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "4px" }}>
                                                    <span
                                                      title={!isAdmin && isPlaceholder ? "Placeholder" : (s.ref || "")}
                                                      style={{
                                                        fontWeight: "700",
                                                        fontSize: "12px",
                                                        color: isPlaceholder ? "#9333ea" : "#0f172a",
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                        maxWidth: "115px"
                                                      }}
                                                    >
                                                      {isPlaceholder
                                                        ? (isAdmin && s.ref ? `⚠️ ${s.ref.startsWith("#") ? s.ref : `#${s.ref}`}` : "⚠️ Placeholder")
                                                        : (s.ref ? (s.ref.startsWith("#") ? s.ref : `#${s.ref}`) : "")}
                                                    </span>
                                                    <span style={{ fontWeight: "600", fontSize: "11px", color: "#0f172a" }}>
                                                      {formatCurrency(s.amount) || `£${s.amount}`}
                                                    </span>
                                                  </div>
                                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "4px", gap: "4px" }}>
                                                    <span style={{ color: "#64748b", fontSize: "10px" }}>{s.sentDate || "-"}</span>
                                                    {s.status && (
                                                      <span style={{ ...getStatusPill(s.status), padding: "1px 5px", borderRadius: "4px", fontSize: "9px", fontWeight: "600" }}>
                                                        {s.status}
                                                      </span>
                                                    )}
                                                  </div>
                                                  {isPlaceholder && isPlacing && (
                                                    <div style={{ color: "#2563eb", fontWeight: "700", fontSize: "10px", marginTop: "3px" }}>
                                                      Click to overwrite
                                                    </div>
                                                  )}
                                                  {!isPlacing && (
                                                    <div style={{ color: "#2563eb", fontSize: "10px", marginTop: "2px" }}>
                                                      Edit
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          </td>
                                        );
                                      })}

                                      {/* Add Row Action Column */}
                                      <td style={{ padding: "6px 4px", verticalAlign: "middle", textAlign: "center" }}>
                                        {invoicesSavingCell === `newrow-${job.client}|||${job.jobName}` ? (
                                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            <Spinner size={12} color="#2563eb" />
                                          </div>
                                        ) : isLastRowOfJob && !jobHasEmptySlot && isPlacing ? (
                                          <button
                                            type="button"
                                            title={isAdmin ? "No spare invoice slot - click to add a new row for this job" : "No spare invoice slot - click to add more space for this job"}
                                            onClick={async () => {
                                              const inv = invoicesPlacingRef.current;
                                              if (!inv) return;
                                              const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                              const sheetClient = String(job.client || "").trim();
                                              const invClient = String(inv.client || "").trim();
                                              const hasMismatch = !!(sheetClient && invClient && sheetClient.toLowerCase() !== invClient.toLowerCase());
                                              const promptPayload = {
                                                job, inv, isNewRow: true, jobLastRow,
                                                sheetClientName: sheetClient, invoiceClientName: invClient,
                                                savingKey,
                                              };
                                              if (hasMismatch) {
                                                setUpdateJobNameChecked(!!(inv.job && inv.job.trim().toLowerCase() !== (job.jobName || "").trim().toLowerCase()));
                                                setNewJobNameInput(inv.job || job.jobName || "");
                                                setClientMismatchPrompt(promptPayload);
                                              } else {
                                                executePlacement(promptPayload, false);
                                              }
                                            }}
                                            style={{
                                              cursor: "pointer",
                                              background: "#eff6ff",
                                              border: "1.5px solid #2563eb",
                                              borderRadius: "6px",
                                              width: "28px",
                                              height: "28px",
                                              display: "inline-flex",
                                              alignItems: "center",
                                              justifyContent: "center",
                                              color: "#1d4ed8",
                                              fontWeight: "700",
                                              fontSize: "16px"
                                            }}
                                          >
                                            +
                                          </button>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                });
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* ========================================================================= */}
                    {/* LEGACY VIEW (for Admins)                                                  */}
                    {/* ========================================================================= */}
                    {viewMode === "legacy" && (
                      <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1100px", tableLayout: "fixed" }}>
                          <colgroup>
                            <col style={{ width: "50px" }} />
                            <col style={{ width: "130px" }} />
                            <col style={{ width: "160px" }} />
                            <col style={{ width: "80px" }} />
                            <col style={{ width: "90px" }} />
                            <col style={{ width: "90px" }} />
                            <col style={{ width: "70px" }} />
                            <col style={{ width: "90px" }} />
                            <col style={{ width: "90px" }} />
                            <col style={{ width: "150px" }} />
                            <col style={{ width: "150px" }} />
                            <col style={{ width: "150px" }} />
                            <col style={{ width: "40px" }} />
                          </colgroup>
                          <thead>
                            <tr style={{ background: "#f5f6fa" }}>
                              {["Row", "Client", "Job name", "Code", "Revenue", "Direct costs", "Type", "Start", "End",
                                "InvSlot1", "InvSlot2", "InvSlot3", ""].map(h => (
                                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInvoicesJobs.length === 0 ? (
                              <tr>
                                <td colSpan={13} style={{ padding: "36px", textAlign: "center", color: "#64748b" }}>
                                  No matching jobs found.
                                </td>
                              </tr>
                            ) : (
                              filteredInvoicesJobs.flatMap((job, jobIdx) => {
                                const jobTotalInvoiced = job.rows.reduce((sum, r) => sum + r.invoiceSlots.reduce((s, slot) => {
                                  const isReal = slot.ref && !isPlaceholderInvoice(slot.ref);
                                  return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) || 0) : 0);
                                }, 0), 0);
                                const jobRevenue = parseFloat(String(job.rows[0].revenue).replace(/[£$€,\s]/g, "")) || 0;
                                const uninvoiced = jobRevenue - jobTotalInvoiced;
                                const jobHasEmptySlot = job.rows.some(jr => jr.invoiceSlots.some(s => (!s.ref || String(s.ref).trim() === "") && !s.amount));
                                const jobLastRow = job.rows[job.rows.length - 1].rowNum;

                                return job.rows.map((jr, rIdx) => {
                                  const isLastRowOfJob = rIdx === job.rows.length - 1;
                                  return (
                                    <tr key={jr.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#f1f5f9" }}>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.client : ""}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.jobName : ""}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.projectCode : ""}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                        {rIdx === 0 ? (
                                          <>
                                            <div>{jr.revenue}</div>
                                            {uninvoiced > 0 && <div style={{ fontSize: "11px", color: "#ef4444", marginTop: "4px" }}>£{uninvoiced.toLocaleString("en-GB", { minimumFractionDigits: 2 })} rem.</div>}
                                          </>
                                        ) : ""}
                                      </td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.directCosts : ""}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.projectRetainer}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                                      <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.endDate}</td>
                                      {jr.invoiceSlots.map(s => {
                                        const isManualEntry = isPlaceholderInvoice(s.ref);
                                        const isBlankRef = !s.ref || String(s.ref).trim() === "";
                                        const isGenuinelyBlank = isBlankRef && !s.amount;
                                        const isPlaceholder = isBlankRef && !!s.amount;
                                        const isEmpty = isBlankRef || isManualEntry;
                                        const isPlacing = !!invoicesPlacing;
                                        const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                                        const isSaving = invoicesSavingCell === cellSavingKey;
                                        return (
                                          <td key={s.slotNum}
                                            onClick={async () => {
                                              if (isSaving) return;
                                              if (isPlacing && isEmpty) {
                                                const inv = invoicesPlacingRef.current;
                                                if (!inv) return;
                                                const sheetClient = String(job.client || "").trim();
                                                const invClient = String(inv.client || "").trim();
                                                const hasMismatch = !!(sheetClient && invClient && sheetClient.toLowerCase() !== invClient.toLowerCase());
                                                const promptPayload = {
                                                  job, inv, isNewRow: false, rowNum: jr.rowNum, slotNum: s.slotNum,
                                                  sheetClientName: sheetClient, invoiceClientName: invClient,
                                                  savingKey: cellSavingKey,
                                                };
                                                if (hasMismatch) {
                                                  setUpdateJobNameChecked(!!(inv.job && inv.job.trim().toLowerCase() !== (job.jobName || "").trim().toLowerCase()));
                                                  setNewJobNameInput(inv.job || job.jobName || "");
                                                  setClientMismatchPrompt(promptPayload);
                                                } else {
                                                  executePlacement(promptPayload, false);
                                                }
                                              } else if (!isPlacing && !isGenuinelyBlank) {
                                                setInvoicesEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s, jobClient: job.client, jobName: job.jobName });
                                              }
                                            }}
                                            style={{
                                              padding: "7px 10px", borderBottom: "1px solid #eee",
                                              cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                              background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                              border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none"
                                            }}>
                                            {isSaving ? (
                                              <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#666" }}>
                                                <Spinner size={12} color="#1a56db" /> Saving...
                                              </div>
                                            ) : isGenuinelyBlank ? (
                                              isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>-</span>
                                            ) : (
                                              <div>
                                                <div style={{ fontWeight: "600", color: isManualEntry ? "#9333ea" : "inherit" }}>
                                                  {(isManualEntry || isPlaceholder) && "(placeholder) "}{s.ref}
                                                </div>
                                                <div style={{ color: "#888" }}>{/^[£$€]/.test(String(s.amount)) ? s.amount : `£${s.amount}`} · {s.sentDate}{s.status ? ` · ${s.status}` : ""}</div>
                                                {(isManualEntry || isPlaceholder) && isPlacing && (
                                                  <div style={{ color: "#1a56db", fontWeight: "700", marginTop: "2px" }}>Click to overwrite</div>
                                                )}
                                                {!isPlacing && (
                                                  <div style={{ color: "#1a56db", fontSize: "10px", marginTop: "2px" }}>Click to edit</div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        );
                                      })}
                                      <td style={{ padding: "0", borderBottom: "1px solid #eee", textAlign: "center" }}>
                                        {invoicesSavingCell === `newrow-${job.client}|||${job.jobName}` ? (
                                          <div style={{ height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            <Spinner size={12} color="#1a56db" />
                                          </div>
                                        ) : isLastRowOfJob && !jobHasEmptySlot && isPlacing && (
                                          <div
                                            title="No spare invoice slot - click to add a new row for this job"
                                            onClick={async () => {
                                              const inv = invoicesPlacingRef.current;
                                              if (!inv) return;
                                              const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                              const sheetClient = String(job.client || "").trim();
                                              const invClient = String(inv.client || "").trim();
                                              const hasMismatch = !!(sheetClient && invClient && sheetClient.toLowerCase() !== invClient.toLowerCase());
                                              const promptPayload = {
                                                job, inv, isNewRow: true, jobLastRow,
                                                sheetClientName: sheetClient, invoiceClientName: invClient,
                                                savingKey,
                                              };
                                              if (hasMismatch) {
                                                setUpdateJobNameChecked(!!(inv.job && inv.job.trim().toLowerCase() !== (job.jobName || "").trim().toLowerCase()));
                                                setNewJobNameInput(inv.job || job.jobName || "");
                                                setClientMismatchPrompt(promptPayload);
                                              } else {
                                                executePlacement(promptPayload, false);
                                              }
                                            }}
                                            style={{
                                              cursor: "pointer", background: "#e8f0fe", border: "1.5px solid #1a56db",
                                              height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center",
                                              color: "#1a56db", fontWeight: "700", fontSize: "16px"
                                            }}>
                                            +
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                });
                              }))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}

                {invoicesSubTab === "byInvoiceNo" && (
                  <div>
                    {/* Controls Bar: Search & Sort */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "14px" }}>
                      <div style={{ position: "relative", width: "100%", maxWidth: "340px" }}>
                        <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: "14px", pointerEvents: "none" }}>🔍</span>
                        <input
                          type="text"
                          placeholder="Search invoices..."
                          value={invoiceSearchTerm}
                          onChange={e => setInvoiceSearchTerm(e.target.value)}
                          style={{
                            width: "100%",
                            padding: "7px 10px 7px 32px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            fontSize: "13px",
                            outline: "none",
                            boxSizing: "border-box",
                            backgroundColor: "#ffffff",
                          }}
                        />
                        {invoiceSearchTerm && (
                          <button
                            type="button"
                            onClick={() => setInvoiceSearchTerm("")}
                            style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "14px" }}
                          >
                            ✕
                          </button>
                        )}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "13px", color: "#475569", fontWeight: "600" }}>Sort by:</span>
                        <select
                          value={invoiceSortOrder}
                          onChange={e => setInvoiceSortOrder(e.target.value)}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            background: "#ffffff",
                            fontSize: "13px",
                            color: "#1e293b",
                            fontWeight: "500",
                            cursor: "pointer",
                            outline: "none",
                          }}
                        >
                          {INVOICE_SORT_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <span style={{ fontSize: "12px", color: "#64748b", marginLeft: "4px" }}>
                          ({filteredAndSortedInvoices.length} {filteredAndSortedInvoices.length === 1 ? "invoice" : "invoices"})
                        </span>
                      </div>
                    </div>

                    {/* Invoices List Table */}
                    <div style={{ background: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
                        <thead>
                          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontSize: "12px", fontWeight: "600" }}>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Invoice No.</th>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Client Name</th>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Job Name</th>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Project Code</th>
                            <th style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>Amount</th>
                            <th style={{ padding: "10px 12px", minWidth: "160px" }}>Description</th>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Sent Date</th>
                            <th style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>Expected Pay Date</th>
                            <th style={{ padding: "10px 12px", textAlign: "center", whiteSpace: "nowrap" }}>Status</th>
                            <th style={{ padding: "10px 12px", textAlign: "center", whiteSpace: "nowrap" }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAndSortedInvoices.length === 0 ? (
                            <tr>
                              <td colSpan={10} style={{ padding: "36px", textAlign: "center", color: "#94a3b8" }}>
                                {invoiceSearchTerm ? `No invoices match "${invoiceSearchTerm}"` : "No invoices found for this client."}
                              </td>
                            </tr>
                          ) : (
                            filteredAndSortedInvoices.map((inv, idx) => {
                              const isPlaceholder = isPlaceholderInvoice(inv.invoiceNo, inv.status);
                              return (
                                <tr
                                  key={inv.id || idx}
                                  style={{
                                    borderBottom: "1px solid #f1f5f9",
                                    backgroundColor: idx % 2 === 0 ? "#ffffff" : "#fafafa",
                                    transition: "background 0.15s ease",
                                  }}
                                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#f0f7ff"; }}
                                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = idx % 2 === 0 ? "#ffffff" : "#fafafa"; }}
                                >
                                  {/* Invoice No. */}
                                  <td style={{ padding: "10px 12px", fontWeight: "700", color: isPlaceholder ? "#9333ea" : "#1e293b", whiteSpace: "nowrap" }}>
                                    {isPlaceholder
                                      ? (isAdmin && inv.invoiceNo ? `⚠️ ${inv.invoiceNo.startsWith("#") ? inv.invoiceNo : `#${inv.invoiceNo}`}` : "⚠️ Placeholder")
                                      : (inv.invoiceNo ? (inv.invoiceNo.startsWith("#") ? inv.invoiceNo : `#${inv.invoiceNo}`) : "-")}
                                  </td>

                                  {/* Client Name */}
                                  <td style={{ padding: "10px 12px", color: "#334155", fontWeight: "500", whiteSpace: "nowrap" }}>
                                    {inv.client || "-"}
                                  </td>

                                  {/* Job Name */}
                                  <td style={{ padding: "10px 12px", color: "#0f172a", fontWeight: "600" }}>
                                    {inv.jobName || "-"}
                                  </td>

                                  {/* Project Code */}
                                  <td style={{ padding: "10px 12px", color: "#64748b", fontFamily: "monospace", fontSize: "12px", whiteSpace: "nowrap" }}>
                                    {inv.projectCode || "-"}
                                  </td>

                                  {/* Invoice Amount */}
                                  <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: "700", color: "#0f172a", whiteSpace: "nowrap" }}>
                                    {formatCurrency(inv.amount) || (inv.amount ? `£${inv.amount}` : "£0.00")}
                                  </td>

                                  {/* Description */}
                                  <td style={{ padding: "10px 12px", color: "#475569", fontSize: "12px", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={inv.description}>
                                    {inv.description || "-"}
                                  </td>

                                  {/* Sent Date */}
                                  <td style={{ padding: "10px 12px", color: "#475569", fontSize: "12px", whiteSpace: "nowrap" }}>
                                    {inv.sentDate || "-"}
                                  </td>

                                  {/* Expected Pay Date */}
                                  <td style={{ padding: "10px 12px", color: "#475569", fontSize: "12px", whiteSpace: "nowrap" }}>
                                    {inv.expectedPaymentDate || "-"}
                                  </td>

                                  {/* Status */}
                                  <td style={{ padding: "10px 12px", textAlign: "center", whiteSpace: "nowrap" }}>
                                    {inv.status ? (
                                      <span style={{ ...getStatusPill(inv.status), padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: "600" }}>
                                        {inv.status}
                                      </span>
                                    ) : (
                                      <span style={{ color: "#94a3b8", fontSize: "12px" }}>-</span>
                                    )}
                                  </td>

                                  {/* Action */}
                                  <td style={{ padding: "10px 12px", textAlign: "center", whiteSpace: "nowrap" }}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setInvoicesEditSlot({
                                          rowNum: inv.rowNum,
                                          slotNum: inv.slotNum,
                                          slot: inv.slot,
                                          jobClient: inv.client,
                                          jobName: inv.jobName,
                                        });
                                      }}
                                      style={{
                                        padding: "4px 10px",
                                        borderRadius: "5px",
                                        background: "#eff6ff",
                                        border: "1px solid #bfdbfe",
                                        color: "#1d4ed8",
                                        fontSize: "11px",
                                        fontWeight: "600",
                                        cursor: "pointer",
                                      }}
                                      title="Edit invoice details"
                                    >
                                      Edit
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}