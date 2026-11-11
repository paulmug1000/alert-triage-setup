import React, { useState, useMemo, useRef, useEffect } from "react";
import Spinner from "./Spinner";
import SplitMonthCard from "./SplitMonthCard";
import { formatSplitString } from "../services/splitHelper";
import DateInput from "./DateInput";
import { useAuth } from "../hooks/useAuth";
import {
  INVOICE_STATUS_OPTIONS,
  EXPENSE_STATUS_OPTIONS,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  calculatePaymentDate
} from "../utils/helpers";
import {
  generateManualPlaceholderInvoiceRef,
  generateManualPlaceholderExpenseId
} from "./PlaceholderPill";

export default function JobsNewJobModal({
  jobsClient,
  initialTab = "Confirmed",
  productLines = [],
  leadSources = [],
  existingClients = [],
  initialJobData = null,
  onClose,
  onSuccess
}) {
  const auth = useAuth?.() || {};
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.role === "Admin");
  // Format today's date as YYYY-MM-DD for native HTML date inputs
  const todayISO = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);

  const [client, setClient] = useState(initialJobData?.client || "");
  const [jobName, setJobName] = useState(initialJobData?.jobName || "");
  const [projectCode, setProjectCode] = useState(initialJobData?.projectCode || "");
  const [projectRetainer, setProjectRetainer] = useState(initialJobData?.projectRetainer || "Project");
  const [status, setStatus] = useState(initialJobData?.status || "");
  const [likelihood, setLikelihood] = useState(initialJobData?.likelihood !== undefined ? String(initialJobData.likelihood) : (initialJobData?.status === "Confirmed" ? "100" : (initialJobData?.status === "Pipeline" ? "50" : "")));
  const [revenue, setRevenue] = useState(initialJobData?.revenue !== undefined ? String(initialJobData.revenue) : "");
  const [directCosts, setDirectCosts] = useState(initialJobData?.directCosts !== undefined ? String(initialJobData.directCosts) : "0");
  const [vat, setVat] = useState(initialJobData?.vat || "Yes");
  const [dateConfirmed, setDateConfirmed] = useState(initialJobData?.dateConfirmed || todayISO);
  const [startDate, setStartDate] = useState(initialJobData?.startDate || "");
  const [endDate, setEndDate] = useState(initialJobData?.endDate || "");
  const [noEndDate, setNoEndDate] = useState(Boolean(initialJobData?.noEndDate));
  const [productLine, setProductLine] = useState(initialJobData?.productLine || "");
  const [leadSource, setLeadSource] = useState(initialJobData?.leadSource || "");

  const [clientDefaultDays, setClientDefaultDays] = useState(30);

  // Invoices (arbitrary count, dynamic list)
  const [showInvoicesSection, setShowInvoicesSection] = useState(
    Boolean(initialJobData?.invoices && initialJobData.invoices.length > 0)
  );
  const [invoices, setInvoices] = useState(() => {
    if (Array.isArray(initialJobData?.invoices) && initialJobData.invoices.length > 0) {
      return initialJobData.invoices.map((inv, idx) => ({
        id: inv.id || `inv_${Date.now()}_${idx}`,
        invoiceNo: inv.invoiceNo || inv.ref || "",
        amount: inv.amount !== undefined ? String(inv.amount) : "",
        sentDate: inv.sentDate || "",
        daysToPay: inv.daysToPay !== undefined ? inv.daysToPay : 30,
        status: inv.status || ""
      }));
    }
    return [
      { id: `inv_${Date.now()}_0`, invoiceNo: "", amount: "", sentDate: "", daysToPay: 30, status: "" }
    ];
  });

  // Expenses / Direct costs (arbitrary count, dynamic list)
  const [showExpensesSection, setShowExpensesSection] = useState(
    Boolean(initialJobData?.expenses && initialJobData.expenses.length > 0)
  );
  const [expenses, setExpenses] = useState(() => {
    if (Array.isArray(initialJobData?.expenses) && initialJobData.expenses.length > 0) {
      return initialJobData.expenses.map((exp, idx) => ({
        id: exp.id || `exp_${Date.now()}_${idx}`,
        description: exp.description || "",
        amount: exp.amount !== undefined ? String(exp.amount) : "",
        vat: exp.vat || "No",
        date: exp.date || "",
        daysToPay: exp.daysToPay !== undefined ? exp.daysToPay : 30,
        status: exp.status || "Received",
        transactionId: exp.transactionId || ""
      }));
    }
    return [
      { id: `exp_${Date.now()}_0`, description: "", amount: "", vat: "No", date: "", daysToPay: 30, status: "Received", transactionId: "" }
    ];
  });

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

  const updateInvoice = (index, field, val) => {
    setInvoices(prev => prev.map((inv, idx) => idx === index ? { ...inv, [field]: val } : inv));
  };

  const handleAddNewInvoice = () => {
    setInvoices(prev => [
      ...prev,
      {
        id: `inv_${Date.now()}_${prev.length}`,
        invoiceNo: "",
        amount: "",
        sentDate: "",
        daysToPay: clientDefaultDays || 30,
        status: ""
      }
    ]);
  };

  const handleRemoveInvoice = (index) => {
    setInvoices(prev => prev.filter((_, idx) => idx !== index));
  };

  const updateExpense = (index, field, val) => {
    setExpenses(prev => prev.map((exp, idx) => idx === index ? { ...exp, [field]: val } : exp));
  };

  const handleAddNewExpense = () => {
    setExpenses(prev => [
      ...prev,
      {
        id: `exp_${Date.now()}_${prev.length}`,
        description: "",
        amount: "",
        vat: "No",
        date: "",
        daysToPay: clientDefaultDays || 30,
        status: "Received",
        transactionId: ""
      }
    ]);
  };

  const handleRemoveExpense = (index) => {
    setExpenses(prev => prev.filter((_, idx) => idx !== index));
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
      return { splitMonths: [], splitDateError: "Please enter start date and end date above to split revenue across months." };
    }
    const sDate = parseModalDate(startDate);
    const eDate = parseModalDate(endDate);
    if (!sDate || !eDate) {
      return { splitMonths: [], splitDateError: "Please enter valid start and end dates to split revenue across months." };
    }
    let currYear = sDate.getFullYear();
    let currMonth = sDate.getMonth();
    const endYear = eDate.getFullYear();
    const endMonth = eDate.getMonth();

    if (new Date(currYear, currMonth, 1) > new Date(endYear, endMonth, 1)) {
      return { splitMonths: [], splitDateError: "End date must be after start date." };
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
    if (isNaN(totRev) || totRev <= 0) return { isSplitError: true, splitErrorText: "Please enter a job revenue amount above to allocate across months." };
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
    } else if (newStatus === "Pipeline") {
      if (likelihood === "100" || !likelihood) {
        setLikelihood("50");
      }
    } else {
      setLikelihood("");
    }
  };

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setError("");

    if (!client.trim()) {
      setError("Please enter a client name.");
      return;
    }
    if (!jobName.trim()) {
      setError("Please enter a job name.");
      return;
    }
    if (!status) {
      setError("Please select a status.");
      return;
    }
    const isRetainerNoEnd = projectRetainer === "Retainer" && noEndDate;
    if (projectRetainer === "Retainer" && !isRetainerNoEnd && !endDate) {
      setError("Please enter an end date or tick 'No end date'.");
      return;
    }
    if (!isRetainerNoEnd && startDate && endDate && endDate < startDate) {
      setError("End date cannot be before start date.");
      return;
    }

    if (enableSplit && isSplitError) {
      setError(splitErrorText || "Please resolve errors in the uneven revenue split section before saving.");
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
    ).map((inv, idx) => {
      const invNo = (inv.invoiceNo || "").trim();
      return {
        slotNum: (idx % 3) + 1,
        rowOffset: Math.floor(idx / 3),
        invoiceNo: invNo,
        amount: parseFloat(inv.amount) || 0,
        sentDate: inv.sentDate || "",
        daysToPay: (() => {
          const s = String(inv.daysToPay || "").trim();
          if (/^[0-9]{4}[-/]/.test(s) || /[A-Za-z]{3}/.test(s)) return 30;
          const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
          return !isNaN(p) && p >= 0 && p <= 365 ? p : (clientDefaultDays || 30);
        })(),
        status: (inv.status || "").trim()
      };
    });

    // Filter active expenses to submit
    const activeExpenses = expenses.filter(exp =>
      (exp.description && exp.description.trim()) ||
      (exp.amount !== "" && !isNaN(parseFloat(exp.amount)) && parseFloat(exp.amount) > 0) ||
      exp.date ||
      (exp.transactionId && exp.transactionId.trim())
    ).map((exp, idx) => ({
      slotNum: (idx % 3) + 1,
      rowOffset: Math.floor(idx / 3),
      description: (exp.description || "").trim(),
      amount: parseFloat(exp.amount) || 0,
      vat: exp.vat || "No",
      date: exp.date || "",
      daysToPay: (() => {
        const s = String(exp.daysToPay || "").trim();
        if (/^[0-9]{4}[-/]/.test(s) || /[A-Za-z]{3}/.test(s)) return 30;
        const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
        return !isNaN(p) && p >= 0 && p <= 365 ? p : (clientDefaultDays || 30);
      })(),
      status: (exp.status || "Received").trim(),
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
            endDate: isRetainerNoEnd ? "31-Dec-2050" : endDate,
            noEndDate: isRetainerNoEnd,
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

      onSuccess(data.targetTab || status, data.targetRow, data);
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
                {initialJobData?.modalTitle || "Add new job"}
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
                    Client name <span style={{ color: "#ef4444" }}>*</span>
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
                    Job name <span style={{ color: "#ef4444" }}>*</span>
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
                  onChange={(e) => {
                    const nextType = e.target.value;
                    setProjectRetainer(nextType);
                    if (nextType !== "Retainer") setNoEndDate(false);
                  }}
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
                    color: status === "Confirmed" ? "#0369a1" : (status === "Pipeline" ? "#b45309" : "#64748b")
                  }}
                  value={status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                >
                  <option value=""></option>
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
                <label style={labelStyle}>Project code</label>
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
                <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                  For retainers, enter the monthly amount
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={labelStyle}>Direct costs (excl. VAT)</label>
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
                  {status === "Confirmed" ? "Date confirmed" : "Date added"}
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
                <label style={labelStyle}>Start date</label>
                <DateInput
                  style={inputStyle}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>End date</label>
                  {projectRetainer === "Retainer" && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", fontWeight: "600", color: "#475569", cursor: "pointer", userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={noEndDate}
                        onChange={(e) => setNoEndDate(e.target.checked)}
                        style={{ margin: 0, cursor: "pointer" }}
                      />
                      No end date
                    </label>
                  )}
                </div>
                {projectRetainer === "Retainer" && noEndDate ? (
                  <input
                    type="text"
                    style={{ ...inputStyle, backgroundColor: "#f8fafc", color: "#64748b", cursor: "not-allowed" }}
                    value="No end date"
                    disabled
                  />
                ) : (
                  <DateInput
                    style={inputStyle}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    min={startDate || undefined}
                  />
                )}
              </div>

              <div>
                <label style={labelStyle}>Product line</label>
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
                <label style={labelStyle}>Lead source</label>
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
                onClick={() => {
                  setShowInvoicesSection(prev => {
                    const next = !prev;
                    if (next && invoices.length === 0) {
                      handleAddNewInvoice();
                    }
                    return next;
                  });
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "16px" }}>🧾</span>
                  <div>
                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#166534" }}>
                      Invoices (optional)
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
                    {showInvoicesSection ? "▲ Hide" : "▼ Add / view"}
                  </span>
                </div>
              </div>

              {showInvoicesSection && (
                <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #bbf7d0", display: "flex", flexDirection: "column", gap: "12px" }}>
                  {invoices.length === 0 ? (
                    <div style={{ padding: "12px", textAlign: "center", color: "#64748b", fontSize: "12px" }}>
                      No invoices added yet. Click below to add an invoice.
                    </div>
                  ) : (
                    invoices.map((inv, index) => {
                      const paymentDate = calculatePaymentDate(inv.sentDate, inv.daysToPay || clientDefaultDays);
                      return (
                        <div
                          key={inv.id || index}
                          style={{
                            background: "#ffffff",
                            padding: "14px",
                            borderRadius: "8px",
                            border: "1px solid #dcfce7",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                          }}
                        >
                          {/* Card Header */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                            <span style={{ fontSize: "12px", fontWeight: "700", color: "#166534" }}>
                              Invoice {index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveInvoice(index)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#dc2626",
                                fontSize: "11px",
                                fontWeight: "600",
                                cursor: "pointer",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#fee2e2"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                              title="Remove this invoice"
                            >
                              ✕ Remove
                            </button>
                          </div>

                          {/* Row 1: Invoice number, Amount (£), Days to pay */}
                          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 1fr", gap: "10px", marginBottom: "10px" }}>
                            <div>
                              <label style={labelStyle}>Invoice number</label>
                              <input
                                type="text"
                                style={inputStyle}
                                value={inv.invoiceNo}
                                onChange={e => updateInvoice(index, "invoiceNo", e.target.value)}
                                placeholder="Leave blank for manual invoice"
                              />
                            </div>

                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                                <label style={{ ...labelStyle, marginBottom: 0 }}>Amount (£)</label>
                                {revenue && index === 0 && !inv.amount && (
                                  <button
                                    type="button"
                                    onClick={() => updateInvoice(0, "amount", revenue)}
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#16a34a",
                                      fontSize: "10px",
                                      fontWeight: "500",
                                      cursor: "pointer",
                                      padding: 0,
                                      textDecoration: "underline"
                                    }}
                                  >
                                    Use rev (£{revenue})
                                  </button>
                                )}
                              </div>
                              <input
                                type="number"
                                step="0.01"
                                style={inputStyle}
                                value={inv.amount}
                                onChange={e => updateInvoice(index, "amount", e.target.value)}
                                placeholder="0.00"
                              />
                            </div>

                            <div>
                              <label style={labelStyle}>Days to pay</label>
                              <input
                                type="number"
                                style={inputStyle}
                                value={inv.daysToPay}
                                onChange={e => updateInvoice(index, "daysToPay", e.target.value)}
                                placeholder={String(clientDefaultDays || 30)}
                              />
                              {paymentDate && (
                                <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                                  Payment date: <strong style={{ color: "#0f172a", fontWeight: "600" }}>{paymentDate}</strong>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Row 2: Sent date, Status */}
                          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr", gap: "10px" }}>
                            <div>
                              <label style={labelStyle}>Sent date</label>
                              <DateInput
                                style={inputStyle}
                                value={inv.sentDate}
                                onChange={e => updateInvoice(index, "sentDate", e.target.value)}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Status</label>
                              <select
                                style={inputStyle}
                                value={canonicalizeInvoiceStatus(inv.status) || ""}
                                onChange={e => updateInvoice(index, "status", e.target.value)}
                              >
                                <option value=""></option>
                                {INVOICE_STATUS_OPTIONS.map((st) => (
                                  <option key={st} value={st}>{st}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}

                  {/* Add New Invoice Button */}
                  <button
                    type="button"
                    onClick={handleAddNewInvoice}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                      padding: "9px 14px",
                      borderRadius: "6px",
                      border: "1px dashed #86efac",
                      background: "#ffffff",
                      color: "#166534",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer",
                      transition: "all 0.15s ease"
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#16a34a"; e.currentTarget.style.background = "#f0fdf4"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#86efac"; e.currentTarget.style.background = "#ffffff"; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add new invoice
                  </button>
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
                onClick={() => {
                  setShowExpensesSection(prev => {
                    const next = !prev;
                    if (next && expenses.length === 0) {
                      handleAddNewExpense();
                    }
                    return next;
                  });
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "16px" }}>📦</span>
                  <div>
                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#854d0e" }}>
                      Direct costs (optional)
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
                      {expenseActiveCount} {expenseActiveCount === 1 ? "cost" : "costs"}
                    </span>
                  )}
                  <span style={{ fontSize: "12px", color: "#854d0e", fontWeight: "bold" }}>
                    {showExpensesSection ? "▲ Hide" : "▼ Add / view"}
                  </span>
                </div>
              </div>

              {showExpensesSection && (
                <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #fef08a", display: "flex", flexDirection: "column", gap: "12px" }}>
                  {expenses.length === 0 ? (
                    <div style={{ padding: "12px", textAlign: "center", color: "#64748b", fontSize: "12px" }}>
                      No direct costs added yet. Click below to add a direct cost.
                    </div>
                  ) : (
                    expenses.map((exp, index) => {
                      const paymentDate = calculatePaymentDate(exp.date, exp.daysToPay || clientDefaultDays);
                      return (
                        <div
                          key={exp.id || index}
                          style={{
                            background: "#ffffff",
                            padding: "14px",
                            borderRadius: "8px",
                            border: "1px solid #fef9c3",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                          }}
                        >
                          {/* Card Header */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                            <span style={{ fontSize: "12px", fontWeight: "700", color: "#854d0e" }}>
                              Direct cost {index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveExpense(index)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#dc2626",
                                fontSize: "11px",
                                fontWeight: "600",
                                cursor: "pointer",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#fee2e2"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                              title="Remove this direct cost"
                            >
                              ✕ Remove
                            </button>
                          </div>

                          {/* Row 1: Description / supplier, Amount (£), VAT charged? */}
                          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                            <div>
                              <label style={labelStyle}>Description / supplier</label>
                              <input
                                type="text"
                                style={inputStyle}
                                value={exp.description}
                                onChange={e => updateExpense(index, "description", e.target.value)}
                                placeholder="e.g. Photography & studio hire"
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Amount (£)</label>
                              <input
                                type="number"
                                step="0.01"
                                style={inputStyle}
                                value={exp.amount}
                                onChange={e => updateExpense(index, "amount", e.target.value)}
                                placeholder="0.00"
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>VAT charged?</label>
                              <select
                                style={inputStyle}
                                value={exp.vat}
                                onChange={e => updateExpense(index, "vat", e.target.value)}
                              >
                                <option value="No">No</option>
                                <option value="Yes">Yes</option>
                              </select>
                            </div>
                          </div>

                          {/* Row 2: Date, Days to pay, Status, Transaction ID */}
                          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "10px" }}>
                            <div>
                              <label style={labelStyle}>Date</label>
                              <DateInput
                                style={inputStyle}
                                value={exp.date}
                                onChange={e => updateExpense(index, "date", e.target.value)}
                              />
                            </div>
                            <div>
                              <label style={labelStyle}>Days to pay</label>
                              <input
                                type="number"
                                style={inputStyle}
                                value={exp.daysToPay}
                                onChange={e => updateExpense(index, "daysToPay", e.target.value)}
                                placeholder={String(clientDefaultDays || 30)}
                              />
                              {paymentDate && (
                                <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                                  Payment date: <strong style={{ color: "#0f172a", fontWeight: "600" }}>{paymentDate}</strong>
                                </div>
                              )}
                            </div>
                            <div>
                              <label style={labelStyle}>Status</label>
                              <select
                                style={inputStyle}
                                value={canonicalizeExpenseStatus(exp.status) || "Received"}
                                onChange={e => updateExpense(index, "status", e.target.value)}
                              >
                                {EXPENSE_STATUS_OPTIONS.map((st) => (
                                  <option key={st} value={st}>{st}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                                <label style={{ ...labelStyle, marginBottom: 0 }}>Transaction ID</label>
                                <button
                                  type="button"
                                  onClick={() => updateExpense(index, "transactionId", generateManualPlaceholderExpenseId(exp.date || todayISO))}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    color: "#854d0e",
                                    fontSize: "10px",
                                    fontWeight: "500",
                                    cursor: "pointer",
                                    padding: 0,
                                    textDecoration: "underline"
                                  }}
                                  title="Insert manual placeholder transaction ID"
                                >
                                  Placeholder
                                </button>
                              </div>
                              <input
                                type="text"
                                style={inputStyle}
                                value={exp.transactionId}
                                onChange={e => updateExpense(index, "transactionId", e.target.value)}
                                placeholder="e.g. TX-492"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}

                  {/* Add New Direct Cost Button */}
                  <button
                    type="button"
                    onClick={handleAddNewExpense}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                      padding: "9px 14px",
                      borderRadius: "6px",
                      border: "1px dashed #fde047",
                      background: "#ffffff",
                      color: "#854d0e",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer",
                      transition: "all 0.15s ease"
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#ca8a04"; e.currentTarget.style.background = "#fefce8"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#fde047"; e.currentTarget.style.background = "#ffffff"; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add new direct cost
                  </button>
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
                    <span>Adding job...</span>
                  </>
                ) : (
                  <span>Save job</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
