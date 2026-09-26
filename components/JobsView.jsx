import React, { useState } from "react";
import Spinner from "./Spinner";
import UnevenSplitModal from "./UnevenSplitModal";
import InvoicesEditModal from "./InvoicesEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import { useJobs } from "../hooks/useJobs";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { isPlaceholderInvoice, isPlaceholderExpense } from "../utils/helpers";

export default function JobsView({
  allOutgoingsClients,
  styles
}) {
  const { outgoingsPullPendingRef } = useAppGlobals();

  const {
    jobsClient, setJobsClient,
    jobsTab, setJobsTab,
    jobsData, setJobsData,
    jobsLoading,
    jobsExpanded, setJobsExpanded,
    jobsEditSplit, setJobsEditSplit,
    loadJobsData
  } = useJobs();

  // Local state for modals rendered by this view
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);

  const noJobsClient = !jobsClient;

  const formatCurrency = (val) => {
    const s = String(val || "").trim();
    if (!s) return "";
    const hasSymbol = /^[£$€]/.test(s);
    const symbol = hasSymbol ? s.charAt(0) : "£";
    const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
    if (isNaN(num)) return s;
    return symbol + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Inline Editable Cell Component
  const EditableCell = ({ value, colLetter, rowNum, type = "text", onSave, customStyle = {}, isCurrency = false }) => {
    const [isEditing, React_useState] = React.useState(false);
    const [val, setVal] = React.useState(value || "");
    const inputRef = React.useRef(null);

    React.useEffect(() => { setVal(value || ""); }, [value]);
    React.useEffect(() => { if (isEditing && inputRef.current) inputRef.current.focus(); }, [isEditing]);

    const handleBlur = () => {
      React_useState(false);
      if (val !== (value || "")) onSave(colLetter, rowNum, val);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Enter") handleBlur();
      if (e.key === "Escape") { React_useState(false); setVal(value || ""); }
    };

    if (isEditing) {
      return (
        <input
          ref={inputRef}
          type={type}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={{ width: "100%", boxSizing: "border-box", padding: "2px 4px", fontSize: "12px", border: "1px solid #0066cc", borderRadius: "3px" }}
        />
      );
    }

    return (
      <div
        onClick={() => React_useState(true)}
        style={{ minHeight: "20px", cursor: "text", padding: "2px", borderRadius: "3px", ...customStyle }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = customStyle.backgroundColor ? customStyle.backgroundColor : "rgba(0,102,204,0.05)"}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = customStyle.backgroundColor || "transparent"}
        title="Click to edit"
      >
        {val ? (isCurrency ? formatCurrency(val) : val) : <span style={{ color: "#ccc" }}>—</span>}
      </div>
    );
  };

  const handleInlineUpdate = async (colLetter, rowNum, newValue) => {
    // Find target job and row identity from current jobsData
    let targetEndClient = "";
    let targetJobName = "";
    if (jobsData) {
      for (const job of jobsData) {
        const matchRow = (job.rows || []).find(r => r.rowNum === rowNum);
        if (matchRow) {
          targetEndClient = matchRow.client || job.client || "";
          targetJobName = matchRow.jobName || job.jobName || "";
          break;
        }
      }
    }

    const FIELD_NAMES = {
      A: "Client",
      B: "Job Name",
      C: "Project Code",
      D: "Date Confirmed",
      E: "Lead Source",
      AE: "Revenue Split",
      AG: "Revenue",
      AH: "Direct Costs",
      AI: "VAT",
      AJ: "Type",
      AK: "Product Line",
      AL: "Start Date",
      AM: "End Date",
      AN: "Likelihood",
      DD: "Copied to Confirmed"
    };
    const fieldName = FIELD_NAMES[colLetter] || `Field ${colLetter}`;

    // Optimistic local update
    setJobsData(prev => prev.map(job => ({
      ...job,
      rows: job.rows.map(r => {
        if (r.rowNum !== rowNum) return r;
        const updated = { ...r };
        if (colLetter === 'A') updated.client = newValue;
        if (colLetter === 'B') updated.jobName = newValue;
        if (colLetter === 'C') updated.projectCode = newValue;
        if (colLetter === 'AG') updated.revenue = newValue;
        if (colLetter === 'AH') updated.directCosts = newValue;
        if (colLetter === 'AI') updated.vat = newValue;
        if (colLetter === 'AJ') updated.projectRetainer = newValue;
        if (colLetter === 'AL') updated.startDate = newValue;
        if (colLetter === 'AM') updated.endDate = newValue;
        if (colLetter === 'AN') updated.likelihood = newValue;
        if (colLetter === 'DD') updated.copiedToConf = newValue;
        if (colLetter === 'D')  updated.dateConf = newValue;
        if (colLetter === 'E')  updated.leadSrc = newValue;
        if (colLetter === 'AK') updated.prodLine = newValue;
        return updated;
      })
    })));

    try {
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_field",
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          tabName: jobsTab,
          cellRef: `${colLetter}${rowNum}`,
          colLetter,
          rowNum,
          fieldName,
          endClientName: targetEndClient,
          jobName: targetJobName,
          value: newValue
        })
      });
    } catch (e) {
      console.error("Inline update failed:", e);
    }
  };

  return (
    <>
      {jobsEditSplit && (
        <UnevenSplitModal
          editSplit={jobsEditSplit}
          client={jobsClient}
          tabName={jobsTab}
          onClose={() => setJobsEditSplit(null)}
          onUpdateJobsData={(rNum, splitStr) => {
            setJobsData(prev => prev.map(j => ({
              ...j,
              rows: j.rows.map(r => r.rowNum === rNum ? { ...r, unevenSplit: splitStr } : r)
            })));
          }}
        />
      )}
      {invoicesEditSlot && (
        <InvoicesEditModal 
          editSlot={invoicesEditSlot}
          invoicesClient={jobsClient}
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onUpdateInvoiceJobs={(rNum, sNum, newData) => {
            setJobsData(prev => prev && prev.map(j => ({
              ...j,
              rows: j.rows.map(r => r.rowNum !== rNum ? r : {
                ...r,
                invoiceSlots: r.invoiceSlots.map(sl => sl.slotNum !== sNum ? sl : { ...sl, ...newData })
              }),
            })));
          }}
        />
      )}
      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={jobsClient}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onUpdateJobs={(rNum, sNum, newData) => {
            setJobsData(prev => prev && prev.map(j => ({
              ...j,
              rows: j.rows.map(r => r.rowNum !== rNum ? r : {
                ...r,
                expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== sNum ? sl : { ...sl, ...newData })
              }),
            })));
          }}
        />
      )}
      
      <div style={{ padding: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
            {jobsClient ? jobsClient.clientName : "Jobs Management"}
          </h2>
          {jobsClient && (
            <button className="triage-btn" onClick={() => { setJobsClient(null); setJobsData(null); }}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
              ← Back to Clients
            </button>
          )}
        </div>

        {noJobsClient && (
          <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
            <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to view and edit all their jobs:</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {(allOutgoingsClients || []).map(c => (
                <button key={c.clientName} className="triage-btn"
                  onClick={() => { setJobsClient(c); loadJobsData(c, jobsTab); }}
                  style={{ ...styles.buttonSecondary, textAlign: "left", padding: "12px 16px", fontSize: "14px" }}>
                  {c.clientName}
                </button>
              ))}
            </div>
          </div>
        )}

        {!noJobsClient && (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e0e0e0" }}>
              {["Confirmed", "Pipeline"].map(tab => (
                <button key={tab} onClick={() => { setJobsTab(tab); loadJobsData(jobsClient, tab); }}
                  style={{ padding: "8px 16px", background: "none", border: "none",
                    borderBottom: jobsTab === tab ? "2px solid #0066cc" : "2px solid transparent",
                    color: jobsTab === tab ? "#0066cc" : "#666",
                    fontWeight: jobsTab === tab ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                  {tab}
                </button>
              ))}
              <button onClick={() => loadJobsData(jobsClient, jobsTab)} disabled={jobsLoading} style={{ marginLeft: "auto", background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: "13px" }}>
                {jobsLoading ? <><Spinner size={12}/> Refreshing</> : "↻ Refresh"}
              </button>
            </div>

            {jobsLoading && !jobsData ? (
              <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
            ) : jobsData && (() => {
              const getStatusPillStyle = (status) => {
                const s = String(status || "").trim();
                if (s === "Paid") return { backgroundColor: "#d9ead3", color: "#0c343d", padding: "1px 4px", borderRadius: "3px", marginLeft: "4px" };
                if (s === "Draft") return { backgroundColor: "#fce5cd", color: "#b45f06", padding: "1px 4px", borderRadius: "3px", marginLeft: "4px" };
                if (s === "Sent" || s === "Received") return { backgroundColor: "#cfe2f3", color: "#0b5394", padding: "1px 4px", borderRadius: "3px", marginLeft: "4px" };
                return s ? { backgroundColor: "#f1f5f9", color: "#64748b", padding: "1px 4px", borderRadius: "3px", marginLeft: "4px" } : null;
              };

              const hasProjectCode = jobsData.some(j => j.rows.some(r => r.projectCode && String(r.projectCode).trim() !== ""));
              const hasDateConf = jobsData.some(j => j.rows.some(r => r.dateConf && String(r.dateConf).trim() !== ""));
              const hasLeadSrc = jobsData.some(j => j.rows.some(r => r.leadSrc && String(r.leadSrc).trim() !== ""));
              const hasProdLine = jobsData.some(j => j.rows.some(r => r.prodLine && String(r.prodLine).trim() !== ""));

              const parseSheetDate = (dStr) => {
                if (!dStr) return null;
                const m = String(dStr).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
                if (!m) return null;
                const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
                let yr = parseInt(m[3], 10);
                if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
                return new Date(yr, months[m[2].toLowerCase()], parseInt(m[1], 10));
              };

              return (
              <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "2000px", tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "24px" }} />
                    <col style={{ width: "50px" }} />
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "160px" }} />
                    {hasProjectCode && <col style={{ width: "80px" }} />}
                    {hasDateConf && <col style={{ width: "80px" }} />}
                    {hasLeadSrc && <col style={{ width: "80px" }} />}
                    <col style={{ width: "90px" }} />
                    {hasProdLine && <col style={{ width: "90px" }} />}
                    {jobsClient?.splitEnabled && <col style={{ width: "60px" }} />}
                    <col style={{ width: "80px" }} />
                    <col style={{ width: "80px" }} />
                    <col style={{ width: "60px" }} />
                    <col style={{ width: "95px" }} />
                    <col style={{ width: "95px" }} />
                    {jobsTab === "Pipeline" && <><col style={{ width: "70px" }}/><col style={{ width: "70px" }}/></>}
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "90px" }} />
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "175px" }} />
                    <col style={{ width: "90px" }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "#f5f6fa" }}>
                      {["", "Row", "Client", "Job name", 
                        ...(hasProjectCode ? ["Code"] : []),
                        ...(hasDateConf ? [jobsTab === "Pipeline" ? "Date Added" : "Date Conf"] : []),
                        ...(hasLeadSrc ? ["Lead src"] : []),
                        "Type", 
                        ...(hasProdLine ? ["Prod. line"] : []),
                        ...(jobsClient?.splitEnabled ? ["Split"] : []),
                        "Revenue", "Costs", "VAT", "Start", "End",
                        ...(jobsTab === "Pipeline" ? ["Likelihood", "Copied?"] : []),
                        "InvSlot1", "InvSlot2", "InvSlot3", "Left to inv.",
                        "ExpSlot1", "ExpSlot2", "ExpSlot3", "Costs outst."].map((h, i) => (
                        <th key={i} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobsData.flatMap((job, jobIdx) => {
                      const isRetainer = String(job.rows[0]?.projectRetainer || "").toLowerCase().includes("retainer");
                      const isExpanded = jobsExpanded.has(job.rows[0]?.rowNum);
                      
                      const visibleRows = (isRetainer && !isExpanded) ? job.rows.slice(0, 1) : job.rows;

                      return visibleRows.map((r, rIdx) => {
                        const isParent = r.isParent;
                        const showFields = !isRetainer || isParent;
                        const showIdentity = isParent; 
                        
                        return (
                          <tr key={r.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#f1f5f9" }}>
                            <td style={{ padding: "7px 4px", borderBottom: "1px solid #eee", textAlign: "center", verticalAlign: "top" }}>
                              {rIdx === 0 && isRetainer && job.rows.length > 1 && (
                                <span
                                  onClick={() => setJobsExpanded(prev => { const n = new Set(prev); if (n.has(r.rowNum)) n.delete(r.rowNum); else n.add(r.rowNum); return n; })}
                                  style={{ cursor: "pointer", color: "#7c3aed", fontSize: "11px", userSelect: "none" }}
                                >
                                  {isExpanded ? "▼" : "▶"}
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888", verticalAlign: "top" }}>{r.rowNum}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {showIdentity && <EditableCell value={r.client} colLetter="A" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                            </td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {showIdentity && <EditableCell value={r.jobName} colLetter="B" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                            </td>
                            {hasProjectCode && (
                              <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", maxWidth: "80px" }}>
                                {showFields && (
                                  <div style={{ overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "thin", paddingBottom: "2px" }}>
                                    <EditableCell value={r.projectCode} colLetter="C" rowNum={r.rowNum} onSave={handleInlineUpdate} />
                                  </div>
                                )}
                              </td>
                            )}
                            {hasDateConf && (
                              <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                {showFields && <EditableCell value={r.dateConf} colLetter="D" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                              </td>
                            )}
                            {hasLeadSrc && (
                              <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                {showFields && <EditableCell value={r.leadSrc} colLetter="E" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                              </td>
                            )}
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {showFields && (() => {
                                let typeStyle = {};
                                if (r.projectRetainer) {
                                  const tStr = String(r.projectRetainer).toLowerCase();
                                  if (tStr.includes("retainer")) typeStyle = { backgroundColor: "#e0f2fe", color: "#0284c7", fontWeight: "600", padding: "2px 6px", display: "inline-block" };
                                  else if (tStr.includes("project")) typeStyle = { backgroundColor: "#f3e8ff", color: "#9333ea", fontWeight: "600", padding: "2px 6px", display: "inline-block" };
                                }
                                return <EditableCell value={r.projectRetainer} colLetter="AJ" rowNum={r.rowNum} onSave={handleInlineUpdate} customStyle={typeStyle} />;
                              })()}
                            </td>
                            {hasProdLine && (
                              <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                {showFields && <EditableCell value={r.prodLine} colLetter="AK" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                              </td>
                            )}
                            
                            {jobsClient?.splitEnabled && (
                              <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", textAlign: "center", verticalAlign: "top" }}>
                                {showFields && !isRetainer && isParent && (
                                  <button onClick={() => setJobsEditSplit({ jobRow: r })} style={{ background: String(r.unevenSplit || "").toLowerCase().startsWith("[split]") ? "#0066cc" : "#f0f0f0", color: String(r.unevenSplit || "").toLowerCase().startsWith("[split]") ? "#fff" : "#666", border: "none", borderRadius: "4px", padding: "2px 6px", fontSize: "10px", cursor: "pointer" }}>
                                    Split
                                  </button>
                                )}
                              </td>
                            )}
                            
                            {(() => {
                              let revBg = "transparent";
                              if (jobsTab === "Pipeline" && isParent) {
                                const l = String(r.likelihood || "").trim();
                                const c = String(r.copiedToConf || "").trim().toLowerCase();
                                const isZero = l === "0%" || l === "0" || parseFloat(l.replace(/[^0-9.-]/g, "")) === 0;
                                if (!isZero && l !== "" && c !== "yes") revBg = "#e0f2fe"; 
                              }
                              const leftToInvVal = parseFloat(String(r.leftToInvoice).replace(/[£$€,\s]/g,""));
                              if (!isNaN(leftToInvVal) && Math.abs(leftToInvVal) > 0.01 && revBg === "transparent") {
                                revBg = "#fce8b2"; 
                              }
                              return (
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", background: revBg }}>
                                  {showFields && <EditableCell value={r.revenue} colLetter="AG" rowNum={r.rowNum} onSave={handleInlineUpdate} isCurrency={true} />}
                                </td>
                              );
                            })()}
                            {(() => {
                              let costsBg = "transparent";
                              const costsOutVal = parseFloat(String(r.costsOutstanding).replace(/[£$€,\s]/g,""));
                              if (!isNaN(costsOutVal) && Math.abs(costsOutVal) > 0.01) {
                                costsBg = "#fce8b2";
                              }
                              return (
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", background: costsBg }}>
                                  {showFields && <EditableCell value={r.directCosts} colLetter="AH" rowNum={r.rowNum} onSave={handleInlineUpdate} isCurrency={true} />}
                                </td>
                              );
                            })()}
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {showFields && <EditableCell value={r.vat} colLetter="AI" rowNum={r.rowNum} onSave={handleInlineUpdate} isCurrency={true} />}
                            </td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {showFields && <EditableCell value={r.startDate} colLetter="AL" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                            </td>
                            {(() => {
                              let endBg = "transparent";
                              const startDt = parseSheetDate(r.startDate);
                              const endDt = parseSheetDate(r.endDate);
                              if (startDt && endDt && endDt < startDt) {
                                endBg = "#f4c7c3"; 
                              }
                              return (
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", background: endBg }}>
                                  {showFields && <EditableCell value={r.endDate} colLetter="AM" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                                </td>
                              );
                            })()}
                            {jobsTab === "Pipeline" && (
                              <>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <EditableCell value={r.likelihood} colLetter="AN" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <EditableCell value={r.copiedToConf} colLetter="DD" rowNum={r.rowNum} onSave={handleInlineUpdate} />}
                                </td>
                              </>
                            )}
                            
                            {r.invoiceSlots.map(s => {
                              let sentStyle = {};
                              let amtStyle = {};
                              
                              const sentDt = parseSheetDate(s.sentDate);
                              if (sentDt) {
                                const today = new Date();
                                today.setHours(0,0,0,0);
                                const status = String(s.status || "").trim();
                                const isPaid = status === "Paid";
                                const isSent = status === "Sent";
                                const todayPlus30 = new Date(today);
                                todayPlus30.setDate(todayPlus30.getDate() + 30);
                                
                                const days = parseInt(s.daysToPay, 10) || 0;
                                const dueDt = new Date(sentDt);
                                dueDt.setDate(dueDt.getDate() + days);

                                if (sentDt < today && !isPaid && !isSent) {
                                  sentStyle = { backgroundColor: "#f4c7c3", color: "#b71c1c", padding: "1px 4px", borderRadius: "3px" };
                                } else if (sentDt < todayPlus30 && !isPaid && !isSent) {
                                  sentStyle = { backgroundColor: "#fff2cc", color: "#f57f17", padding: "1px 4px", borderRadius: "3px" };
                                } else if (dueDt < today && !isPaid) {
                                  sentStyle = { backgroundColor: "#fce8b2", color: "#e65100", padding: "1px 4px", borderRadius: "3px" }; 
                                }
                              }
                              
                              if (s.amount && String(s.amount).trim() !== "") {
                                const isRetainer = String(r.projectRetainer || "").trim() === "Retainer";
                                const startDt = parseSheetDate(r.startDate);
                                const endDt = parseSheetDate(r.endDate);
                                if (isRetainer && startDt && endDt) {
                                  const eom = new Date(startDt.getFullYear(), startDt.getMonth() + 1, 0);
                                  if (endDt > eom) {
                                    amtStyle = { backgroundColor: "#ead1dc", color: "#4a148c", padding: "1px 4px", borderRadius: "3px" };
                                  }
                                }
                              }

                              return (
                                <td key={`inv${s.slotNum}`} onClick={() => {
                                  setInvoicesEditSlot({ rowNum: r.rowNum, slotNum: s.slotNum, slot: s });
                                }} style={{ padding: "7px 10px", borderBottom: "1px solid #eee", cursor: "pointer", borderLeft: s.slotNum === 1 ? "2px solid #f0f0f0" : "none" }} onMouseEnter={e => e.currentTarget.style.background = "#f0f4ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                                  {!s.ref && !s.amount ? <span style={{ color: "#ccc" }}>—</span> : (
                                    <div>
                                      <div style={{ fontWeight: "600", color: isPlaceholderInvoice(s.ref) ? "#9333ea" : "inherit" }}>{s.ref}</div>
                                      <div style={{ color: "#888", fontSize: "10px", marginTop: "3px" }}>
                                        <span style={amtStyle}>{formatCurrency(s.amount)}</span>
                                        {s.sentDate ? <><span style={{ margin: "0 2px" }}>·</span><span style={{ ...sentStyle, whiteSpace: "nowrap" }}>{s.sentDate}</span></> : null}
                                        {s.status ? <span style={getStatusPillStyle(s.status)}>{s.status}</span> : null}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              );
                            })}

                            {(() => {
                              let varBg = "transparent";
                              const val = parseFloat(String(r.leftToInvoice).replace(/[£$€,\s]/g,""));
                              if (!isNaN(val) && (val > 1 || val < -1)) varBg = "#f4c7c3";
                              return (
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", background: varBg }}>
                                  {showFields && formatCurrency(r.leftToInvoice)}
                                </td>
                              );
                            })()}

                            {r.expenseSlots.map(s => (
                              <td key={`exp${s.slotNum}`} onClick={() => {
                                setDirectCostsEditSlot({ rowNum: r.rowNum, slotNum: s.slotNum, slot: s });
                              }} style={{ padding: "7px 10px", borderBottom: "1px solid #eee", cursor: "pointer", borderLeft: s.slotNum === 1 ? "2px solid #f0f0f0" : "none" }} onMouseEnter={e => e.currentTarget.style.background = "#f0f4ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                                {!s.description && !s.amount ? <span style={{ color: "#ccc" }}>—</span> : (
                                  <div>
                                    <div style={{ fontWeight: "600", color: isPlaceholderExpense(s.transactionId) ? "#9333ea" : "inherit", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "155px" }}>{s.description || s.transactionId}</div>
                                    <div style={{ color: "#888", fontSize: "10px", marginTop: "3px" }}>
                                      <span>{formatCurrency(s.amount)}</span>
                                      {s.date ? <><span style={{ margin: "0 2px" }}>·</span><span style={{ whiteSpace: "nowrap" }}>{s.date}</span></> : null}
                                      {s.status ? <span style={getStatusPillStyle(s.status)}>{s.status}</span> : null}
                                    </div>
                                  </div>
                                )}
                              </td>
                            ))}

                            {(() => {
                              let costsVarBg = "transparent";
                              const val = parseFloat(String(r.costsOutstanding).replace(/[£$€,\s]/g,""));
                              if (!isNaN(val) && (val > 1 || val < -1)) costsVarBg = "#f4c7c3";
                              return (
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top", background: costsVarBg }}>
                                  {showFields && formatCurrency(r.costsOutstanding)}
                                </td>
                              );
                            })()}
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
              );
            })()}
          </>
        )}
      </div>
    </>
  );
}