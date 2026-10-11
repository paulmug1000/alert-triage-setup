import React, { useState } from "react";
import Spinner from "./Spinner";
import InvoicesEditModal from "./InvoicesEditModal";
import InvoicesNewJobModal from "./InvoicesNewJobModal";
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

export default function InvoicesView({
  allOutgoingsClients,
  styles,
  isAdmin: propIsAdmin
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));

  const { assignedAppIds, setAssignedAppIds, outgoingsPullPendingRef } = useAppGlobals();
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

  const [viewMode, setViewMode] = useState("modern");
  const [expandedRetainerKeys, setExpandedRetainerKeys] = useState(() => new Set());
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [invoicesNewJob, setInvoicesNewJob] = useState(null);
  const [clientMismatchPrompt, setClientMismatchPrompt] = useState(null);

  const toggleRetainerExpand = (key) => {
    setExpandedRetainerKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const executePlacement = async (promptData, shouldUpdateClientName) => {
    const { job, inv, isNewRow, rowNum, slotNum, jobLastRow, savingKey } = promptData;
    setClientMismatchPrompt(null);
    setInvoicesPlacing(null);
    setInvoicesSavingCell(savingKey);

    setAssignedAppIds(prevSet => {
      const next = new Set(prevSet); next.add(inv.invoiceNo);
      try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
      return next;
    });
    setInvoicesInbox(prev => prev.filter(e => e.invoiceNo !== inv.invoiceNo));

    setClientsWithFlags(prev => prev.map(c => {
      if (c.clientName !== invoicesClient?.clientName) return c;
      const updatedCounts = { ...c.alertCounts };
      if (updatedCounts["invoiceDashboardDiscr"] > 0) updatedCounts["invoiceDashboardDiscr"]--;
      return { ...c, alertCounts: updatedCounts };
    }));

    const jobRowNums = job?.rows ? job.rows.map(r => r.rowNum) : (rowNum ? [rowNum] : []);
    const effectiveClientName = shouldUpdateClientName ? String(inv.client || "").trim() : job.client;

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
        if (data.rowShifted) {
          // If rows shifted on the sheet, reload the live jobs list to guarantee 100% accurate row numbers
          await loadInvoicesJobs(invoicesClient, invoicesShowAll);
        } else {
          setInvoicesJobs(prev => prev && prev.map(j => {
            if (j.jobName !== job.jobName || j.client !== job.client) return j;
            const updatedClient = shouldUpdateClientName ? effectiveClientName : j.client;
            return {
              ...j,
              client: updatedClient,
              rows: j.rows.map(r => {
                const baseR = shouldUpdateClientName ? { ...r, client: updatedClient } : r;
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
    } catch(e) {
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
            <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "18px" }}>
              {isAdmin
                ? "Updating will change the client name across all rows for this job in the Confirmed sheet."
                : "Updating will change the client name for this job in the Confirmed sheet."}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <button className="triage-btn"
                onClick={() => executePlacement(clientMismatchPrompt, true)}
                style={{ background: "#2563eb", color: "white", border: "none", padding: "10px 14px", borderRadius: "6px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
              >
                ✓ Update sheet to &ldquo;{clientMismatchPrompt.invoiceClientName}&rdquo;
              </button>
              <button className="triage-btn"
                onClick={() => executePlacement(clientMismatchPrompt, false)}
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
            setAssignedAppIds(prevSet => {
              const next = new Set(prevSet); next.add(inv.invoiceNo);
              try { localStorage.setItem("pulse_assignedAppIds", JSON.stringify([...next])); } catch {}
              return next;
            });
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
      
      <div style={{ padding: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
            {invoicesClient ? invoicesClient.clientName : "Invoices"}
          </h2>
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
                  <span>{viewMode === "modern" ? "📋 Legacy View" : "✨ Modern View"}</span>
                </button>
              )}
              <button className="triage-btn" onClick={() => {
                loadInvoicesInbox(invoicesClient);
                loadInvoicesJobs(invoicesClient, invoicesShowAll);
              }}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
              title="Refresh jobs and invoices from live sheets">
                ↻ Refresh
              </button>
              <button className="triage-btn" onClick={() => { setInvoicesClient(null); setInvoicesInbox([]); setInvoicesJobs(null); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
                ← Back to Clients
              </button>
            </div>
          )}
        </div>

        {noInvClient && (
          <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
            <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to place unmatched invoices:</p>
            {(() => {
              const allClients = allOutgoingsClients || [];
              const clientsWithInbox = allClients.filter(c =>
                clientsWithFlags?.some(f => f.clientName === c.clientName &&
                  (f.flags?.invoiceDashboardDiscr))
              );
              const clientsNoInbox = allClients.filter(c => !clientsWithInbox.includes(c));
              const renderClientBtn = (c) => (
                <button key={c.clientName} className="triage-btn"
                  onClick={() => {
                    setInvoicesClient(c);
                    loadInvoicesInbox(c);
                    loadInvoicesJobs(c, false);
                    setInvoicesShowAll(false);
                  }}
                  style={{ padding: "10px 16px", background: "#fff8e1",
                    border: "1px solid #ffe082",
                    borderRadius: "8px", cursor: "pointer", textAlign: "left", fontSize: "14px", fontWeight: "500", width: "100%" }}>
                  {c.clientName}
                </button>
              );
              const renderClientBtnPlain = (c) => (
                <button key={c.clientName} className="triage-btn"
                  onClick={() => {
                    setInvoicesClient(c);
                    loadInvoicesInbox(c);
                    loadInvoicesJobs(c, false);
                    setInvoicesShowAll(false);
                  }}
                  style={{ ...styles.buttonSecondary, textAlign: "left", padding: "12px 16px", fontSize: "14px" }}>
                  {c.clientName}
                </button>
              );
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {clientsWithInbox.length > 0 && clientsNoInbox.length > 0 && (
                    <div style={{ fontSize: "11px", fontWeight: "700", color: "#e65100", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>Invoices to assign</div>
                  )}
                  {clientsWithInbox.map(renderClientBtn)}
                  {clientsNoInbox.length > 0 && clientsWithInbox.length > 0 && (
                    <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>No invoices to assign</div>
                  )}
                  {clientsNoInbox.map(renderClientBtnPlain)}
                  {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet - go to Home and refresh first.</p>}
                </div>
              );
            })()}
          </div>
        )}

        {!noInvClient && (
          <>
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
                        style={{ padding: "8px 12px", borderRadius: "8px",
                          background: isPlacing ? "#1a56db" : "#fff8e1",
                          color: isPlacing ? "#fff" : "#333",
                          border: `1px solid ${isPlacing ? "#1a56db" : "#ffe082"}`,
                          fontSize: "12px", minWidth: "160px" }}>
                        <div onClick={() => setInvoicesPlacing(isPlacing ? null : inv)} style={{ cursor: "pointer" }}>
                          <div style={{ fontWeight: "700" }}>#{inv.invoiceNo} - £{inv.amount.toFixed(2)}</div>
                          <div style={{ opacity: 0.85 }}>{inv.client}{inv.job ? ` - ${inv.job}` : ""}</div>
                          <div style={{ opacity: 0.7 }}>{inv.sentDate}{inv.status ? ` · ${inv.status}` : ""}</div>
                        </div>
                        <button onClick={e => { e.stopPropagation(); setInvoicesNewJob({ inv }); }}
                          title="Create new job for this invoice"
                          style={{ marginTop: "6px", fontSize: "10px", padding: "2px 8px",
                            background: isPlacing ? "rgba(255,255,255,0.2)" : "#f0f0f0",
                            border: `1px solid ${isPlacing ? "rgba(255,255,255,0.4)" : "#ccc"}`,
                            borderRadius: "4px", cursor: "pointer",
                            color: isPlacing ? "#fff" : "#555", whiteSpace: "nowrap" }}>
                          + New job
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {invoicesJobsLoading && (
              <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
            )}
            {!invoicesJobsLoading && invoicesJobs && (
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
                    marginBottom: "14px"
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
                        {invoicesJobs.length === 0 ? (
                          <tr>
                            <td colSpan={12} style={{ padding: "36px", textAlign: "center", color: "#64748b" }}>
                              No matching jobs found.
                            </td>
                          </tr>
                        ) : (
                          invoicesJobs.map((job) => {
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
                          {["Row","Client","Job name","Code","Revenue","Direct costs","Type","Start","End",
                            "InvSlot1","InvSlot2","InvSlot3",""].map(h => (
                            <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {invoicesJobs.flatMap((job, jobIdx) => {
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
                                  {uninvoiced > 0 && <div style={{ fontSize: "11px", color: "#ef4444", marginTop: "4px" }}>£{uninvoiced.toLocaleString("en-GB", {minimumFractionDigits: 2})} rem.</div>}
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
                                        setClientMismatchPrompt(promptPayload);
                                      } else {
                                        executePlacement(promptPayload, false);
                                      }
                                    } else if (!isPlacing && !isGenuinelyBlank) {
                                      setInvoicesEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s, jobClient: job.client, jobName: job.jobName });
                                    }
                                  }}
                                  style={{ padding: "7px 10px", borderBottom: "1px solid #eee",
                                    cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                    background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                    border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none" }}>
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
                                      setClientMismatchPrompt(promptPayload);
                                    } else {
                                      executePlacement(promptPayload, false);
                                    }
                                  }}
                                  style={{ cursor: "pointer", background: "#e8f0fe", border: "1.5px solid #1a56db",
                                    height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center",
                                    color: "#1a56db", fontWeight: "700", fontSize: "16px" }}>
                                  +
                                </div>
                              )}
                            </td>
                          </tr>
                          );
                          });
                        })}
                      </tbody>
                    </table>
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