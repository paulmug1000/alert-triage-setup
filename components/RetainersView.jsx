import React, { useState } from "react";
import Spinner from "./Spinner";
import RetainersEditModal from "./RetainersEditModal";
import CreateRetainerModal from "./CreateRetainerModal";
import { useRetainers } from "../hooks/useRetainers";

export default function RetainersView({
  allOutgoingsClients,
  styles
}) {
  const {
    retainersClient, setRetainersClient,
    retainersJobs, setRetainersJobs,
    retainersJobsLoading,
    isTidying,
    showTidyConfirm, setShowTidyConfirm,
    tidyResult, setTidyResult,
    handleTidyRetainers,
    loadRetainersJobs
  } = useRetainers();

  const [showCreateRetainerModal, setShowCreateRetainerModal] = useState(false);
  const [retainersEditJob, setRetainersEditJob] = useState(null);
  const [expandedRetainerJobs, setExpandedRetainerJobs] = useState(new Set());

  const noRetClient = !retainersClient;

  return (
    <div style={{ padding: "20px" }}>
      {showTidyConfirm && (
        <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowTidyConfirm(false); }}>
          <div style={styles.modalCard}>
            <h3 style={styles.modalTitle}>Tidy up retainers?</h3>
            <p style={styles.modalSubtitle}>
              This will rearrange rows in the Confirmed tab to group and alphabetize all finished and active retainers into two distinct blocks.
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
              <button onClick={handleTidyRetainers}
                style={{ padding: "8px 16px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Proceed
              </button>
              <button onClick={() => setShowTidyConfirm(false)}
                style={{ padding: "8px 16px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {tidyResult && (
        <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setTidyResult(null); }}>
          <div style={styles.modalCard}>
            <h3 style={styles.modalTitle}>{tidyResult.success ? "Tidy Up Complete" : "Error"}</h3>
            <p style={styles.modalSubtitle}>
              {tidyResult.success ? `Success! ${tidyResult.moves} moves executed.` : `Failed: ${tidyResult.error}`}
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
              <button onClick={() => setTidyResult(null)}
                style={{ padding: "8px 16px", background: tidyResult.success ? "#16a34a" : "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {retainersEditJob && (
        <RetainersEditModal
          key={retainersEditJob.parentRowNum}
          job={retainersEditJob}
          clientSheetId={retainersClient?.clientSheetId}
          masterSheetId={retainersClient?.masterSheetId}
          onClose={() => setRetainersEditJob(null)}
          onRenamedInPlace={(newJobName) => {
            setRetainersJobs(prev => prev && prev.map(j => j.parentRowNum !== retainersEditJob.parentRowNum ? j : {
              ...j, jobName: newJobName,
              rows: j.rows.map(r => ({ ...r, jobName: newJobName })),
            }));
          }}
          onNeedsReload={() => loadRetainersJobs(retainersClient)}
        />
      )}
      {showCreateRetainerModal && (
        <CreateRetainerModal
          clientName={retainersClient?.clientName}
          clientSheetId={retainersClient?.clientSheetId}
          masterSheetId={retainersClient?.masterSheetId}
          onClose={() => setShowCreateRetainerModal(false)}
          onCreated={() => loadRetainersJobs(retainersClient)}
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
          {retainersClient ? retainersClient.clientName : "Retainers"}
        </h2>
        <div style={{ display: "flex", gap: "8px" }}>
          {retainersClient && (
            <button className="triage-btn" onClick={() => setShowTidyConfirm(true)} disabled={isTidying}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
              {isTidying ? <><Spinner size={12} color="#1d4ed8" />Tidying...</> : "🧹 Tidy up retainers"}
            </button>
          )}
          {retainersClient && (
            <button className="triage-btn" onClick={() => setShowCreateRetainerModal(true)}
              style={{ ...styles.button, fontSize: "12px", padding: "5px 12px" }}>
              + Create Retainer
            </button>
          )}
          {retainersClient && (
            <button className="triage-btn" onClick={() => { setRetainersClient(null); setRetainersJobs(null); }}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
              ← Back to Clients
            </button>
          )}
        </div>
      </div>

      {noRetClient && (
        <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
          <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to manage their retainer jobs:</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {(allOutgoingsClients || []).map(c => (
              <button key={c.clientName} className="triage-btn"
                onClick={() => { setRetainersClient(c); loadRetainersJobs(c); }}
                style={{ ...styles.buttonSecondary, textAlign: "left", padding: "12px 16px", fontSize: "14px" }}>
                {c.clientName}
              </button>
            ))}
            {(!allOutgoingsClients || allOutgoingsClients.length === 0) && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet — go to Home and refresh first.</p>}
          </div>
        </div>
      )}

      {!noRetClient && (
        <>
          {retainersJobsLoading && (
            <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading retainer jobs...</div>
          )}
          {!retainersJobsLoading && retainersJobs && retainersJobs.length === 0 && (
            <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>No active (or recently-ended) retainer jobs found for this client.</div>
          )}
          {!retainersJobsLoading && retainersJobs && retainersJobs.length > 0 && (
            <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1100px", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "24px" }} />
                  <col style={{ width: "50px" }} />
                  <col style={{ width: "130px" }} />
                  <col style={{ width: "160px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "150px" }} />
                  <col style={{ width: "150px" }} />
                  <col style={{ width: "150px" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f5f6fa" }}>
                    {["","Row","Client","Job name","Monthly £","Start","End","InvSlot1","InvSlot2","InvSlot3"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {retainersJobs.flatMap((job, jobIdx) => {
                    const isExpanded = expandedRetainerJobs.has(job.parentRowNum);
                    const visibleRows = isExpanded ? job.rows : job.rows.slice(0, 1);
                    return visibleRows.map((jr, rIdx) => (
                      <tr key={jr.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#fafbfd" }}>
                        <td style={{ padding: "7px 4px", borderBottom: "1px solid #eee", textAlign: "center" }}>
                          {rIdx === 0 && job.rows.length > 1 && (
                            <span
                              onClick={() => setExpandedRetainerJobs(prev => {
                                const next = new Set(prev);
                                if (next.has(job.parentRowNum)) next.delete(job.parentRowNum); else next.add(job.parentRowNum);
                                return next;
                              })}
                              style={{ cursor: "pointer", color: "#7c3aed", fontSize: "11px", userSelect: "none" }}
                              title={isExpanded ? "Collapse" : `Show ${job.rows.length - 1} more row(s)`}>
                              {isExpanded ? "▼" : "▶"}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? job.client : ""}</td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", fontWeight: rIdx === 0 ? "600" : "normal" }}>
                          {rIdx === 0 ? (
                            <span onClick={() => setRetainersEditJob(job)} style={{ cursor: "pointer" }}>
                              {jr.jobName} <span style={{ color: "#7c3aed", fontSize: "10px" }}>✎ edit</span>
                            </span>
                          ) : ""}
                        </td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{rIdx === 0 ? job.revenue : ""}</td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                        <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.endDate}</td>
                        {jr.invoiceSlots.map(s => {
                          const isEmpty = !s.ref && !s.amount;
                          return (
                            <td key={s.slotNum} style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>
                              {isEmpty ? <span style={{ color: "#ccc" }}>—</span> : (
                                <div>
                                  <div style={{ fontWeight: "600" }}>{s.ref}</div>
                                  <div style={{ color: "#888" }}>{/^[£$€]/.test(String(s.amount)) ? s.amount : `£${s.amount}`} · {s.sentDate}{s.status ? ` · ${s.status}` : ""}</div>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}