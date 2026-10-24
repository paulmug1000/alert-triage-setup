import React, { useState, useEffect, useRef } from "react";
import Spinner from "./Spinner";
import RetainersEditModal from "./RetainersEditModal";
import CreateRetainerModal from "./CreateRetainerModal";
import EditClientSelector from "./EditClientSelector";
import { useRetainers } from "../hooks/useRetainers";
import { useAuth } from "../hooks/useAuth";

export default function RetainersView({
  allOutgoingsClients,
  styles,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));
  const {
    retainersClient, setRetainersClient,
    retainersJobs, setRetainersJobs,
    retainersJobsLoading,
    isTidying,
    showTidyConfirm, setShowTidyConfirm,
    tidyResult, setTidyResult,
    handleTidyRetainers,
    loadRetainersJobs
  } = useRetainers(managedClient);

  const [showCreateRetainerModal, setShowCreateRetainerModal] = useState(false);
  const [retainersEditJob, setRetainersEditJob] = useState(null);
  const [expandedRetainerJobs, setExpandedRetainerJobs] = useState(new Set());

  const prevManagedClientRef = useRef(null);
  // Auto-select managedClient when in manage mode, or clear when manage mode cancelled
  useEffect(() => {
    if (managedClient) {
      const currentName = managedClient.clientName?.toLowerCase();
      if (prevManagedClientRef.current !== currentName) {
        prevManagedClientRef.current = currentName;
        const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName) || managedClient;
        setRetainersClient(clientObj);
        loadRetainersJobs(clientObj);
      }
    } else if (prevManagedClientRef.current) {
      prevManagedClientRef.current = null;
      setRetainersClient(null);
      setRetainersJobs(null);
    }
  }, [managedClient, allOutgoingsClients]);

  const noRetClient = !retainersClient && !managedClient;

  return (
    <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
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
          clientName={retainersClient?.clientName}
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
          {retainersClient && (
            <button
              type="button"
              onClick={() => {
                if (managedClient && onClearManagedClient) {
                  onClearManagedClient();
                } else {
                  setRetainersClient(null);
                  setRetainersJobs(null);
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
              <span>Retainers</span>
            </h1>
            {retainersClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {retainersClient.clientName}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to manage their retainer jobs
              </p>
            )}
          </div>
        </div>

        {retainersClient && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {isAdmin && (
              <button
                type="button"
                className="triage-btn"
                onClick={() => setShowTidyConfirm(true)}
                disabled={isTidying}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}
              >
                {isTidying ? <><Spinner size={12} color="#1d4ed8" />Tidying...</> : "🧹 Tidy up retainers"}
              </button>
            )}
            <button
              type="button"
              className="triage-btn"
              onClick={() => setShowCreateRetainerModal(true)}
              style={{ ...styles.button, fontSize: "12px", padding: "6px 14px" }}
            >
              + Create retainer
            </button>
          </div>
        )}
      </div>

      {noRetClient && (
        <EditClientSelector
          clients={allOutgoingsClients || []}
          onSelectClient={(c) => {
            setRetainersClient(c);
            loadRetainersJobs(c);
          }}
          loading={retainersJobsLoading}
          title="Select a client to manage retainer jobs:"
        />
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
                    {["", "Row", "Client", "Job name", "Monthly £", "Start", "End", "InvSlot1", "InvSlot2", "InvSlot3"].map(h => (
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
                              {isEmpty ? <span style={{ color: "#ccc" }}>-</span> : (
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