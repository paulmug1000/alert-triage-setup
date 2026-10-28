import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import JobMatchCard from "./JobMatchCard";
import { isPlaceholderInvoice, toSheetDateFormat, getStatusPill } from "../utils/helpers";

export default function ExploreJobsModal({
  isOpen,
  onClose,
  clientSheetId,
  clientName,
  mode = "invoice", // "invoice" | "expense"
  alertItem,
  onSelectSlot,
  onViewJob,
  isAdmin = false
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!isOpen || !clientSheetId) {
      setJobs([]);
      setError(null);
      setSearchQuery("");
      return;
    }

    let isMounted = true;
    const fetchJobs = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_all_client_jobs",
            clientSheetId,
            tabName: "Confirmed"
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to load jobs");
        if (isMounted) {
          setJobs(data.jobs || []);
        }
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchJobs();

    return () => {
      isMounted = false;
    };
  }, [isOpen, clientSheetId]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Prioritize jobs with uninvoiced revenue at the top of the list, then filter by search
  const sortedAndFilteredJobs = useMemo(() => {
    if (!jobs || jobs.length === 0) return [];

    const parseSheetDate = (d) => {
      if (!d) return 0;
      const m = String(d).match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
      if (!m) return 0;
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return 0;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
      return new Date(yr, mIdx, parseInt(m[1], 10)).getTime();
    };

    const enriched = jobs.map((j) => {
      const isRet = String(j.projectRetainer || j.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
      const pRow = j.rows?.[0] || {};
      const revNum = parseFloat(String(j.revenue || pRow.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;

      let realInvoicedTotal = 0;
      let hasUnallocatedSlot = false;
      for (const jr of (j.rows || [])) {
        for (const slot of (jr.invoiceSlots || [])) {
          const ref = String(slot.ref || "").trim();
          const isReal = ref && !isPlaceholderInvoice(ref, slot.status);
          if (isReal) {
            realInvoicedTotal += parseFloat(String(slot.amount || "").replace(/[£$€,\s]/g, "")) || 0;
          } else if (slot.slotNum === 1 || (slot.amount && parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) > 0)) {
            hasUnallocatedSlot = true;
          }
        }
      }

      // Check sheet's Column BV (leftToInvoice) if present
      const sheetLeftToInv = parseFloat(String(pRow.leftToInvoice || "").replace(/[£$€,\s]/g, "")) || 0;

      let uninvoicedAmount = 0;
      let hasUninvoiced = false;

      if (isRet) {
        hasUninvoiced = hasUnallocatedSlot || sheetLeftToInv > 0;
        uninvoicedAmount = sheetLeftToInv > 0 ? sheetLeftToInv : (hasUnallocatedSlot ? revNum : 0);
      } else {
        uninvoicedAmount = sheetLeftToInv > 0 ? sheetLeftToInv : Math.max(0, revNum - realInvoicedTotal);
        hasUninvoiced = uninvoicedAmount > 0.01;
      }

      return {
        ...j,
        _hasUninvoiced: hasUninvoiced,
        _uninvoicedAmount: uninvoicedAmount,
      };
    });

    enriched.sort((a, b) => {
      // 1. Jobs with uninvoiced revenue come first
      if (a._hasUninvoiced && !b._hasUninvoiced) return -1;
      if (!a._hasUninvoiced && b._hasUninvoiced) return 1;
      // 2. Most recent start date first
      const da = parseSheetDate(a.rows?.[0]?.startDate || a.startDate);
      const db = parseSheetDate(b.rows?.[0]?.startDate || b.startDate);
      return db - da;
    });

    if (!searchQuery.trim()) return enriched;
    const q = searchQuery.toLowerCase().trim();
    return enriched.filter((j) => {
      const c = (j.client || "").toLowerCase();
      const n = (j.jobName || "").toLowerCase();
      const p = (j.projectCode || "").toLowerCase();
      return c.includes(q) || n.includes(q) || p.includes(q);
    });
  }, [jobs, searchQuery]);

  if (!isOpen) return null;

  const summary = alertItem?.summary || {};
  const acc = alertItem?.data?.accounting || [];

  const formatAmt = (val) => {
    const n = parseFloat(String(val ?? 0).replace(/[£$€,\s]/g, ""));
    if (isNaN(n)) return "0.00";
    return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const isExpense = mode === "expense";
  const invNo = !isExpense
    ? String(summary.invoiceNo || summary.reference || alertItem?.invoiceNo || alertItem?.reference || acc[5] || "").trim()
    : "";
  const expRef = isExpense
    ? String(summary.transactionId || summary.reference || alertItem?.transactionId || alertItem?.reference || alertItem?.appId || acc[3] || "").trim()
    : "";
  const rawAmt = isExpense
    ? (summary.amount ?? alertItem?.amount ?? acc[2] ?? 0)
    : (summary.amount ?? alertItem?.amount ?? acc[3] ?? acc[2] ?? 0);
  const vatNum = parseFloat(
    String(
      (isExpense ? (summary.vatAmount ?? alertItem?.vatAmount) : (summary.vatIncluded ?? alertItem?.vatIncluded ?? acc[4])) ?? 0
    ).replace(/[£$€,\s]/g, "")
  ) || 0;
  const vatSuffix = vatNum > 0 ? " +VAT" : (!isExpense ? " (no VAT)" : "");

  const itemClient = !isExpense
    ? String(summary.client || alertItem?.client || alertItem?.endClientName || acc[0] || "").trim()
    : "";
  const itemDesc = isExpense
    ? String(summary.description || alertItem?.description || alertItem?.vendor || acc[1] || "").trim()
    : String(summary.job || summary.description || alertItem?.job || alertItem?.description || acc[1] || "").trim();
  const itemCategory = isExpense
    ? String(summary.accountName || alertItem?.accountName || acc[4] || "").trim()
    : "";
  const rawDate = isExpense
    ? (summary.date || alertItem?.date || alertItem?.recDate || acc[0] || "")
    : (summary.sentDate || alertItem?.sentDate || acc[6] || "");
  const formattedDate = rawDate ? toSheetDateFormat(rawDate) : "";
  const rawDueDate = !isExpense ? (acc[7] || alertItem?.dueDate || "") : "";
  const formattedDueDate = rawDueDate ? toSheetDateFormat(rawDueDate) : "";
  const rawPaidDate = summary.datePaid || alertItem?.datePaid || (!isExpense ? acc[8] : alertItem?.payDate) || "";
  const formattedPaidDate = rawPaidDate ? toSheetDateFormat(rawPaidDate) : "";
  const itemStatus = String(summary.status || alertItem?.status || (isExpense ? acc[5] : acc[9]) || "").trim();

  const itemTitle = isExpense
    ? `Expense: £${formatAmt(rawAmt)}${vatSuffix}${itemDesc ? ` — ${itemDesc}` : ""}${expRef ? ` (#${expRef})` : ""}`
    : `Invoice: ${invNo ? `#${invNo.replace(/^#/, "")}` : "Unnumbered"} (£${formatAmt(rawAmt)}${vatSuffix})`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 1050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(96vw, 880px)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          overflow: "hidden"
        }}
      >
        {/* Modal Header */}
        <div style={{
          padding: "18px 24px",
          borderBottom: "1px solid #e2e8f0",
          background: "#f8fafc",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
          <div style={{ flex: 1, minWidth: 0, paddingRight: "16px" }}>
            <h2 style={{ fontSize: "17px", fontWeight: "700", color: "#0f172a", margin: 0 }}>
              Search & explore all confirmed jobs
            </h2>
            <div style={{ fontSize: "13px", color: "#475569", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>
                Placing <strong style={{ color: isExpense ? "#059669" : "#ea580c" }}>{itemTitle}</strong>
              </span>
              {itemStatus && (
                <span style={{
                  ...getStatusPill(itemStatus),
                  padding: "1px 8px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: "600"
                }}>
                  {itemStatus}
                </span>
              )}
            </div>
            {(itemClient || itemDesc || itemCategory || formattedDate || formattedDueDate || formattedPaidDate) && (
              <div style={{
                marginTop: "6px",
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 16px",
                fontSize: "12px",
                color: "#334155",
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                padding: "6px 10px"
              }}>
                {itemClient && (
                  <div><strong style={{ color: "#64748b" }}>Client:</strong> {itemClient}</div>
                )}
                {itemDesc && (
                  <div><strong style={{ color: "#64748b" }}>{isExpense ? "Description:" : "Description / job:"}</strong> {itemDesc}</div>
                )}
                {itemCategory && (
                  <div><strong style={{ color: "#64748b" }}>Category:</strong> {itemCategory}</div>
                )}
                {formattedDate && (
                  <div><strong style={{ color: "#64748b" }}>{isExpense ? "Date:" : "Sent date:"}</strong> {formattedDate}</div>
                )}
                {formattedDueDate && (
                  <div><strong style={{ color: "#64748b" }}>Due date:</strong> {formattedDueDate}</div>
                )}
                {formattedPaidDate && (
                  <div><strong style={{ color: "#64748b" }}>Paid date:</strong> {formattedPaidDate}</div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="triage-btn"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#475569",
              cursor: "pointer"
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Search Bar */}
        <div style={{ padding: "14px 24px", borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", fontSize: "14px", color: "#94a3b8" }}>
              🔍
            </span>
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by client name, job title, or project code..."
              style={{
                width: "100%",
                padding: "9px 12px 9px 36px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box"
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  position: "absolute",
                  right: "10px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "#94a3b8",
                  fontSize: "14px"
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Modal Body / Jobs List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px", background: "#f8fafc" }}>
          {loading && (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
              <Spinner color="#3b82f6" />
              <div style={{ marginTop: "12px", fontSize: "14px" }}>Loading Confirmed jobs...</div>
            </div>
          )}

          {error && !loading && (
            <div style={{ padding: "16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "13px" }}>
              ⚠️ {error}
            </div>
          )}

          {!loading && !error && sortedAndFilteredJobs.length === 0 && (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b", background: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "15px", fontWeight: "600", color: "#334155" }}>No matching jobs found</div>
              <div style={{ fontSize: "13px", marginTop: "4px" }}>
                {searchQuery ? `No jobs match "${searchQuery}". Try a different keyword.` : "No confirmed jobs found for this client."}
              </div>
            </div>
          )}

          {!loading && !error && sortedAndFilteredJobs.map((job) => (
            <JobMatchCard
              key={job.id || `explore-job-${job.rows?.[0]?.rowNum || job.jobName}`}
              job={job}
              mode={mode}
              isAdmin={isAdmin}
              onPlaceSlot={(j, slotNum, slot, rowNum, createNewRow, customLabel) => {
                if (onSelectSlot) {
                  onSelectSlot(j, slotNum, slot, rowNum, createNewRow, customLabel);
                }
              }}
              onViewJob={(j) => {
                if (onViewJob) {
                  onViewJob({
                    clientSheetId,
                    clientName: j.client || clientName,
                    jobName: j.jobName,
                    rowNum: j.rows?.[0]?.rowNum || j.rowNum,
                    tabName: j.tabName || "Confirmed"
                  });
                }
              }}
            />
          ))}

        </div>
      </div>
    </div>
  );
}
