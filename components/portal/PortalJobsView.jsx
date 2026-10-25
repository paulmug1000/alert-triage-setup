import React, { useState, useEffect, useMemo, useRef } from "react";
import Spinner from "../Spinner";
import { PortalTableSkeleton } from "../Skeleton";
import SplitMonthCard from "../SplitMonthCard";
import { formatMoney, parseMoney } from "../../services/deepDiveHelper";
import {
  downloadCsv,
  isPlaceholderInvoice,
  isPlaceholderExpense,
  hasActiveAccountingIntegration,
  isCrmDeal,
  getCrmDisplayName,
  INVOICE_STATUS_OPTIONS,
  EXPENSE_STATUS_OPTIONS,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus
} from "../../utils/helpers";
import { parseSplitString, formatSplitString } from "../../services/splitHelper";
import InvoicesNewJobModal from "../InvoicesNewJobModal";
import CrmSyncBadge, { CrmSyncIcon } from "../CrmSyncBadge";
import PlaceholderPill, {
  isAutoPlaceholder,
  generatePlaceholderInvoiceRef,
  generatePlaceholderExpenseId
} from "../PlaceholderPill";

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
  const [underAllocationPrompt, setUnderAllocationPrompt] = useState(null); // null or { message }
  const [optimisticJobs, setOptimisticJobs] = useState({}); // { [key]: job }
  const [enableSplit, setEnableSplit] = useState(false);
  const [lockedMonths, setLockedMonths] = useState({});
  const lockedMonthsRef = useRef(lockedMonths);
  lockedMonthsRef.current = lockedMonths;
  const pageSize = 25;

  const [deletePromptInvoice, setDeletePromptInvoice] = useState(null); // { idx, inv }
  const [movingPromptInvoice, setMovingPromptInvoice] = useState(null); // { idx, inv }
  const [newJobFromInvoice, setNewJobFromInvoice] = useState(null); // { idx, inv }
  const [moveJobSearch, setMoveJobSearch] = useState("");
  const [isMovingInvoice, setIsMovingInvoice] = useState(false);

  const hasAccounting = useMemo(() => {
    if (data?.hasAccountingIntegration !== undefined) return Boolean(data.hasAccountingIntegration);
    return hasActiveAccountingIntegration(data?.accountingTool);
  }, [data?.hasAccountingIntegration, data?.accountingTool]);

  const crmTool = data?.crmTool || "None";
  const crmDrives = data?.crmDrives || "NA";
  const crmDisplayName = useMemo(() => getCrmDisplayName(crmTool), [crmTool]);
  const isEditingCrmDeal = useMemo(() => isCrmDeal(editingJob, crmTool, crmDrives), [editingJob, crmTool, crmDrives]);
  const isEditingCrmPipelineDeal = useMemo(() => {
    return isEditingCrmDeal && String(editingJob?.type || editingJob?.tabName || "").toLowerCase() === "pipeline";
  }, [isEditingCrmDeal, editingJob?.type, editingJob?.tabName]);
  const crmLockedTooltip = isEditingCrmDeal ? "Locked - syncing with CRM data" : undefined;
  const getCrmInputStyle = (isSelect = false) => ({
    ...formInputStyle,
    cursor: isEditingCrmDeal ? "not-allowed" : (isSelect ? "pointer" : "text"),
    backgroundColor: isEditingCrmDeal ? "#f8fafc" : "#ffffff",
    opacity: isEditingCrmDeal ? 0.85 : 1,
  });

  const candidateTargetJobs = useMemo(() => {
    const currentKey = editingJob?.id !== undefined ? editingJob.id : editingJob?.rowNumber;
    const currentName = String(editingJob?.jobName || "").trim().toLowerCase();
    const search = moveJobSearch.trim().toLowerCase();
    const allJobsList = Array.isArray(data?.jobs?.all)
      ? data.jobs.all
      : (Array.isArray(data?.jobs) ? data.jobs : []);
    return allJobsList.filter((j) => {
      const jKey = j.id !== undefined ? j.id : j.rowNumber;
      if (jKey && currentKey && jKey === currentKey) return false;
      if (String(j.jobName || "").trim().toLowerCase() === currentName) return false;
      if (!search) return true;
      return (
        String(j.jobName || "").toLowerCase().includes(search) ||
        String(j.client || "").toLowerCase().includes(search) ||
        String(j.projectCode || "").toLowerCase().includes(search)
      );
    });
  }, [data?.jobs, editingJob, moveJobSearch]);

  const handleMoveInvoiceToTarget = async (targetJob, promptInfo) => {
    setIsMovingInvoice(true);
    try {
      const inv = promptInfo.inv;
      const targetInvoices = Array.isArray(targetJob.invoices) ? [...targetJob.invoices] : [];
      targetInvoices.push({
        amount: inv.amount || "",
        ref: inv.ref || "",
        sendDate: inv.sendDate || "",
        days: inv.days || "30",
        status: inv.status || "",
      });

      const res = await fetch("/api/portal/save-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          job: {
            ...targetJob,
            invoices: targetInvoices,
          },
        }),
      });
      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to move invoice to target job");
      }

      const updatedInvoices = (editingJob?.invoices || []).filter((_, i) => i !== promptInfo.idx);
      setEditingJob((prev) => ({ ...prev, invoices: updatedInvoices }));

      if (editingJob?.rowNumber) {
        await fetch("/api/portal/save-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientSheetId,
            clientName,
            job: {
              ...editingJob,
              invoices: updatedInvoices,
            },
          }),
        });
      }

      setMovingPromptInvoice(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      alert("Error moving invoice: " + err.message);
    } finally {
      setIsMovingInvoice(false);
    }
  };

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

  const rawSymbol =
    (propCurrencySymbol && propCurrencySymbol !== "£" ? propCurrencySymbol : null) ||
    data?.currencySymbol ||
    data?.clientInfo?.currencySymbol ||
    propCurrencySymbol ||
    "£";
  const currencySymbol =
    rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;
  const thousandsSeparator =
    (propThousandsSeparator && propThousandsSeparator !== "," ? propThousandsSeparator : null) ||
    data?.thousandsSeparator ||
    data?.clientInfo?.thousandsSeparator ||
    propThousandsSeparator ||
    (currencySymbol === "€" ? "." : ",");

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
    lockedMonthsRef.current = {};
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
      const rev = parseFloat(String(job?.revenue || "0").replace(/[^0-9.-]/g, "")) || 0;
      const initialLocked = parseSplitString(splitStr, [], rev);
      setLockedMonths(initialLocked);
      lockedMonthsRef.current = initialLocked;
    } else {
      setEnableSplit(false);
      setLockedMonths({});
      lockedMonthsRef.current = {};
    }

    const normalizeAmount = (val) => {
      if (!val && val !== 0) return "";
      const s = String(val).trim();
      if (!s || s === "—" || s === "-") return "";
      const num = parseMoney(s, thousandsSeparator);
      return formatMoney(num, 0, currencySymbol, thousandsSeparator);
    };

    setEditingJob({
      ...job,
      revenue: normalizeAmount(job?.revenue),
      directCosts: normalizeAmount(job?.directCosts),
      childRowNumbers: Array.isArray(job.childRowNumbers) ? job.childRowNumbers : [],
      invoices: Array.isArray(job.invoices) && job.invoices.length > 0
        ? job.invoices.map((inv, i) => ({
          ...inv,
          num: i + 1,
          amount: normalizeAmount(inv.amount),
          status: inv.status || "",
        }))
        : [{ num: 1, amount: "", ref: "", sendDate: "", days: "30", status: "" }],
      directExpenses: Array.isArray(job.directExpenses) && job.directExpenses.length > 0
        ? job.directExpenses.map((exp, i) => ({
          ...exp,
          num: i + 1,
          amount: normalizeAmount(exp.amount),
          status: exp.status || "",
        }))
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
    if (isEditingCrmPipelineDeal) {
      setSaveError(`CRM pipeline deals cannot be manually promoted to confirmed. This must be updated directly in ${crmDisplayName}.`);
      return;
    }
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
    const hasActualInvoices = (editingJob.invoices || []).some(
      (inv) => Boolean(inv.ref && String(inv.ref).trim() !== "" && !isPlaceholderInvoice(inv.ref, inv.status))
    );
    const hasActualExpenses = (editingJob.directExpenses || []).some((exp) => {
      const hasData = Boolean(
        (exp.amount && Math.abs(parseFloat(String(exp.amount).replace(/[£$€,\s]/g, ""))) > 0) ||
        (exp.desc && String(exp.desc).trim() !== "") ||
        (exp.appId && String(exp.appId).trim() !== "")
      );
      return hasData && !isPlaceholderExpense(exp.appId, exp.desc, exp.status);
    });
    if (hasActualInvoices || hasActualExpenses) {
      setSaveError("Cannot unconfirm this job because it has actual invoices or expenses assigned to it.");
      return;
    }
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

  const handleSaveJob = async (e, bypassUnderAllocationWarning = false) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isReadOnly) return;
    if (!editingJob.client?.trim() || !editingJob.jobName?.trim()) {
      setSaveError("Client name and job name are required.");
      return;
    }

    if (isEditingCrmPipelineDeal && String(editingJob?.type || "").toLowerCase() === "confirmed") {
      setSaveError(`CRM pipeline deals cannot be manually promoted to confirmed. This must be updated directly in ${crmDisplayName}.`);
      return;
    }

    if (enableSplit && isSplitError) {
      setSaveError(splitErrorText || "Please resolve the errors in the Uneven revenue split section before saving.");
      return;
    }

    // Over-allocation & under-allocation checks
    const parsedRev = parseMoney(editingJob.revenue);
    const jobRevenue = isNaN(parsedRev) ? 0 : parsedRev;
    const totalInvoices = (editingJob.invoices || []).reduce((acc, inv) => {
      const amt = parseMoney(inv.amount);
      return acc + (isNaN(amt) ? 0 : amt);
    }, 0);

    const parsedDc = parseMoney(editingJob.directCosts);
    const jobDirectCosts = isNaN(parsedDc) ? 0 : parsedDc;
    const totalExpenses = (editingJob.directExpenses || []).reduce((acc, exp) => {
      const amt = parseMoney(exp.amount);
      return acc + (isNaN(amt) ? 0 : amt);
    }, 0);

    // Over-allocation check (invoices)
    if (totalInvoices > jobRevenue + 0.01) {
      setSaveError(`Total invoices (${formatGBP(totalInvoices)}) exceed job revenue (${formatGBP(jobRevenue)}). Please adjust the job revenue or your manual placeholders before saving.`);
      return;
    }

    // Over-allocation check (direct expenses)
    if (totalExpenses > jobDirectCosts + 0.01) {
      setSaveError(`Total direct expenses (${formatGBP(totalExpenses)}) exceed job direct costs (${formatGBP(jobDirectCosts)}). Please adjust the job direct costs or your manual placeholders before saving.`);
      return;
    }

    // Under-allocation warning check
    if (!bypassUnderAllocationWarning) {
      const invGap = jobRevenue > totalInvoices + 0.01 ? jobRevenue - totalInvoices : 0;
      const expGap = jobDirectCosts > totalExpenses + 0.01 ? jobDirectCosts - totalExpenses : 0;

      if (invGap > 0 || expGap > 0) {
        let msg = "";
        if (invGap > 0 && expGap > 0) {
          msg = `Invoices and direct expenses do not match revenue and direct costs. New automatic placeholders will be created to fill the remaining gaps of ${formatGBP(invGap)} for invoices and ${formatGBP(expGap)} for direct expenses. Would you like to proceed?`;
        } else if (invGap > 0) {
          msg = `Invoices do not match revenue. New automatic placeholders will be created to fill the remaining gap of ${formatGBP(invGap)}. Would you like to proceed?`;
        } else {
          msg = `Direct expenses do not match direct costs. New automatic placeholders will be created to fill the remaining gap of ${formatGBP(expGap)}. Would you like to proceed?`;
        }
        setUnderAllocationPrompt({ message: msg });
        return;
      }
    }

    setIsSaving(true);
    setSaveError(null);

    let splitStrResult = "";
    if (enableSplit && splitMonths.length > 0 && String(editingJob?.projectRetainer || "").toLowerCase() === "project") {
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

    downloadCsv(`Pulse_Jobs_${dateStr}.csv`, [header, ...rowsData]);
  };

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

  if (!jobsData) {
    return <PortalTableSkeleton title="Jobs" columns={7} />;
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
              <span>Add job</span>
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
              minWidth: "880px",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "13.8px",
              tableLayout: "fixed",
            }}
          >
            <thead style={{ background: "#0047AB" }}>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, width: "10%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  Status
                </th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 700, width: "27%", fontSize: "13.5px", background: "#0047AB" }}>
                  Client & Job Name
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "7%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  Type
                </th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, width: "13%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  Revenue
                </th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, width: "11%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  Direct Costs
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "10%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  Start Date
                </th>
                <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 700, width: "10%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
                  End Date
                </th>
                <th style={{ padding: "10px 10px", textAlign: "center", fontWeight: 700, width: "12%", fontSize: "13.5px", background: "#0047AB", whiteSpace: "nowrap" }}>
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
                  const isJobFromCrm = isCrmDeal(job, crmTool, crmDrives);

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
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
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
                          {isJobFromCrm && <CrmSyncBadge crmDisplayName={crmDisplayName} />}
                        </div>
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
                  {isReadOnly ? "View Job" : (editingJob.rowNumber ? "Edit job" : "Add New Job")}
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
                  {isEditingCrmDeal && (
                    <div style={{ marginBottom: "-0.25rem" }}>
                      <span
                        title={crmDisplayName ? `Synced with ${crmDisplayName}` : "Synced with CRM"}
                        style={{
                          fontSize: "11px",
                          fontWeight: "normal",
                          color: "#64748b",
                          background: "#f1f5f9",
                          padding: "2px 7px",
                          borderRadius: "4px",
                          border: "1px solid #e2e8f0",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        <CrmSyncIcon size={11} color="#64748b" />
                        <span>Syncing with CRM</span>
                      </span>
                    </div>
                  )}

                  {/* Row 1: Client Name (25%) | Job Name (75%) */}
                  <div className="modal-form-row modal-form-row-1" style={{ display: "grid", gridTemplateColumns: "1fr 3fr", gap: "0.75rem" }}>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Client Name *</label>
                      <input
                        type="text"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.client || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, client: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Job Name *</label>
                      <input
                        type="text"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.jobName || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, jobName: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                  </div>

                  {/* Row 2: Type | Status | % Likelihood | Project Code */}
                  <div className="modal-form-row modal-form-row-2" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Type *</label>
                      <select
                        value={editingJob.projectRetainer || "Project"}
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        onChange={(e) => {
                          if (isEditingCrmDeal) return;
                          const val = e.target.value;
                          setEditingJob({ ...editingJob, projectRetainer: val });
                          if (val === "Retainer") {
                            setEnableSplit(false);
                            setLockedMonths({});
                          }
                        }}
                        style={getCrmInputStyle(true)}
                      >
                        <option value="Project">Project</option>
                        <option value="Retainer">Retainer</option>
                      </select>
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Status *</label>
                      <select
                        value={editingJob.type || "Confirmed"}
                        disabled={isReadOnly || isEditingCrmDeal || isEditingCrmPipelineDeal}
                        title={crmLockedTooltip || (isEditingCrmPipelineDeal ? `Status must be updated directly in ${crmDisplayName}` : undefined)}
                        onChange={(e) => {
                          if (isEditingCrmPipelineDeal || isEditingCrmDeal) return;
                          const newType = e.target.value;
                          if (newType === "Confirmed") {
                            setEditingJob({ ...editingJob, type: "Confirmed", likelihood: "100%" });
                          } else {
                            setEditingJob({
                              ...editingJob,
                              type: "Pipeline",
                              likelihood: (editingJob.likelihood === "100%" || !editingJob.likelihood) ? "50%" : editingJob.likelihood,
                            });
                          }
                        }}
                        style={{
                          ...formInputStyle,
                          cursor: (isEditingCrmDeal || isEditingCrmPipelineDeal) ? "not-allowed" : "pointer",
                          backgroundColor: (isEditingCrmDeal || isEditingCrmPipelineDeal) ? "#f8fafc" : "#ffffff",
                          opacity: (isEditingCrmDeal || isEditingCrmPipelineDeal) ? 0.85 : 1,
                        }}
                      >
                        <option value="Confirmed">Confirmed</option>
                        <option value="Pipeline">Pipeline</option>
                      </select>
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>% Likelihood</label>
                      <input
                        type="text"
                        value={editingJob.likelihood || (editingJob.type === "Confirmed" ? "100%" : "50%")}
                        disabled={isReadOnly || isEditingCrmDeal || editingJob.type === "Confirmed"}
                        title={crmLockedTooltip}
                        onChange={(e) => {
                          if (isEditingCrmDeal) return;
                          const val = e.target.value;
                          const num = parseFloat(String(val).replace(/[%,\s]/g, ""));
                          if (!isNaN(num) && num >= 100) {
                            if (isEditingCrmPipelineDeal) {
                              setSaveError(`CRM pipeline deals cannot be manually promoted to confirmed. This must be updated directly in ${crmDisplayName}.`);
                              return;
                            }
                            setEditingJob({ ...editingJob, likelihood: "100%", type: "Confirmed" });
                          } else {
                            setEditingJob({ ...editingJob, likelihood: val });
                          }
                        }}
                        style={{
                          ...formInputStyle,
                          cursor: (isEditingCrmDeal || editingJob.type === "Confirmed") ? "not-allowed" : "text",
                          backgroundColor: (isEditingCrmDeal || editingJob.type === "Confirmed") ? "#f8fafc" : "#ffffff",
                          opacity: (isEditingCrmDeal || editingJob.type === "Confirmed") ? 0.85 : 1,
                        }}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Project Code</label>
                      <input
                        type="text"
                        value={editingJob.projectCode || ""}
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        onChange={(e) => setEditingJob({ ...editingJob, projectCode: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                  </div>

                  {/* Row 3: Revenue | Direct Costs | VAT | Date Confirmed */}
                  <div className="modal-form-row modal-form-row-3" style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 2fr", gap: "0.75rem" }}>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Revenue (excl. VAT) *</label>
                      <input
                        type="text"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.revenue || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, revenue: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Direct Costs (excl. VAT) *</label>
                      <input
                        type="text"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.directCosts || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, directCosts: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>VAT? *</label>
                      <select
                        value={editingJob.vat || "Yes"}
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        onChange={(e) => setEditingJob({ ...editingJob, vat: e.target.value })}
                        style={getCrmInputStyle(true)}
                      >
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>
                        {editingJob.type === "Pipeline" ? "Date Added" : "Date Confirmed"}
                      </label>
                      <input
                        type="date"
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.dateConfirmed || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, dateConfirmed: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                  </div>

                  {/* Row 4: Start Date | End Date | Product Line | Lead Source */}
                  <div className="modal-form-row modal-form-row-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Start Date *</label>
                      <input
                        type="date"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.startDate || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, startDate: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>End Date *</label>
                      <input
                        type="date"
                        required
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        value={editingJob.endDate || ""}
                        onChange={(e) => setEditingJob({ ...editingJob, endDate: e.target.value })}
                        style={getCrmInputStyle(false)}
                      />
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Product Line</label>
                      <select
                        value={editingJob.productLine || ""}
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        onChange={(e) => setEditingJob({ ...editingJob, productLine: e.target.value })}
                        style={getCrmInputStyle(true)}
                      >
                        <option value="">Select...</option>
                        {productLineOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div title={crmLockedTooltip}>
                      <label style={formLabelStyle}>Lead Source</label>
                      <select
                        value={editingJob.leadSource || ""}
                        disabled={isReadOnly || isEditingCrmDeal}
                        title={crmLockedTooltip}
                        onChange={(e) => setEditingJob({ ...editingJob, leadSource: e.target.value })}
                        style={getCrmInputStyle(true)}
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
                      title={crmLockedTooltip}
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
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }} title={crmLockedTooltip}>
                        <input
                          type="checkbox"
                          id="enable-split"
                          name="enableSplit"
                          checked={enableSplit}
                          disabled={isReadOnly || isEditingCrmDeal}
                          title={crmLockedTooltip}
                          onChange={(e) => {
                            if (isEditingCrmDeal) return;
                            const checked = e.target.checked;
                            setEnableSplit(checked);
                            if (!checked) {
                              setLockedMonths({});
                              lockedMonthsRef.current = {};
                            }
                          }}
                          style={{ width: "18px", height: "18px", cursor: isEditingCrmDeal ? "not-allowed" : "pointer" }}
                        />
                        <label
                          htmlFor="enable-split"
                          style={{
                            fontWeight: 600,
                            color: isEditingCrmDeal ? "#64748b" : "#0047AB",
                            cursor: isEditingCrmDeal ? "not-allowed" : "pointer",
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
                        <div
                          id="split-grid-container"
                          title={crmLockedTooltip}
                          style={{
                            marginTop: "0.75rem",
                            pointerEvents: isEditingCrmDeal ? "none" : "auto",
                            opacity: isEditingCrmDeal ? 0.75 : 1,
                          }}
                        >
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
                                    <SplitMonthCard
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
                                          lockedMonthsRef.current = next;
                                          return next;
                                        });
                                      }}
                                    />
                                  );
                                })}
                              </div>

                              <div style={{ marginTop: "-0.5rem", marginBottom: "0.75rem", fontSize: "11px", color: "#64748b", textAlign: "right", fontStyle: "italic" }}>
                                Click 🔒 Locked to unlock, or delete an amount to return that month to automatic allocation.
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
                      <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB", display: "flex", alignItems: "center", gap: "8px" }}>
                        <span>Invoices</span>
                        {hasAccounting && (
                          <span
                            title="Invoices are syncing with your accounting software."
                            style={{
                              fontSize: "11px",
                              fontWeight: "normal",
                              color: "#64748b",
                              background: "#f1f5f9",
                              padding: "2px 7px",
                              borderRadius: "4px",
                              border: "1px solid #e2e8f0",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                            }}
                          >
                            <CrmSyncIcon size={11} color="#64748b" />
                            <span>Syncing with accounting</span>
                          </span>
                        )}
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
                          + Add invoice
                        </button>
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(editingJob.invoices || []).map((inv, idx) => {
                        const isPlaceholder = isPlaceholderInvoice(inv.ref, inv.status);
                        const isAuto = isPlaceholder && isAutoPlaceholder(inv.ref);
                        const isLocked = Boolean(hasAccounting && !isPlaceholder && inv.ref && String(inv.ref).trim() !== "");
                        const isAutoLocked = isPlaceholder && isAuto;
                        const isFieldLocked = isLocked || isAutoLocked;
                        const isPaid = String(inv.status || "").trim().toLowerCase() === "paid";
                        const fieldLockTitle = isAutoLocked
                          ? "Automatic placeholder. Convert to manual placeholder to edit."
                          : isLocked
                            ? "Synced from accounting software. To modify invoice number, amount, or sent date, update directly in your accounting software."
                            : undefined;

                        return (
                          <div
                            key={idx}
                            className="modal-sub-grid-row"
                            style={{
                              display: "grid",
                              gridTemplateColumns: isReadOnly ? "1.2fr 1fr 1.2fr 0.7fr 1fr" : "1.2fr 1fr 1.2fr 0.7fr 1fr 28px",
                              gap: "6px",
                              alignItems: "center",
                              background: isFieldLocked ? "#f8fafc" : "#ffffff",
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
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Ref</label>
                              {isPlaceholder ? (
                                <div style={{ marginTop: "2px" }}>
                                  <PlaceholderPill
                                    isAuto={isAuto}
                                    disabled={isReadOnly}
                                    onToggle={(targetAuto) => {
                                      if (targetAuto) {
                                        updateInvoice(idx, "ref", generatePlaceholderInvoiceRef(inv.sendDate));
                                      } else {
                                        updateInvoice(idx, "ref", "");
                                      }
                                    }}
                                  />
                                </div>
                              ) : (
                                <input
                                  type="text"
                                  value={inv.ref || ""}
                                  onChange={(e) => updateInvoice(idx, "ref", e.target.value)}
                                  disabled={isLocked}
                                  title={isLocked ? "Synced from accounting software. To modify invoice number, amount, or sent date, update directly in your accounting software." : undefined}
                                  style={{
                                    ...formInputStyle,
                                    padding: "4px 6px",
                                    fontSize: "12px",
                                    ...(isLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                  }}
                                />
                              )}
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Send date</label>
                              <input
                                type="date"
                                value={inv.sendDate || ""}
                                onChange={(e) => updateInvoice(idx, "sendDate", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                              <input
                                type="number"
                                placeholder="30"
                                value={inv.days || ""}
                                onChange={(e) => updateInvoice(idx, "days", e.target.value)}
                                disabled={isPaid || isAutoLocked}
                                title={isAutoLocked ? "Automatic placeholder. Convert to manual placeholder to edit." : (isPaid ? "Days to pay is determined once an invoice is marked as paid." : undefined)}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isPaid || isAutoLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                              {(() => {
                                const currentStatus = canonicalizeInvoiceStatus(inv.status);
                                return (
                                  <select
                                    value={currentStatus}
                                    onChange={(e) => updateInvoice(idx, "status", e.target.value)}
                                    disabled={isFieldLocked}
                                    title={fieldLockTitle}
                                    style={{
                                      ...formInputStyle,
                                      padding: "4px 6px",
                                      fontSize: "12px",
                                      ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                    }}
                                  >
                                    <option value="">Select...</option>
                                    {INVOICE_STATUS_OPTIONS.map((st) => (
                                      <option key={st} value={st}>{st}</option>
                                    ))}
                                    {currentStatus && !INVOICE_STATUS_OPTIONS.includes(currentStatus) && (
                                      <option value={currentStatus}>{currentStatus}</option>
                                    )}
                                  </select>
                                );
                              })()}
                            </div>
                            {!isReadOnly && (
                              <div style={{ paddingTop: "14px", textAlign: "center" }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (inv.ref || inv.amount) {
                                      setDeletePromptInvoice({ idx, inv });
                                      setMovingPromptInvoice(null);
                                    } else {
                                      removeInvoice(idx);
                                    }
                                  }}
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
                        );
                      })}
                    </div>

                    {deletePromptInvoice && (
                      <div
                        style={{
                          marginTop: "8px",
                          padding: "12px",
                          background: "#f8fafc",
                          border: "1px solid #e2e8f0",
                          borderRadius: "6px",
                        }}
                      >
                        <div style={{ fontSize: "12.5px", fontWeight: "600", color: "#0f172a", marginBottom: "4px" }}>
                          Delete invoice from this job?
                        </div>
                        <div style={{ fontSize: "11.5px", color: "#64748b", marginBottom: "10px", lineHeight: "1.4" }}>
                          Would you prefer to move this invoice to another job or create a new job for it instead?
                        </div>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            onClick={() => setDeletePromptInvoice(null)}
                            style={{
                              padding: "5px 10px",
                              background: "#f1f5f9",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              cursor: "pointer",
                              fontSize: "12px",
                              color: "#334155",
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMovingPromptInvoice(deletePromptInvoice);
                              setDeletePromptInvoice(null);
                            }}
                            style={{
                              padding: "5px 10px",
                              background: "#ffffff",
                              border: "1px solid #bfdbfe",
                              borderRadius: "5px",
                              cursor: "pointer",
                              fontSize: "12px",
                              color: "#1d4ed8",
                              fontWeight: "500",
                            }}
                          >
                            Move to a different job
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setNewJobFromInvoice(deletePromptInvoice);
                              setDeletePromptInvoice(null);
                            }}
                            style={{
                              padding: "5px 10px",
                              background: "#ffffff",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              cursor: "pointer",
                              fontSize: "12px",
                              color: "#0f172a",
                              fontWeight: "500",
                            }}
                          >
                            Create new job
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              removeInvoice(deletePromptInvoice.idx);
                              setDeletePromptInvoice(null);
                            }}
                            style={{
                              padding: "5px 10px",
                              background: "#fee2e2",
                              border: "1px solid #fecaca",
                              borderRadius: "5px",
                              cursor: "pointer",
                              fontSize: "12px",
                              color: "#b91c1c",
                              fontWeight: "600",
                            }}
                          >
                            Delete from job anyway
                          </button>
                        </div>
                      </div>
                    )}

                    {movingPromptInvoice && (
                      <div
                        style={{
                          marginTop: "8px",
                          padding: "12px",
                          background: "#f8fafc",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                          <div style={{ fontSize: "12.5px", fontWeight: "600", color: "#0f172a" }}>
                            Move invoice {movingPromptInvoice.inv.ref ? `#${movingPromptInvoice.inv.ref}` : `(slot ${movingPromptInvoice.idx + 1})`} to another job
                          </div>
                          <button
                            type="button"
                            onClick={() => setMovingPromptInvoice(null)}
                            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "16px", color: "#94a3b8" }}
                          >
                            ×
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Search target job..."
                          value={moveJobSearch}
                          onChange={(e) => setMoveJobSearch(e.target.value)}
                          style={{
                            ...formInputStyle,
                            padding: "5px 8px",
                            fontSize: "12px",
                            marginBottom: "8px",
                            width: "100%",
                            boxSizing: "border-box",
                          }}
                        />
                        <div style={{ maxHeight: "150px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "5px", background: "#ffffff" }}>
                          {candidateTargetJobs.length === 0 ? (
                            <div style={{ padding: "10px", fontSize: "12px", color: "#64748b", textAlign: "center" }}>
                              No matching jobs found
                            </div>
                          ) : (
                            candidateTargetJobs.map((j, i) => (
                              <div
                                key={j.id || i}
                                onClick={() => handleMoveInvoiceToTarget(j, movingPromptInvoice)}
                                style={{
                                  padding: "7px 10px",
                                  borderBottom: i < candidateTargetJobs.length - 1 ? "1px solid #f1f5f9" : "none",
                                  cursor: isMovingInvoice ? "wait" : "pointer",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  fontSize: "12px",
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                                onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
                              >
                                <div>
                                  <div style={{ fontWeight: "600", color: "#1e293b" }}>{j.jobName}</div>
                                  <div style={{ fontSize: "10.5px", color: "#64748b" }}>
                                    {j.client}{j.projectCode ? ` · ${j.projectCode}` : ""}
                                  </div>
                                </div>
                                <div style={{ fontSize: "11px", fontWeight: "600", color: "#0284c7" }}>
                                  Select
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
                          <button
                            type="button"
                            onClick={() => setMovingPromptInvoice(null)}
                            disabled={isMovingInvoice}
                            style={{
                              padding: "5px 10px",
                              background: "#f1f5f9",
                              border: "1px solid #cbd5e1",
                              borderRadius: "5px",
                              cursor: "pointer",
                              fontSize: "12px",
                              color: "#334155",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
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
                      <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB", display: "flex", alignItems: "center", gap: "8px" }}>
                        <span>Direct expenses</span>
                        {hasAccounting && (
                          <span
                            title="Direct expenses are syncing with your accounting software."
                            style={{
                              fontSize: "11px",
                              fontWeight: "normal",
                              color: "#64748b",
                              background: "#f1f5f9",
                              padding: "2px 7px",
                              borderRadius: "4px",
                              border: "1px solid #e2e8f0",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                            }}
                          >
                            <CrmSyncIcon size={11} color="#64748b" />
                            <span>Syncing with accounting</span>
                          </span>
                        )}
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
                          + Add direct expense
                        </button>
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(editingJob.directExpenses || []).map((exp, idx) => {
                        const isPlaceholder = isPlaceholderExpense(exp.appId, exp.desc, exp.status);
                        const isAuto = isPlaceholder && isAutoPlaceholder(exp.appId || exp.desc);
                        const isActual = Boolean(
                          hasAccounting &&
                          !isPlaceholder &&
                          ((exp.appId && String(exp.appId).trim() !== "") || (exp.desc && String(exp.desc).trim() !== ""))
                        );
                        const isAutoLocked = isPlaceholder && isAuto;
                        const isFieldLocked = isActual || isAutoLocked;
                        const currentStatus = canonicalizeExpenseStatus(exp.status);
                        const isPaid = currentStatus === "Paid" || currentStatus === "Part-paid (paid)";
                        const fieldLockTitle = isAutoLocked
                          ? "Automatic placeholder. Convert to manual placeholder to edit."
                          : isActual
                            ? "Synced from accounting software. To modify description, amount, VAT, or date, update directly in your accounting software."
                            : undefined;

                        return (
                          <div
                            key={idx}
                            className="modal-sub-grid-row"
                            style={{
                              display: "grid",
                              gridTemplateColumns: isReadOnly ? "1.2fr 1fr 0.7fr 1.2fr 0.6fr 1fr" : "1.2fr 1fr 0.7fr 1.2fr 0.6fr 1fr 28px",
                              gap: "6px",
                              alignItems: "center",
                              background: isFieldLocked ? "#f8fafc" : "#ffffff",
                              padding: "6px 8px",
                              borderRadius: "6px",
                              border: "1px solid #e2e8f0",
                            }}
                          >
                            <div>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "2px" }}>
                                <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b", margin: 0 }}>
                                  Description ({idx + 1})
                                </label>
                                {isPlaceholder && (
                                  <PlaceholderPill
                                    isAuto={isAuto}
                                    size="sm"
                                    disabled={isReadOnly}
                                    onToggle={(targetAuto) => {
                                      if (targetAuto) {
                                        updateExpense(idx, "appId", generatePlaceholderExpenseId(exp.recDate));
                                      } else {
                                        updateExpense(idx, "appId", "");
                                      }
                                    }}
                                  />
                                )}
                              </div>
                              <input
                                type="text"
                                placeholder="Description"
                                value={exp.desc || ""}
                                onChange={(e) => updateExpense(idx, "desc", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Amount</label>
                              <input
                                type="text"
                                placeholder="Amount"
                                value={exp.amount || ""}
                                onChange={(e) => updateExpense(idx, "amount", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>VAT?</label>
                              <select
                                value={exp.vat || "Yes"}
                                onChange={(e) => updateExpense(idx, "vat", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle || (isActual ? "VAT treatment is determined upstream in your accounting software." : undefined)}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              >
                                <option value="Yes">Yes</option>
                                <option value="No">No</option>
                              </select>
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Receive date</label>
                              <input
                                type="date"
                                value={exp.recDate || ""}
                                onChange={(e) => updateExpense(idx, "recDate", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                              <input
                                type="number"
                                placeholder="30"
                                value={exp.days || ""}
                                onChange={(e) => updateExpense(idx, "days", e.target.value)}
                                disabled={isPaid || isAutoLocked}
                                title={isAutoLocked ? "Automatic placeholder. Convert to manual placeholder to edit." : (isPaid ? "Days to pay is determined once a bill is marked as paid." : undefined)}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isPaid || isAutoLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                              <select
                                value={currentStatus}
                                onChange={(e) => updateExpense(idx, "status", e.target.value)}
                                disabled={isFieldLocked}
                                title={fieldLockTitle}
                                style={{
                                  ...formInputStyle,
                                  padding: "4px 6px",
                                  fontSize: "12px",
                                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                                }}
                              >
                                <option value="">Select...</option>
                                {EXPENSE_STATUS_OPTIONS.map((st) => (
                                  <option key={st} value={st}>{st}</option>
                                ))}
                                {currentStatus && !EXPENSE_STATUS_OPTIONS.includes(currentStatus) && (
                                  <option value={currentStatus}>{currentStatus}</option>
                                )}
                              </select>
                            </div>
                            {!isReadOnly && (
                              <div style={{ paddingTop: "14px", textAlign: "center" }}>
                                {isActual ? (
                                  <span title="Synced bill cannot be deleted" style={{ color: "#94a3b8", fontSize: "12px", cursor: "not-allowed" }}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                    </svg>
                                  </span>
                                ) : (
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
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
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
                {!isReadOnly && editingJob.rowNumber && String(editingJob.type || "").toLowerCase() === "pipeline" && !isEditingCrmPipelineDeal && (
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
                    <span>{isConfirming ? "Confirming..." : "Confirm job"}</span>
                  </button>
                )}

                {!isReadOnly && editingJob.rowNumber && String(editingJob.type || "").toLowerCase() === "confirmed" && (() => {
                  const hasActualInvoices = (editingJob.invoices || []).some(
                    (inv) => Boolean(inv.ref && String(inv.ref).trim() !== "" && !isPlaceholderInvoice(inv.ref, inv.status))
                  );
                  const hasActualExpenses = (editingJob.directExpenses || []).some((exp) => {
                    const hasData = Boolean(
                      (exp.amount && Math.abs(parseFloat(String(exp.amount).replace(/[£$€,\s]/g, ""))) > 0) ||
                      (exp.desc && String(exp.desc).trim() !== "") ||
                      (exp.appId && String(exp.appId).trim() !== "")
                    );
                    return hasData && !isPlaceholderExpense(exp.appId, exp.desc, exp.status);
                  });
                  const hasActualInvoicesOrExpenses = hasActualInvoices || hasActualExpenses;

                  return (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
                      <button
                        type="button"
                        onClick={hasActualInvoicesOrExpenses ? undefined : handleUnconfirmJob}
                        disabled={isSaving || isConfirming || hasActualInvoicesOrExpenses}
                        style={{
                          background: hasActualInvoicesOrExpenses ? "#f1f5f9" : "#fffbeb",
                          border: `1px solid ${hasActualInvoicesOrExpenses ? "#cbd5e1" : "#f59e0b"}`,
                          color: hasActualInvoicesOrExpenses ? "#94a3b8" : "#b45309",
                          padding: "7px 16px",
                          borderRadius: "6px",
                          fontSize: "13px",
                          fontWeight: 700,
                          cursor: hasActualInvoicesOrExpenses ? "not-allowed" : (isConfirming ? "wait" : "pointer"),
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          opacity: isConfirming ? 0.7 : 1,
                        }}
                        title={
                          hasActualInvoicesOrExpenses
                            ? "Cannot unconfirm a job that has actual invoices or expenses assigned to it. Reassign or remove them before moving this job back to the pipeline."
                            : "Move job from confirmed back to pipeline"
                        }
                      >
                        {isConfirming ? <Spinner size={14} color="#b45309" /> : null}
                        <span>{isConfirming ? "Unconfirming..." : "Unconfirm job"}</span>
                      </button>
                      {hasActualInvoicesOrExpenses && (
                        <span style={{ fontSize: "11px", color: "#64748b", maxWidth: "340px", lineHeight: "1.3" }}>
                          Cannot be unconfirmed while actual invoices or expenses are assigned to this job.
                        </span>
                      )}
                    </div>
                  );
                })()}
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
                    <span>{isSaving ? "Saving..." : "Save job"}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Under-allocation confirmation prompt */}
      {underAllocationPrompt && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10001,
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setUnderAllocationPrompt(null);
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: "480px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
              border: "1px solid #e2e8f0",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "1rem" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "#fef3c7",
                  color: "#d97706",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div>
                <h4 style={{ margin: "0 0 4px 0", fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                  Confirm placeholder allocation
                </h4>
                <p style={{ margin: 0, fontSize: "13px", color: "#475569", lineHeight: "1.5" }}>
                  {underAllocationPrompt.message}
                </p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "1.25rem" }}>
              <button
                type="button"
                onClick={() => setUnderAllocationPrompt(null)}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "6px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Adjust
              </button>
              <button
                type="button"
                onClick={() => {
                  setUnderAllocationPrompt(null);
                  handleSaveJob(null, true);
                }}
                style={{
                  background: "#0047AB",
                  border: "none",
                  borderRadius: "6px",
                  padding: "6px 16px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      {newJobFromInvoice && (
        <InvoicesNewJobModal
          newJobData={{
            inv: {
              invoiceNo: newJobFromInvoice.inv.ref || "",
              client: editingJob?.client || clientName,
              job: editingJob?.jobName || "",
              amount: parseFloat(String(newJobFromInvoice.inv.amount || "0").replace(/[£$€,\s]/g, "")) || 0,
              sentDate: newJobFromInvoice.inv.sendDate || "",
              daysToPay: parseInt(newJobFromInvoice.inv.days) || 30,
              status: newJobFromInvoice.inv.status || "",
            }
          }}
          invoicesClient={{
            clientSheetId,
            clientName,
            masterSheetId: data?.masterSheetId,
            defaultDaysToPay: 30,
          }}
          onClose={() => setNewJobFromInvoice(null)}
          onMarkPullPending={() => { }}
          onSuccess={async () => {
            const updatedInvoices = (editingJob?.invoices || []).filter((_, i) => i !== newJobFromInvoice.idx);
            setEditingJob((prev) => ({ ...prev, invoices: updatedInvoices }));
            if (editingJob?.rowNumber) {
              await fetch("/api/portal/save-job", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientSheetId,
                  clientName,
                  job: {
                    ...editingJob,
                    invoices: updatedInvoices,
                  },
                }),
              });
            }
            setNewJobFromInvoice(null);
            if (onRefresh) onRefresh();
          }}
        />
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
