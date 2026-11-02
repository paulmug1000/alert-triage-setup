import React, { useState, useEffect, useRef, useMemo } from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaRetainersTableSkeleton } from "./Skeleton";
import RetainersEditModal from "./RetainersEditModal";
import CreateRetainerModal from "./CreateRetainerModal";
import InvoicesEditModal from "./InvoicesEditModal";
import EditClientSelector from "./EditClientSelector";
import PlaceholderPill, { isAutoPlaceholder } from "./PlaceholderPill";
import { formatCurrency, toSheetDateFormat } from "./JobsView";
import { useRetainers } from "../hooks/useRetainers";
import { useAuth } from "../hooks/useAuth";
import {
  formatJobEndDateDisplay,
  stripCurrency,
  isPlaceholderInvoice,
  getRetainerRowMonthLabel,
  calculatePaymentDate,
  groupSlotItemsForDisplay,
} from "../utils/helpers";

function getStatusPill(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") {
    return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  }
  if (s === "sent") {
    return { background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" };
  }
  if (s === "overdue") {
    return { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" };
  }
  if (s.includes("part")) {
    return { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  if (s === "placeholder" || s === "unsent") {
    return { background: "#f3e8ff", color: "#6b21a8", border: "1px solid #e9d5ff" };
  }
  return { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
}

function getRetainerJobInvoiceItems(job) {
  if (!job || !Array.isArray(job.rows) || job.rows.length === 0) return [];
  const items = [];
  job.rows.forEach((r, rIdx) => {
    const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
    const slots = r.invoiceSlots || [];
    slots.forEach((s) => {
      const hasRef = Boolean(s.ref && String(s.ref).trim() !== "");
      const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
      if (hasRef || hasAmt) {
        const isPartPaid = String(s.status || "").toLowerCase().includes("part");
        const isPlace = isPlaceholderInvoice(s.ref, s.status);
        const extraRef = s.ref && String(s.ref).trim() !== ""
          ? `#${String(s.ref).trim()}`
          : (isPlace ? "Placeholder" : (isPartPaid ? "Part payment" : monthLabel));
        items.push({
          id: `ret_inv_${r.rowNum}_${s.slotNum}`,
          rowNum: r.rowNum,
          slotNum: s.slotNum,
          slot: s,
          row: r,
          label: extraRef,
          subLabel: s.sentDate ? `${s.sentDate}` : "",
        });
      }
    });
  });
  return items;
}

const RET_SHORT_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseRetainerSortDate(val) {
  if (!val) return 0;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = RET_SHORT_MONTHS[m[2].toLowerCase()];
    if (mi !== undefined) {
      let yr = parseInt(m[3], 10);
      if (m[3].length === 2) yr += yr <= 69 ? 2000 : 1900;
      return new Date(yr, mi, parseInt(m[1], 10)).getTime();
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

export default function RetainersView({
  allOutgoingsClients,
  styles,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient
}) {
  const auth = useAuth();
  const isSysAdmin = Boolean(!auth.user?.isReadOnly && (auth.user?.isAdmin || auth.user?.role === "Admin"));
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : isSysAdmin;
  const {
    retainersClient, setRetainersClient,
    retainersJobs, setRetainersJobs,
    retainersJobsLoading, setRetainersJobsLoading,
    isTidying,
    showTidyConfirm, setShowTidyConfirm,
    tidyResult, setTidyResult,
    handleTidyRetainers,
    loadRetainersJobs
  } = useRetainers(managedClient || initialClient);

  const [showCreateRetainerModal, setShowCreateRetainerModal] = useState(false);
  const [retainersEditJob, setRetainersEditJob] = useState(null);
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [expandedRetainerJobs, setExpandedRetainerJobs] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("client_asc");
  const [showCompletedRetainers, setShowCompletedRetainers] = useState(false);

  const filteredAndSortedJobs = useMemo(() => {
    if (!Array.isArray(retainersJobs)) return [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const q = searchQuery.trim().toLowerCase();
    const filtered = retainersJobs.filter((job) => {
      const isCompleted = job.isCompleted !== undefined
        ? Boolean(job.isCompleted)
        : Boolean(job.rows?.[0]?.endDate && !String(job.rows[0].endDate).includes("2050") && parseRetainerSortDate(job.rows[0].endDate) > 0 && parseRetainerSortDate(job.rows[0].endDate) < todayStart.getTime());
      if (!showCompletedRetainers && isCompleted) return false;
      if (!q) return true;
      return (
        String(job.client || "").toLowerCase().includes(q) ||
        String(job.jobName || "").toLowerCase().includes(q) ||
        String(job.projectCode || "").toLowerCase().includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === "start_asc" || sortBy === "start_desc") {
        const da = parseRetainerSortDate(a.rows?.[0]?.startDate);
        const db = parseRetainerSortDate(b.rows?.[0]?.startDate);
        if (da !== db) return sortBy === "start_asc" ? da - db : db - da;
      } else if (sortBy === "rev_asc" || sortBy === "rev_desc") {
        const ra = parseFloat(stripCurrency(a.revenue)) || 0;
        const rb = parseFloat(stripCurrency(b.revenue)) || 0;
        if (ra !== rb) return sortBy === "rev_asc" ? ra - rb : rb - ra;
      }
      const ca = String(a.client || "").toLowerCase();
      const cb = String(b.client || "").toLowerCase();
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.jobName || "").toLowerCase().localeCompare(String(b.jobName || "").toLowerCase());
    });
  }, [retainersJobs, searchQuery, sortBy, showCompletedRetainers]);

  const prevInitialClientRef = useRef(null);
  const prevManagedClientRef = useRef(null);
  // Auto-select managedClient when in manage mode, or initialClient when passed, or clear when manage mode cancelled
  useEffect(() => {
    if (managedClient) {
      const currentName = managedClient.clientName?.toLowerCase();
      const hasFullClient = Boolean(retainersClient?.clientSheetId);
      const clientWithSheet = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName && c.clientSheetId) || (managedClient.clientSheetId ? managedClient : null);
      if (prevManagedClientRef.current !== currentName || (!hasFullClient && clientWithSheet)) {
        prevManagedClientRef.current = currentName;
        const clientObj = clientWithSheet || (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName) || managedClient;
        setRetainersClient(clientObj);
        if (clientObj?.clientSheetId) {
          loadRetainersJobs(clientObj);
        } else {
          setRetainersJobsLoading(true);
        }
      }
    } else if (initialClient && (initialClient !== prevInitialClientRef.current || (!retainersClient?.clientSheetId && initialClient.clientSheetId))) {
      prevInitialClientRef.current = initialClient;
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === initialClient.clientName?.toLowerCase()) || initialClient;
      setRetainersClient(clientObj);
      if (clientObj?.clientSheetId) {
        loadRetainersJobs(clientObj);
      } else {
        setRetainersJobsLoading(true);
      }
    } else if (prevManagedClientRef.current) {
      prevManagedClientRef.current = null;
      setRetainersClient(null);
      setRetainersJobs(null);
    }
  }, [managedClient, initialClient, allOutgoingsClients, retainersClient?.clientSheetId]);

  const noRetClient = !retainersClient && !managedClient;

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
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
          onNeedsReload={() => loadRetainersJobs(retainersClient, true)}
        />
      )}
      {showCreateRetainerModal && (
        <CreateRetainerModal
          clientName={retainersClient?.clientName}
          clientSheetId={retainersClient?.clientSheetId}
          masterSheetId={retainersClient?.masterSheetId}
          onClose={() => setShowCreateRetainerModal(false)}
          onCreated={(resData) => {
            loadRetainersJobs(retainersClient, true);
            if (resData?.backgroundProvisioning) {
              setTimeout(() => loadRetainersJobs(retainersClient, true, true), 4000);
              setTimeout(() => loadRetainersJobs(retainersClient, true, true), 8000);
            }
          }}
        />
      )}
      {invoicesEditSlot && (
        <InvoicesEditModal
          editSlot={invoicesEditSlot}
          invoicesClient={retainersClient}
          availableJobs={retainersJobs}
          onClose={() => setInvoicesEditSlot(null)}
          onInvoiceMoved={() => loadRetainersJobs(retainersClient, true)}
          onUpdateInvoiceJobs={(rNum, sNum, newData) => {
            if (invoicesEditSlot?.createNewRow) {
              loadRetainersJobs(retainersClient, true);
              return;
            }
            setRetainersJobs((prev) =>
              prev &&
              prev.map((j) => ({
                ...j,
                rows: j.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                        ...r,
                        invoiceSlots: r.invoiceSlots.map((sl) =>
                          sl.slotNum !== sNum ? sl : { ...sl, ...newData }
                        ),
                      }
                ),
              }))
            );
          }}
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
          {retainersClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
            <button
              type="button"
              onClick={() => {
                if (managedClient && onClearManagedClient) {
                  onClearManagedClient();
                } else {
                  setRetainersClient(null);
                  setRetainersJobs(null);
                  onSelectClient?.(null);
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
            {retainersClient && (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {retainersClient.clientName}
              </div>
            )}
          </div>
        </div>

        {retainersClient && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              className="triage-btn"
              onClick={() => loadRetainersJobs(retainersClient, true)}
              disabled={retainersJobsLoading}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", display: "inline-flex", alignItems: "center", gap: "6px", opacity: retainersJobsLoading ? 0.7 : 1 }}
              title={isSysAdmin ? "Refresh retainers from live sheets" : "Refresh retainers"}
            >
              {retainersJobsLoading ? <><Spinner size={12} color="#475569" /> Refreshing...</> : "↻ Refresh"}
            </button>
            {isSysAdmin && (
              <button
                type="button"
                className="triage-btn"
                onClick={() => setShowTidyConfirm(true)}
                disabled={isTidying}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}
              >
                {isTidying ? <><Spinner size={12} color="#1d4ed8" />Tidying...</> : "Tidy up retainers"}
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
            const targetName = String(c?.clientName || c?.name || "").trim().toLowerCase();
            const fullC =
              (allOutgoingsClients || []).find(item => String(item.clientName || "").trim().toLowerCase() === targetName && item.clientSheetId) ||
              c;
            prevInitialClientRef.current = fullC;
            setRetainersClient(fullC);
            setRetainersJobs(null);
            setRetainersJobsLoading(true);
            onSelectClient?.(fullC);
            if (fullC.clientSheetId) {
              loadRetainersJobs(fullC);
            }
          }}
          loading={(allOutgoingsClients || []).length === 0}
          title="Select a client to manage retainer jobs:"
        />
      )}

      {!noRetClient && (
        <>
          {retainersJobs && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                marginBottom: "14px",
                padding: "12px 16px",
                background: "#fff",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", flex: "1 1 320px" }}>
                <input
                  type="text"
                  placeholder="Search client or job name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    padding: "7px 12px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    minWidth: "240px",
                    outline: "none",
                  }}
                />
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>
                    Sort by:
                  </label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    style={{
                      padding: "6px 10px",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "13px",
                      background: "#fff",
                      color: "#1e293b",
                      cursor: "pointer",
                    }}
                  >
                    <option value="client_asc">Client name</option>
                    <option value="start_asc">Start date (ascending)</option>
                    <option value="start_desc">Start date (descending)</option>
                    <option value="rev_asc">Revenue (ascending)</option>
                    <option value="rev_desc">Revenue (descending)</option>
                  </select>
                </div>
              </div>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "#475569",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={showCompletedRetainers}
                  onChange={(e) => setShowCompletedRetainers(e.target.checked)}
                  style={{ margin: 0, cursor: "pointer" }}
                />
                Show completed retainers
              </label>
            </div>
          )}

          {(retainersJobsLoading || !retainersJobs) && !retainersJobs && (
            <PmaRetainersTableSkeleton />
          )}
          {!retainersJobsLoading && retainersJobs && filteredAndSortedJobs.length === 0 && (
            <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>
              {retainersJobs.length > 0
                ? "No retainer jobs match the current filter."
                : "No active retainer jobs found for this client."}
            </div>
          )}
          {retainersJobs && filteredAndSortedJobs.length > 0 && (
            <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "680px", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "36px" }} />
                  {isSysAdmin && <col style={{ width: "56px" }} />}
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f5f6fa" }}>
                    {(isSysAdmin
                      ? ["", "Row", "Client", "Job name", "Monthly £", "Start", "End"]
                      : ["", "Client", "Job name", "Monthly £", "Start", "End"]
                    ).map(h => (
                      <th
                        key={h}
                        style={{
                          padding: "9px 12px",
                          textAlign: h === "Monthly £" ? "right" : "left",
                          borderBottom: "2px solid #ddd",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedJobs.map((job, jobIdx) => {
                    const isExpanded = expandedRetainerJobs.has(job.parentRowNum);
                    const jr = job.rows?.[0] || {};
                    const invoiceItems = isExpanded ? groupSlotItemsForDisplay(getRetainerJobInvoiceItems(job), "invoice") : [];
                    const toggleExpand = () => {
                      setExpandedRetainerJobs(prev => {
                        const next = new Set(prev);
                        if (next.has(job.parentRowNum)) next.delete(job.parentRowNum);
                        else next.add(job.parentRowNum);
                        return next;
                      });
                    };

                    return (
                      <React.Fragment key={job.parentRowNum || jr.rowNum}>
                        <tr
                          onClick={toggleExpand}
                          style={{
                            background: isExpanded ? "#f8fafc" : (jobIdx % 2 === 0 ? "#fff" : "#fafbfd"),
                            cursor: "pointer",
                            transition: "background-color 0.15s ease"
                          }}
                        >
                          <td style={{ padding: "8px 4px", borderBottom: "1px solid #eee", textAlign: "center" }}>
                            <span
                              style={{ cursor: "pointer", color: "#7c3aed", fontSize: "11px", userSelect: "none", display: "inline-block", width: "20px" }}
                              title={isExpanded ? "Collapse invoices" : "Expand attached invoices"}
                            >
                              {isExpanded ? "▼" : "▶"}
                            </span>
                          </td>
                          {isSysAdmin && <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>}
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee" }}>{job.client}</td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", fontWeight: "600" }}>
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setRetainersEditJob(job);
                              }}
                              style={{ cursor: "pointer" }}
                              title="Edit retainer details"
                            >
                              {jr.jobName || job.jobName} <span style={{ color: "#7c3aed", fontSize: "10px", marginLeft: "4px" }}>✎ edit</span>
                            </span>
                          </td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600", color: "#0f172a" }}>
                            {formatCurrency(job.revenue) || job.revenue}
                          </td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                          <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                            {jr.endDate ? formatJobEndDateDisplay(jr.endDate, "") : ""}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr style={{ background: "#f8fafc" }}>
                            <td colSpan={isSysAdmin ? 7 : 6} style={{ padding: "14px 20px 18px 36px", borderBottom: "2px solid #cbd5e1" }}>
                              <div
                                style={{
                                  background: "#ffffff",
                                  borderRadius: "8px",
                                  border: "1px solid #e2e8f0",
                                  padding: "14px 16px",
                                  maxWidth: "760px",
                                  boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px", paddingBottom: "8px", borderBottom: "1px solid #f1f5f9" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#1e293b" }}>Invoices</span>
                                    <span style={{ fontSize: "11px", padding: "1px 7px", borderRadius: "10px", background: "#f1f5f9", color: "#475569", fontWeight: "600" }}>
                                      {invoiceItems.length}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRetainersEditJob(job);
                                    }}
                                    style={{
                                      padding: "4px 10px",
                                      borderRadius: "6px",
                                      border: "1px solid #cbd5e1",
                                      background: "#ffffff",
                                      color: "#475569",
                                      fontSize: "11px",
                                      fontWeight: "600",
                                      cursor: "pointer"
                                    }}
                                  >
                                    Manage retainer
                                  </button>
                                </div>

                                <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "360px", overflowY: "auto", paddingRight: "4px" }}>
                                  {invoiceItems.length === 0 ? (
                                    <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                                      No invoices found.
                                    </div>
                                  ) : (
                                    invoiceItems.map((item) => {
                                      if (item.isComposite) {
                                        return (
                                          <div
                                            key={item.id}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              const targetSlotItem = item.balanceTranche || item.receivedTranches[0] || item;
                                              setInvoicesEditSlot({
                                                rowNum: targetSlotItem.rowNum,
                                                slotNum: targetSlotItem.slotNum,
                                                slot: targetSlotItem.slot,
                                                jobClient: targetSlotItem.row?.client || jr.client || job.client,
                                                jobName: targetSlotItem.row?.jobName || jr.jobName || job.jobName,
                                                slotLabel: item.label,
                                                tabName: "Confirmed",
                                                job,
                                              });
                                            }}
                                            style={{
                                              padding: "9px 12px",
                                              borderRadius: "7px",
                                              border: "1px solid #bfdbfe",
                                              background: "#ffffff",
                                              cursor: "pointer",
                                              transition: "all 0.15s ease",
                                              boxSizing: "border-box",
                                              maxWidth: "100%",
                                              overflow: "hidden",
                                              flexShrink: 0,
                                              display: "flex",
                                              flexDirection: "column",
                                              gap: "5px"
                                            }}
                                            title="Part-paid invoice. Click to view or edit balance payment terms."
                                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#bfdbfe"; e.currentTarget.style.background = "#ffffff"; }}
                                          >
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                  #{item.slot.ref}
                                                </span>
                                                <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", background: item.isFullyPaid ? "#dcfce7" : "#eff6ff", color: item.isFullyPaid ? "#166534" : "#1d4ed8", border: item.isFullyPaid ? "1px solid #bbf7d0" : "1px solid #bfdbfe" }}>
                                                  {item.isFullyPaid ? `Paid in full (${item.receivedTranches.length} payments)` : `Part-paid (${item.percentPaid.toFixed(1)}%)`}
                                                </span>
                                                {item.row && (
                                                  <span style={{ fontSize: "10px", color: "#64748b" }}>
                                                    ({getRetainerRowMonthLabel(item.row, 0, job)})
                                                  </span>
                                                )}
                                              </div>
                                              <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                                Total: {formatCurrency(item.totalAmount)}
                                              </div>
                                            </div>

                                            <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                              <div
                                                style={{
                                                  width: `${Math.min(100, Math.max(0, item.percentPaid))}%`,
                                                  height: "100%",
                                                  background: "#10b981",
                                                  borderRadius: "2px",
                                                }}
                                              />
                                            </div>

                                            {item.isFullyPaid ? (
                                              <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                                {item.receivedTranches.map((t, tIdx) => (
                                                  <div key={tIdx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                    <span style={{ color: "#166534", fontWeight: "600" }}>
                                                      ✓ Payment {tIdx + 1}: {formatCurrency(parseFloat(stripCurrency(t.slot?.amount)) || 0)}
                                                    </span>
                                                    <span style={{ color: "#64748b" }}>
                                                      {t.slot?.sentDate ? `Sent: ${t.slot.sentDate}` : ""}
                                                      {t.slot?.daysToPay ? ` · Paid: ${t.slot.daysToPay}d` : ""}
                                                    </span>
                                                  </div>
                                                ))}
                                              </div>
                                            ) : (
                                              <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                  <span style={{ color: "#166534", fontWeight: "600" }}>
                                                    ✓ {formatCurrency(item.receivedAmount)} received
                                                  </span>
                                                  <span style={{ color: "#64748b" }}>
                                                    {item.receivedTranches[0]?.slot?.sentDate ? `Sent: ${item.receivedTranches[0].slot.sentDate}` : ""}
                                                    {item.receivedTranches[0]?.slot?.daysToPay ? ` · Paid: ${item.receivedTranches[0].slot.daysToPay}d` : ""}
                                                  </span>
                                                </div>
                                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                  <span style={{ color: "#b45309", fontWeight: "600" }}>
                                                    ⏳ {formatCurrency(item.balanceAmount)} balance
                                                  </span>
                                                  <span style={{ color: "#64748b" }}>
                                                    {item.balanceTranche?.slot?.sentDate && calculatePaymentDate(item.balanceTranche.slot.sentDate, item.balanceTranche.slot.daysToPay || 30) ? (
                                                      `Due: ${calculatePaymentDate(item.balanceTranche.slot.sentDate, item.balanceTranche.slot.daysToPay || 30)} (${item.balanceTranche.slot.daysToPay || 30}d)`
                                                    ) : (
                                                      item.balanceTranche ? `${item.balanceTranche.slot?.daysToPay || 30} days` : "Fully paid"
                                                    )}
                                                  </span>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      }

                                      const slot = item.slot;
                                      const hasData = Boolean((slot.ref && String(slot.ref).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                                      const isPlaceholder = isPlaceholderInvoice(slot.ref, slot.status);
                                      const pillStyle = getStatusPill(slot.status);
                                      const isPaid = String(slot.status || "").trim().toLowerCase() === "paid";

                                      return (
                                        <div
                                          key={item.id}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setInvoicesEditSlot({
                                              rowNum: item.rowNum,
                                              slotNum: item.slotNum,
                                              slot,
                                              jobClient: item.row?.client || jr.client || job.client,
                                              jobName: item.row?.jobName || jr.jobName || job.jobName,
                                              slotLabel: slot.ref ? `#${slot.ref}` : (isPlaceholder ? "Placeholder" : (isSysAdmin ? `Slot ${item.slotNum}` : `Invoice ${item.slotNum}`)),
                                              tabName: "Confirmed",
                                              job,
                                            });
                                          }}
                                          style={{
                                            padding: "9px 12px",
                                            borderRadius: "7px",
                                            border: "1px solid #e2e8f0",
                                            background: "#ffffff",
                                            cursor: "pointer",
                                            transition: "all 0.15s ease",
                                            boxSizing: "border-box",
                                            maxWidth: "100%",
                                            overflow: "hidden",
                                            flexShrink: 0,
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: "5px",
                                            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                          }}
                                          title="Click to edit invoice"
                                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.background = "#ffffff"; }}
                                        >
                                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                              {isPlaceholder ? (
                                                <PlaceholderPill isAuto={isAutoPlaceholder(slot.ref)} size="sm" />
                                              ) : slot.ref ? (
                                                <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                  #{slot.ref}
                                                </span>
                                              ) : (
                                                <span style={{ fontSize: "12px", fontWeight: "600", color: "#475569" }}>
                                                  Invoice
                                                </span>
                                              )}

                                              {hasData && slot.status && (
                                                <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                                  {slot.status}
                                                </span>
                                              )}

                                              {item.row && (
                                                <span style={{ fontSize: "10px", color: "#64748b" }}>
                                                  ({getRetainerRowMonthLabel(item.row, 0, job)})
                                                </span>
                                              )}
                                            </div>

                                            <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                              {formatCurrency(slot.amount)}
                                            </span>
                                          </div>

                                          {isPaid && (
                                            <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                              <div style={{ width: "100%", height: "100%", background: "#10b981", borderRadius: "2px" }} />
                                            </div>
                                          )}

                                          {hasData && (
                                            isPaid ? (
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                                <span style={{ color: "#166534", fontWeight: 600 }}>
                                                  ✓ {formatCurrency(slot.amount)} paid
                                                </span>
                                                <span style={{ color: "#64748b" }}>
                                                  {slot.sentDate ? `Sent: ${toSheetDateFormat(slot.sentDate)}` : ""}
                                                  {slot.daysToPay ? ` · Paid: ${slot.daysToPay}d` : ""}
                                                </span>
                                              </div>
                                            ) : (
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                                <span style={{ color: "#b45309", fontWeight: 600 }}>
                                                  {calculatePaymentDate(slot.sentDate, slot.daysToPay || 30)
                                                    ? `Due: ${calculatePaymentDate(slot.sentDate, slot.daysToPay || 30)}`
                                                    : `Expected in ${slot.daysToPay || 30}d`}
                                                </span>
                                                <span style={{ color: "#64748b" }}>
                                                  {slot.sentDate ? `Sent: ${toSheetDateFormat(slot.sentDate)} (${slot.daysToPay || 30}d)` : `Terms: ${slot.daysToPay || 30}d`}
                                                </span>
                                              </div>
                                            )
                                          )}
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
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