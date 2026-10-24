import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import { stripCurrency, isPlaceholderInvoice } from "../utils/helpers";
import { useAuth } from "../hooks/useAuth";
import DateInput from "./DateInput";

export default function InvoicesEditModal({ 
  editSlot, 
  invoicesClient, 
  onClose, 
  onUpdateInvoiceJobs, 
  onMarkPullPending,
  isAdmin: propIsAdmin,
  availableJobs = [],
  onInvoiceMoved
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));
  const { rowNum, slotNum, slot, jobClient, jobName, tabName, job } = editSlot;
  
  const [invoiceNo, setInvoiceNo] = useState(slot.ref || "");
  const [amount, setAmount] = useState(stripCurrency(slot.amount));
  const [sentDate, setSentDate] = useState(slot.sentDate || "");
  const [daysToPay, setDaysToPay] = useState(slot.daysToPay || 30);
  const status = slot.status || "";
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  
  // Move invoice state
  const [movingInvoice, setMovingInvoice] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobsList, setJobsList] = useState(availableJobs || []);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [selectedTargetJob, setSelectedTargetJob] = useState(null);
  
  // Revenue prompt state: { type: "save" | "move", projectedTotal, currentRevenue, onConfirm }
  const [revenuePrompt, setRevenuePrompt] = useState(null);

  const close = () => { if (!saving) onClose(); };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saving]);

  // If availableJobs wasn't passed, load confirmed jobs for this client on demand
  useEffect(() => {
    if (movingInvoice && (!jobsList || jobsList.length === 0) && invoicesClient?.clientSheetId) {
      setLoadingJobs(true);
      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_invoice_jobs",
          clientSheetId: invoicesClient.clientSheetId,
          showAll: true
        })
      })
        .then(res => res.json())
        .then(data => {
          if (data.success && Array.isArray(data.jobs)) {
            setJobsList(data.jobs);
          }
        })
        .catch(err => console.error("Error loading jobs for move:", err))
        .finally(() => setLoadingJobs(false));
    }
  }, [movingInvoice, jobsList, invoicesClient]);

  // Compute current real invoiced total on this job
  const jobRealInvoicedTotal = useMemo(() => {
    if (!job?.rows) return 0;
    let sum = 0;
    job.rows.forEach(r => {
      (r.invoiceSlots || []).forEach(sl => {
        if (sl.ref && !isPlaceholderInvoice(sl.ref, sl.status)) {
          sum += parseFloat(String(sl.amount).replace(/[£$€,\s]/g, "")) || 0;
        }
      });
    });
    return sum;
  }, [job]);

  const jobRevenue = useMemo(() => {
    if (!job?.rows?.[0]) return 0;
    return parseFloat(String(job.rows[0].revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
  }, [job]);

  // Save changes to invoice slot
  const executeSave = async (updateJobRevenue = false, newJobRevenue = undefined) => {
    setSaving(true);
    setRevenuePrompt(null);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum, slotNum,
          jobClient, jobName,
          invoice: { invoiceNo, amount: parseFloat(amount) || 0, sentDate, daysToPay: parseInt(daysToPay) || 30, status },
          updateJobRevenue,
          newJobRevenue,
          jobRowNums: job?.rows ? job.rows.map(r => r.rowNum) : [rowNum]
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || "Failed to update invoice");
        return;
      }
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      onUpdateInvoiceJobs(rowNum, slotNum, { 
        ref: invoiceNo, 
        amount: parseFloat(amount) || 0, 
        sentDate, 
        daysToPay: parseInt(daysToPay) || 30, 
        status 
      }, data);
      close();
    } catch(e) { console.error("update_invoice_slot save error:", e); }
    finally { setSaving(false); }
  };

  const handleSaveClick = () => {
    const newAmtNum = parseFloat(amount) || 0;
    const oldAmtNum = parseFloat(stripCurrency(slot.amount)) || 0;
    if (jobRevenue > 0 && newAmtNum !== oldAmtNum) {
      const projectedTotal = Math.round((jobRealInvoicedTotal - oldAmtNum + newAmtNum) * 100) / 100;
      if (projectedTotal > jobRevenue) {
        setRevenuePrompt({
          type: "save",
          projectedTotal,
          currentRevenue: jobRevenue,
          onConfirmYes: () => executeSave(true, projectedTotal),
          onConfirmNo: () => executeSave(false)
        });
        return;
      }
    }
    executeSave(false);
  };

  // Move invoice to destination job
  const executeMove = async (targetJob, updateTargetRevenue = false, newTargetRevenue = undefined) => {
    setSaving(true);
    setRevenuePrompt(null);
    try {
      const targetRows = targetJob.rows || [];
      const targetParentRow = targetRows[0];
      const targetJobLastRow = targetRows[targetRows.length - 1]?.rowNum || targetParentRow?.rowNum;

      // Find first available slot on target job
      let foundTargetRowNum = null;
      let foundTargetSlotNum = null;
      for (const r of targetRows) {
        for (const sl of (r.invoiceSlots || [])) {
          if (!sl.ref || isPlaceholderInvoice(sl.ref, sl.status) || !sl.amount) {
            foundTargetRowNum = r.rowNum;
            foundTargetSlotNum = sl.slotNum;
            break;
          }
        }
        if (foundTargetRowNum) break;
      }

      const createNewRow = !foundTargetRowNum;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move_invoice_to_job",
          clientSheetId: invoicesClient?.clientSheetId,
          masterSheetId: invoicesClient?.masterSheetId || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          sourceRowNum: rowNum,
          sourceSlotNum: slotNum,
          sourceJobClient: jobClient,
          sourceJobName: jobName,
          invoiceRef: invoiceNo,
          targetJobClient: targetJob.client,
          targetJobName: targetJob.jobName,
          targetRowNum: foundTargetRowNum || targetJobLastRow,
          targetSlotNum: foundTargetSlotNum || 1,
          createNewRow,
          targetJobLastRow,
          updateTargetRevenue,
          newTargetRevenue,
          invoice: {
            invoiceNo,
            amount: parseFloat(amount) || 0,
            sentDate,
            daysToPay: parseInt(daysToPay) || 30,
            status: status || "Sent"
          }
        })
      });

      const resData = await res.json();
      if (!resData.success) {
        alert(resData.error || "Failed to move invoice");
        return;
      }

      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }

      if (onInvoiceMoved) {
        onInvoiceMoved({
          sourceRowNum: rowNum,
          sourceSlotNum: slotNum,
          targetJob,
          targetRowNum: resData.targetRowNum,
          targetSlotNum: resData.targetSlotNum,
          invoice: { invoiceNo, amount: parseFloat(amount) || 0, sentDate, daysToPay: parseInt(daysToPay) || 30, status },
          resData
        });
      } else {
        // Fallback: clear invoice slot on current job
        onUpdateInvoiceJobs(rowNum, slotNum, { ref: "", amount: "", sentDate: "", daysToPay: "", status: "" });
      }

      close();
    } catch (e) {
      console.error("move_invoice_to_job error:", e);
      alert("Error moving invoice: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSelectTargetJob = (targetJob) => {
    setSelectedTargetJob(targetJob);
    const invAmtNum = parseFloat(amount) || 0;
    const targetRevenue = parseFloat(String(targetJob.rows?.[0]?.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
    
    // Calculate current real invoiced total on target job
    let targetInvoicedTotal = 0;
    (targetJob.rows || []).forEach(r => {
      (r.invoiceSlots || []).forEach(sl => {
        if (sl.ref && !isPlaceholderInvoice(sl.ref, sl.status)) {
          targetInvoicedTotal += parseFloat(String(sl.amount).replace(/[£$€,\s]/g, "")) || 0;
        }
      });
    });

    const projectedTotal = Math.round((targetInvoicedTotal + invAmtNum) * 100) / 100;
    if (targetRevenue > 0 && projectedTotal > targetRevenue) {
      setRevenuePrompt({
        type: "move",
        targetJobName: targetJob.jobName,
        projectedTotal,
        currentRevenue: targetRevenue,
        onConfirmYes: () => executeMove(targetJob, true, projectedTotal),
        onConfirmNo: () => executeMove(targetJob, false)
      });
      return;
    }

    executeMove(targetJob, false);
  };

  const doDelete = async () => {
    setSaving(true);
    try {
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum, slotNum, deleteSlot: true,
          jobClient, jobName,
        }),
      });
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      onUpdateInvoiceJobs(rowNum, slotNum, { 
        ref: "", amount: "", sentDate: "", daysToPay: "", status: "" 
      });
      close();
    } catch(e) { console.error("update_invoice_slot delete error:", e); }
    finally { setSaving(false); }
  };

  const filteredTargetJobs = useMemo(() => {
    const cleanSearch = jobSearch.trim().toLowerCase();
    return (jobsList || []).filter(j => {
      // Exclude the current job
      if (j.jobName === jobName && (j.client === jobClient || !j.client)) return false;
      if (!cleanSearch) return true;
      return (
        String(j.jobName || "").toLowerCase().includes(cleanSearch) ||
        String(j.client || "").toLowerCase().includes(cleanSearch) ||
        String(j.projectCode || "").toLowerCase().includes(cleanSearch)
      );
    });
  }, [jobsList, jobSearch, jobName, jobClient]);

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "14px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 520px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
              {movingInvoice ? (
                `Move invoice #${invoiceNo || slot.ref}`
              ) : jobName ? (
                `${jobName} · ${isAdmin ? (editSlot.slotLabel || `Slot ${slotNum}`) : (editSlot.slotLabel ? editSlot.slotLabel.replace(/\s*\(Row\s*\d+\)/gi, "").replace(/\bRow\s*\d+\b,?\s*/gi, "").trim() : `Slot ${slotNum}`)}`
              ) : (
                `Edit invoice - ${isAdmin
                  ? (editSlot.slotLabel ? `${editSlot.slotLabel} (Row ${rowNum})` : `Row ${rowNum}, Slot ${slotNum}`)
                  : (editSlot.slotLabel ? editSlot.slotLabel.replace(/\s*\(Row\s*\d+\)/gi, "").replace(/\bRow\s*\d+\b,?\s*/gi, "").trim() : `Slot ${slotNum}`)}`
              )}
            </h3>
            {jobClient && (
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Client: <strong>{jobClient}</strong>{isAdmin ? ` · Row ${rowNum}` : ""}
              </div>
            )}
          </div>
          <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>

        {/* REVENUE INCREASE PROMPT MODAL */}
        {revenuePrompt && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13.5px", fontWeight: "600", color: "#1e40af", marginBottom: "6px" }}>
              Increase job revenue to match?
            </div>
            <div style={{ fontSize: "12.5px", color: "#334155", lineHeight: "1.5", marginBottom: "12px" }}>
              {revenuePrompt.type === "move" ? (
                <>Moving this invoice brings total invoiced on <strong>&ldquo;{revenuePrompt.targetJobName}&rdquo;</strong> to <strong>£{revenuePrompt.projectedTotal.toFixed(2)}</strong>, which exceeds its current revenue of <strong>£{revenuePrompt.currentRevenue.toFixed(2)}</strong>.</>
              ) : (
                <>Saving this invoice brings total invoiced on this job to <strong>£{revenuePrompt.projectedTotal.toFixed(2)}</strong>, which exceeds its current revenue of <strong>£{revenuePrompt.currentRevenue.toFixed(2)}</strong>.</>
              )}
              <br />Would you like to increase the job&apos;s revenue to match?
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setRevenuePrompt(null)}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", cursor: "pointer", color: "#475569" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={revenuePrompt.onConfirmNo}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "#334155" }}
              >
                No, keep current revenue
              </button>
              <button
                type="button"
                onClick={revenuePrompt.onConfirmYes}
                disabled={saving}
                style={{ padding: "6px 14px", background: "#2563eb", border: "none", borderRadius: "5px", fontSize: "12px", fontWeight: "600", color: "#ffffff", cursor: "pointer" }}
              >
                Yes, increase revenue
              </button>
            </div>
          </div>
        )}

        {/* MOVE TO DIFFERENT JOB VIEW */}
        {movingInvoice ? (
          <div>
            <div style={{ fontSize: "13px", color: "#475569", marginBottom: "12px" }}>
              Select a new destination job for invoice <strong>#{invoiceNo || slot.ref}</strong> (£{parseFloat(amount || 0).toFixed(2)}):
            </div>
            
            <div style={{ marginBottom: "12px" }}>
              <input
                type="text"
                placeholder="Search jobs by name, client, or code..."
                value={jobSearch}
                onChange={e => setJobSearch(e.target.value)}
                style={{ ...inputStyle, padding: "8px 12px" }}
                autoFocus
              />
            </div>

            <div style={{ maxHeight: "260px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#f8fafc", marginBottom: "16px" }}>
              {loadingJobs ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                  <Spinner size={14} color="#2563eb" /> Loading available jobs...
                </div>
              ) : filteredTargetJobs.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                  No available jobs found.
                </div>
              ) : (
                filteredTargetJobs.map(j => {
                  const jKey = `${j.client}|||${j.jobName}`;
                  const rev = parseFloat(String(j.rows?.[0]?.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
                  return (
                    <div
                      key={jKey}
                      onClick={() => !saving && handleSelectTargetJob(j)}
                      style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid #e2e8f0",
                        cursor: saving ? "default" : "pointer",
                        backgroundColor: "#ffffff",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background-color 0.1s ease"
                      }}
                      onMouseEnter={e => { if (!saving) e.currentTarget.style.backgroundColor = "#eff6ff"; }}
                      onMouseLeave={e => { if (!saving) e.currentTarget.style.backgroundColor = "#ffffff"; }}
                    >
                      <div>
                        <div style={{ fontWeight: "600", fontSize: "13px", color: "#1e293b" }}>{j.jobName}</div>
                        <div style={{ fontSize: "11px", color: "#64748b" }}>
                          {j.client}{j.projectCode ? ` · ${j.projectCode}` : ""}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "12px", fontWeight: "600", color: "#0f172a" }}>
                          {rev > 0 ? `£${rev.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                        </div>
                        <div style={{ fontSize: "10.5px", color: "#64748b" }}>Revenue</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setMovingInvoice(false)}
                disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}
              >
                Back to edit
              </button>
            </div>
          </div>
        ) : (
          /* STANDARD EDIT FORM */
          <>
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Invoice number</label>
                <input style={inputStyle} value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>Amount (£)</label>
                  <input style={inputStyle} type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Days to pay</label>
                  <input style={inputStyle} type="number" value={daysToPay} onChange={e => setDaysToPay(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Sent date</label>
                <DateInput style={inputStyle} value={sentDate} onChange={e => setSentDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Status (automation managed)</label>
                <div style={{
                  padding: "7px 10px",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#334155",
                  display: "inline-block"
                }}>
                  {status || "None"}
                </div>
              </div>
            </div>

            {confirmingDelete ? (
              <div style={{ marginTop: "18px", padding: "12px", background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "8px" }}>
                <div style={{ fontSize: "13px", color: "#991b1b", marginBottom: "10px" }}>Delete this invoice entry? This clears all fields for this slot and can&apos;t be undone from here.</div>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmingDelete(false)} disabled={saving}
                    style={{ padding: "7px 14px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                  <button onClick={doDelete} disabled={saving}
                    style={{ padding: "7px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.7 : 1 }}>
                    {saving ? "Deleting..." : "Yes, delete"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={saving}
                    style={{ padding: "8px 14px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Delete invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => setMovingInvoice(true)}
                    disabled={saving}
                    style={{ padding: "8px 14px", background: "#ffffff", color: "#2563eb", border: "1px solid #bfdbfe", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Move to a different job
                  </button>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={close} disabled={saving}
                    style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                  <button onClick={handleSaveClick} disabled={saving}
                    style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}