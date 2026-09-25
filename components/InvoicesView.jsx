import React, { useState } from "react";
import Spinner from "./Spinner";
import InvoicesEditModal from "./InvoicesEditModal";
import InvoicesNewJobModal from "./InvoicesNewJobModal";
import { useInvoices } from "../hooks/useInvoices";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";

export default function InvoicesView({
  allOutgoingsClients,
  styles
}) {
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

  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [invoicesNewJob, setInvoicesNewJob] = useState(null);
  const [clientMismatchPrompt, setClientMismatchPrompt] = useState(null);

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
        await fetch("/api/triage", {
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
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
        await loadInvoicesJobs(invoicesClient, invoicesShowAll);
      } else {
        await fetch("/api/triage", {
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
        if (invoicesClient?.masterSheetId) {
          outgoingsPullPendingRef.current = invoicesClient.masterSheetId;
        }
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
              Updating will change the client name across all rows for this job in the Confirmed sheet.
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
            <button className="triage-btn" onClick={() => { setInvoicesClient(null); setInvoicesInbox([]); setInvoicesJobs(null); }}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
              ← Back to Clients
            </button>
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
                  {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet — go to Home and refresh first.</p>}
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
                  ? `Unmatched invoices (${invoicesInbox.length}) — click to select, then click a slot to place`
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
                          <div style={{ fontWeight: "700" }}>#{inv.invoiceNo} — £{inv.amount.toFixed(2)}</div>
                          <div style={{ opacity: 0.85 }}>{inv.client}{inv.job ? ` — ${inv.job}` : ""}</div>
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
                          const isReal = slot.ref && !String(slot.ref).toUpperCase().includes("MANUAL-INV");
                          return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) || 0) : 0);
                        }, 0), 0);
                        const jobRevenue = parseFloat(String(job.rows[0].revenue).replace(/[£$€,\s]/g, "")) || 0;
                        const uninvoiced = jobRevenue - jobTotalInvoiced;
                        
                        const jobHasEmptySlot = job.rows.some(jr => jr.invoiceSlots.some(s => (!s.ref || String(s.ref).trim() === "") && !s.amount));
                        const jobLastRow = job.rows[job.rows.length - 1].rowNum;
                        const isPlacing = !!invoicesPlacing;
                        
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
                            const isManualEntry = String(s.ref || "").toUpperCase().includes("MANUAL-INV");
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
                                    setInvoicesEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s });
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
                                  isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>—</span>
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
                                title="No spare invoice slot — click to add a new row for this job"
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
                {!invoicesShowAll && (
                  <div style={{ textAlign: "center", marginTop: "14px" }}>
                    <button onClick={() => { setInvoicesShowAll(true); loadInvoicesJobs(invoicesClient, true); }}
                      style={{ padding: "8px 20px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                      Show all jobs
                    </button>
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