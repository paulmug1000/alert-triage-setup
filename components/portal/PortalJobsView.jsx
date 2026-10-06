import React, { useState, useEffect, useMemo } from "react";
import Spinner from "../Spinner";
import { formatMoney, parseMoney } from "../../services/deepDiveHelper";

export default function PortalJobsView({
  clientName,
  clientSheetId,
  data,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isReadOnly = false,
}) {
  const [filterType, setFilterType] = useState("all"); // 'all' | 'confirmed' | 'pipeline' | 'project' | 'retainer'
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("startDateDesc"); // 'startDateDesc' | 'revDesc' | 'revAsc' | 'clientAsc'
  const [currentPage, setCurrentPage] = useState(1);
  const [editingJob, setEditingJob] = useState(null); // null or job object
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [optimisticJobs, setOptimisticJobs] = useState({}); // { [key]: job }
  const [enableSplit, setEnableSplit] = useState(false);
  const [lockedMonths, setLockedMonths] = useState({});
  const pageSize = 25;

  // Clear optimistic jobs when fresh server data arrives
  useEffect(() => {
    setOptimisticJobs({});
  }, [data?.jobs]);

  // Lock background scroll when modal is open
  useEffect(() => {
    if (editingJob) {
      const origBodyOverflow = document.body.style.overflow;
      const origHtmlOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = origBodyOverflow;
        document.documentElement.style.overflow = origHtmlOverflow;
      };
    }
  }, [editingJob]);

  const parseDate = (dateVal) => {
    if (!dateVal) return null;
    if (dateVal instanceof Date && !isNaN(dateVal.getTime())) return dateVal;
    const str = String(dateVal).trim();
    if (!str || str === "—") return null;

    // yyyy-mm-dd
    const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (isoMatch) {
      const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
      return isNaN(d.getTime()) ? null : d;
    }

    // dd/mm/yyyy or dd-mm-yyyy
    const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (ukMatch) {
      let y = parseInt(ukMatch[3], 10);
      if (y < 100) y += 2000;
      const d = new Date(y, parseInt(ukMatch[2], 10) - 1, parseInt(ukMatch[1], 10));
      return isNaN(d.getTime()) ? null : d;
    }

    // dd-Mmm-yyyy e.g. 1-Oct-2026 or 01-Oct-26
    const mmmMatch = str.match(/^(\d{1,2})[\s\-]([a-zA-Z]{3})[\s\-](\d{2,4})$/);
    if (mmmMatch) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mi = months[mmmMatch[2].toLowerCase()];
      let y = parseInt(mmmMatch[3], 10);
      if (y < 100) y += 2000;
      if (mi !== undefined) {
        const d = new Date(y, mi, parseInt(mmmMatch[1], 10));
        return isNaN(d.getTime()) ? null : d;
      }
    }

    // Mmm-yy or Mmm-yyyy
    const myMatch = str.match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
    if (myMatch) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mi = months[myMatch[1].toLowerCase()];
      let y = parseInt(myMatch[2], 10);
      if (y < 100) y += 2000;
      if (mi !== undefined) {
        const d = new Date(y, mi, 1);
        return isNaN(d.getTime()) ? null : d;
      }
    }

    const parsed = new Date(str);
    return !isNaN(parsed.getTime()) ? parsed : null;
  };

  const formatDateDdMmmYy = (dateVal) => {
    const d = parseDate(dateVal);
    if (!d) return dateVal ? String(dateVal) : "—";
    const day = String(d.getDate()).padStart(2, "0");
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mmm = monthNames[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    return `${day}-${mmm}-${yy}`;
  };

  const jobsData = data?.jobs;

  const productLineOptions = useMemo(() => {
    const fromApi = data?.formOptions?.productLines || [];
    if (fromApi.length > 0) return fromApi;
    const set = new Set();
    (jobsData?.all || []).forEach((j) => { if (j.productLine) set.add(j.productLine); });
    return Array.from(set);
  }, [data?.formOptions?.productLines, jobsData?.all]);

  const leadSourceOptions = useMemo(() => {
    const fromApi = data?.formOptions?.leadSources || [];
    if (fromApi.length > 0) return fromApi;
    const set = new Set();
    (jobsData?.all || []).forEach((j) => { if (j.leadSource) set.add(j.leadSource); });
    return Array.from(set);
  }, [data?.formOptions?.leadSources, jobsData?.all]);

  const filteredJobs = useMemo(() => {
    if (!jobsData?.all) return [];
    let list = jobsData.all.map((j) => {
      const key = j.id !== undefined ? j.id : (j.parentId !== undefined ? j.parentId : j.rowNumber);
      return (key !== undefined && optimisticJobs[key]) ? { ...j, ...optimisticJobs[key] } : j;
    });

    // Filter by type
    if (filterType === "confirmed") {
      list = list.filter((j) => j.type === "Confirmed");
    } else if (filterType === "pipeline") {
      list = list.filter((j) => j.type === "Pipeline");
    } else if (filterType === "project") {
      list = list.filter((j) => String(j.projectRetainer || "").toLowerCase().includes("project"));
    } else if (filterType === "retainer") {
      list = list.filter((j) => String(j.projectRetainer || "").toLowerCase().includes("retainer"));
    }

    // Filter by search
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim();
      list = list.filter(
        (j) =>
          (j.client || "").toLowerCase().includes(q) ||
          (j.jobName || "").toLowerCase().includes(q) ||
          (j.productLine && j.productLine.toLowerCase().includes(q))
      );
    }

    // Sort
    list.sort((a, b) => {
      if (sortBy === "startDateDesc") {
        const timeA = parseDate(a.startDate)?.getTime() || 0;
        const timeB = parseDate(b.startDate)?.getTime() || 0;
        if (timeB !== timeA) return timeB - timeA;
        return (a.client || "").localeCompare(b.client || "");
      }
      if (sortBy === "startDateAsc") {
        const timeA = parseDate(a.startDate)?.getTime() || 0;
        const timeB = parseDate(b.startDate)?.getTime() || 0;
        if (timeA !== timeB) return timeA - timeB;
        return (a.client || "").localeCompare(b.client || "");
      }
      if (sortBy === "clientAsc") {
        const cmp = (a.client || "").localeCompare(b.client || "");
        if (cmp !== 0) return cmp;
        return (a.jobName || "").localeCompare(b.jobName || "");
      }
      if (sortBy === "likelihoodDesc") {
        const likA = typeof a.likelihoodNum === "number" && !isNaN(a.likelihoodNum)
          ? a.likelihoodNum
          : (parseFloat(String(a.likelihood || "").replace("%", "")) || 0);
        const likB = typeof b.likelihoodNum === "number" && !isNaN(b.likelihoodNum)
          ? b.likelihoodNum
          : (parseFloat(String(b.likelihood || "").replace("%", "")) || 0);
        if (likB !== likA) return likB - likA;
        return (b.revNum || 0) - (a.revNum || 0);
      }
      if (sortBy === "likelihoodAsc") {
        const likA = typeof a.likelihoodNum === "number" && !isNaN(a.likelihoodNum)
          ? a.likelihoodNum
          : (parseFloat(String(a.likelihood || "").replace("%", "")) || 0);
        const likB = typeof b.likelihoodNum === "number" && !isNaN(b.likelihoodNum)
          ? b.likelihoodNum
          : (parseFloat(String(b.likelihood || "").replace("%", "")) || 0);
        if (likA !== likB) return likA - likB;
        return (b.revNum || 0) - (a.revNum || 0);
      }
      if (sortBy === "revDesc") {
        const revA = typeof a.revNum === "number" && !isNaN(a.revNum)
          ? a.revNum
          : parseMoney(a.revenue);
        const revB = typeof b.revNum === "number" && !isNaN(b.revNum)
          ? b.revNum
          : parseMoney(b.revenue);
        if (revB !== revA) return revB - revA;
        const timeA = parseDate(a.startDate)?.getTime() || 0;
        const timeB = parseDate(b.startDate)?.getTime() || 0;
        return timeB - timeA;
      }
      if (sortBy === "revAsc") {
        const revA = typeof a.revNum === "number" && !isNaN(a.revNum)
          ? a.revNum
          : parseMoney(a.revenue);
        const revB = typeof b.revNum === "number" && !isNaN(b.revNum)
          ? b.revNum
          : parseMoney(b.revenue);
        if (revA !== revB) return revA - revB;
        const timeA = parseDate(a.startDate)?.getTime() || 0;
        const timeB = parseDate(b.startDate)?.getTime() || 0;
        return timeB - timeA;
      }
      // Default: Start date (descending)
      const timeA = parseDate(a.startDate)?.getTime() || 0;
      const timeB = parseDate(b.startDate)?.getTime() || 0;
      return timeB - timeA;
    });

    return list;
  }, [jobsData, filterType, searchTerm, sortBy, optimisticJobs]);

  const currencySymbol = propCurrencySymbol || data?.currencySymbol || data?.clientInfo?.currencySymbol || "£";
  const thousandsSeparator = propThousandsSeparator || data?.thousandsSeparator || data?.clientInfo?.thousandsSeparator || ",";

  const totalPages = Math.ceil(filteredJobs.length / pageSize) || 1;
  const paginatedJobs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredJobs.slice(start, start + pageSize);
  }, [filteredJobs, currentPage, pageSize]);

  const formatGBP = (val) => {
    return formatMoney(val, 0, currencySymbol, thousandsSeparator);
  };

  const handleOpenAddJob = () => {
    if (isReadOnly) return;
    setSaveError(null);
    setEnableSplit(false);
    setLockedMonths({});
    setEditingJob({
      id: "new",
      rowNumber: null,
      type: "Pipeline",
      client: "",
      jobName: "",
      projectRetainer: "Project",
      likelihood: "50%",
      revenue: `${currencySymbol}0`,
      directCosts: `${currencySymbol}0`,
      startDate: new Date().toISOString().split("T")[0],
      endDate: "",
      productLine: "",
      leadSource: "",
      vat: "Yes",
      projectCode: "",
      dateConfirmed: "",
      childRowNumbers: [],
      invoices: [{ num: 1, amount: "", ref: "", sendDate: "", days: "30", status: "" }],
      directExpenses: [{ num: 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "" }],
    });
  };

  const handleOpenEditJob = (job, e) => {
    if (e) e.stopPropagation();
    setSaveError(null);

    const splitStr = String(job?.splitStr || "").trim();
    if (splitStr.toLowerCase().startsWith("[split]")) {
      setEnableSplit(true);
      const initialLocked = {};
      const parts = splitStr.split(",");
      parts.forEach((p) => {
        const match = p.match(/([a-zA-Z]{3}-\d{2})\s*:\s*([^,]+)/);
        if (match) {
          const mKey = match[1].toLowerCase().trim();
          const mVal = parseFloat(String(match[2]).replace(/[^0-9.-]/g, "")) || 0;
          initialLocked[mKey] = mVal;
        }
      });
      setLockedMonths(initialLocked);
    } else {
      setEnableSplit(false);
      setLockedMonths({});
    }

    setEditingJob({
      ...job,
      childRowNumbers: Array.isArray(job.childRowNumbers) ? job.childRowNumbers : [],
      invoices: Array.isArray(job.invoices) && job.invoices.length > 0
        ? job.invoices.map((inv, i) => ({ ...inv, num: i + 1, status: inv.status || "" }))
        : [{ num: 1, amount: "", ref: "", sendDate: "", days: "30", status: "" }],
      directExpenses: Array.isArray(job.directExpenses) && job.directExpenses.length > 0
        ? job.directExpenses.map((exp, i) => ({ ...exp, num: i + 1, status: exp.status || "" }))
        : [{ num: 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "" }],
    });
  };

  // Uneven Revenue Split calculations
  const isProject = String(editingJob?.projectRetainer || "Project").toLowerCase() === "project";
  const clientSplitEnabled = data?.formOptions?.splitEnabled !== undefined
    ? data.formOptions.splitEnabled
    : (data?.splitEnabled !== undefined ? data.splitEnabled : true);
  const hasExistingSplit = Boolean(editingJob?.splitStr && String(editingJob.splitStr).trim().toLowerCase().startsWith("[split]"));
  const isSplitSectionVisible = isProject && (clientSplitEnabled || hasExistingSplit || enableSplit);

  const { splitMonths, splitDateError } = useMemo(() => {
    if (!editingJob?.startDate || !editingJob?.endDate) {
      return { splitMonths: [], splitDateError: "Please enter a Start Date and End Date to split revenue." };
    }
    const sDate = parseDate(editingJob.startDate);
    const eDate = parseDate(editingJob.endDate);
    if (!sDate || !eDate) {
      return { splitMonths: [], splitDateError: "Please enter a Start Date and End Date to split revenue." };
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
  }, [editingJob?.startDate, editingJob?.endDate]);

  const totRev = useMemo(() => {
    return parseFloat(String(editingJob?.revenue || "0").replace(/[^0-9.-]/g, "")) || 0;
  }, [editingJob?.revenue]);

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
    if (isNaN(totRev) || totRev <= 0) return { isSplitError: true, splitErrorText: "Please enter a valid Total Revenue." };
    if (lockedSum > totRev + 0.05) return { isSplitError: true, splitErrorText: "Allocated revenue exceeds the total job revenue." };
    if (unlockedCount === 0 && Math.abs(remaining) > 0.05) {
      return { isSplitError: true, splitErrorText: "Total allocated revenue does not perfectly match the job revenue." };
    }
    return { isSplitError: false, splitErrorText: "" };
  }, [enableSplit, splitDateError, totRev, lockedSum, unlockedCount, remaining]);

  const formatSummaryNum = (num) =>
    Number.isInteger(num)
      ? num.toLocaleString()
      : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const addInvoice = () => {
    setEditingJob((prev) => ({
      ...prev,
      invoices: [
        ...(prev.invoices || []),
        { num: (prev.invoices?.length || 0) + 1, amount: "", ref: "", sendDate: "", days: "30", status: "" },
      ],
    }));
  };

  const removeInvoice = (idx) => {
    setEditingJob((prev) => ({
      ...prev,
      invoices: prev.invoices.filter((_, i) => i !== idx),
    }));
  };

  const updateInvoice = (idx, field, val) => {
    setEditingJob((prev) => {
      const invs = [...(prev.invoices || [])];
      invs[idx] = { ...invs[idx], [field]: val };
      return { ...prev, invoices: invs };
    });
  };

  const addExpense = () => {
    setEditingJob((prev) => ({
      ...prev,
      directExpenses: [
        ...(prev.directExpenses || []),
        { num: (prev.directExpenses?.length || 0) + 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "" },
      ],
    }));
  };

  const removeExpense = (idx) => {
    setEditingJob((prev) => ({
      ...prev,
      directExpenses: prev.directExpenses.filter((_, i) => i !== idx),
    }));
  };

  const updateExpense = (idx, field, val) => {
    setEditingJob((prev) => {
      const exps = [...(prev.directExpenses || [])];
      exps[idx] = { ...exps[idx], [field]: val };
      return { ...prev, directExpenses: exps };
    });
  };

  const handleConfirmJob = async () => {
    if (isReadOnly || !editingJob?.rowNumber) return;
    setIsConfirming(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/portal/confirm-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          pipelineRow: editingJob.rowNumber,
        }),
      });
      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to confirm job");
      }
      setEditingJob(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Confirm job error:", err);
      setSaveError(err.message || "Failed to confirm job");
    } finally {
      setIsConfirming(false);
    }
  };

  const handleUnconfirmJob = async () => {
    if (isReadOnly || !editingJob?.rowNumber) return;
    setIsConfirming(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/portal/unconfirm-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          confirmedRow: editingJob.rowNumber,
        }),
      });
      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to unconfirm job");
      }
      setEditingJob(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Unconfirm job error:", err);
      setSaveError(err.message || "Failed to unconfirm job");
    } finally {
      setIsConfirming(false);
    }
  };

  const handleSaveJob = async (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isReadOnly) return;
    if (!editingJob.client?.trim() || !editingJob.jobName?.trim()) {
      setSaveError("Client name and Job name are required.");
      return;
    }

    if (enableSplit && isSplitError) {
      setSaveError(splitErrorText || "Please resolve the errors in the Uneven Revenue Split section before saving.");
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    let splitStrResult = "";
    if (enableSplit && splitMonths.length > 0 && String(editingJob?.projectRetainer || "").toLowerCase() === "project") {
      let str = "[Split]";
      splitMonths.forEach((m) => {
        const mKey = m.toLowerCase();
        const isLocked = validLocked[mKey] !== undefined;
        const val = isLocked ? validLocked[mKey] : evenSplit;
        const cleanVal = Number.isInteger(val) ? val : Math.round(val * 100) / 100;
        str += `,${m}:${cleanVal}`;
      });
      splitStrResult = str;
    }

    const jobToSave = {
      ...editingJob,
      splitStr: splitStrResult,
    };

    try {
      const res = await fetch("/api/portal/save-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          job: jobToSave,
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to save job");
      }

      // Optimistically update local job state immediately so new value is visible with zero delay
      const savedJob = { ...jobToSave };
      const parsedRev = parseMoney(savedJob.revenue);
      const parsedDc = parseMoney(savedJob.directCosts);
      savedJob.revNum = isNaN(parsedRev) ? 0 : parsedRev;
      savedJob.dcNum = isNaN(parsedDc) ? 0 : parsedDc;
      if (resData.rowNumber) savedJob.rowNumber = resData.rowNumber;
      if (resData.childRowNumbers) savedJob.childRowNumbers = resData.childRowNumbers;

      const jobKey = savedJob.id !== undefined ? savedJob.id : (savedJob.parentId !== undefined ? savedJob.parentId : savedJob.rowNumber);
      if (jobKey !== undefined) {
        setOptimisticJobs((prev) => ({
          ...prev,
          [jobKey]: savedJob,
        }));
      }

      setEditingJob(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Save job error:", err);
      setSaveError(err.message || "An error occurred while saving.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadCSV = () => {
    if (!jobsData?.all || jobsData.all.length === 0) return;
    const dateStr = new Date().toISOString().split("T")[0];

    const header = [
      "Type",
      "Client",
      "Job Name",
      "Project/Retainer",
      "Revenue",
      "Direct Costs",
      "Likelihood",
      "Start Date",
      "End Date",
      "Product Line",
      "Lead Source",
    ];

    const rowsData = (filteredJobs || []).map((j) => [
      j.type || "",
      j.client || "",
      j.jobName || "",
      j.projectRetainer || "",
      j.revenue || "",
      j.directCosts || "",
      j.likelihood || "",
      formatDateDdMmmYy(j.startDate),
      formatDateDdMmmYy(j.endDate),
      j.productLine || "",
      j.leadSource || "",
    ]);

    const csvContent =
      "data:text/csv;charset=utf-8," +
      [header, ...rowsData]
        .map((e) =>
          e.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Pulse_Jobs_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading && !jobsData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Please wait - loading
        </p>
      </div>
    );
  }

  if (error && !jobsData) {
    return (
      <div
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          padding: "1.5rem",
          color: "#991b1b",
          margin: "1rem 0",
        }}
      >
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load jobs data</h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>{error}</p>
        <button
          onClick={onRefresh}
          style={{
            padding: "6px 14px",
            background: "#dc2626",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%", fontFamily: "'Kumbh Sans', sans-serif" }}>
      {/* Action Bar */}
      <div
        className="portal-action-bar"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          padding: "0.25rem 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
            Jobs
          </h2>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "10px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            {filteredJobs.length} active
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {!isReadOnly && (
            <button
              type="button"
              onClick={handleOpenAddJob}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                background: "#0047AB",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "6px 14px",
                fontSize: "12.5px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <span>+</span>
              <span>Add Job</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh data"
            style={{
              background: "transparent",
              border: "none",
              cursor: isLoading ? "wait" : "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            {isLoading ? (
              <Spinner size={18} color="#0047AB" />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadCSV}
            title="Download CSV"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        className="portal-filter-container"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          background: "#ffffff",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
        }}
      >
        {/* Type Filter Buttons */}
        <div className="portal-filter-pills" style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {[
            { id: "all", label: `All (${jobsData?.all?.length || 0})` },
            { id: "confirmed", label: `Confirmed (${jobsData?.confirmedCount || 0})` },
            { id: "pipeline", label: `Pipeline (${jobsData?.pipelineCount || 0})` },
            { id: "project", label: "Projects" },
            { id: "retainer", label: "Retainers" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setFilterType(tab.id);
                setCurrentPage(1);
              }}
              style={{
                padding: "3px 10px",
                borderRadius: "14px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                border: filterType === tab.id ? "1px solid #0047AB" : "1px solid #e2e8f0",
                background: filterType === tab.id ? "#0047AB" : "#f8fafc",
                color: filterType === tab.id ? "#ffffff" : "#475569",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Sort */}
        <div className="portal-search-sort" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="text"
            placeholder="Search jobs or clients..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              width: "180px",
            }}
          />
          <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Sort by:</span>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
              setCurrentPage(1);
            }}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              background: "#ffffff",
              color: "#334155",
              cursor: "pointer",
            }}
          >
            <option value="startDateDesc">Start date (descending)</option>
            <option value="startDateAsc">Start date (ascending)</option>
            <option value="clientAsc">Client name</option>
            <option value="likelihoodDesc">Likelihood % (descending)</option>
            <option value="likelihoodAsc">Likelihood % (ascending)</option>
            <option value="revDesc">Revenue (descending)</option>
            <option value="revAsc">Revenue (ascending)</option>
          </select>
        </div>
      </div>

      {/* Main Jobs Table (Fitting desktop width) */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          width: "100%",
        }}
      >
        <div style={{ overflowX: "auto", width: "100%" }}>
          <table
            className="portal-data-table"
            style={{
              width: "100%",
              minWidth: "820px",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "13.8px",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, width: "11%", fontSize: "13.5px" }}>
                  Status
                </th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, width: "30%", fontSize: "13.5px" }}>
                  Client & Job Name
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "8%", fontSize: "13.5px" }}>
                  Type
                </th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, width: "13%", fontSize: "13.5px" }}>
                  Revenue
                </th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, width: "11%", fontSize: "13.5px" }}>
                  Direct Costs
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "10%", fontSize: "13.5px" }}>
                  Start Date
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "10%", fontSize: "13.5px" }}>
                  End Date
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "7%", fontSize: "13.5px" }}>
                  Likelihood
                </th>
              </tr>
            </thead>

            <tbody>
              {paginatedJobs.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "3rem", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
                    No jobs match your search/filter criteria.
                  </td>
                </tr>
              ) : (
                paginatedJobs.map((job, idx) => {
                  const isConfirmed = job.type === "Confirmed";

                  return (
                    <tr
                      key={job.id || idx}
                      onClick={(e) => handleOpenEditJob(job, e)}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        cursor: "pointer",
                        background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "rgba(0, 71, 171, 0.04)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = idx % 2 === 0 ? "#ffffff" : "#fbfcfe";
                      }}
                    >
                      {/* Status */}
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "11.5px",
                            fontWeight: 700,
                            background: isConfirmed ? "#dcfce7" : "#e0f2fe",
                            color: isConfirmed ? "#166534" : "#0369a1",
                          }}
                        >
                          {job.type}
                        </span>
                      </td>

                      {/* Client & Job Name */}
                      <td style={{ padding: "10px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "14px" }}>{job.client}</div>
                        <div style={{ color: "#64748b", fontSize: "12.5px" }}>
                          {job.jobName}
                        </div>
                      </td>

                      {/* Project / Retainer */}
                      <td style={{ padding: "10px 12px", textAlign: "center", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: 600,
                            background: "#f1f5f9",
                            color: "#475569",
                          }}
                        >
                          {job.projectRetainer || "Project"}
                        </span>
                        {String(job.splitStr || "").trim().toLowerCase().startsWith("[split]") && (
                          <span
                            style={{
                              marginLeft: "5px",
                              padding: "1px 6px",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: 700,
                              background: "#eff6ff",
                              color: "#1d4ed8",
                              border: "1px solid #bfdbfe",
                              display: "inline-block",
                            }}
                            title={job.splitStr}
                          >
                            Split
                          </span>
                        )}
                      </td>

                      {/* Revenue */}
                      <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: "#0047AB", fontSize: "14px" }}>
                        {formatGBP(job.revenue)}
                      </td>

                      {/* Direct Costs */}
                      <td style={{ padding: "10px 12px", textAlign: "right", color: "#64748b", fontSize: "14px" }}>
                        {formatGBP(job.directCosts)}
                      </td>

                      {/* Start Date */}
                      <td style={{ padding: "10px 12px", textAlign: "center", color: "#64748b", fontSize: "12.5px", whiteSpace: "nowrap" }}>
                        {formatDateDdMmmYy(job.startDate)}
                      </td>

                      {/* End Date */}
                      <td style={{ padding: "10px 12px", textAlign: "center", color: "#64748b", fontSize: "12.5px", whiteSpace: "nowrap" }}>
                        {formatDateDdMmmYy(job.endDate)}
                      </td>

                      {/* Likelihood */}
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: "10px",
                            fontSize: "12px",
                            fontWeight: 700,
                            background: isConfirmed ? "#f0fdf4" : "#fef3c7",
                            color: isConfirmed ? "#166534" : "#b45309",
                          }}
                        >
                          {job.likelihood || (isConfirmed ? "100%" : "50%")}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {totalPages > 1 && (
          <div
            style={{
              padding: "0.5rem 1rem",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
            }}
          >
            <span style={{ color: "#64748b" }}>
              Page {currentPage} of {totalPages} ({filteredJobs.length} jobs)
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={pageBtnStyle}
              >
                ◀ Prev
              </button>
              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                style={pageBtnStyle}
              >
                Next ▶
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Job Edit / Add Modal */}
      {editingJob && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1rem",
            overscrollBehavior: "contain",
          }}
          onClick={() => !isSaving && !isConfirming && setEditingJob(null)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              maxWidth: "860px",
              width: "100%",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header (Fixed at top) */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #e2e8f0",
                padding: "1.25rem 1.75rem 1rem",
                background: "#ffffff",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h3 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#0047AB" }}>
                  {isReadOnly ? "View Job" : (editingJob.rowNumber ? "Edit Job" : "Add New Job")}
                </h3>
                {isReadOnly && (
                  <span
                    style={{
                      background: "#f1f5f9",
                      color: "#475569",
                      border: "1px solid #cbd5e1",
                      borderRadius: "12px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    Read-only
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditingJob(null)}
                disabled={isSaving || isConfirming}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "18px",
                  cursor: "pointer",
                  color: "#64748b",
                }}
              >
                ✕
              </button>
            </div>

            {/* Scrollable Form Body */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "1.25rem 1.75rem",
                overscrollBehavior: "contain",
              }}
            >
              {saveError && (
                <div
                  style={{
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    padding: "0.6rem 0.85rem",
                    color: "#991b1b",
                    fontSize: "12px",
                    marginBottom: "1rem",
                  }}
                >
                  {saveError}
                </div>
              )}

              {/* Form */}
              <form id="job-modal-form" onSubmit={handleSaveJob} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <fieldset disabled={isReadOnly} style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
              {/* Row 1: Client Name (25%) | Job Name (75%) */}
              <div className="modal-form-row modal-form-row-1" style={{ display: "grid", gridTemplateColumns: "1fr 3fr", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Client Name *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.client || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, client: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Job Name *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.jobName || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, jobName: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 2: Type | Status | % Likelihood | Project Code */}
              <div className="modal-form-row modal-form-row-2" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Type *</label>
                  <select
                    value={editingJob.projectRetainer || "Project"}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditingJob({ ...editingJob, projectRetainer: val });
                      if (val === "Retainer") {
                        setEnableSplit(false);
                        setLockedMonths({});
                      }
                    }}
                    style={formInputStyle}
                  >
                    <option value="Project">Project</option>
                    <option value="Retainer">Retainer</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>Status *</label>
                  <select
                    value={editingJob.type || "Confirmed"}
                    onChange={(e) => setEditingJob({ ...editingJob, type: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="Confirmed">Confirmed</option>
                    <option value="Pipeline">Pipeline</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>% Likelihood</label>
                  <input
                    type="text"
                    value={editingJob.likelihood || (editingJob.type === "Confirmed" ? "100%" : "50%")}
                    disabled={editingJob.type === "Confirmed"}
                    onChange={(e) => setEditingJob({ ...editingJob, likelihood: e.target.value })}
                    style={{
                      ...formInputStyle,
                      opacity: editingJob.type === "Confirmed" ? 0.6 : 1,
                    }}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Project Code</label>
                  <input
                    type="text"
                    value={editingJob.projectCode || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, projectCode: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 3: Revenue | Direct Costs | VAT | Date Confirmed */}
              <div className="modal-form-row modal-form-row-3" style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 2fr", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Revenue (excl. VAT) *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.revenue || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, revenue: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Direct Costs (excl. VAT) *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.directCosts || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, directCosts: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>VAT? *</label>
                  <select
                    value={editingJob.vat || "Yes"}
                    onChange={(e) => setEditingJob({ ...editingJob, vat: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>
                    {editingJob.type === "Pipeline" ? "Date Added" : "Date Confirmed"}
                  </label>
                  <input
                    type="date"
                    value={editingJob.dateConfirmed || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, dateConfirmed: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 4: Start Date | End Date | Product Line | Lead Source */}
              <div className="modal-form-row modal-form-row-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Start Date *</label>
                  <input
                    type="date"
                    required
                    value={editingJob.startDate || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, startDate: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>End Date *</label>
                  <input
                    type="date"
                    required
                    value={editingJob.endDate || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, endDate: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Product Line</label>
                  <select
                    value={editingJob.productLine || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, productLine: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="">Select...</option>
                    {productLineOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>Lead Source</label>
                  <select
                    value={editingJob.leadSource || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, leadSource: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="">Select...</option>
                    {leadSourceOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Uneven Revenue Split Section */}
              {isSplitSectionVisible && (
                <div
                  id="split-revenue-section"
                  style={{
                    marginTop: "1rem",
                    marginBottom: "0.75rem",
                    padding: "1rem",
                    border: `1px solid ${isSplitError ? "#ef4444" : "#cbd5e1"}`,
                    borderRadius: "8px",
                    background: "#f8fafc",
                    transition: "border-color 0.2s ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      id="enable-split"
                      name="enableSplit"
                      checked={enableSplit}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEnableSplit(checked);
                        if (!checked) setLockedMonths({});
                      }}
                      style={{ width: "18px", height: "18px", cursor: "pointer" }}
                    />
                    <label
                      htmlFor="enable-split"
                      style={{
                        fontWeight: 600,
                        color: "#0047AB",
                        cursor: "pointer",
                        userSelect: "none",
                        fontSize: "14px",
                      }}
                    >
                      Uneven revenue split?
                    </label>
                  </div>

                  {enableSplit && isSplitError && (
                    <div
                      id="split-error-message"
                      style={{
                        color: "#ef4444",
                        fontSize: "0.85rem",
                        marginTop: "0.5rem",
                        fontWeight: 600,
                      }}
                    >
                      {splitErrorText || "Revenue split must be updated to match the total before saving."}
                    </div>
                  )}

                  {enableSplit && (
                    <div id="split-grid-container" style={{ marginTop: "0.75rem" }}>
                      {splitDateError ? (
                        <p style={{ color: "#64748b", fontSize: "0.9rem", margin: "0.5rem 0" }}>
                          {splitDateError}
                        </p>
                      ) : (
                        <>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))",
                              gap: "0.75rem",
                              marginBottom: "1rem",
                            }}
                          >
                            {splitMonths.map((m) => {
                              const mKey = m.toLowerCase();
                              const isLocked = validLocked[mKey] !== undefined;
                              const val = isLocked ? validLocked[mKey] : evenSplit;
                              const valStr = Number.isInteger(val) ? val.toString() : val.toFixed(2);

                              return (
                                <SplitMonthInputCard
                                  key={m}
                                  month={m}
                                  mKey={mKey}
                                  isLocked={isLocked}
                                  displayVal={valStr}
                                  currencySymbol={currencySymbol}
                                  onCommit={(k, newVal) => {
                                    setLockedMonths((prev) => {
                                      const next = { ...prev };
                                      if (newVal === null || newVal === undefined || isNaN(newVal)) {
                                        delete next[k];
                                      } else {
                                        next[k] = newVal;
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              );
                            })}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "flex-end",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: "1.25rem",
                              paddingTop: "0.75rem",
                              borderTop: "1px dashed #cbd5e1",
                              fontSize: "0.85rem",
                            }}
                          >
                            <div>
                              <span style={{ color: "#64748b" }}>Job Revenue:</span>{" "}
                              <strong style={{ color: "#1e293b" }}>
                                {currencySymbol}{formatSummaryNum(totRev)}
                              </strong>
                            </div>
                            <div>
                              <span style={{ color: "#64748b" }}>Locked Assigned:</span>{" "}
                              <strong style={{ color: "#0047AB" }}>
                                {currencySymbol}{formatSummaryNum(lockedSum)}
                              </strong>
                            </div>
                            <div
                              style={{
                                color:
                                  (unlockedCount === 0 && Math.abs(remaining) > 0.05) || lockedSum > totRev + 0.05
                                    ? "#ef4444"
                                    : "#64748b",
                              }}
                            >
                              <span style={{ opacity: 0.9 }}>
                                {unlockedCount === 0 ? "Unassigned:" : "Remaining (Auto-spread):"}
                              </span>{" "}
                              <strong>
                                {currencySymbol}{formatSummaryNum(remaining)}
                              </strong>
                            </div>
                          </div>
                          <div
                            style={{
                              textAlign: "right",
                              marginTop: "0.5rem",
                              fontSize: "0.8rem",
                              color: "#64748b",
                              fontStyle: "italic",
                            }}
                          >
                            Delete an amount to unlock that month and return to automatic allocations.
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Invoices Section */}
              <div
                style={{
                  marginTop: "0.5rem",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.6rem",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB" }}>
                    Invoices
                  </h4>
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={addInvoice}
                      style={{
                        background: "#f0fdf4",
                        border: "1px solid #bbf7d0",
                        color: "#166534",
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "3px 10px",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      + Add Invoice
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(editingJob.invoices || []).map((inv, idx) => (
                    <div
                      key={idx}
                      className="modal-sub-grid-row"
                      style={{
                        display: "grid",
                        gridTemplateColumns: isReadOnly ? "1.2fr 1fr 1.2fr 0.7fr 1fr" : "1.2fr 1fr 1.2fr 0.7fr 1fr 28px",
                        gap: "6px",
                        alignItems: "center",
                        background: "#f8fafc",
                        padding: "6px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>
                          Amount ({idx + 1})
                        </label>
                        <input
                          type="text"
                          placeholder="Amount"
                          value={inv.amount || ""}
                          onChange={(e) => updateInvoice(idx, "amount", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Ref</label>
                        <input
                          type="text"
                          placeholder="Ref"
                          value={inv.ref || ""}
                          onChange={(e) => updateInvoice(idx, "ref", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Send Date</label>
                        <input
                          type="date"
                          value={inv.sendDate || ""}
                          onChange={(e) => updateInvoice(idx, "sendDate", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                        <input
                          type="number"
                          placeholder="30"
                          value={inv.days || ""}
                          onChange={(e) => updateInvoice(idx, "days", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                        <select
                          value={inv.status || ""}
                          onChange={(e) => updateInvoice(idx, "status", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="">Select...</option>
                          <option value="Draft">Draft</option>
                          <option value="Invoiced">Invoiced</option>
                          <option value="Paid">Paid</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      </div>
                      {!isReadOnly && (
                        <div style={{ paddingTop: "14px", textAlign: "center" }}>
                          <button
                            type="button"
                            onClick={() => removeInvoice(idx)}
                            title="Delete invoice"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "#ef4444",
                              cursor: "pointer",
                              fontSize: "14px",
                              padding: "2px",
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Direct Expenses Section */}
              <div
                style={{
                  marginTop: "0.25rem",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.6rem",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB" }}>
                    Direct Expenses
                  </h4>
                  {!isReadOnly && (
                    <button
                      type="button"
                      onClick={addExpense}
                      style={{
                        background: "#f0fdf4",
                        border: "1px solid #bbf7d0",
                        color: "#166534",
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "3px 10px",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      + Add Direct Expense
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(editingJob.directExpenses || []).map((exp, idx) => (
                    <div
                      key={idx}
                      className="modal-sub-grid-row"
                      style={{
                        display: "grid",
                        gridTemplateColumns: isReadOnly ? "1.2fr 1fr 0.7fr 1.2fr 0.6fr 1fr" : "1.2fr 1fr 0.7fr 1.2fr 0.6fr 1fr 28px",
                        gap: "6px",
                        alignItems: "center",
                        background: "#f8fafc",
                        padding: "6px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>
                          Description ({idx + 1})
                        </label>
                        <input
                          type="text"
                          placeholder="Description"
                          value={exp.desc || ""}
                          onChange={(e) => updateExpense(idx, "desc", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Amount</label>
                        <input
                          type="text"
                          placeholder="Amount"
                          value={exp.amount || ""}
                          onChange={(e) => updateExpense(idx, "amount", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>VAT?</label>
                        <select
                          value={exp.vat || "Yes"}
                          onChange={(e) => updateExpense(idx, "vat", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Receive Date</label>
                        <input
                          type="date"
                          value={exp.recDate || ""}
                          onChange={(e) => updateExpense(idx, "recDate", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                        <input
                          type="number"
                          placeholder="30"
                          value={exp.days || ""}
                          onChange={(e) => updateExpense(idx, "days", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                        <select
                          value={exp.status || ""}
                          onChange={(e) => updateExpense(idx, "status", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="">Select...</option>
                          <option value="Received">Received</option>
                          <option value="Paid">Paid</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      </div>
                      {!isReadOnly && (
                        <div style={{ paddingTop: "14px", textAlign: "center" }}>
                          <button
                            type="button"
                            onClick={() => removeExpense(idx)}
                            title="Delete expense"
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "#ef4444",
                              cursor: "pointer",
                              fontSize: "14px",
                              padding: "2px",
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

                </fieldset>
              </form>
            </div>

            {/* Sticky / Hovering Action Bar (Always visible at bottom of modal) */}
            <div
              style={{
                flexShrink: 0,
                borderTop: "1px solid #e2e8f0",
                background: "#f8fafc",
                boxShadow: "0 -4px 6px -1px rgba(0, 0, 0, 0.04)",
                padding: "0.85rem 1.75rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                zIndex: 10,
              }}
            >
              {/* Left side: Confirm / Unconfirm button */}
              <div>
                {!isReadOnly && editingJob.rowNumber && String(editingJob.type || "").toLowerCase() === "pipeline" && (
                  <button
                    type="button"
                    onClick={handleConfirmJob}
                    disabled={isSaving || isConfirming}
                    style={{
                      background: "#16a34a",
                      border: "none",
                      color: "#ffffff",
                      padding: "7px 16px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: isConfirming ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      opacity: isConfirming ? 0.7 : 1,
                      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
                    }}
                  >
                    {isConfirming ? <Spinner size={14} color="#ffffff" /> : null}
                    <span>{isConfirming ? "Confirming..." : "Confirm Job"}</span>
                  </button>
                )}

                {!isReadOnly && editingJob.rowNumber && String(editingJob.type || "").toLowerCase() === "confirmed" && (
                  <button
                    type="button"
                    onClick={handleUnconfirmJob}
                    disabled={isSaving || isConfirming}
                    style={{
                      background: "#fffbeb",
                      border: "1px solid #f59e0b",
                      color: "#b45309",
                      padding: "7px 16px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: isConfirming ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      opacity: isConfirming ? 0.7 : 1,
                    }}
                  >
                    {isConfirming ? <Spinner size={14} color="#b45309" /> : null}
                    <span>{isConfirming ? "Unconfirming..." : "Unconfirm Job"}</span>
                  </button>
                )}
              </div>

              {/* Right side: Cancel & Save buttons */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setEditingJob(null)}
                  disabled={isSaving || isConfirming}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    color: "#475569",
                    padding: "7px 16px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {isReadOnly ? "Close" : "Cancel"}
                </button>

                {!isReadOnly && (
                  <button
                    type="submit"
                    form="job-modal-form"
                    disabled={isSaving || isConfirming}
                    style={{
                      background: "#0047AB",
                      border: "none",
                      color: "#ffffff",
                      padding: "7px 20px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: isSaving ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 1px 2px rgba(0, 71, 171, 0.2)",
                    }}
                  >
                    {isSaving ? <Spinner size={14} color="#ffffff" /> : null}
                    <span>{isSaving ? "Saving..." : "Save Job"}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        @media (max-width: 640px) {
          .portal-action-bar {
            gap: 0.75rem !important;
          }
          .portal-filter-pills {
            display: flex !important;
            overflow-x: auto !important;
            white-space: nowrap !important;
            flex-wrap: nowrap !important;
            width: 100% !important;
            padding-bottom: 4px !important;
            -webkit-overflow-scrolling: touch !important;
          }
          .portal-filter-pills > button {
            flex-shrink: 0 !important;
          }
          .portal-search-sort {
            width: 100% !important;
            flex-wrap: wrap !important;
          }
          .portal-search-sort input {
            flex: 1 1 140px !important;
            width: auto !important;
          }
        }
        @media (max-width: 768px) {
          .modal-form-row-1,
          .modal-form-row-2,
          .modal-form-row-3,
          .modal-form-row-4 {
            grid-template-columns: 1fr !important;
          }
          .modal-sub-grid-row {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}

const formLabelStyle = {
  display: "block",
  fontSize: "11px",
  fontWeight: 700,
  color: "#475569",
  textTransform: "uppercase",
  marginBottom: "4px",
};

const formInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  fontSize: "12.5px",
  color: "#0f172a",
  background: "#ffffff",
};

const pageBtnStyle = {
  padding: "3px 8px",
  borderRadius: "4px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  fontSize: "11px",
  fontWeight: 600,
  color: "#0047AB",
  cursor: "pointer",
};

function SplitMonthInputCard({ month, mKey, isLocked, displayVal, currencySymbol, onCommit }) {
  const [localVal, setLocalVal] = useState(displayVal);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setLocalVal(displayVal);
    }
  }, [displayVal, isFocused]);

  const handleBlur = () => {
    setIsFocused(false);
    const trimmed = String(localVal).trim();
    if (trimmed === "") {
      onCommit(mKey, null);
    } else {
      const parsed = parseFloat(trimmed);
      if (isNaN(parsed)) {
        onCommit(mKey, null);
      } else {
        onCommit(mKey, parsed);
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  return (
    <div
      style={{
        background: "#fff",
        padding: "0.5rem",
        borderRadius: "6px",
        border: `1px solid ${isLocked ? "#0047AB" : "#cbd5e1"}`,
        boxShadow: isLocked ? "0 1px 3px rgba(0,71,171,0.12)" : "none",
        transition: "border-color 0.15s ease",
      }}
    >
      <label
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.8rem",
          fontWeight: isLocked ? "700" : "500",
          color: isLocked ? "#0047AB" : "#64748b",
          marginBottom: "0.35rem",
        }}
      >
        <span>{month}</span>
        <span style={{ fontSize: "0.7rem", opacity: 0.75 }}>
          {isLocked ? "🔒" : "Auto"}
        </span>
      </label>
      <div style={{ position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: "8px",
            top: "50%",
            transform: "translateY(-50%)",
            color: "#64748b",
            fontSize: "0.85rem",
            pointerEvents: "none",
          }}
        >
          {currencySymbol}
        </span>
        <input
          type="number"
          step="0.01"
          placeholder="Auto"
          value={localVal}
          onFocus={() => setIsFocused(true)}
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={{
            paddingLeft: "22px",
            width: "100%",
            minHeight: "32px",
            fontSize: "0.95rem",
            border: "1px solid transparent",
            background: "#f8fafc",
            borderRadius: "4px",
            color: isLocked ? "#0047AB" : "#1e293b",
            fontWeight: isLocked ? 700 : 400,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
    </div>
  );
}
