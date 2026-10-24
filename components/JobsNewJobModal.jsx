import React, { useState, useMemo, useRef, useEffect } from "react";
import Spinner from "./Spinner";
import SplitMonthCard from "./SplitMonthCard";
import { formatSplitString } from "../services/splitHelper";
import DateInput from "./DateInput";
import {
  INVOICE_STATUS_OPTIONS,
  EXPENSE_STATUS_OPTIONS,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus
} from "../utils/helpers";

export default function JobsNewJobModal({
  jobsClient,
  initialTab = "Confirmed",
  productLines = [],
  leadSources = [],
  existingClients = [],
  onClose,
  onSuccess
}) {
  // Format today's date as YYYY-MM-DD for native HTML date inputs
  const todayISO = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);

  const [client, setClient] = useState("");
  const [jobName, setJobName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [projectRetainer, setProjectRetainer] = useState("Project");
  const [status, setStatus] = useState(initialTab === "Pipeline" ? "Pipeline" : "Confirmed");
  const [likelihood, setLikelihood] = useState(initialTab === "Pipeline" ? "50" : "100");
  const [revenue, setRevenue] = useState("");
  const [directCosts, setDirectCosts] = useState("0");
  const [vat, setVat] = useState("Yes");
  const [dateConfirmed, setDateConfirmed] = useState(todayISO);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [productLine, setProductLine] = useState("");
  const [leadSource, setLeadSource] = useState("");

  const [clientDefaultDays, setClientDefaultDays] = useState(30);

  // Invoices (up to 3 slots)
  const [showInvoicesSection, setShowInvoicesSection] = useState(false);
  const [activeInvoiceSlot, setActiveInvoiceSlot] = useState(1);
  const [invoices, setInvoices] = useState([
    { slotNum: 1, invoiceNo: "", amount: "", sentDate: "", daysToPay: 30, status: "Sent" },
    { slotNum: 2, invoiceNo: "", amount: "", sentDate: "", daysToPay: 30, status: "Sent" },
    { slotNum: 3, invoiceNo: "", amount: "", sentDate: "", daysToPay: 30, status: "Sent" },
  ]);

  // Expenses (up to 3 slots)
  const [showExpensesSection, setShowExpensesSection] = useState(false);
  const [activeExpenseSlot, setActiveExpenseSlot] = useState(1);
  const [expenses, setExpenses] = useState([
    { slotNum: 1, description: "", amount: "", vat: "No", date: "", daysToPay: 30, status: "Received", transactionId: "" },
    { slotNum: 2, description: "", amount: "", vat: "No", date: "", daysToPay: 30, status: "Received", transactionId: "" },
    { slotNum: 3, description: "", amount: "", vat: "No", date: "", daysToPay: 30, status: "Received", transactionId: "" },
  ]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch client's default days to pay from DataChgAlert!B52 (Master Sheet)
  useEffect(() => {
    let isMounted = true;
    const fetchDefaultDays = async () => {
      if (!jobsClient?.clientSheetId && !jobsClient?.masterSheetId) return;
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_default_days_to_pay",
            clientSheetId: jobsClient?.clientSheetId,
            masterSheetId: jobsClient?.masterSheetId,
            clientName: jobsClient?.clientName || jobsClient?.name || "",
          }),
        });
        const data = await res.json();
        if (isMounted && data?.success && typeof data.defaultDaysToPay === "number") {
          const defDays = data.defaultDaysToPay;
          setClientDefaultDays(defDays);
          setInvoices(prev => prev.map(inv => (inv.daysToPay === 30 || inv.daysToPay === "" || inv.daysToPay === undefined) ? { ...inv, daysToPay: defDays } : inv));
          setExpenses(prev => prev.map(exp => (exp.daysToPay === 30 || exp.daysToPay === "" || exp.daysToPay === undefined) ? { ...exp, daysToPay: defDays } : exp));
        }
      } catch (e) {
        console.warn("Could not fetch client default days to pay for JobsNewJobModal:", e.message);
      }
    };
    fetchDefaultDays();
    return () => { isMounted = false; };
  }, [jobsClient]);

  const updateInvoice = (slotNum, field, val) => {
    setInvoices(prev => prev.map(inv => inv.slotNum === slotNum ? { ...inv, [field]: val } : inv));
  };

  const clearInvoice = (slotNum) => {
    setInvoices(prev => prev.map(inv => inv.slotNum === slotNum ? { slotNum, invoiceNo: "", amount: "", sentDate: "", daysToPay: clientDefaultDays, status: "Sent" } : inv));
  };

  const updateExpense = (slotNum, field, val) => {
    setExpenses(prev => prev.map(exp => exp.slotNum === slotNum ? { ...exp, [field]: val } : exp));
  };

  const clearExpense = (slotNum) => {
    setExpenses(prev => prev.map(exp => exp.slotNum === slotNum ? { slotNum, description: "", amount: "", vat: "No", date: "", daysToPay: clientDefaultDays, status: "Received", transactionId: "" } : exp));
  };

  // Compute active counts for badges
  const invoiceActiveCount = useMemo(() => {
    return invoices.filter(i => (i.invoiceNo && i.invoiceNo.trim()) || (i.amount !== "" && parseFloat(i.amount) > 0) || i.sentDate).length;
  }, [invoices]);

  const expenseActiveCount = useMemo(() => {
    return expenses.filter(e => (e.description && e.description.trim()) || (e.amount !== "" && parseFloat(e.amount) > 0) || e.date).length;
  }, [expenses]);

  const totalExpenseSum = useMemo(() => {
    return expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  }, [expenses]);

  // Uneven Revenue Split
  const [enableSplit, setEnableSplit] = useState(false);
  const [lockedMonths, setLockedMonths] = useState({});
  const lockedMonthsRef = useRef(lockedMonths);
  lockedMonthsRef.current = lockedMonths;

  const parseModalDate = (dStr) => {
    if (!dStr) return null;
    const s = String(dStr).trim();
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const { splitMonths, splitDateError } = useMemo(() => {
    if (!startDate || !endDate) {
      return { splitMonths: [], splitDateError: "Please enter Start Date and End Date above to split revenue across months." };
    }
    const sDate = parseModalDate(startDate);
    const eDate = parseModalDate(endDate);
    if (!sDate || !eDate) {
      return { splitMonths: [], splitDateError: "Please enter valid Start and End Dates to split revenue across months." };
    }
    let currYear = sDate.getFullYear();
    let currMonth = sDate.getMonth();
    const endYear = eDate.getFullYear();
    const endMonth = eDate.getMonth();

    if (new Date(currYear, currMonth, 1) > new Date(endYear, endMonth, 1)) {
      return { splitMonths: [], splitDateError: "End Date must be after Start Date." };
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mList = [];
    while (currYear < endYear || (currYear === endYear && currMonth <= endMonth)) {
      mList.push(`${monthNames[currMonth]}-${String(currYear).slice(-2)}`);
      currMonth++;
      if (currMonth > 11) {
        currMonth = 0;
        currYear++;
      }
    }
    return { splitMonths: mList, splitDateError: "" };
  }, [startDate, endDate]);

  const totRev = useMemo(() => {
    return parseFloat(String(revenue || "0").replace(/[^0-9.-]/g, "")) || 0;
  }, [revenue]);

  const { validLocked, lockedSum, lockedCount, remaining, unlockedCount, evenSplit } = useMemo(() => {
    const vLocked = {};
    let lSum = 0;
    let lCount = 0;
    splitMonths.forEach((m) => {
      const k = m.toLowerCase();
      if (lockedMonths[k] !== undefined) {
        vLocked[k] = lockedMonths[k];
        lSum += lockedMonths[k];
        lCount++;
      }
    });
    const rem = totRev - lSum;
    const uCount = splitMonths.length - lCount;
    const eSplit = uCount > 0 ? rem / uCount : 0;
    return {
      validLocked: vLocked,
      lockedSum: lSum,
      lockedCount: lCount,
      remaining: rem,
      unlockedCount: uCount,
      evenSplit: eSplit,
    };
  }, [splitMonths, lockedMonths, totRev]);

  const { isSplitError, splitErrorText } = useMemo(() => {
    if (!enableSplit) return { isSplitError: false, splitErrorText: "" };
    if (splitDateError) return { isSplitError: true, splitErrorText: splitDateError };
    if (isNaN(totRev) || totRev <= 0) return { isSplitError: true, splitErrorText: "Please enter a Job Revenue amount above to allocate across months." };
    if (lockedSum > totRev + 0.05) return { isSplitError: true, splitErrorText: `Allocated revenue exceeds total job revenue (£${lockedSum.toFixed(2)} vs £${totRev.toFixed(2)}).` };
    if (unlockedCount === 0 && Math.abs(remaining) > 0.05) {
      return { isSplitError: true, splitErrorText: `Total allocated revenue does not match total job revenue (£${Math.abs(remaining).toFixed(2)} discrepancy).` };
    }
    return { isSplitError: false, splitErrorText: "" };
  }, [enableSplit, splitDateError, totRev, lockedSum, unlockedCount, remaining]);

  const handleStatusChange = (newStatus) => {
    setStatus(newStatus);
    if (newStatus === "Confirmed") {
      setLikelihood("100");
    } else {
      if (likelihood === "100" || !likelihood) {
        setLikelihood("50");
      }
    }
  };

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setError("");

    if (!client.trim()) {
      setError("Please enter a Client Name.");
      return;
    }
    if (!jobName.trim()) {
      setError("Please enter a Job Name.");
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setError("End Date cannot be before Start Date.");
      return;
    }

    if (enableSplit && isSplitError) {
      setError(splitErrorText || "Please resolve errors in the Uneven Revenue Split section before saving.");
      return;
    }

    let splitStrResult = "";
    if (enableSplit && splitMonths.length > 0 && projectRetainer === "Project") {
      const curLocked = lockedMonthsRef.current || {};
      const vLocked = {};
      let lSum = 0;
      let lCount = 0;
      splitMonths.forEach((m) => {
        const k = m.toLowerCase();
        if (curLocked[k] !== undefined) {
          vLocked[k] = curLocked[k];
          lSum += curLocked[k];
          lCount++;
        }
      });
      const rem = totRev - lSum;
      const uCount = splitMonths.length - lCount;
      const eSplit = uCount > 0 ? rem / uCount : 0;
      splitStrResult = formatSplitString(splitMonths, vLocked, eSplit);
    }

    // Filter active invoices to submit
    const activeInvoices = invoices.filter(inv =>
      (inv.invoiceNo && inv.invoiceNo.trim()) ||
      (inv.amount !== "" && !isNaN(parseFloat(inv.amount)) && parseFloat(inv.amount) > 0) ||
      inv.sentDate
    ).map(inv => ({
      slotNum: inv.slotNum,
      invoiceNo: (inv.invoiceNo || "").trim(),
      amount: parseFloat(inv.amount) || 0,
      sentDate: inv.sentDate || "",
      daysToPay: (() => {
        const s = String(inv.daysToPay || "").trim();
        if (/^[0-9]{4}[-/]/.test(s) || /[A-Za-z]{3}/.test(s)) return 30;
        const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
        return !isNaN(p) && p >= 0 && p <= 365 ? p : 30;
      })(),
      status: (inv.status || "Sent").trim()
    }));

    // Filter active expenses to submit
    const activeExpenses = expenses.filter(exp =>
      (exp.description && exp.description.trim()) ||
      (exp.amount !== "" && !isNaN(parseFloat(exp.amount)) && parseFloat(exp.amount) > 0) ||
      exp.date ||
      (exp.transactionId && exp.transactionId.trim())
    ).map(exp => ({
      slotNum: exp.slotNum,
      description: (exp.description || "").trim(),
      amount: parseFloat(exp.amount) || 0,
      vat: exp.vat || "No",
      date: exp.date || "",
      daysToPay: (() => {
        const s = String(exp.daysToPay || "").trim();
        if (/^[0-9]{4}[-/]/.test(s) || /[A-Za-z]{3}/.test(s)) return 30;
        const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
        return !isNaN(p) && p >= 0 && p <= 365 ? p : 30;
      })(),
      status: (exp.status || "Pending").trim(),
      transactionId: (exp.transactionId || "").trim()
    }));

    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_new_job",
          clientSheetId: jobsClient?.clientSheetId,
          masterSheetId: jobsClient?.masterSheetId,
          clientName: jobsClient?.clientName || jobsClient?.name || "",
          tabName: status,
          jobData: {
            client: client.trim(),
            jobName: jobName.trim(),
            projectCode: projectCode.trim(),
            projectRetainer,
            status,
            likelihood: status === "Pipeline" ? likelihood : "",
            revenue: revenue === "" ? 0 : parseFloat(revenue) || 0,
            directCosts: directCosts === "" ? 0 : parseFloat(directCosts) || 0,
            vat,
            dateConfirmed,
            dateAdded: dateConfirmed,
            startDate,
            endDate,
            productLine,
            leadSource,
            invoices: activeInvoices,
            expenses: activeExpenses,
            unevenSplit: splitStrResult
          }
        })
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to create job.");
        setSaving(false);
        return;
      }

      onSuccess(data.targetTab || status, data.targetRow);
    } catch (err) {
      console.error("Error creating new job:", err);
      setError(err.message || "Network error while creating job.");
      setSaving(false);
    }
  };

  const inputStyle = {
    width: "100%",
    padding: "8px 11px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    fontSize: "13px",
    color: "#1e293b",
    backgroundColor: "#ffffff",
    boxSizing: "border-box",
    transition: "border-color 0.15s ease, box-shadow 0.15s ease",
    outline: "none"
  };

  const labelStyle = {
    display: "block",
    fontSize: "11px",
    fontWeight: "600",
    color: "#475569",
    marginBottom: "4px",
    textTransform: "uppercase",
    letterSpacing: "0.4px"
  };

  const sectionStyle = {
    background: "#f8fafc",
    padding: "14px",
    borderRadius: "8px",
    border: "1px solid #e2e8f0"
  };

  const currentInvoice = invoices.find(i => i.slotNum === activeInvoiceSlot) || invoices[0];
  const currentExpense = expenses.find(e => e.slotNum === activeExpenseSlot) || expenses[0];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(3px)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "14px",
          width: "min(95vw, 760px)",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.05)",
          overflow: "hidden"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#ffffff"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "24px",
                  height: "24px",
                  borderRadius: "6px",
                  background: "#e0f2fe",
                  color: "#0284c7",
                  fontSize: "15px",
                  fontWeight: "700"
                }}
              >
                +
              </span>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                Add New Job
              </h2>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
              {jobsClient?.clientName ? `${jobsClient.clientName} · ` : ""}<strong style={{ color: status === "Confirmed" ? "#0369a1" : "#b45309" }}>{status}</strong>
            </div>
          </div>
          <button
            onClick={() => { if (!saving) onClose(); }}
            disabled={saving}
            style={{
              background: "none",
              border: "none",
              fontSize: "22px",
              cursor: saving ? "not-allowed" : "pointer",
              color: "#94a3b8",
              padding: "4px 8px",
              borderRadius: "4px",
              lineHeight: 1
            }}
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto" }}>
          <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: "14px" }}>
            {error && (
              <div
                style={{
                  backgroundColor: "#fef2f2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px"
                }}
              >
                <span style={{ fontWeight: "700" }}>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Row 1: Client Name (35%) & Job Name (65%) */}
            <div style={sectionStyle}>
              <div style={{ display: "grid", gridTemplateColumns: "35% 65%", gap: "12px" }}>
                <div>
                  <label style={labelStyle}>
                    Client Name <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="text"
                    list="new-job-client-suggestions"
                    style={inputStyle}
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                    placeholder="e.g. Acme Corp"
                    autoFocus
                    required
                  />
                  <datalist id="new-job-client-suggestions">
                    {(existingClients || []).map((cName) => (
                      <option key={cName} value={cName} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label style={labelStyle}>
                    Job Name <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="text"
                    style={inputStyle}
                    value={jobName}
                    onChange={(e) => setJobName(e.target.value)}
                    placeholder="e.g. Brand Identity Overhaul"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Row 2: Type | Status | % likelihood | Project Code */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              <div>
                <label style={labelStyle}>
                  Type <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={inputStyle}
                  value={projectRetainer}
                  onChange={(e) => setProjectRetainer(e.target.value)}
                >
                  <option value="Project">Project</option>
                  <option value="Retainer">Retainer</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  Status <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={{
                    ...inputStyle,
                    fontWeight: "600",
                    color: status === "Confirmed" ? "#0369a1" : "#b45309"
                  }}
                  value={status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                >
                  <option value="Confirmed">Confirmed</option>
                  <option value="Pipeline">Pipeline</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>% Likelihood</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  style={{
                    ...inputStyle,
                    backgroundColor: status === "Confirmed" ? "#f1f5f9" : "#ffffff",
                    cursor: status === "Confirmed" ? "not-allowed" : "text",
                    opacity: status === "Confirmed" ? 0.75 : 1
                  }}
                  value={status === "Confirmed" ? 100 : likelihood}
                  disabled={status === "Confirmed"}
                  onChange={(e) => setLikelihood(e.target.value)}
                  placeholder="e.g. 50"
                />
              </div>

              <div>
                <label style={labelStyle}>Project Code</label>
                <input
                  type="text"
                  style={inputStyle}
                  value={projectCode}
                  onChange={(e) => setProjectCode(e.target.value)}
                  placeholder="e.g. PRJ-102"
                />
              </div>
            </div>

            {/* Row 3: Revenue | Direct Costs | VAT? | Date Confirmed / Added */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 2fr", gap: "12px" }}>
              <div>
                <label style={labelStyle}>
                  Revenue (excl. VAT) <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={revenue}
                  onChange={(e) => setRevenue(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={labelStyle}>Direct Costs (excl. VAT)</label>
                  {totalExpenseSum > 0 && parseFloat(directCosts) !== totalExpenseSum && (
                    <button
                      type="button"
                      onClick={() => setDirectCosts(String(totalExpenseSum))}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#2563eb",
                        fontSize: "10px",
                        cursor: "pointer",
                        padding: 0,
                        marginBottom: "4px",
                        textDecoration: "underline"
                      }}
                      title="Sync with entered expenses sum"
                    >
                      Use sum (£{totalExpenseSum})
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={directCosts}
                  onChange={(e) => setDirectCosts(e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <div>
                <label style={labelStyle}>
                  VAT? <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={inputStyle}
                  value={vat}
                  onChange={(e) => setVat(e.target.value)}
                >
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  {status === "Confirmed" ? "Date Confirmed" : "Date Added"}
                </label>
                <DateInput
                  style={inputStyle}
                  value={dateConfirmed}
                  onChange={(e) => setDateConfirmed(e.target.value)}
                />
              </div>
            </div>

            {/* Row 4: Start Date | End Date | Product Line | Lead Source */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Start Date</label>
                <DateInput
                  style={inputStyle}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div>
                <label style={labelStyle}>End Date</label>
                <DateInput
                  style={inputStyle}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate || undefined}
                />
              </div>

              <div>
                <label style={labelStyle}>Product Line</label>
                <select
                  style={inputStyle}
                  value={productLine}
                  onChange={(e) => setProductLine(e.target.value)}
                >
                  <option value="">Select...</option>
                  {(productLines || []).map((pl) => (
                    <option key={pl} value={pl}>
                      {pl}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}>Lead Source</label>
                <select
                  style={inputStyle}
                  value={leadSource}
                  onChange={(e) => setLeadSource(e.target.value)}
                >
                  <option value="">Select...</option>
                  {(leadSources || []).map((ls) => (
                    <option key={ls} value={ls}>
                      {ls}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Uneven Revenue Split Checkbox & Section (Visible for Project jobs) */}
            {projectRetainer === "Project" && (
              <div
                style={{
                  padding: "14px",
                  borderRadius: "8px",
                  border: `1px solid ${enableSplit && isSplitError ? "#f87171" : enableSplit ? "#93c5fd" : "#e2e8f0"}`,
                  background: enableSplit ? "#f0f9ff" : "#f8fafc",
                  transition: "all 0.2s ease"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "9px", cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={enableSplit}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEnableSplit(checked);
                        if (!checked) {
                          setLockedMonths({});
                          lockedMonthsRef.current = {};
                        }
                      }}
                      style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#0066cc" }}
                    />
                    <span style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a" }}>
                      Uneven revenue split?
                    </span>
                    <span style={{ fontSize: "11px", color: "#64748b" }}>
                      (Allocate custom revenue amounts across job duration)
                    </span>
                  </label>

                  {enableSplit && splitMonths.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setLockedMonths({});
                        lockedMonthsRef.current = {};
                      }}
                      style={{
                        padding: "3px 8px",
                        fontSize: "11px",
                        fontWeight: "500",
                        color: "#0369a1",
                        background: "#ffffff",
                        border: "1px solid #bae6fd",
                        borderRadius: "5px",
                        cursor: "pointer"
                      }}
                      title="Reset all locks and distribute revenue equally across all months"
                    >
                      Reset to Even
                    </button>
                  )}
                </div>

                {enableSplit && (
                  <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #e0f2fe" }}>
                    {splitErrorText ? (
                      <div
                        style={{
                          color: "#dc2626",
                          fontSize: "12px",
                          fontWeight: "600",
                          background: "#fef2f2",
                          border: "1px solid #fecaca",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          marginBottom: "10px"
                        }}
                      >
                        ⚠️ {splitErrorText}
                      </div>
                    ) : (
                      <div style={{ fontSize: "12px", color: "#0369a1", marginBottom: "10px", fontWeight: "500" }}>
                        Remaining <strong>£{remaining.toFixed(2)}</strong> auto-distributed across {unlockedCount} unlocked month{unlockedCount === 1 ? "" : "s"} (<strong>£{evenSplit.toFixed(2)}/mo</strong>). Total: £{totRev.toFixed(2)}.
                      </div>
                    )}

                    {splitMonths.length > 0 && (
                      <>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(135px, 1fr))",
                            gap: "8px"
                          }}
                        >
                          {splitMonths.map((m) => {
                            const mKey = m.toLowerCase();
                            const isLocked = validLocked[mKey] !== undefined;
                            const val = isLocked ? validLocked[mKey] : evenSplit;
                            const displayVal = Number.isInteger(val) ? String(val) : val.toFixed(2);

                            return (
                              <SplitMonthCard
                                key={m}
                                month={m}
                                mKey={mKey}
                                isLocked={isLocked}
                                displayVal={displayVal}
                                currencySymbol="£"
                                onCommit={(k, newVal) => {
                                  setLockedMonths((prev) => {
                                    const next = { ...prev };
                                    if (newVal === null || newVal === undefined || isNaN(newVal)) {
                                      delete next[k];
                                    } else {
                                      next[k] = newVal;
                                    }
                                    lockedMonthsRef.current = next;
                                    return next;
                                  });
                                }}
                              />
                            );
                          })}
                        </div>
                        <div style={{ marginTop: "8px", fontSize: "11px", color: "#64748b", textAlign: "right", fontStyle: "italic" }}>
                          Click 🔒 Locked to unlock, or delete an amount to return that month to automatic allocation.
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ========================================================================= */}
            {/* INVOICES SECTION                                                          */}
            {/* ========================================================================= */}
            <div style={{ ...sectionStyle, background: "#f0fdf4", borderColor: "#bbf7d0" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  userSelect: "none"
                }}
                onClick={() => setShowInvoicesSection(prev => !prev)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "16px" }}>🧾</span>
                  <div>
                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#166534" }}>
                      Invoices (Optional)
                    </span>
                    <span style={{ fontSize: "11px", color: "#4ade80", marginLeft: "8px" }}>
                      {invoiceActiveCount > 0
                        ? `${invoiceActiveCount} configured`
                        : "Add initial invoice details"}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {invoiceActiveCount > 0 && (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "10px",
                        background: "#16a34a",
                        color: "#ffffff",
                        fontSize: "11px",
                        fontWeight: "600"
                      }}
                    >
                      {invoiceActiveCount} {invoiceActiveCount === 1 ? "invoice" : "invoices"}
                    </span>
                  )}
                  <span style={{ fontSize: "12px", color: "#166534", fontWeight: "bold" }}>
                    {showInvoicesSection ? "▲ Hide" : "▼ Add / View"}
                  </span>
                </div>
              </div>

              {showInvoicesSection && (
                <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #bbf7d0" }}>
                  {/* Slot Selector Pills */}
                  <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                    {[1, 2, 3].map(slotNum => {
                      const inv = invoices.find(i => i.slotNum === slotNum);
                      const isConfigured = Boolean((inv?.invoiceNo && inv.invoiceNo.trim()) || (inv?.amount !== "" && parseFloat(inv?.amount) > 0) || inv?.sentDate);
                      const isActive = activeInvoiceSlot === slotNum;
                      return (
                        <button
                          key={slotNum}
                          type="button"
                          onClick={() => setActiveInvoiceSlot(slotNum)}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "6px",
                            border: `1px solid ${isActive ? "#16a34a" : isConfigured ? "#86efac" : "#cbd5e1"}`,
                            background: isActive ? "#16a34a" : isConfigured ? "#dcfce7" : "#ffffff",
                            color: isActive ? "#ffffff" : isConfigured ? "#166534" : "#475569",
                            fontSize: "12px",
                            fontWeight: "600",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px"
                          }}
                        >
                          <span>Slot {slotNum}</span>
                          {isConfigured && (
                            <span style={{ fontSize: "11px", opacity: 0.9 }}>
                              {inv.amount ? `£${inv.amount}` : "✓"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Active Invoice Fields */}
                  <div style={{ background: "#ffffff", padding: "12px", borderRadius: "8px", border: "1px solid #dcfce7" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 1fr", gap: "10px", marginBottom: "10px" }}>
                      <div>
                        <label style={labelStyle}>Invoice Number</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={currentInvoice.invoiceNo}
                          onChange={e => updateInvoice(activeInvoiceSlot, "invoiceNo", e.target.value)}
                          placeholder="e.g. INV-1001"
                        />
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <label style={labelStyle}>Amount (£)</label>
                          {revenue && activeInvoiceSlot === 1 && !currentInvoice.amount && (
                            <button
                              type="button"
                              onClick={() => updateInvoice(1, "amount", revenue)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#16a34a",
                                fontSize: "10px",
                                cursor: "pointer",
                                padding: 0,
                                marginBottom: "4px",
                                textDecoration: "underline"
                              }}
                            >
                              Use Rev (£{revenue})
                            </button>
                          )}
                        </div>
                        <input
                          type="number"
                          step="0.01"
                          style={inputStyle}
                          value={currentInvoice.amount}
                          onChange={e => updateInvoice(activeInvoiceSlot, "amount", e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Days To Pay</label>
                        <input
                          type="number"
                          style={inputStyle}
                          value={currentInvoice.daysToPay}
                          onChange={e => updateInvoice(activeInvoiceSlot, "daysToPay", e.target.value)}
                          placeholder="30"
                        />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr auto", gap: "10px", alignItems: "flex-end" }}>
                      <div>
                        <label style={labelStyle}>Sent Date</label>
                        <DateInput
                          style={inputStyle}
                          value={currentInvoice.sentDate}
                          onChange={e => updateInvoice(activeInvoiceSlot, "sentDate", e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Status</label>
                        <select
                          style={inputStyle}
                          value={canonicalizeInvoiceStatus(currentInvoice.status) || "Draft"}
                          onChange={e => updateInvoice(activeInvoiceSlot, "status", e.target.value)}
                        >
                          {INVOICE_STATUS_OPTIONS.map((st) => (
                            <option key={st} value={st}>{st}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <button
                          type="button"
                          onClick={() => clearInvoice(activeInvoiceSlot)}
                          style={{
                            padding: "8px 12px",
                            border: "1px solid #e2e8f0",
                            borderRadius: "6px",
                            background: "#f8fafc",
                            color: "#64748b",
                            fontSize: "12px",
                            cursor: "pointer"
                          }}
                          title="Clear this invoice slot"
                        >
                          Clear Slot
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ========================================================================= */}
            {/* EXPENSES / DIRECT COSTS SECTION                                          */}
            {/* ========================================================================= */}
            <div style={{ ...sectionStyle, background: "#fefce8", borderColor: "#fef08a" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  userSelect: "none"
                }}
                onClick={() => setShowExpensesSection(prev => !prev)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "16px" }}>📦</span>
                  <div>
                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#854d0e" }}>
                      Direct Costs & Expenses (Optional)
                    </span>
                    <span style={{ fontSize: "11px", color: "#ca8a04", marginLeft: "8px" }}>
                      {expenseActiveCount > 0
                        ? `${expenseActiveCount} configured (£${totalExpenseSum})`
                        : "Add itemised subcontractor or supplier costs"}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {expenseActiveCount > 0 && (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "10px",
                        background: "#ca8a04",
                        color: "#ffffff",
                        fontSize: "11px",
                        fontWeight: "600"
                      }}
                    >
                      {expenseActiveCount} {expenseActiveCount === 1 ? "expense" : "expenses"}
                    </span>
                  )}
                  <span style={{ fontSize: "12px", color: "#854d0e", fontWeight: "bold" }}>
                    {showExpensesSection ? "▲ Hide" : "▼ Add / View"}
                  </span>
                </div>
              </div>

              {showExpensesSection && (
                <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #fef08a" }}>
                  {/* Slot Selector Pills */}
                  <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                    {[1, 2, 3].map(slotNum => {
                      const exp = expenses.find(e => e.slotNum === slotNum);
                      const isConfigured = Boolean((exp?.description && exp.description.trim()) || (exp?.amount !== "" && parseFloat(exp?.amount) > 0) || exp?.date);
                      const isActive = activeExpenseSlot === slotNum;
                      return (
                        <button
                          key={slotNum}
                          type="button"
                          onClick={() => setActiveExpenseSlot(slotNum)}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "6px",
                            border: `1px solid ${isActive ? "#ca8a04" : isConfigured ? "#fde047" : "#cbd5e1"}`,
                            background: isActive ? "#ca8a04" : isConfigured ? "#fef9c3" : "#ffffff",
                            color: isActive ? "#ffffff" : isConfigured ? "#854d0e" : "#475569",
                            fontSize: "12px",
                            fontWeight: "600",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px"
                          }}
                        >
                          <span>Slot {slotNum}</span>
                          {isConfigured && (
                            <span style={{ fontSize: "11px", opacity: 0.9 }}>
                              {exp.amount ? `£${exp.amount}` : "✓"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Active Expense Fields */}
                  <div style={{ background: "#ffffff", padding: "12px", borderRadius: "8px", border: "1px solid #fef9c3" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                      <div>
                        <label style={labelStyle}>Description / Supplier</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={currentExpense.description}
                          onChange={e => updateExpense(activeExpenseSlot, "description", e.target.value)}
                          placeholder="e.g. Photography & Studio hire"
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Amount (£)</label>
                        <input
                          type="number"
                          step="0.01"
                          style={inputStyle}
                          value={currentExpense.amount}
                          onChange={e => updateExpense(activeExpenseSlot, "amount", e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>VAT Charged?</label>
                        <select
                          style={inputStyle}
                          value={currentExpense.vat}
                          onChange={e => updateExpense(activeExpenseSlot, "vat", e.target.value)}
                        >
                          <option value="No">No</option>
                          <option value="Yes">Yes</option>
                        </select>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr auto", gap: "10px", alignItems: "flex-end" }}>
                      <div>
                        <label style={labelStyle}>Date</label>
                        <DateInput
                          style={inputStyle}
                          value={currentExpense.date}
                          onChange={e => updateExpense(activeExpenseSlot, "date", e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Days To Pay</label>
                        <input
                          type="number"
                          style={inputStyle}
                          value={currentExpense.daysToPay}
                          onChange={e => updateExpense(activeExpenseSlot, "daysToPay", e.target.value)}
                          placeholder="30"
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Status</label>
                        <select
                          style={inputStyle}
                          value={canonicalizeExpenseStatus(currentExpense.status) || "Received"}
                          onChange={e => updateExpense(activeExpenseSlot, "status", e.target.value)}
                        >
                          {EXPENSE_STATUS_OPTIONS.map((st) => (
                            <option key={st} value={st}>{st}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle}>Transaction ID</label>
                        <input
                          type="text"
                          style={inputStyle}
                          value={currentExpense.transactionId}
                          onChange={e => updateExpense(activeExpenseSlot, "transactionId", e.target.value)}
                          placeholder="e.g. TX-492"
                        />
                      </div>
                      <div>
                        <button
                          type="button"
                          onClick={() => clearExpense(activeExpenseSlot)}
                          style={{
                            padding: "8px 12px",
                            border: "1px solid #e2e8f0",
                            borderRadius: "6px",
                            background: "#f8fafc",
                            color: "#64748b",
                            fontSize: "12px",
                            cursor: "pointer"
                          }}
                          title="Clear this expense slot"
                        >
                          Clear Slot
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid #e2e8f0",
              backgroundColor: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "10px"
            }}
          >
            <div style={{ fontSize: "12px", color: "#64748b" }}>
              {(invoiceActiveCount > 0 || expenseActiveCount > 0 || enableSplit) && (
                <span>
                  Including:{" "}
                  <strong>
                    {[
                      enableSplit ? "custom revenue split" : null,
                      invoiceActiveCount > 0 ? `${invoiceActiveCount} invoice(s)` : null,
                      expenseActiveCount > 0 ? `${expenseActiveCount} expense(s)` : null,
                    ].filter(Boolean).join(", ")}
                  </strong>
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                style={{
                  padding: "8px 16px",
                  fontSize: "13px",
                  fontWeight: "500",
                  color: "#475569",
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: saving ? "not-allowed" : "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{
                  padding: "8px 22px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#ffffff",
                  backgroundColor: saving ? "#60a5fa" : "#0066cc",
                  border: "none",
                  borderRadius: "6px",
                  cursor: saving ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0, 102, 204, 0.2)"
                }}
              >
                {saving ? (
                  <>
                    <Spinner size={14} color="#ffffff" />
                    <span>Adding Job...</span>
                  </>
                ) : (
                  <span>Save Job</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
