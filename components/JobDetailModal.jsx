import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import UnevenSplitModal from "./UnevenSplitModal";
import InvoicesEditModal from "./InvoicesEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import {
  JobDateInput,
  parseSheetDate,
  addMonths,
  toSheetDateFormat,
  formatCurrency,
  parseLikelihoodValue
} from "./JobsView";
import { isPlaceholderInvoice, isPlaceholderExpense } from "../utils/helpers";

export default function JobDetailModal({
  isOpen,
  target,
  onClose,
  onMarkPullPending
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [productLines, setProductLines] = useState([]);
  const [leadSources, setLeadSources] = useState([]);
  const [draftEdits, setDraftEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [recentlySaved, setRecentlySaved] = useState(false);

  // Sub-modals state
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);
  const [jobsEditSplit, setJobsEditSplit] = useState(null);

  // Fetch job details on-demand when opened
  useEffect(() => {
    if (!isOpen || !target?.client?.clientSheetId) {
      setJob(null);
      setDraftEdits({});
      setError(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setJob(null);
    setDraftEdits({});

    fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_all_client_jobs",
        clientSheetId: target.client.clientSheetId,
        tabName: "All"
      })
    })
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.success && Array.isArray(data.jobs)) {
          if (data.productLines) setProductLines(data.productLines);
          if (data.leadSources) setLeadSources(data.leadSources);

          const targetRow = target.rowNum ? Number(target.rowNum) : null;
          let found = null;

          // 1. Try matching by row number in rows array
          if (targetRow) {
            found = data.jobs.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow));
          }

          // 2. Fallback matching by job name and client name
          if (!found && target.jobName) {
            const qJob = String(target.jobName).toLowerCase().trim();
            const qClient = String(target.endClientName || target.client?.clientName || "").toLowerCase().trim();

            found = data.jobs.find((j) => {
              const jName = String(j.jobName || j.rows?.[0]?.jobName || "").toLowerCase().trim();
              const cName = String(j.client || j.rows?.[0]?.client || "").toLowerCase().trim();
              const jobMatches = jName === qJob || jName.includes(qJob) || qJob.includes(jName);
              const clientMatches = !qClient || cName === qClient || cName.includes(qClient) || qClient.includes(cName);
              return jobMatches && clientMatches;
            });
          }

          if (found) {
            setJob(found);
          } else {
            setError(`Job ${targetRow ? `on row ${targetRow}` : ""} "${target.jobName || ""}" could not be found in the client sheet.`);
          }
        } else {
          setError(data.error || "Failed to load job details from spreadsheet.");
        }
      })
      .catch((err) => {
        if (isMounted) setError(err.message || "Failed to fetch job details.");
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, target]);

  // Close on Escape key if no sub-modal is open
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen && !invoicesEditSlot && !directCostsEditSlot && !jobsEditSplit) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, invoicesEditSlot, directCostsEditSlot, jobsEditSplit, onClose]);

  if (!isOpen) return null;

  // Job helpers
  const parentRow = job?.rows?.[0] || {};
  const tabName = job?.tabName || parentRow.tabName || target?.tabName || "Confirmed";
  const isConfirmed = tabName.toLowerCase() === "confirmed";

  const getJobFieldValue = (fieldKey) => {
    if (draftEdits[fieldKey] !== undefined) return draftEdits[fieldKey];
    return parentRow[fieldKey] !== undefined ? parentRow[fieldKey] : "";
  };

  const handleDraftFieldChange = (fieldKey, val) => {
    setDraftEdits((prev) => ({ ...prev, [fieldKey]: val }));
  };

  const handleDiscardChanges = () => {
    setDraftEdits({});
  };

  const isDirty = Object.keys(draftEdits).length > 0;

  // Active values
  const clientVal = getJobFieldValue("client");
  const jobNameVal = getJobFieldValue("jobName");
  const typeVal = getJobFieldValue("projectRetainer") || "Project";
  const isRetainer = String(typeVal).toLowerCase().includes("retainer");
  const revVal = getJobFieldValue("revenue");
  const directCostsVal = getJobFieldValue("directCosts");
  const startDateVal = getJobFieldValue("startDate");
  const endDateVal = getJobFieldValue("endDate");
  const likelihoodVal = getJobFieldValue("likelihood");
  const dateConfVal = getJobFieldValue("dateConf");
  const leadSrcVal = getJobFieldValue("leadSrc");
  const prodLineVal = getJobFieldValue("prodLine");
  const vatVal = getJobFieldValue("vat") || "Yes";
  const projectCodeVal = getJobFieldValue("projectCode");
  const unevenSplitVal = getJobFieldValue("unevenSplit") || parentRow.unevenSplit || "";

  // Distinct options
  const plOptions = Array.from(new Set([...(productLines || []), prodLineVal].filter(Boolean))).sort();
  const lsOptions = Array.from(new Set([...(leadSources || []), leadSrcVal].filter(Boolean))).sort();

  // Financial metrics
  const getJobFinancialMetrics = () => {
    if (!job || !job.rows || job.rows.length === 0) {
      return { revenue: 0, realInvoiced: 0, placeholderInvoiced: 0, leftToInvoice: 0, directCosts: 0, realCostsReceived: 0, placeholderCosts: 0, costsLeftToReceive: 0 };
    }

    const rawRev = parseFloat(String(revVal !== undefined ? revVal : (parentRow.revenue || "0")).replace(/[£$€,\s]/g, "")) || 0;
    const rawCost = parseFloat(String(directCostsVal !== undefined ? directCostsVal : (parentRow.directCosts || "0")).replace(/[£$€,\s]/g, "")) || 0;

    let realInvoiced = 0;
    let placeholderInvoiced = 0;
    job.rows.forEach((r) => {
      (r.invoiceSlots || []).forEach((slot) => {
        const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (amt > 0) {
          const ref = String(slot.ref || "").trim();
          if (isPlaceholderInvoice(ref, slot.status) || !ref) {
            placeholderInvoiced += amt;
          } else {
            realInvoiced += amt;
          }
        }
      });
    });

    let realCostsReceived = 0;
    let placeholderCosts = 0;
    job.rows.forEach((r) => {
      (r.expenseSlots || []).forEach((slot) => {
        const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (amt > 0) {
          if (isPlaceholderExpense(slot)) {
            placeholderCosts += amt;
          } else {
            realCostsReceived += amt;
          }
        }
      });
    });

    let totalRevenue = rawRev;
    let totalDirectCosts = rawCost;
    let leftToInvoice = 0;
    let costsLeftToReceive = 0;

    if (!isConfirmed) {
      leftToInvoice = 0;
      costsLeftToReceive = 0;
    } else if (isRetainer) {
      const now = new Date();
      let baseStartDate = parseSheetDate(parentRow.startDate) || parseSheetDate(parentRow.dateConf);
      const sDate = baseStartDate || parseSheetDate(parentRow.startDate);
      const eDate = parseSheetDate(parentRow.endDate);
      let monthsCount = job.rows.length;
      if (sDate && eDate && eDate > sDate) {
        const diffDays = (eDate.getTime() - sDate.getTime()) / (24 * 60 * 60 * 1000);
        monthsCount = Math.max(job.rows.length, Math.round(diffDays / 30.4375));
      }
      totalRevenue = rawRev * monthsCount;
      totalDirectCosts = rawCost * monthsCount;

      if (sDate) {
        let expectedPriorRevenue = 0;
        let expectedPriorCosts = 0;
        for (let p = 0; p < monthsCount; p++) {
          const nextPStart = addMonths(sDate, p + 1);
          const pEnd = new Date(nextPStart.getFullYear(), nextPStart.getMonth(), nextPStart.getDate() - 1, 23, 59, 59, 999);
          if (pEnd < now) {
            const periodRev = job.rows[p]?.revenue ? (parseFloat(String(job.rows[p].revenue).replace(/[£$€,\s]/g, "")) || rawRev) : rawRev;
            expectedPriorRevenue += periodRev;
            const periodCost = job.rows[p]?.directCosts ? (parseFloat(String(job.rows[p].directCosts).replace(/[£$€,\s]/g, "")) || rawCost) : rawCost;
            expectedPriorCosts += periodCost;
          }
        }
        leftToInvoice = Math.max(0, expectedPriorRevenue - realInvoiced);
        costsLeftToReceive = Math.max(0, expectedPriorCosts - realCostsReceived);
      }
    } else {
      leftToInvoice = totalRevenue > 0 ? Math.max(0, totalRevenue - realInvoiced) : 0;
      costsLeftToReceive = totalDirectCosts > 0 ? Math.max(0, totalDirectCosts - realCostsReceived) : 0;
    }

    return {
      revenue: totalRevenue,
      realInvoiced,
      placeholderInvoiced,
      leftToInvoice,
      directCosts: totalDirectCosts,
      realCostsReceived,
      placeholderCosts,
      costsLeftToReceive
    };
  };

  const metrics = getJobFinancialMetrics();

  // Gather invoice slots
  const getJobInvoiceItems = () => {
    if (!job || !job.rows || job.rows.length === 0) return [];
    const items = [];
    if (isRetainer) {
      job.rows.forEach((r, rIdx) => {
        const periodNum = rIdx + 1;
        const slots = r.invoiceSlots || [];
        const mainSlot = slots.find((s) => s.slotNum === 1) || { slotNum: 1, amount: "", ref: "", sentDate: "", daysToPay: "", status: "" };
        items.push({
          id: `ret_inv_${r.rowNum}_1`,
          rowNum: r.rowNum,
          slotNum: 1,
          slot: mainSlot,
          row: r,
          label: `Month ${periodNum}`,
          subLabel: `Row ${r.rowNum}${mainSlot.sentDate ? ` · ${mainSlot.sentDate}` : ""}`
        });
        slots.filter((s) => s.slotNum > 1).forEach((extraSlot) => {
          if ((extraSlot.ref && String(extraSlot.ref).trim() !== "") || (extraSlot.amount && String(extraSlot.amount).trim() !== "")) {
            items.push({
              id: `ret_inv_${r.rowNum}_${extraSlot.slotNum}`,
              rowNum: r.rowNum,
              slotNum: extraSlot.slotNum,
              slot: extraSlot,
              row: r,
              label: `Month ${periodNum} (Extra Inv ${extraSlot.slotNum})`,
              subLabel: `Row ${r.rowNum}`
            });
          }
        });
      });
    } else {
      job.rows.forEach((r, rIdx) => {
        const slots = r.invoiceSlots || [
          { slotNum: 1, amount: "", ref: "", sentDate: "", daysToPay: "", status: "" },
          { slotNum: 2, amount: "", ref: "", sentDate: "", daysToPay: "", status: "" },
          { slotNum: 3, amount: "", ref: "", sentDate: "", daysToPay: "", status: "" }
        ];
        slots.forEach((s) => {
          const seqNum = rIdx * 3 + s.slotNum;
          items.push({
            id: `proj_inv_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            slot: s,
            row: r,
            label: `Invoice ${seqNum}`,
            subLabel: rIdx > 0 ? `Row ${r.rowNum}` : ""
          });
        });
      });
    }
    return items;
  };

  // Gather direct cost slots
  const getJobExpenseItems = () => {
    if (!job || !job.rows || job.rows.length === 0) return [];
    const items = [];
    if (isRetainer) {
      job.rows.forEach((r, rIdx) => {
        const periodNum = rIdx + 1;
        const slots = r.expenseSlots || [];
        slots.forEach((s) => {
          const hasData = Boolean((s.description && String(s.description).trim() !== "") || (s.amount && String(s.amount).trim() !== "") || (s.transactionId && String(s.transactionId).trim() !== ""));
          if (hasData || (rIdx === 0 && s.slotNum === 1)) {
            items.push({
              id: `ret_exp_${r.rowNum}_${s.slotNum}`,
              rowNum: r.rowNum,
              slotNum: s.slotNum,
              slot: s,
              row: r,
              label: s.slotNum === 1 ? `Month ${periodNum} Cost` : `Month ${periodNum} Cost ${s.slotNum}`,
              subLabel: `Row ${r.rowNum}`
            });
          }
        });
      });
    } else {
      job.rows.forEach((r, rIdx) => {
        const slots = r.expenseSlots || [
          { slotNum: 1, description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: "" },
          { slotNum: 2, description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: "" },
          { slotNum: 3, description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: "" }
        ];
        slots.forEach((s) => {
          const seqNum = rIdx * 3 + s.slotNum;
          items.push({
            id: `proj_exp_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            slot: s,
            row: r,
            label: `Direct Cost ${seqNum}`,
            subLabel: rIdx > 0 ? `Row ${r.rowNum}` : ""
          });
        });
      });
    }
    return items;
  };

  const invoiceItems = getJobInvoiceItems();
  const expenseItems = getJobExpenseItems();

  const getStatusPill = (status) => {
    const s = String(status || "").trim();
    if (s === "Paid") return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
    if (s === "Draft") return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
    if (s === "Sent" || s === "Received") return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
    return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
  };

  // Save changes handler
  const handleSaveJob = async () => {
    if (!job || !isDirty || !target?.client?.clientSheetId) return;

    const parentRowNum = parentRow.rowNum;
    const FIELD_MAP = {
      client: { colLetter: "A", fieldName: "Client" },
      jobName: { colLetter: "B", fieldName: "Job Name" },
      projectCode: { colLetter: "C", fieldName: "Project Code" },
      dateConf: { colLetter: "D", fieldName: tabName === "Pipeline" ? "Date Added" : "Date Confirmed", isDate: true },
      leadSrc: { colLetter: "E", fieldName: "Lead Source" },
      revenue: { colLetter: "AG", fieldName: "Revenue" },
      directCosts: { colLetter: "AH", fieldName: "Direct Costs" },
      vat: { colLetter: "AI", fieldName: "VAT" },
      projectRetainer: { colLetter: "AJ", fieldName: "Type" },
      prodLine: { colLetter: "AK", fieldName: "Product Line" },
      startDate: { colLetter: "AL", fieldName: "Start Date", isDate: true },
      endDate: { colLetter: "AM", fieldName: "End Date", isDate: true },
      likelihood: { colLetter: "AN", fieldName: "Likelihood" }
    };

    const updates = [];
    Object.keys(draftEdits).forEach((f) => {
      const meta = FIELD_MAP[f];
      if (!meta) return;
      let val = draftEdits[f];
      if (meta.isDate && val) val = toSheetDateFormat(val);
      updates.push({
        colLetter: meta.colLetter,
        rowNum: parentRowNum,
        cellRef: `${meta.colLetter}${parentRowNum}`,
        fieldName: meta.fieldName,
        value: val
      });

      if ((f === "client" || f === "jobName") && job.rows && job.rows.length > 1) {
        job.rows.slice(1).forEach((childRow) => {
          updates.push({
            colLetter: meta.colLetter,
            rowNum: childRow.rowNum,
            cellRef: `${meta.colLetter}${childRow.rowNum}`,
            fieldName: meta.fieldName,
            value: val
          });
        });
      }
    });

    if (updates.length === 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId: target.client.clientSheetId,
          clientName: target.client.clientName || target.client.name || "",
          tabName,
          rowNum: parentRowNum,
          endClientName: draftEdits.client || parentRow.client || job.client,
          jobName: draftEdits.jobName || parentRow.jobName || job.jobName,
          updates
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update job");

      // Update local state
      setJob((prev) => {
        if (!prev) return prev;
        const updatedRows = prev.rows.map((r, rIdx) => {
          const nextRow = { ...r };
          Object.keys(draftEdits).forEach((f) => {
            let nextVal = draftEdits[f];
            if (FIELD_MAP[f]?.isDate && nextVal) nextVal = toSheetDateFormat(nextVal);
            if (rIdx === 0 || f === "client" || f === "jobName") nextRow[f] = nextVal;
          });
          return nextRow;
        });
        return {
          ...prev,
          client: draftEdits.client || prev.client,
          jobName: draftEdits.jobName || prev.jobName,
          projectCode: draftEdits.projectCode !== undefined ? draftEdits.projectCode : prev.projectCode,
          rows: updatedRows
        };
      });

      setDraftEdits({});
      setRecentlySaved(true);
      setTimeout(() => setRecentlySaved(false), 3000);
    } catch (err) {
      alert("Error saving job: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Sub-modals */}
      {invoicesEditSlot && (
        <InvoicesEditModal
          editSlot={invoicesEditSlot}
          invoicesClient={target.client}
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => onMarkPullPending && onMarkPullPending(masterId)}
          onUpdateInvoiceJobs={(rNum, sNum, newData) => {
            setJob((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                rows: prev.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                        ...r,
                        invoiceSlots: (r.invoiceSlots || []).map((sl) => (sl.slotNum !== sNum ? sl : { ...sl, ...newData }))
                      }
                )
              };
            });
          }}
        />
      )}

      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={target.client}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => onMarkPullPending && onMarkPullPending(masterId)}
          onUpdateJobs={(rNum, sNum, newData) => {
            setJob((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                rows: prev.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                        ...r,
                        expenseSlots: (r.expenseSlots || []).map((sl) => (sl.slotNum !== sNum ? sl : { ...sl, ...newData }))
                      }
                )
              };
            });
          }}
        />
      )}

      {jobsEditSplit && (
        <UnevenSplitModal
          editSplit={jobsEditSplit}
          client={target.client}
          tabName={jobsEditSplit.tabName || tabName}
          onClose={() => setJobsEditSplit(null)}
          onUpdateJobsData={(rNum, splitStr, updatedFields) => {
            setJob((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                rows: prev.rows.map((r) => {
                  if (r.rowNum === rNum) {
                    const updatedRow = { ...r, unevenSplit: splitStr };
                    if (updatedFields?.startDate) updatedRow.startDate = toSheetDateFormat(updatedFields.startDate);
                    if (updatedFields?.endDate) updatedRow.endDate = toSheetDateFormat(updatedFields.endDate);
                    if (updatedFields?.revenue !== undefined) updatedRow.revenue = updatedFields.revenue;
                    return updatedRow;
                  }
                  return r;
                })
              };
            });
          }}
        />
      )}

      {/* Main Modal Overlay */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.65)",
          zIndex: 1100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !invoicesEditSlot && !directCostsEditSlot && !jobsEditSplit) {
            onClose();
          }
        }}
      >
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            width: "min(96vw, 1340px)",
            maxHeight: "92vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
            overflow: "hidden"
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid #e2e8f0",
              background: "#ffffff",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "3px 9px",
                  borderRadius: "12px",
                  fontSize: "12px",
                  fontWeight: "700",
                  background: isConfirmed ? "#dcfce7" : "#e0f2fe",
                  color: isConfirmed ? "#15803d" : "#0369a1",
                  border: isConfirmed ? "1px solid #bbf7d0" : "1px solid #bae6fd"
                }}
              >
                {isConfirmed ? "Confirmed Job" : "Pipeline Job"}
              </span>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0f172a" }}>
                {clientVal || target?.endClientName || target?.client?.clientName || "Client"}
                {" · "}
                <span style={{ color: "#334155", fontWeight: "600" }}>
                  {jobNameVal || target?.jobName || "Job Details"}
                </span>
              </h2>
              {projectCodeVal && (
                <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "4px", border: "1px solid #e2e8f0", fontFamily: "monospace" }}>
                  {projectCodeVal}
                </span>
              )}
              {parentRow.rowNum && (
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  ({tabName} Row {parentRow.rowNum}{job?.rows?.length > 1 ? `-${job.rows[job.rows.length - 1].rowNum}` : ""})
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                padding: "6px 14px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#475569",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                transition: "all 0.15s ease"
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#e2e8f0"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#f1f5f9"; }}
            >
              ✕ Close
            </button>
          </div>

          {/* Body Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
            {loading && (
              <div style={{ padding: "60px 0", textAlign: "center", color: "#64748b" }}>
                <Spinner size={24} color="#0284c7" />
                <div style={{ marginTop: "12px", fontSize: "14px", fontWeight: "500" }}>
                  Loading job details from spreadsheet…
                </div>
              </div>
            )}

            {!loading && error && (
              <div
                style={{
                  padding: "24px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "8px",
                  color: "#991b1b",
                  fontSize: "14px"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "6px" }}>⚠️ Could not load job details</div>
                <div>{error}</div>
                <div style={{ marginTop: "16px", display: "flex", gap: "10px" }}>
                  <button
                    type="button"
                    onClick={onClose}
                    style={{
                      padding: "6px 14px",
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

            {!loading && !error && job && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* Main Job Row Summary Inputs */}
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: "8px",
                    border: "1px solid #e2e8f0",
                    padding: "16px",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
                  }}
                >
                  <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.04em", color: "#64748b", marginBottom: "10px" }}>
                    Primary Job Fields
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px" }}>
                    {/* Client Name */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Client</label>
                      <input
                        type="text"
                        value={clientVal}
                        onChange={(e) => handleDraftFieldChange("client", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.client !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600", outline: "none", boxSizing: "border-box"
                        }}
                      />
                    </div>

                    {/* Job Name */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Job Name</label>
                      <input
                        type="text"
                        value={jobNameVal}
                        onChange={(e) => handleDraftFieldChange("jobName", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.jobName !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "500", outline: "none", boxSizing: "border-box"
                        }}
                      />
                    </div>

                    {/* Job Type */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Type</label>
                      <select
                        value={isRetainer ? "Retainer" : "Project"}
                        onChange={(e) => handleDraftFieldChange("projectRetainer", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.projectRetainer !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600", background: isRetainer ? "#e0f2fe" : "#f3e8ff",
                          color: isRetainer ? "#0284c7" : "#7e22ce", outline: "none", boxSizing: "border-box"
                        }}
                      >
                        <option value="Project">Project</option>
                        <option value="Retainer">Retainer</option>
                      </select>
                    </div>

                    {/* Revenue */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Revenue</label>
                      <input
                        type="text"
                        value={revVal}
                        onChange={(e) => handleDraftFieldChange("revenue", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.revenue !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600", outline: "none", boxSizing: "border-box"
                        }}
                      />
                      {isConfirmed && metrics.revenue > 0 && (
                        metrics.leftToInvoice > 0 ? (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                              Left to inv: {formatCurrency(metrics.leftToInvoice)}
                            </span>
                          </div>
                        ) : (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                              ✓ Invoiced
                            </span>
                          </div>
                        )
                      )}
                    </div>

                    {/* Direct Costs */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Direct Costs</label>
                      <input
                        type="text"
                        value={directCostsVal}
                        onChange={(e) => handleDraftFieldChange("directCosts", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.directCosts !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", color: "#475569", outline: "none", boxSizing: "border-box"
                        }}
                      />
                      {isConfirmed && metrics.directCosts > 0 && (
                        metrics.costsLeftToReceive > 0 ? (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                              Left to rec: {formatCurrency(metrics.costsLeftToReceive)}
                            </span>
                          </div>
                        ) : (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                              ✓ Received
                            </span>
                          </div>
                        )
                      )}
                    </div>

                    {/* Start Date */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Start Date</label>
                      <JobDateInput
                        value={startDateVal}
                        onChange={(val) => handleDraftFieldChange("startDate", val)}
                        isDirty={draftEdits.startDate !== undefined}
                        defaultBorder="1px solid #cbd5e1"
                        defaultBg="#ffffff"
                        style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                      />
                    </div>

                    {/* End Date */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>End Date</label>
                      <JobDateInput
                        value={endDateVal}
                        onChange={(val) => handleDraftFieldChange("endDate", val)}
                        isDirty={draftEdits.endDate !== undefined}
                        defaultBorder="1px solid #cbd5e1"
                        defaultBg="#ffffff"
                        style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                      />
                    </div>

                    {/* % Likelihood */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Likelihood</label>
                      <input
                        type="text"
                        value={likelihoodVal !== undefined && likelihoodVal !== "" ? likelihoodVal : (isConfirmed ? "100%" : "")}
                        onChange={(e) => handleDraftFieldChange("likelihood", e.target.value)}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.likelihood !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600",
                          color: isConfirmed ? "#15803d" : "#0369a1", outline: "none", boxSizing: "border-box"
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Sub-grid of 3 Expanded Cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1.4fr", gap: "16px" }}>
                  {/* Card 1: Additional Job Information */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                    }}
                  >
                    <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      Additional Information
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                      {/* Date Confirmed */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          {isConfirmed ? "Date Confirmed" : "Date Added"}
                        </label>
                        <JobDateInput
                          value={dateConfVal}
                          onChange={(val) => handleDraftFieldChange("dateConf", val)}
                          isDirty={draftEdits.dateConf !== undefined}
                          defaultBorder="1px solid #cbd5e1"
                          defaultBg="#ffffff"
                          style={{ width: "100%", padding: "5px 7px", boxSizing: "border-box" }}
                        />
                      </div>

                      {/* Project Code */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Project Code
                        </label>
                        <input
                          type="text"
                          value={projectCodeVal || ""}
                          onChange={(e) => handleDraftFieldChange("projectCode", e.target.value)}
                          placeholder="e.g. PRJ-2026-01"
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.projectCode !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none", boxSizing: "border-box"
                          }}
                        />
                      </div>

                      {/* Lead Source */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Lead Source
                        </label>
                        <select
                          value={leadSrcVal || ""}
                          onChange={(e) => handleDraftFieldChange("leadSrc", e.target.value)}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.leadSrc !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none", background: "#ffffff", boxSizing: "border-box"
                          }}
                        >
                          <option value="">Select Lead Source...</option>
                          {lsOptions.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      {/* Product Line */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Product Line
                        </label>
                        <select
                          value={prodLineVal || ""}
                          onChange={(e) => handleDraftFieldChange("prodLine", e.target.value)}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.prodLine !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none", background: "#ffffff", boxSizing: "border-box"
                          }}
                        >
                          <option value="">Select Product Line...</option>
                          {plOptions.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      {/* VAT Applicable */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          VAT Applicable?
                        </label>
                        <select
                          value={vatVal}
                          onChange={(e) => handleDraftFieldChange("vat", e.target.value)}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.vat !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none", background: "#ffffff", boxSizing: "border-box"
                          }}
                        >
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      </div>

                      {/* Revenue Split */}
                      <div style={{ gridColumn: "span 2", marginTop: "4px", padding: "8px 10px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: "11px", fontWeight: "700", color: "#334155" }}>Revenue Split</div>
                            <div style={{ fontSize: "11px", color: "#64748b" }}>
                              {isRetainer
                                ? "Even monthly (Retainer)"
                                : String(unevenSplitVal).toLowerCase().startsWith("[split]")
                                ? "Custom uneven split active"
                                : "Even monthly distribution"}
                            </div>
                          </div>
                          {!isRetainer && (
                            <button
                              type="button"
                              onClick={() => {
                                const mergedJobRow = {
                                  ...parentRow,
                                  ...draftEdits,
                                  startDate: draftEdits.startDate !== undefined ? draftEdits.startDate : parentRow.startDate,
                                  endDate: draftEdits.endDate !== undefined ? draftEdits.endDate : parentRow.endDate,
                                  revenue: draftEdits.revenue !== undefined ? draftEdits.revenue : parentRow.revenue,
                                  client: draftEdits.client !== undefined ? draftEdits.client : parentRow.client,
                                  jobName: draftEdits.jobName !== undefined ? draftEdits.jobName : parentRow.jobName,
                                };
                                setJobsEditSplit({ jobRow: mergedJobRow, tabName });
                              }}
                              style={{
                                padding: "4px 9px", borderRadius: "5px", border: "1px solid #cbd5e1",
                                background: String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#0284c7" : "#ffffff",
                                color: String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#ffffff" : "#0284c7",
                                fontSize: "11px", fontWeight: "600", cursor: "pointer"
                              }}
                            >
                              Configure Split
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Card 2: Invoices */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                      display: "flex",
                      flexDirection: "column"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Invoices ({invoiceItems.length})
                      </div>
                      {isConfirmed && metrics.revenue > 0 && (
                        metrics.leftToInvoice > 0 ? (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            Left to inv: {formatCurrency(metrics.leftToInvoice)}
                          </span>
                        ) : (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                            ✓ Invoiced
                          </span>
                        )
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
                      {invoiceItems.length === 0 ? (
                        <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                          No invoice slots found.
                        </div>
                      ) : (
                        invoiceItems.map((item) => {
                          const slot = item.slot;
                          const hasData = Boolean((slot.ref && String(slot.ref).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                          const isPlaceholder = isPlaceholderInvoice(slot.ref, slot.status);
                          const pillStyle = getStatusPill(slot.status);

                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                setInvoicesEditSlot({
                                  rowNum: item.rowNum,
                                  slotNum: item.slotNum,
                                  slot,
                                  jobClient: item.row.client || parentRow.client || job.client,
                                  jobName: item.row.jobName || parentRow.jobName || job.jobName,
                                  slotLabel: item.label,
                                  tabName
                                });
                              }}
                              style={{
                                padding: "8px 10px", borderRadius: "6px", border: "1px solid #e2e8f0",
                                background: hasData ? "#f8fafc" : "#ffffff", cursor: "pointer", transition: "border-color 0.15s ease"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#93c5fd"; e.currentTarget.style.background = "#eff6ff"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.background = hasData ? "#f8fafc" : "#ffffff"; }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontSize: "11px", fontWeight: "700", color: "#475569" }}>{item.label}</span>
                                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                                  {item.subLabel && <span style={{ fontSize: "10px", color: "#94a3b8" }}>{item.subLabel}</span>}
                                  {slot.status && <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>{slot.status}</span>}
                                </div>
                              </div>
                              {hasData ? (
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "4px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ fontSize: "13px", fontWeight: "600", color: isPlaceholder ? "#9333ea" : "#0f172a" }}>
                                      {slot.ref || "No Ref"}
                                    </span>
                                    {isPlaceholder && (
                                      <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "6px", background: "#f3e8ff", color: "#7e22ce", fontWeight: "600" }}>
                                        Placeholder
                                      </span>
                                    )}
                                  </div>
                                  <span style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a" }}>
                                    {formatCurrency(slot.amount)}
                                  </span>
                                </div>
                              ) : (
                                <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", marginTop: "4px" }}>
                                  Empty · Click to assign invoice
                                </div>
                              )}
                              {slot.sentDate && (
                                <div style={{ fontSize: "10px", color: "#64748b", marginTop: "2px" }}>
                                  Sent: {slot.sentDate} ({slot.daysToPay || 30} days)
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Card 3: Direct Costs */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                      display: "flex",
                      flexDirection: "column"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Direct Costs ({expenseItems.length})
                      </div>
                      {isConfirmed && metrics.directCosts > 0 && (
                        metrics.costsLeftToReceive > 0 ? (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            Left to rec: {formatCurrency(metrics.costsLeftToReceive)}
                          </span>
                        ) : (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                            ✓ Received
                          </span>
                        )
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
                      {expenseItems.length === 0 ? (
                        <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                          No direct cost slots found.
                        </div>
                      ) : (
                        expenseItems.map((item) => {
                          const slot = item.slot;
                          const hasData = Boolean((slot.description && String(slot.description).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                          const isPlaceholder = isPlaceholderExpense(slot);
                          const pillStyle = getStatusPill(slot.status);

                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                setDirectCostsEditSlot({
                                  rowNum: item.rowNum,
                                  slotNum: item.slotNum,
                                  slot,
                                  jobName: item.row.jobName || parentRow.jobName || job.jobName,
                                  jobClient: item.row.client || parentRow.client || job.client,
                                  slotLabel: item.label,
                                  tabName
                                });
                              }}
                              style={{
                                padding: "8px 10px", borderRadius: "6px", border: "1px solid #e2e8f0",
                                background: hasData ? "#f8fafc" : "#ffffff", cursor: "pointer", transition: "border-color 0.15s ease"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#93c5fd"; e.currentTarget.style.background = "#eff6ff"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.background = hasData ? "#f8fafc" : "#ffffff"; }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontSize: "11px", fontWeight: "700", color: "#475569" }}>{item.label}</span>
                                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                                  {item.subLabel && <span style={{ fontSize: "10px", color: "#94a3b8" }}>{item.subLabel}</span>}
                                  {slot.status && <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>{slot.status}</span>}
                                </div>
                              </div>
                              {hasData ? (
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "4px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                                    <span style={{ fontSize: "13px", fontWeight: "600", color: isPlaceholder ? "#9333ea" : "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "160px" }}>
                                      {slot.description || slot.transactionId || "Expense"}
                                    </span>
                                    {isPlaceholder && (
                                      <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "6px", background: "#f3e8ff", color: "#7e22ce", fontWeight: "600", flexShrink: 0 }}>
                                        Placeholder
                                      </span>
                                    )}
                                  </div>
                                  <span style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a" }}>
                                    {formatCurrency(slot.amount)}
                                  </span>
                                </div>
                              ) : (
                                <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", marginTop: "4px" }}>
                                  Empty · Click to assign direct cost
                                </div>
                              )}
                              {slot.date && (
                                <div style={{ fontSize: "10px", color: "#64748b", marginTop: "2px" }}>
                                  Date: {slot.date} {slot.vat ? `· VAT: ${slot.vat}` : ""}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div
            style={{
              padding: "14px 24px",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px"
            }}
          >
            <div>
              {recentlySaved ? (
                <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: "700" }}>
                  ✓ Changes saved successfully to sheet
                </span>
              ) : isDirty ? (
                <span style={{ fontSize: "12px", color: "#b45309", fontWeight: "600" }}>
                  ⚠️ Unsaved changes to this job
                </span>
              ) : (
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  ✓ All job details synchronized
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {isDirty && (
                <button
                  type="button"
                  onClick={handleDiscardChanges}
                  disabled={saving}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#475569",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: saving ? "not-allowed" : "pointer"
                  }}
                >
                  Discard Changes
                </button>
              )}

              {isDirty && (
                <button
                  type="button"
                  onClick={handleSaveJob}
                  disabled={saving}
                  style={{
                    padding: "6px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: saving ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(22, 163, 74, 0.2)"
                  }}
                >
                  {saving ? <><Spinner size={12} color="#ffffff" /> Saving...</> : "💾 Save Job"}
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
