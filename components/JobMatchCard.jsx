import React, { useState } from "react";
import {
  formatCurrency,
  getStatusPill,
  getJobInvoiceItems,
  getJobExpenseItems,
  getJobFinancialMetrics
} from "./JobsView";
import { isPlaceholderInvoice, isPlaceholderExpense, cleanUserFacingText } from "../utils/helpers";

const fmtGBP = (val) => {
  const num = typeof val === "number" ? val : (parseFloat(String(val || "0").replace(/[£$€,\s]/g, "")) || 0);
  return "£" + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * Normalizes either raw rows from fetchJobRowsForDisplay (which have isParent: true on row 0)
 * or unified job objects into an array of unified jobs with job.rows intact.
 * If fallbackDetails is supplied, backfills missing parent fields (client, jobName, revenue, dates, etc.).
 */
export function buildJobsFromRows(input, fallbackDetails = null) {
  if (!input && !fallbackDetails) return [];
  const items = Array.isArray(input) ? input : (input ? [input] : []);

  // Helper to extract clean fallback values
  const fbClient = fallbackDetails?.clientName || fallbackDetails?.client || "";
  const fbJobName = fallbackDetails?.jobName || fallbackDetails?.job || "";
  const fbProjectCode = fallbackDetails?.projectCode || "";
  const fbRev = fallbackDetails?.revenue || "0";
  const fbCosts = fallbackDetails?.directCosts || "0";
  const fbType = fallbackDetails?.projectRetainer || fallbackDetails?.type || "";
  const fbStart = fallbackDetails?.startDate || "";
  const fbEnd = fallbackDetails?.endDate || "";
  const fbTab = fallbackDetails?.tabName || "Confirmed";

  // If no items at all, but fallbackDetails exists, create a synthetic unified job
  if (items.length === 0 && (fbClient || fbJobName)) {
    return [{
      id: "synthetic_job_1",
      rowNum: fallbackDetails?.rowNum || 1,
      tabName: fbTab,
      status: fbTab,
      client: fbClient,
      jobName: fbJobName,
      projectCode: fbProjectCode,
      projectRetainer: fbType,
      revenue: fbRev,
      directCosts: fbCosts,
      vat: fallbackDetails?.vatSetting || "Yes",
      startDate: fbStart,
      endDate: fbEnd,
      likelihood: fallbackDetails?.likelihood || 100,
      rows: [{
        rowNum: fallbackDetails?.rowNum || 1,
        isParent: true,
        client: fbClient,
        jobName: fbJobName,
        projectCode: fbProjectCode,
        projectRetainer: fbType,
        revenue: fbRev,
        directCosts: fbCosts,
        startDate: fbStart,
        endDate: fbEnd,
        invoiceSlots: [],
        expenseSlots: []
      }]
    }];
  }

  // If already an array of jobs where items have a .rows array, enrich them with fallbacks if needed
  if (items[0] && Array.isArray(items[0].rows)) {
    return items.map((j) => {
      const p = j.rows?.find(r => r.isParent) || j.rows?.[0] || j;
      const client = j.client || p.client || fbClient;
      const jobName = j.jobName || p.jobName || fbJobName;
      let revenue = (j.revenue && j.revenue !== "0") ? j.revenue : (p.revenue && p.revenue !== "0" ? p.revenue : fbRev);
      let directCosts = (j.directCosts && j.directCosts !== "0") ? j.directCosts : (p.directCosts && p.directCosts !== "0" ? p.directCosts : fbCosts);
      let projectRetainer = j.projectRetainer || p.projectRetainer || fbType;
      let startDate = j.startDate || p.startDate || fbStart;
      let endDate = j.endDate || p.endDate || fbEnd;


      // Scan rows for monthly amount if revenue is blank or zero
      if (!revenue || revenue === "0") {
        for (const r of (j.rows || [])) {
          if (r.revenue && String(r.revenue).trim() !== "" && String(r.revenue).trim() !== "0") {
            revenue = r.revenue;
            break;
          }
          const sAmt = r.invoiceSlots?.[0]?.amount;
          if (sAmt && parseFloat(String(sAmt).replace(/[£$€,\s]/g, "")) > 0) {
            revenue = sAmt;
            break;
          }
        }
      }

      // Scan rows for start date if missing
      if (!startDate) {
        for (const r of (j.rows || [])) {
          if (r.startDate) { startDate = r.startDate; break; }
          const sDate = r.invoiceSlots?.[0]?.sentDate || r.expenseSlots?.[0]?.date;
          if (sDate) { startDate = sDate; break; }
        }
      }

      // Scan rows for end date if missing
      if (!endDate) {
        for (let idx = (j.rows || []).length - 1; idx >= 0; idx--) {
          const r = j.rows[idx];
          if (r.endDate) { endDate = r.endDate; break; }
          const sDate = r.invoiceSlots?.[0]?.sentDate || r.expenseSlots?.[0]?.date;
          if (sDate) { endDate = sDate; break; }
        }
      }

      if (p) {
        p.client = client;
        p.jobName = jobName;
        p.revenue = revenue;
        p.directCosts = directCosts;
        p.projectRetainer = projectRetainer;
        p.startDate = startDate;
        p.endDate = endDate;
        p.projectCode = j.projectCode || p.projectCode || fbProjectCode;
      }

      return {
        ...j,
        client,
        jobName,
        revenue,
        directCosts,
        projectRetainer,
        startDate,
        endDate,
        projectCode: j.projectCode || p?.projectCode || fbProjectCode
      };
    });
  }

  // Otherwise, group raw spreadsheet rows into unified jobs
  const jobs = [];
  let currentJob = null;

  for (const r of items) {
    if (!r) continue;
    const isNewParent = r.isParent || !currentJob || (
      r.client && r.jobName && (r.startDate || r.endDate || (r.revenue && parseFloat(String(r.revenue).replace(/[£$€,\s]/g, "")) > 0))
    );

    if (isNewParent) {
      currentJob = {
        id: `job_${r.rowNum || jobs.length + 1}`,
        rowNum: r.rowNum,
        tabName: r.tabName || fbTab || "Confirmed",
        status: r.tabName || fbTab || "Confirmed",
        client: r.client || fbClient || "",
        jobName: r.jobName || fbJobName || "",
        projectCode: r.projectCode || fbProjectCode || "",
        projectRetainer: r.projectRetainer || fbType || "",
        revenue: (r.revenue && r.revenue !== "0") ? r.revenue : fbRev,
        directCosts: (r.directCosts && r.directCosts !== "0") ? r.directCosts : fbCosts,
        vat: r.vat || "Yes",
        startDate: r.startDate || fbStart || "",
        endDate: r.endDate || fbEnd || "",
        likelihood: r.likelihood !== undefined ? r.likelihood : 100,
        unevenSplit: r.unevenSplit || "",
        rows: [r]
      };
      jobs.push(currentJob);
    } else {
      currentJob.rows.push(r);
    }
  }

  // Backfill parent job fields if rows only had child data
  jobs.forEach((j) => {
    if (!j.client && fbClient) j.client = fbClient;
    if (!j.jobName && fbJobName) j.jobName = fbJobName;


    // Scan rows for monthly revenue if blank or 0
    if (!j.revenue || j.revenue === "0") {
      for (const r of (j.rows || [])) {
        if (r.revenue && String(r.revenue).trim() !== "" && String(r.revenue).trim() !== "0") {
          j.revenue = r.revenue;
          break;
        }
        const sAmt = r.invoiceSlots?.[0]?.amount;
        if (sAmt && parseFloat(String(sAmt).replace(/[£$€,\s]/g, "")) > 0) {
          j.revenue = sAmt;
          break;
        }
      }
      if ((!j.revenue || j.revenue === "0") && fbRev) j.revenue = fbRev;
    }

    // Scan rows for direct costs if missing
    if (!j.directCosts || j.directCosts === "0") {
      for (const r of (j.rows || [])) {
        if (r.directCosts && r.directCosts !== "0") { j.directCosts = r.directCosts; break; }
      }
      if ((!j.directCosts || j.directCosts === "0") && fbCosts) j.directCosts = fbCosts;
    }

    // Scan rows for start date if missing
    if (!j.startDate) {
      for (const r of (j.rows || [])) {
        if (r.startDate) { j.startDate = r.startDate; break; }
        const sDate = r.invoiceSlots?.[0]?.sentDate || r.expenseSlots?.[0]?.date;
        if (sDate) { j.startDate = sDate; break; }
      }
      if (!j.startDate && fbStart) j.startDate = fbStart;
    }

    // Scan rows for end date if missing
    if (!j.endDate) {
      for (let idx = (j.rows || []).length - 1; idx >= 0; idx--) {
        const r = j.rows[idx];
        if (r.endDate) { j.endDate = r.endDate; break; }
        const sDate = r.invoiceSlots?.[0]?.sentDate || r.expenseSlots?.[0]?.date;
        if (sDate) { j.endDate = sDate; break; }
      }
      if (!j.endDate && fbEnd) j.endDate = fbEnd;
    }

    if (!j.projectRetainer && fbType) j.projectRetainer = fbType;
    if (!j.projectCode && fbProjectCode) j.projectCode = fbProjectCode;

    // Sync resolved fields to parent row
    if (j.rows && j.rows[0]) {
      j.rows[0].client = j.client;
      j.rows[0].jobName = j.jobName;
      j.rows[0].revenue = j.revenue;
      j.rows[0].directCosts = j.directCosts;
      j.rows[0].projectRetainer = j.projectRetainer;
      j.rows[0].startDate = j.startDate;
      j.rows[0].endDate = j.endDate;
      j.rows[0].projectCode = j.projectCode;
    }
  });

  return jobs;
}

export default function JobMatchCard({
  job,
  jobRow,
  jobDetails,
  mode = "invoice", // "invoice" | "expense"
  onPlaceSlot,
  onViewJob,
  isAdmin = false,
  confidence,
  recommendationReason,
  candidateIndex,
  alertSummary
}) {
  const [showHistory, setShowHistory] = useState(false);

  // Normalize input to unified job
  const rawTarget = job || jobRow;
  if (!rawTarget && !jobDetails) return null;

  const unifiedJobs = buildJobsFromRows(rawTarget, jobDetails);
  const normalizedJob = unifiedJobs[0] || rawTarget;
  if (!normalizedJob) return null;

  // Identify true parent row
  const parentRow = normalizedJob.rows?.find((r) => r.isParent) ||
    normalizedJob.rows?.find((r) => r.client && r.jobName) ||
    normalizedJob.rows?.[0] ||
    normalizedJob;

  const isRetainer = String(
    normalizedJob.projectRetainer ||
    parentRow.projectRetainer ||
    jobDetails?.projectRetainer ||
    jobDetails?.type ||
    ""
  ).toLowerCase().includes("retainer");

  const tabName = normalizedJob.tabName || parentRow.tabName || jobDetails?.tabName || "Confirmed";
  const isConfirmed = String(tabName).toLowerCase() === "confirmed";

  const clientName = normalizedJob.client || parentRow.client || jobDetails?.clientName || jobDetails?.client || "(No client)";
  const jobName = normalizedJob.jobName || parentRow.jobName || jobDetails?.jobName || "(No job name)";
  const projectCode = normalizedJob.projectCode || parentRow.projectCode || jobDetails?.projectCode || "";
  const jobType = isRetainer ? "Retainer" : "Project";

  const startDateVal = normalizedJob.startDate || parentRow.startDate || jobDetails?.startDate || "";
  const endDateVal = normalizedJob.endDate || parentRow.endDate || jobDetails?.endDate || "";
  const likelihoodVal = normalizedJob.likelihood !== undefined ? normalizedJob.likelihood : parentRow.likelihood;

  // Financial metrics matching JobsView
  const metrics = getJobFinancialMetrics(
    normalizedJob,
    isRetainer,
    isConfirmed,
    normalizedJob.revenue || parentRow.revenue || jobDetails?.revenue,
    normalizedJob.directCosts || parentRow.directCosts || jobDetails?.directCosts
  );

  // Extract candidate items
  const allInvoiceItems = mode === "invoice" ? getJobInvoiceItems(normalizedJob, isRetainer) : [];
  const allExpenseItems = mode === "expense" ? getJobExpenseItems(normalizedJob, isRetainer) : [];

  // For multi-row retainers, strictly filter out secondary auxiliary slots (slotNum > 1) unless they have real data
  const invoiceItems = isRetainer
    ? allInvoiceItems.filter((item) => {
        if (item.slotNum === 1) return true;
        const s = item.slot || {};
        return Boolean(
          s.ref && String(s.ref).trim() !== "" && !isPlaceholderInvoice(s.ref, s.status)
        );
      })
    : allInvoiceItems;

  const expenseItems = isRetainer
    ? allExpenseItems.filter((item) => {
        if (item.slotNum === 1) return true;
        const s = item.slot || {};
        return Boolean(
          ((s.description && String(s.description).trim() !== "") || (s.transactionId && String(s.transactionId).trim() !== "")) &&
          !isPlaceholderExpense(s)
        );
      })
    : allExpenseItems;

  // Categorize real placed items vs unplaced items
  const placedInvoices = [];
  const unplacedInvoices = [];
  if (mode === "invoice") {
    invoiceItems.forEach((item) => {
      const s = item.slot || {};
      const hasReal = Boolean(
        s.ref && String(s.ref).trim() !== "" && !isPlaceholderInvoice(s.ref, s.status)
      );
      if (hasReal) placedInvoices.push(item);
      else unplacedInvoices.push(item);
    });
  }

  const placedExpenses = [];
  const unplacedExpenses = [];
  if (mode === "expense") {
    expenseItems.forEach((item) => {
      const s = item.slot || {};
      const hasReal = Boolean(
        ((s.description && String(s.description).trim() !== "") || (s.transactionId && String(s.transactionId).trim() !== "")) &&
        !isPlaceholderExpense(s)
      );
      if (hasReal) placedExpenses.push(item);
      else unplacedExpenses.push(item);
    });
  }

  const currentItems = mode === "invoice" ? invoiceItems : expenseItems;
  const placedItems = mode === "invoice" ? placedInvoices : placedExpenses;
  const unplacedItems = mode === "invoice" ? unplacedInvoices : unplacedExpenses;

  // Determine the active target (first available unplaced slot)
  const activeTarget = currentItems.find((it) => it.slot?.highlighted) || unplacedItems[0] || currentItems[0] || null;

  // Clean target label (e.g. "Nov-26" or "Invoice 2")
  const getCleanTargetLabel = (item) => {
    if (!item) return mode === "invoice" ? "invoice" : "direct cost";
    return item.label;
  };

  const activeTargetLabel = getCleanTargetLabel(activeTarget);

  // Confidence text in sentence case
  const formatConfidence = (conf) => {
    if (!conf) return null;
    const s = String(conf).trim();
    if (s.toLowerCase().includes("high")) return "Recommended match · High confidence";
    if (s.toLowerCase().includes("medium")) return "Likely match · Medium confidence";
    if (s.toLowerCase().includes("low")) return "Possible match · Low confidence";
    return s;
  };

  return (
    <div
      style={{
        background: "#ffffff",
        border: "1.5px solid #e2e8f0",
        borderRadius: "10px",
        padding: "16px",
        marginBottom: "16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        transition: "border-color 0.15s ease",
      }}
    >
      {/* ── Top Header: Client & Job with Pills to the right ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "16px", fontWeight: "700", color: "#0f172a", wordBreak: "break-word" }}>
              {clientName} - {jobName}
            </span>

            {/* Retainer / Project Badge */}
            <span
              style={{
                fontSize: "11px",
                fontWeight: "600",
                background: isRetainer ? "#e0f2fe" : "#f3e8ff",
                color: isRetainer ? "#0284c7" : "#7e22ce",
                padding: "2px 8px",
                borderRadius: "12px",
                whiteSpace: "nowrap"
              }}
            >
              {jobType}
            </span>

            {projectCode && (
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "11px",
                  fontWeight: "700",
                  background: "#eff6ff",
                  color: "#2563eb",
                  padding: "1px 6px",
                  borderRadius: "4px",
                  border: "1px solid #bfdbfe",
                  whiteSpace: "nowrap"
                }}
              >
                {projectCode}
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons: View Job */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {onViewJob && (
            <button
              type="button"
              className="triage-btn"
              onClick={() => onViewJob(normalizedJob)}
              style={{
                fontSize: "12px",
                fontWeight: "600",
                padding: "5px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#f8fafc",
                color: "#334155",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                whiteSpace: "nowrap"
              }}
            >
              👁 View job
            </button>
          )}
        </div>
      </div>



      {/* ── Full Job Details Grid (Modeled on CRM Missing Job Screen) ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "8px 14px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          padding: "12px 14px",
          marginTop: "12px",
          fontSize: "13px",
          color: "#374151"
        }}
      >
        <div>
          <span style={{ color: "#64748b", fontWeight: "500" }}>
            {isRetainer ? "Monthly revenue: " : "Revenue: "}
          </span>
          <strong style={{ color: "#111827" }}>
            {formatCurrency(isRetainer ? (parentRow.revenue || normalizedJob.revenue || metrics.revenue) : (normalizedJob.revenue || metrics.revenue)) || "£0.00"}
            {isRetainer && <span style={{ fontSize: "11px", fontWeight: "normal", color: "#64748b" }}> / mo</span>}
          </strong>
        </div>

        <div>
          <span style={{ color: "#64748b", fontWeight: "500" }}>
            {isRetainer ? "Monthly direct costs: " : "Direct costs: "}
          </span>
          <strong style={{ color: "#111827" }}>
            {formatCurrency(isRetainer ? (parentRow.directCosts || normalizedJob.directCosts || metrics.directCosts) : (normalizedJob.directCosts || metrics.directCosts)) || "£0.00"}
            {isRetainer && <span style={{ fontSize: "11px", fontWeight: "normal", color: "#64748b" }}> / mo</span>}
          </strong>
        </div>

        <div>
          <span style={{ color: "#64748b", fontWeight: "500" }}>Retainer / project: </span>
          <strong style={{ color: "#111827" }}>{jobType}</strong>
        </div>

        <div>
          <span style={{ color: "#64748b", fontWeight: "500" }}>Start date: </span>
          <strong style={{ color: "#111827" }}>{startDateVal || "(blank)"}</strong>
        </div>

        <div>
          <span style={{ color: "#64748b", fontWeight: "500" }}>End date: </span>
          <strong style={{ color: "#111827" }}>{endDateVal || "(blank)"}</strong>
        </div>

        {!isConfirmed && likelihoodVal !== null && likelihoodVal !== undefined && (
          <div>
            <span style={{ color: "#64748b", fontWeight: "500" }}>Likelihood: </span>
            <strong style={{ color: "#0284c7" }}>{likelihoodVal}%</strong>
          </div>
        )}

        {/* Clean 1-Line Financial Progress Summary inside Grid */}
        <div style={{ gridColumn: "1 / -1", paddingTop: "8px", borderTop: "1px solid #e2e8f0", fontSize: "12px" }}>
          {mode === "invoice" ? (
            <span style={{ color: metrics.leftToInvoice > 0 ? "#92400e" : "#15803d", fontWeight: "600" }}>
              {metrics.leftToInvoice > 0
                ? `${fmtGBP(metrics.leftToInvoice)} left to invoice (${metrics.realInvoiced > 0 ? fmtGBP(metrics.realInvoiced) : "£0"} invoiced so far - ${metrics.revenue > 0 ? Math.round((metrics.realInvoiced / metrics.revenue) * 100) : 0}%)`
                : `Fully invoiced (${metrics.revenue > 0 ? fmtGBP(metrics.revenue) : "£0"} invoiced so far - 100%)`}
            </span>
          ) : (
            <span style={{ color: metrics.costsLeftToReceive > 0 ? "#92400e" : "#15803d", fontWeight: "600" }}>
              {metrics.costsLeftToReceive > 0
                ? `${fmtGBP(metrics.costsLeftToReceive)} left to receive (${metrics.realCostsReceived > 0 ? fmtGBP(metrics.realCostsReceived) : "£0"} received so far - ${metrics.directCosts > 0 ? Math.round((metrics.realCostsReceived / metrics.directCosts) * 100) : 0}%)`
                : `Fully received (${metrics.directCosts > 0 ? fmtGBP(metrics.directCosts) : "£0"} received so far - 100%)`}
            </span>
          )}
        </div>
      </div>

      {/* ── Collapsible History of Real Placed Items (Zero Default Screen Clutter) ── */}
      {placedItems.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <button
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            style={{
              background: "none",
              border: "none",
              color: "#475569",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              padding: "2px 0",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px"
            }}
          >
            {showHistory ? "▴ Hide" : "▾ View"} previously placed {mode === "invoice" ? "invoices" : "direct costs"} ({placedItems.length})
          </button>

          {showHistory && (
            <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
              {placedItems.map((item) => {
                const s = item.slot || {};
                const pill = getStatusPill(s.status);
                return (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 10px",
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      borderRadius: "6px",
                      fontSize: "12px"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontWeight: "600", color: "#334155" }}>
                        {item.label}:
                      </span>
                      <span style={{ color: "#0f172a" }}>
                        {mode === "invoice" ? (s.ref ? `#${s.ref}` : "Placed") : (s.description || "Cost")}
                      </span>
                      {s.status && (
                        <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pill }}>
                          {s.status}
                        </span>
                      )}
                      {(s.sentDate || s.date) && (
                        <span style={{ fontSize: "11px", color: "#64748b" }}>
                          {s.sentDate || s.date}
                        </span>
                      )}
                    </div>
                    <strong style={{ color: "#0f172a" }}>
                      {formatCurrency(s.amount)}
                    </strong>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Primary Action Bar ── */}
      {activeTarget && (
        <div
          style={{
            marginTop: "12px",
            padding: "10px 14px",
            background: mode === "invoice" ? "#f0fdf4" : "#ecfdf5",
            border: mode === "invoice" ? "1.5px solid #22c55e" : "1.5px solid #10b981",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start"
          }}
        >
          <button
            type="button"
            className="triage-btn"
            onClick={() => onPlaceSlot && onPlaceSlot(
              normalizedJob,
              activeTarget.slotNum,
              activeTarget.slot,
              activeTarget.rowNum,
              false,
              activeTargetLabel
            )}
            style={{
              padding: "8px 18px",
              borderRadius: "6px",
              border: "1px solid #15803d",
              background: "#16a34a",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: "700",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 3px rgba(22, 163, 74, 0.25)"
            }}
          >
            {mode === "invoice"
              ? (isRetainer ? `Place on ${activeTargetLabel}` : "Place invoice on job")
              : (isRetainer ? `Allocate to ${activeTargetLabel}` : "Place expense on job")}
          </button>
        </div>
      )}
    </div>
  );
}
