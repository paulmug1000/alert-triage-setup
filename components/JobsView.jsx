import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import Skeleton, { PmaJobsTableSkeleton } from "./Skeleton";
import UnevenSplitModal from "./UnevenSplitModal";
import InvoicesEditModal from "./InvoicesEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import AssignAccountingItemsModal from "./AssignAccountingItemsModal";
import RetainersEditModal from "./RetainersEditModal";
import JobsNewJobModal from "./JobsNewJobModal";
import EditClientSelector from "./EditClientSelector";
import CellNoteModal from "./CellNoteModal";
import NoteIndicatorButton from "./NoteIndicatorButton";
import CrmSyncBadge, { CrmSyncIcon } from "./CrmSyncBadge";
import PlaceholderPill, { isAutoPlaceholder, generatePlaceholderInvoiceRef, generateManualPlaceholderInvoiceRef } from "./PlaceholderPill";
import { useJobs } from "../hooks/useJobs";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import {
  isPlaceholderInvoice,
  isDraftInvoice,
  isPlaceholderExpense,
  isDraftExpense,
  getRetainerRowMonthLabel,
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  isCrmDeal,
  getCrmDisplayName,
  calculatePaymentDate,
  groupSlotItemsForDisplay,
  NO_END_DATE_SHEET_VALUE,
  isNoEndDateSentinel,
  formatJobEndDateDisplay,
  stripCurrency,
  generateDuplicateJobName,
  generateRenewalJobName,
  calculateRenewalDates,
  formatLikelihood,
  normalizeLikelihoodInput,
  isValidCalendarIsoDate,
  validateDateRange,
  MIN_INPUT_DATE,
  MAX_INPUT_DATE
} from "../utils/helpers";
import {
  getJobInvoiceItems,
  getJobExpenseItems,
} from "../utils/jobItemsHelpers";
export { getJobInvoiceItems, getJobExpenseItems };

const SHEET_DATE_TS_CACHE = new Map();
const SHEET_MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const parseSheetDateToTs = (dStr) => {
  if (!dStr) return null;
  if (isNoEndDateSentinel(dStr)) return new Date(2050, 11, 31).getTime();
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr.getTime();
  const s = String(dStr).trim();
  if (!s) return null;

  if (SHEET_DATE_TS_CACHE.has(s)) {
    return SHEET_DATE_TS_CACHE.get(s);
  }

  let ts = null;

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mIdx = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const d = new Date(yr, mIdx, day);
    ts = isNaN(d.getTime()) ? null : d.getTime();
  } else {
    // 2. DD-Mon-YY or DD-Mon-YYYY
    const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) {
      const mIdx = SHEET_MONTHS_MAP[m[2].toLowerCase()];
      if (mIdx !== undefined) {
        let yr = parseInt(m[3], 10);
        if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
        const d = new Date(yr, mIdx, parseInt(m[1], 10));
        ts = isNaN(d.getTime()) ? null : d.getTime();
      }
    } else {
      // 3. Mon-YY or Mon-YYYY
      const myMatch = s.match(/^([A-Za-z]{3})[-/\s](\d{2,4})$/);
      if (myMatch) {
        const mIdx = SHEET_MONTHS_MAP[myMatch[1].toLowerCase()];
        if (mIdx !== undefined) {
          let yr = parseInt(myMatch[2], 10);
          if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
          const d = new Date(yr, mIdx, 1);
          ts = isNaN(d.getTime()) ? null : d.getTime();
        }
      } else {
        // 4. DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY
        const slashMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
        if (slashMatch) {
          let yr = parseInt(slashMatch[3], 10);
          if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
          const d = new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
          ts = isNaN(d.getTime()) ? null : d.getTime();
        } else {
          const d = new Date(s);
          ts = isNaN(d.getTime()) ? null : d.getTime();
        }
      }
    }
  }

  if (SHEET_DATE_TS_CACHE.size > 5000) {
    SHEET_DATE_TS_CACHE.clear();
  }
  SHEET_DATE_TS_CACHE.set(s, ts);
  return ts;
};

export const parseSheetDate = (dStr) => {
  if (!dStr) return null;
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
  const ts = parseSheetDateToTs(dStr);
  return ts === null ? null : new Date(ts);
};

export const addMonths = (baseDate, n) => {
  if (!baseDate) return null;
  const targetMonth = baseDate.getMonth() + n;
  const targetYear = baseDate.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const day = baseDate.getDate();
  const maxDays = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  return new Date(targetYear, normalizedMonth, Math.min(day, maxDays));
};

export const toInputDateFormat = (dStr) => {
  if (!dStr) return "";
  if (isNoEndDateSentinel(dStr)) return "";
  const d = parseSheetDate(dStr);
  if (!d) return "";
  const y = d.getFullYear();
  if (y < 1900 || y > 2099) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${m}-${day}`;
};

export const toSheetDateFormat = (dStr) => {
  if (!dStr) return "";
  if (isNoEndDateSentinel(dStr)) return NO_END_DATE_SHEET_VALUE;
  const d = parseSheetDate(dStr);
  if (!d) return String(dStr).trim();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d.getDate();
  const mmm = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${day}-${mmm}-${yy}`;
};

export const formatCurrency = (val) => {
  const s = String(val || "").trim();
  if (!s) return "";
  const hasSymbol = /^[£$€]/.test(s);
  const symbol = hasSymbol ? s.charAt(0) : "£";
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return symbol + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const parseLikelihoodValue = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().replace(/[%,\s]/g, "");
  if (!s) return null;
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (num > 0 && num <= 1 && String(val).includes(".")) {
    return num * 100;
  }
  return num;
};

// Resilient inline date input for spreadsheet grid:
// Does NOT wipe existing segments to "dd/yy" when a user is editing/typing in Chromium
export const JobDateInput = ({
  value,
  onChange,
  onKeyDown,
  isDirty = false,
  style = {},
  defaultBorder = "1px solid transparent",
  dirtyBorder = "1px solid #f59e0b",
  focusBorder = "1px solid #3b82f6",
  defaultBg = "transparent",
  focusBg = "#ffffff",
  title,
  disabled = false,
  readOnly = false,
  min,
  max,
  ...rest
}) => {
  const inputRef = React.useRef(null);
  const isFocusedRef = React.useRef(false);
  const isCancelledRef = React.useRef(false);
  const isoValue = React.useMemo(() => toInputDateFormat(value), [value]);
  const effectiveMin = React.useMemo(() => {
    const parsed = min ? toInputDateFormat(min) : "";
    return parsed && isValidCalendarIsoDate(parsed) ? parsed : MIN_INPUT_DATE;
  }, [min]);
  const effectiveMax = React.useMemo(() => {
    const parsed = max ? toInputDateFormat(max) : "";
    return parsed && isValidCalendarIsoDate(parsed) ? parsed : MAX_INPUT_DATE;
  }, [max]);

  React.useEffect(() => {
    if (inputRef.current && !isFocusedRef.current) {
      inputRef.current.value = isoValue;
    }
  }, [isoValue]);

  const handleChange = (e) => {
    const newVal = e.target.value;
    if (newVal === "") {
      if (!e.target.validity?.badInput) {
        onChange("");
      }
      return;
    }
    if (isValidCalendarIsoDate(newVal)) {
      onChange(newVal);
    }
  };

  const handleFocus = () => {
    if (disabled || readOnly) return;
    isFocusedRef.current = true;
    if (inputRef.current) {
      inputRef.current.style.background = focusBg;
      inputRef.current.style.borderColor = focusBorder.replace(/^1px solid\s*/, "");
    }
  };

  const handleBlur = (e) => {
    isFocusedRef.current = false;
    if (inputRef.current) {
      inputRef.current.style.background = defaultBg;
      inputRef.current.style.borderColor = isDirty ? "#f59e0b" : (defaultBorder.includes("transparent") ? "transparent" : "#cbd5e1");
    }

    if (isCancelledRef.current) {
      isCancelledRef.current = false;
      if (inputRef.current) {
        inputRef.current.value = isoValue;
      }
      return;
    }

    const finalVal = inputRef.current ? inputRef.current.value : e.target.value;
    if (e.target.validity?.badInput || (finalVal && !isValidCalendarIsoDate(finalVal))) {
      if (inputRef.current) {
        inputRef.current.value = isoValue;
      }
      return;
    }
    if (finalVal !== isoValue) {
      onChange(finalVal);
    }
  };

  const handleKeyDownInternal = (e) => {
    if (e.key === "Escape") {
      isCancelledRef.current = true;
    }
    if (onKeyDown) onKeyDown(e);
  };

  const currentBorder = isDirty ? dirtyBorder : defaultBorder;

  return (
    <input
      ref={inputRef}
      type="date"
      min={effectiveMin}
      max={effectiveMax}
      defaultValue={isoValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDownInternal}
      title={title}
      disabled={disabled}
      readOnly={readOnly}
      {...rest}
      style={{
        padding: "3px 4px",
        borderRadius: "5px",
        border: currentBorder,
        background: defaultBg,
        fontSize: "12px",
        color: "#334155",
        outline: "none",
        ...style
      }}
    />
  );
};

export const getStatusPill = (status) => {
  const s = String(status || "").trim();
  const lower = s.toLowerCase();
  if (lower === "paid") return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  if (lower === "draft") return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
  if (lower === "sent" || lower === "received") return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  if (lower.includes("part-paid") || lower.includes("part paid") || lower.includes("partpaid")) {
    return { backgroundColor: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
};

const JOB_SEARCH_SCOPES = [
  { id: "all", label: "All fields", placeholder: "Search jobs by client, job name, project code, invoice, or direct cost..." },
  { id: "core", label: "Client & job", placeholder: "Search by client name, job name, project code, product line, or note..." },
  { id: "invoices", label: "Invoices", placeholder: "Search by invoice number, status, amount, date, or note..." },
  { id: "expenses", label: "Direct costs", placeholder: "Search by direct cost description, ID, status, amount, date, or note..." },
];

const DRAFT_CORE_SEARCH_FIELDS = [
  "client",
  "jobName",
  "projectCode",
  "prodLine",
  "leadSrc",
  "projectRetainer",
  "startDate",
  "endDate",
  "revenue",
  "directCosts",
  "rechargedExpenses",
  "likelihood",
  "note",
];

const JOB_SEARCH_INDEX_CACHE = new WeakMap();

const getJobSearchIndex = (job) => {
  if (!job || typeof job !== "object") {
    return {
      primaryClient: "",
      primaryJobName: "",
      primaryProjectCode: "",
      client: "",
      jobName: "",
      projectCode: "",
      meta: "",
      invoices: "",
      expenses: "",
      core: "",
      all: "",
      invoiceRefs: [],
      expenseTitles: [],
    };
  }
  const cached = JOB_SEARCH_INDEX_CACHE.get(job);
  if (cached !== undefined) return cached;

  const clientParts = [];
  const jobNameParts = [];
  const projectCodeParts = [];
  const metaParts = [];
  const invoiceParts = [];
  const expenseParts = [];
  const invoiceRefs = [];
  const expenseTitles = [];

  const addTo = (arr, val) => {
    if (val !== null && val !== undefined) {
      const s = String(val).trim();
      if (s) arr.push(s.toLowerCase());
    }
  };

  addTo(clientParts, job.client);
  addTo(jobNameParts, job.jobName);
  addTo(projectCodeParts, job.projectCode);
  addTo(metaParts, job.note);

  if (Array.isArray(job.rows)) {
    job.rows.forEach((r) => {
      if (!r) return;
      addTo(clientParts, r.client);
      addTo(jobNameParts, r.jobName);
      addTo(projectCodeParts, r.projectCode);
      addTo(metaParts, r.note);
      addTo(metaParts, r.prodLine);
      addTo(metaParts, r.leadSrc);
      addTo(metaParts, r.projectRetainer);
      addTo(metaParts, r.startDate);
      if (isNoEndDateSentinel(r.endDate)) {
        addTo(metaParts, "no end date");
      } else {
        addTo(metaParts, r.endDate);
      }
      addTo(metaParts, r.revenue);
      addTo(metaParts, r.directCosts);
      addTo(metaParts, r.rechargedExpenses);
      addTo(metaParts, r.likelihood);

      if (Array.isArray(r.invoiceSlots)) {
        r.invoiceSlots.forEach((inv) => {
          if (!inv) return;
          addTo(invoiceParts, inv.ref);
          if (inv.ref && String(inv.ref).trim()) {
            invoiceRefs.push(String(inv.ref).trim().toLowerCase());
          }
          addTo(invoiceParts, inv.amount);
          addTo(invoiceParts, inv.status);
          addTo(invoiceParts, inv.sentDate);
          if (inv.sentDate) {
            addTo(invoiceParts, toSheetDateFormat(inv.sentDate));
          }
          addTo(invoiceParts, inv.note);
        });
      }

      if (Array.isArray(r.expenseSlots)) {
        r.expenseSlots.forEach((exp) => {
          if (!exp) return;
          addTo(expenseParts, exp.description);
          addTo(expenseParts, exp.transactionId);
          if (exp.description && String(exp.description).trim()) {
            expenseTitles.push(String(exp.description).trim().toLowerCase());
          }
          if (exp.transactionId && String(exp.transactionId).trim()) {
            expenseTitles.push(String(exp.transactionId).trim().toLowerCase());
          }
          addTo(expenseParts, exp.amount);
          addTo(expenseParts, exp.status);
          addTo(expenseParts, exp.date);
          if (exp.date) {
            addTo(expenseParts, toSheetDateFormat(exp.date));
          }
          addTo(expenseParts, exp.note);
        });
      }
    });
  }

  const client = clientParts.join(" ");
  const jobName = jobNameParts.join(" ");
  const projectCode = projectCodeParts.join(" ");
  const meta = metaParts.join(" ");
  const invoices = invoiceParts.join(" ");
  const expenses = expenseParts.join(" ");
  const core = [client, jobName, projectCode, meta].filter(Boolean).join(" ");
  const all = [core, invoices, expenses].filter(Boolean).join(" ");

  const firstRow = job.rows?.[0] || {};
  const index = {
    primaryClient: String(job.client || firstRow.client || "").trim().toLowerCase(),
    primaryJobName: String(job.jobName || firstRow.jobName || "").trim().toLowerCase(),
    primaryProjectCode: String(job.projectCode || firstRow.projectCode || "").trim().toLowerCase(),
    client,
    jobName,
    projectCode,
    meta,
    invoices,
    expenses,
    core,
    all,
    invoiceRefs,
    expenseTitles,
  };
  JOB_SEARCH_INDEX_CACHE.set(job, index);
  return index;
};

/**
 * Searches across user-facing job fields, optionally scoped to "all", "core", "invoices", or "expenses".
 */
export const isJobMatchSearch = (job, query, draftEdits = {}, scope = "all") => {
  if (!query || !query.trim()) return true;
  if (!job) return false;

  const q = query.toLowerCase().trim();
  const searchTokens = q.split(/\s+/).filter(Boolean);
  const index = getJobSearchIndex(job);

  let haystack = index.all;
  if (scope === "core") haystack = index.core;
  else if (scope === "invoices") haystack = index.invoices;
  else if (scope === "expenses") haystack = index.expenses;

  if (draftEdits && (scope === "all" || scope === "core")) {
    const jobKey = job.id || (job.rows?.[0] ? `${(job.tabName || job.rows[0].tabName || "").toLowerCase()}_${job.rows[0].rowNum}` : null);
    if (jobKey && draftEdits[jobKey]) {
      const draftParts = [];
      DRAFT_CORE_SEARCH_FIELDS.forEach((field) => {
        const val = draftEdits[jobKey][field];
        if (val !== null && val !== undefined) {
          const s = String(val).trim();
          if (s) draftParts.push(s.toLowerCase());
        }
      });
      if (draftParts.length > 0) {
        haystack = haystack ? `${haystack} ${draftParts.join(" ")}` : draftParts.join(" ");
      }
    }
  }

  if (!haystack) return false;
  if (haystack.includes(q)) return true;
  if (searchTokens.length > 1 && searchTokens.every((tok) => haystack.includes(tok))) {
    return true;
  }

  return false;
};

/**
 * Scores a matched job by search relevance using persisted index fields.
 */
export const getJobSearchScore = (job, query, scope = "all") => {
  if (!job || !query || !query.trim()) return 0;
  const q = query.toLowerCase().trim();
  const searchTokens = q.split(/\s+/).filter(Boolean);
  const index = getJobSearchIndex(job);

  if (scope === "invoices") {
    if (index.invoiceRefs.some((ref) => ref === q)) return 1000;
    if (index.invoiceRefs.some((ref) => ref.startsWith(q))) return 800;
    if (index.invoices.includes(q)) return 600;
    if (searchTokens.length > 1 && searchTokens.every((tok) => index.invoices.includes(tok))) return 300;
    return 100;
  }

  if (scope === "expenses") {
    if (index.expenseTitles.some((t) => t === q)) return 1000;
    if (index.expenseTitles.some((t) => t.startsWith(q))) return 800;
    if (index.expenses.includes(q)) return 600;
    if (searchTokens.length > 1 && searchTokens.every((tok) => index.expenses.includes(tok))) return 300;
    return 100;
  }

  if (index.primaryClient === q || index.primaryJobName === q || index.primaryProjectCode === q) return 1000;
  if (index.primaryClient.startsWith(q)) return 850;
  if (index.primaryJobName.startsWith(q) || index.primaryProjectCode.startsWith(q)) return 800;
  if (index.client.includes(q)) return 700;
  if (index.jobName.includes(q)) return 650;
  if (index.projectCode.includes(q)) return 600;

  const clientAndJob = `${index.client} ${index.jobName}`.trim();
  if (searchTokens.length > 1 && searchTokens.every((tok) => clientAndJob.includes(tok))) return 500;
  if (index.meta.includes(q)) return 350;
  if (searchTokens.length > 1 && searchTokens.every((tok) => index.core.includes(tok))) return 300;
  if (scope === "all" && index.invoices.includes(q)) return 250;
  if (scope === "all" && index.expenses.includes(q)) return 200;
  return 100;
};

export const jobHasActualInvoicesOrExpenses = (job) => {
  if (!job) return false;
  const hasActualInvoices = (job.rows || []).some((r) =>
    (r.invoiceSlots || []).some(
      (s) => Boolean(s.ref && String(s.ref).trim() !== "" && !isPlaceholderInvoice(s.ref, s.status))
    )
  );
  const hasActualExpenses = (job.rows || []).some((r) =>
    (r.expenseSlots || []).some((s) => {
      const hasData = Boolean(
        (s.amount && Math.abs(parseFloat(String(s.amount).replace(/[£$€,\s]/g, ""))) > 0) ||
        (s.description && String(s.description).trim() !== "") ||
        (s.transactionId && String(s.transactionId).trim() !== "")
      );
      return hasData && !isPlaceholderExpense(s.transactionId, s.description, s.status);
    })
  );
  return hasActualInvoices || hasActualExpenses;
};

export const textMatchesQuery = (text, query, { matchAll = false } = {}) => {
  if (!text || !query || !query.trim()) return false;
  const q = query.toLowerCase().trim();
  const s = String(text).toLowerCase();
  if (s.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return matchAll ? tokens.every((t) => s.includes(t)) : tokens.some((t) => s.includes(t));
};

const HIGHLIGHT_REGEX_CACHE = new Map();

const getHighlightMatchers = (query) => {
  const q = query.trim();
  if (!q) return null;
  let cached = HIGHLIGHT_REGEX_CACHE.get(q);
  if (!cached) {
    const rawTokens = [...q.split(/\s+/).filter(Boolean)].sort((a, b) => b.length - a.length);
    if (rawTokens.length === 0) return null;
    const escapedTokens = rawTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const lowerTokenSet = new Set(rawTokens.map((t) => t.toLowerCase()));
    cached = {
      regex: new RegExp(`(${escapedTokens.join("|")})`, "gi"),
      lowerTokenSet,
    };
    if (HIGHLIGHT_REGEX_CACHE.size > 200) {
      HIGHLIGHT_REGEX_CACHE.clear();
    }
    HIGHLIGHT_REGEX_CACHE.set(q, cached);
  }
  return cached;
};

export const HighlightText = ({ text, query }) => {
  const str = text !== null && text !== undefined ? String(text) : "";
  if (!str || !query || !query.trim()) return <>{str}</>;

  const matchers = getHighlightMatchers(query);
  if (!matchers) return <>{str}</>;

  const { regex, lowerTokenSet } = matchers;
  const parts = str.split(regex);

  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const isMatch = lowerTokenSet.has(part.toLowerCase());
        return isMatch ? (
          <mark
            key={i}
            style={{
              backgroundColor: "rgba(254, 240, 138, 0.65)",
              color: "inherit",
              padding: "0 2px",
              borderRadius: "2px",
              fontWeight: "inherit"
            }}
          >
            {part}
          </mark>
        ) : (
          part
        );
      })}
    </>
  );
};

export const buildMatchSnippet = (text, query, maxLen = 76) => {
  const str = text !== null && text !== undefined ? String(text).trim() : "";
  if (!str || str.length <= maxLen) return str;

  const lower = str.toLowerCase();
  const q = String(query || "").toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);

  let matchIdx = q ? lower.indexOf(q) : -1;
  if (matchIdx === -1 && tokens.length > 0) {
    for (let i = 0; i < tokens.length; i++) {
      const idx = lower.indexOf(tokens[i]);
      if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
        matchIdx = idx;
      }
    }
  }

  if (matchIdx === -1) {
    return `${str.slice(0, maxLen - 1).trimEnd()}…`;
  }

  let start = matchIdx > 20 ? matchIdx - 20 : 0;
  if (start > 0) {
    const prevSpace = str.lastIndexOf(" ", start + 6);
    if (prevSpace > 0 && start - prevSpace <= 12) {
      start = prevSpace + 1;
    }
  }

  let end = start + maxLen;
  if (end >= str.length) {
    end = str.length;
    start = Math.max(0, end - maxLen);
  } else {
    const nextSpace = str.indexOf(" ", end - 8);
    if (nextSpace !== -1 && nextSpace - end <= 10) {
      end = nextSpace;
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < str.length ? "…" : "";
  return `${prefix}${str.slice(start, end).trim()}${suffix}`;
};

export const getJobNestedMatchSummary = (
  job,
  query,
  { maxItems = 2, scope = "all", clientText = "", jobNameText = "" } = {}
) => {
  const empty = {
    items: [],
    totalCount: 0,
    countsBySection: { details: 0, invoices: 0, expenses: 0 },
    collapseToSummary: false,
  };
  if (!job || !query || !query.trim()) return empty;

  const firstRow = job.rows?.[0] || {};
  const resolvedClient = clientText !== undefined && clientText !== "" ? String(clientText) : String(job.client || firstRow.client || "");
  const resolvedJobName = jobNameText !== undefined && jobNameText !== "" ? String(jobNameText) : String(job.jobName || firstRow.jobName || "");
  const combinedVisible = `${resolvedClient} ${resolvedJobName}`.trim();

  const visibleMatchedAll =
    textMatchesQuery(resolvedClient, query, { matchAll: true }) ||
    textMatchesQuery(resolvedJobName, query, { matchAll: true }) ||
    textMatchesQuery(combinedVisible, query, { matchAll: true });

  const qTokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const combinedVisibleLower = combinedVisible.toLowerCase();
  const unmatchedTokens = qTokens.filter((t) => !combinedVisibleLower.includes(t));
  const unmatchedQuery = unmatchedTokens.join(" ");

  const candidates = [];
  const seen = new Set();
  const addCandidate = (label, matchText, title, section) => {
    if (!matchText) return;
    const strVal = String(matchText).trim();
    if (!strVal) return;
    const key = `${section}:${label}:${strVal.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ label, matchText: strVal, title, section });
  };

  const includeDetails = scope === "all" || scope === "core";
  const includeInvoices = scope === "all" || scope === "invoices";
  const includeExpenses = scope === "all" || scope === "expenses";

  if (includeDetails) {
    const pCode = job.projectCode || firstRow.projectCode;
    if (pCode) addCandidate("Code", pCode, `Matched project code: ${pCode}`, "details");
  }

  if (Array.isArray(job.rows)) {
    job.rows.forEach((r) => {
      if (!r) return;
      if (includeDetails) {
        if (r.projectCode) addCandidate("Code", r.projectCode, `Matched project code: ${r.projectCode}`, "details");
        if (r.note) addCandidate("Note", r.note, `Matched note: ${r.note}`, "details");
        if (r.prodLine) addCandidate("Product line", r.prodLine, `Matched product line: ${r.prodLine}`, "details");
        if (r.leadSrc) addCandidate("Lead source", r.leadSrc, `Matched lead source: ${r.leadSrc}`, "details");
      }

      if (includeInvoices && Array.isArray(r.invoiceSlots)) {
        r.invoiceSlots.forEach((inv) => {
          if (!inv) return;
          if (inv.ref) {
            const extra = inv.amount ? ` (${formatCurrency(inv.amount)})` : "";
            addCandidate("Invoice", `${inv.ref}${extra}`, `Matched invoice ${inv.ref}`, "invoices");
          }
          if (inv.note) {
            addCandidate("Invoice note", inv.note, `Matched invoice note: ${inv.note}`, "invoices");
          }
        });
      }

      if (includeExpenses && Array.isArray(r.expenseSlots)) {
        r.expenseSlots.forEach((exp) => {
          if (!exp) return;
          if (exp.transactionId) {
            addCandidate("Direct cost ID", exp.transactionId, `Matched direct cost ID: ${exp.transactionId}`, "expenses");
          }
          if (exp.description) {
            const extra = exp.amount ? ` (${formatCurrency(exp.amount)})` : "";
            addCandidate("Direct cost", `${exp.description}${extra}`, `Matched direct cost: ${exp.description}`, "expenses");
          }
          if (exp.note) {
            addCandidate("Direct cost note", exp.note, `Matched direct cost note: ${exp.note}`, "expenses");
          }
        });
      }
    });
  }

  if (includeDetails && job.note) {
    addCandidate("Note", job.note, `Matched note: ${job.note}`, "details");
  }

  let matched = candidates.filter((c) => {
    if (textMatchesQuery(c.matchText, query, { matchAll: true })) return true;
    if (unmatchedQuery && textMatchesQuery(c.matchText, unmatchedQuery, { matchAll: true })) return true;
    return false;
  });

  if (matched.length === 0 && !visibleMatchedAll) {
    matched = candidates.filter((c) => textMatchesQuery(c.matchText, query, { matchAll: false }));
  }

  const effectiveSnippetQuery = unmatchedQuery || query;
  const countsBySection = { details: 0, invoices: 0, expenses: 0 };
  const items = matched.map((c) => {
    countsBySection[c.section] = (countsBySection[c.section] || 0) + 1;
    return {
      ...c,
      snippet: buildMatchSnippet(c.matchText, effectiveSnippetQuery, 76),
    };
  });

  return {
    items: items.slice(0, maxItems),
    totalCount: items.length,
    countsBySection,
    collapseToSummary: scope === "all" && visibleMatchedAll,
  };
};

export const getJobNestedMatches = (job, query, maxItems = 4) => {
  return getJobNestedMatchSummary(job, query, { maxItems, scope: "all" }).items;
};

const JOB_METRICS_CACHE = new WeakMap();

export const getJobFinancialMetrics = (job, isRetainer, isConfirmed, currentRevVal, currentCostVal, noEndDateRetainerMonths = 18, currentEndDateVal, currentRechVal) => {
  if (!job || !job.rows || job.rows.length === 0) {
    return {
      revenue: 0,
      rechargedExpenses: 0,
      totalBillable: 0,
      realInvoiced: 0,
      placeholderInvoiced: 0,
      draftInvoiced: 0,
      leftToInvoice: 0,
      priorMonthsUninvoicedCount: 0,
      directCosts: 0,
      realCostsReceived: 0,
      placeholderCosts: 0,
      draftCosts: 0,
      costsLeftToReceive: 0,
      priorMonthsUnreceivedCount: 0,
      isRetainer: false,
      isConfirmed: false
    };
  }

  const canUseMetricsCache =
    currentRevVal === undefined &&
    currentCostVal === undefined &&
    currentEndDateVal === undefined &&
    currentRechVal === undefined;

  let cacheMap = null;
  let cacheKey = null;
  if (canUseMetricsCache && typeof job === "object") {
    const nowForKey = new Date();
    const dayKey = `${nowForKey.getFullYear()}-${nowForKey.getMonth()}-${nowForKey.getDate()}`;
    cacheKey = `${Boolean(isRetainer)}_${isConfirmed === undefined ? "auto" : Boolean(isConfirmed)}_${noEndDateRetainerMonths}_${dayKey}`;
    cacheMap = JOB_METRICS_CACHE.get(job);
    if (cacheMap && cacheMap.has(cacheKey)) {
      return cacheMap.get(cacheKey);
    }
  }

  const parentRow = job.rows[0];
  const tabName = job.tabName || parentRow.tabName || "Confirmed";
  const confirmed = isConfirmed !== undefined ? Boolean(isConfirmed) : (String(tabName).toLowerCase() === "confirmed");

  const rawRev = parseFloat(String(currentRevVal !== undefined ? currentRevVal : (parentRow.revenue || "0")).replace(/[£$€,\s]/g, "")) || 0;
  const rawRech = confirmed ? (parseFloat(String(currentRechVal !== undefined ? currentRechVal : (parentRow.rechargedExpenses || job.rechargedExpenses || "0")).replace(/[£$€,\s]/g, "")) || 0) : 0;
  const rawCost = parseFloat(String(currentCostVal !== undefined ? currentCostVal : (parentRow.directCosts || "0")).replace(/[£$€,\s]/g, "")) || 0;

  let realInvoiced = 0;
  let placeholderInvoiced = 0;
  let draftInvoiced = 0;
  job.rows.forEach((r) => {
    (r.invoiceSlots || []).forEach((slot) => {
      const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
      if (amt > 0) {
        const ref = String(slot.ref || "").trim();
        if (isPlaceholderInvoice(ref, slot.status) || !ref) {
          placeholderInvoiced += amt;
        } else if (isDraftInvoice(ref, slot.status)) {
          draftInvoiced += amt;
        } else {
          realInvoiced += amt;
        }
      }
    });
  });

  let realCostsReceived = 0;
  let placeholderCosts = 0;
  let draftCosts = 0;
  job.rows.forEach((r) => {
    (r.expenseSlots || []).forEach((slot) => {
      const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
      if (amt > 0) {
        if (isPlaceholderExpense(slot)) {
          placeholderCosts += amt;
        } else if (isDraftExpense(slot)) {
          draftCosts += amt;
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
  let priorMonthsUninvoicedCount = 0;
  let priorMonthsUnreceivedCount = 0;

  if (!confirmed) {
    leftToInvoice = 0;
    costsLeftToReceive = 0;
  } else if (isRetainer) {
    const now = new Date();

    let baseStartDate = parseSheetDate(parentRow.startDate);
    if (!baseStartDate && parentRow.invoiceSlots?.[0]?.sentDate) {
      baseStartDate = parseSheetDate(parentRow.invoiceSlots[0].sentDate);
    }
    if (!baseStartDate && parentRow.dateConf) {
      baseStartDate = parseSheetDate(parentRow.dateConf);
    }
    if (!baseStartDate) {
      for (let i = 0; i < job.rows.length; i++) {
        const d = parseSheetDate(job.rows[i].invoiceSlots?.[0]?.sentDate);
        if (d) {
          baseStartDate = new Date(d.getFullYear(), d.getMonth() - i, d.getDate());
          break;
        }
      }
    }

    const sDate = baseStartDate || parseSheetDate(parentRow.startDate);
    const effectiveEndVal = currentEndDateVal !== undefined ? currentEndDateVal : parentRow.endDate;
    const isNoEnd = isNoEndDateSentinel(effectiveEndVal);
    const eDate = isNoEnd ? null : parseSheetDate(effectiveEndVal);

    // Multi-month child rows & schedule interval detection:
    // In Pulse, retainer child rows can represent multiple months of revenue (e.g. quarterly = 3 months, 6-monthly = 6 months).
    // 1. Detect cadence interval between child row dates (fallback to 1 if monthly).
    const childRows = job.rows.filter((r) => !r.isParent);
    const childDates = childRows.map((cr) => parseSheetDate(cr.invoiceSlots?.[0]?.sentDate || cr.startDate)).filter(Boolean);
    let detectedInterval = 1;
    if (childDates.length >= 2) {
      const d1 = childDates[childDates.length - 2];
      const d2 = childDates[childDates.length - 1];
      const diffDays = Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86400000);
      const calc = Math.round(diffDays / 30);
      if (calc > 0) detectedInterval = calc;
    }

    // 2. Sum the actual months covered by child rows based on invoice amount ratio or date cadence
    let totalChildRowMonths = 0;
    childRows.forEach((cr) => {
      let childAmt = 0;
      (cr.invoiceSlots || []).forEach((s) => {
        const amt = parseFloat(String(s.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (amt > 0) childAmt += amt;
      });
      if (childAmt <= 0 && cr.revenue) {
        childAmt = parseFloat(String(cr.revenue).replace(/[£$€,\s]/g, "")) || 0;
      }
      if (rawRev > 0 && childAmt > 0) {
        totalChildRowMonths += Math.max(1, Math.round(childAmt / rawRev));
      } else {
        totalChildRowMonths += detectedInterval;
      }
    });

    // 3. Contract duration in months:
    // For fixed-term contracts (sDate & eDate), duration is strictly determined by dates (or child row coverage if larger).
    // Never conflate total spreadsheet rows (which include the parent header row) with month count.
    let monthsCount = childRows.length > 0 ? totalChildRowMonths : 1;
    if (isNoEnd) {
      const d18Months = (typeof noEndDateRetainerMonths === "number" && noEndDateRetainerMonths > 0) ? noEndDateRetainerMonths : 18;
      monthsCount = Math.max(totalChildRowMonths, d18Months);
    } else if (sDate && eDate && eDate >= sDate) {
      const diffDays = (eDate.getTime() - sDate.getTime()) / (24 * 60 * 60 * 1000);
      const diffMonths = Math.max(1, Math.round(diffDays / 30.4375));
      monthsCount = Math.max(diffMonths, totalChildRowMonths);
    }

    totalRevenue = rawRev * monthsCount;
    totalDirectCosts = rawCost * monthsCount;

    if (sDate) {
      let expectedPriorRevenue = 0;
      let expectedPriorCosts = 0;
      let priorPeriodsCount = 0;

      for (let p = 0; p < monthsCount; p++) {
        // Stop projecting periods that start after the contract end date
        const pStart = addMonths(sDate, p);
        if (eDate && pStart > eDate) break;

        const nextPStart = addMonths(sDate, p + 1);
        const pEnd = new Date(nextPStart.getFullYear(), nextPStart.getMonth(), nextPStart.getDate() - 1, 23, 59, 59, 999);

        if (pEnd < now) {
          priorPeriodsCount++;
          expectedPriorRevenue += rawRev;
          expectedPriorCosts += rawCost;
        }
      }

      expectedPriorRevenue = Math.min(expectedPriorRevenue, totalRevenue);
      expectedPriorCosts = Math.min(expectedPriorCosts, totalDirectCosts);

      leftToInvoice = Math.max(0, expectedPriorRevenue + rawRech - realInvoiced);
      priorMonthsUninvoicedCount = rawRev > 0 ? Math.ceil(leftToInvoice / rawRev) : (leftToInvoice > 0 ? 1 : 0);

      costsLeftToReceive = Math.max(0, expectedPriorCosts - realCostsReceived);
      priorMonthsUnreceivedCount = rawCost > 0 ? Math.ceil(costsLeftToReceive / rawCost) : (costsLeftToReceive > 0 ? 1 : 0);
    } else {
      leftToInvoice = 0;
      costsLeftToReceive = 0;
    }
  } else {
    leftToInvoice = (totalRevenue + rawRech) > 0 ? Math.max(0, (totalRevenue + rawRech) - realInvoiced) : 0;
    costsLeftToReceive = totalDirectCosts > 0 ? Math.max(0, totalDirectCosts - realCostsReceived) : 0;
  }

  const totalRecharged = rawRech;
  const totalBillable = totalRevenue + totalRecharged;

  const result = {
    rechargedExpenses: totalRecharged,
    totalBillable,
    revenue: totalRevenue,
    realInvoiced,
    placeholderInvoiced,
    draftInvoiced,
    leftToInvoice,
    priorMonthsUninvoicedCount,
    directCosts: totalDirectCosts,
    realCostsReceived,
    placeholderCosts,
    draftCosts,
    costsLeftToReceive,
    priorMonthsUnreceivedCount,
    isRetainer,
    isConfirmed: confirmed
  };

  if (canUseMetricsCache && cacheKey) {
    if (!cacheMap) {
      cacheMap = new Map();
      JOB_METRICS_CACHE.set(job, cacheMap);
    }
    cacheMap.set(cacheKey, result);
  }

  return result;
};

const uiRetainerRowHasRealData = (row) => {
  if (!row) return false;
  for (const s of (row.invoiceSlots || [])) {
    const ref = String(s.ref ?? "").trim();
    if (ref && !isPlaceholderInvoice(ref, s.status)) return true;
    const status = String(s.status ?? "").trim().toLowerCase();
    if (status.includes("sent") || status.includes("paid")) return true;
  }
  for (const s of (row.expenseSlots || [])) {
    const id = String(s.ref ?? s.id ?? "").trim();
    if (id && !isPlaceholderExpense(id, s.status)) return true;
  }
  return false;
};

const detectRetainerIntervalMonthsUi = (childDates) => {
  const dates = (childDates || []).filter(Boolean);
  if (dates.length < 2) return 1;
  const diffs = [];
  for (let k = 0; k < dates.length - 1; k++) {
    const d1 = dates[k];
    const d2 = dates[k + 1];
    if (d1 && d2) {
      const diffDays = Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86400000);
      const calc = Math.round(diffDays / 30);
      if (calc > 0) diffs.push(calc);
    }
  }
  if (diffs.length === 0) return 1;
  const counts = {};
  let maxCount = 0;
  let modeInterval = 1;
  for (const val of diffs) {
    counts[val] = (counts[val] || 0) + 1;
    if (counts[val] > maxCount) {
      maxCount = counts[val];
      modeInterval = val;
    }
  }
  return modeInterval;
};

const detectRetainerTimingOffsetUi = (allInvoiceDates, jobStartDate, intervalMonths) => {
  const dates = (allInvoiceDates || []).filter(Boolean);
  if (dates.length === 0 || !jobStartDate) return "during";
  const interval = intervalMonths || 1;
  if (dates.length === 1) {
    const firstPeriodStart = new Date(jobStartDate.getFullYear(), jobStartDate.getMonth(), 1);
    const firstPeriodEnd = new Date(jobStartDate.getFullYear(), jobStartDate.getMonth() + interval, 0, 23, 59, 59);
    if (dates[0].getTime() < firstPeriodStart.getTime()) return "before";
    if (dates[0].getTime() > firstPeriodEnd.getTime()) return "after";
    return "during";
  }
  let beforeVotes = 0;
  let duringVotes = 0;
  let afterVotes = 0;
  dates.forEach((sent, i) => {
    const total = jobStartDate.getFullYear() * 12 + jobStartDate.getMonth() + i * interval;
    const y = Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    const periodStart = new Date(y, m, 1);
    const periodEnd = new Date(y, m + interval, 0, 23, 59, 59);
    if (sent.getTime() < periodStart.getTime()) beforeVotes++;
    else if (sent.getTime() > periodEnd.getTime()) afterVotes++;
    else duringVotes++;
  });
  const total = beforeVotes + duringVotes + afterVotes;
  if (total === 0) return "during";
  if (beforeVotes / total >= 2 / 3) return "before";
  if (afterVotes / total >= 2 / 3) return "after";
  return "during";
};

/**
 * Optimistically projects retainer child rows when a retainer's end date is changed in the UI,
 * mirroring `executeChangeRetainerEndDate` so the invoice placeholder list updates immediately.
 */
export const projectRetainerRowsForEndDate = (job, targetEndDateVal, overrideRevenueVal) => {
  if (!job || !Array.isArray(job.rows) || job.rows.length === 0) return job?.rows || [];
  const parentRow = job.rows[0];
  const childRows = job.rows.slice(1);
  const oldEndDate = parseSheetDate(parentRow.endDate);
  const newEnd = isNoEndDateSentinel(targetEndDateVal) ? new Date(2050, 11, 31) : parseSheetDate(targetEndDateVal);
  if (!newEnd) return job.rows;

  const startDate = parseSheetDate(parentRow.startDate);
  const childDates = childRows.map((cr) => parseSheetDate(cr.invoiceSlots?.[0]?.sentDate)).filter(Boolean);
  const intervalMonths = detectRetainerIntervalMonthsUi(childDates);
  const invoiceTimingOffset = detectRetainerTimingOffsetUi(childDates, startDate, intervalMonths);
  const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

  const isGrowing = !oldEndDate || newEnd > oldEndDate;

  if (!isGrowing) {
    const newEndVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
    let anchorIdx = -1;
    let anchorPeriodMonthVal = null;
    for (let k = 0; k < childRows.length; k++) {
      const slot0 = childRows[k].invoiceSlots?.[0];
      const d = parseSheetDate(slot0?.sentDate);
      const ref = String(slot0?.ref ?? "").trim();
      if (d && ref && !isPlaceholderInvoice(ref, slot0?.status)) {
        anchorIdx = k;
        anchorPeriodMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
        break;
      }
    }
    if (anchorIdx === -1 && !startDate) {
      for (let k = 0; k < childRows.length; k++) {
        const d = parseSheetDate(childRows[k].invoiceSlots?.[0]?.sentDate);
        if (d) {
          anchorIdx = k;
          anchorPeriodMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
          break;
        }
      }
    }

    const trimIndices = new Set();
    for (let c = childRows.length - 1; c >= 0; c--) {
      const cr = childRows[c];
      const invDate = parseSheetDate(cr.invoiceSlots?.[0]?.sentDate);
      let rowMonthVal = invDate ? (invDate.getFullYear() * 12 + invDate.getMonth() + timingMonthAdjust) : null;
      if (rowMonthVal === null && !uiRetainerRowHasRealData(cr)) {
        if (anchorIdx !== -1 && anchorPeriodMonthVal !== null) {
          rowMonthVal = anchorPeriodMonthVal + (c - anchorIdx) * intervalMonths;
        } else if (startDate) {
          rowMonthVal = startDate.getFullYear() * 12 + startDate.getMonth() + c * intervalMonths;
        }
      }
      if (rowMonthVal !== null && rowMonthVal > newEndVal) {
        trimIndices.add(c);
      } else {
        break;
      }
    }

    if (trimIndices.size === 0) return job.rows;
    // Mirror backend safety: if any candidate row has real invoice/expense data, trim is blocked.
    for (const idx of trimIndices) {
      if (uiRetainerRowHasRealData(childRows[idx])) return job.rows;
    }
    const keptChildren = childRows.filter((_, idx) => !trimIndices.has(idx));
    return [parentRow, ...keptChildren];
  }

  // Growing: mirror executeChangeRetainerEndDate 18-month future runway + contract end / value caps
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
  const pastCount = childDates.filter((d) => (d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust) <= currentMonthVal).length;
  const targetCount = pastCount + 18;
  if (childRows.length >= targetCount) return job.rows;

  const parseMoney = (v) => parseFloat(String(v ?? "").replace(/[£$€,\s]/g, "")) || 0;
  const revenue = overrideRevenueVal !== undefined ? parseMoney(overrideRevenueVal) : parseMoney(parentRow.revenue);
  const totalInvoiced =
    childRows.reduce((sum, cr) => sum + Math.max(0, parseMoney(cr.invoiceSlots?.[0]?.amount) - parseMoney(cr.invoiceSlots?.[0]?.ofWhichRechgd)), 0) +
    Math.max(0, parseMoney(parentRow.invoiceSlots?.[0]?.amount) - parseMoney(parentRow.invoiceSlots?.[0]?.ofWhichRechgd));
  const diffDays = Math.round(Math.abs(newEnd.getTime() - (startDate || newEnd).getTime()) / 86400000);
  const durationMonths = Math.max(1, Math.round(diffDays / 30.4375));
  const totalContractValue = durationMonths * revenue;

  const sendDay = childDates.length > 0 ? childDates[childDates.length - 1].getDate() : 28;
  let lastDate;
  if (childDates.length > 0) {
    lastDate = childDates[childDates.length - 1];
  } else {
    const baseStart = startDate || newEnd;
    const prevMonth = new Date(baseStart.getFullYear(), baseStart.getMonth() - 1, 1);
    const maxDayPrev = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
    lastDate = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), Math.min(sendDay, maxDayPrev));
  }

  const rowsNeeded = targetCount - childRows.length;
  const newRowDates = [];
  let simulatedTotal = totalInvoiced;
  const endVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
  for (let k = 0; k < rowsNeeded; k++) {
    const monthOffset = (k + 1) * intervalMonths;
    const targetMonthFirst = new Date(lastDate.getFullYear(), lastDate.getMonth() + monthOffset, 1);
    const testVal = targetMonthFirst.getFullYear() * 12 + targetMonthFirst.getMonth();
    if ((testVal + timingMonthAdjust) > endVal) break;
    if ((simulatedTotal + revenue) > (totalContractValue + 1.00)) break;
    const maxDaysInMonth = new Date(targetMonthFirst.getFullYear(), targetMonthFirst.getMonth() + 1, 0).getDate();
    const nextTestDate = new Date(targetMonthFirst.getFullYear(), targetMonthFirst.getMonth(), Math.min(sendDay, maxDaysInMonth));
    simulatedTotal += revenue;
    newRowDates.push(nextTestDate);
  }

  if (newRowDates.length === 0) return job.rows;

  const defaultDays = childRows[0]?.invoiceSlots?.[0]?.daysToPay || "30";
  const formattedAmount = revenue > 0 ? formatCurrency(revenue) : (parentRow.revenue || "");
  const syntheticChildren = newRowDates.map((d, idx) => ({
    rowNum: -(idx + 1),
    isParent: false,
    isOptimisticPlaceholder: true,
    tabName: parentRow.tabName || job.tabName || "Confirmed",
    client: parentRow.client || job.client || "",
    jobName: parentRow.jobName || job.jobName || "",
    vat: parentRow.vat || "",
    likelihood: "100%",
    invoiceSlots: [
      {
        slotNum: 1,
        amount: formattedAmount,
        ref: "",
        sentDate: toSheetDateFormat(d),
        daysToPay: String(defaultDays),
        status: "",
      },
    ],
    expenseSlots: [],
  }));

  return [parentRow, ...childRows, ...syntheticChildren];
};

const pendingTextareaResizes = new Set();
let resizeBatchScheduled = false;

function scheduleTextareaResize(el) {
  if (!el) return;
  pendingTextareaResizes.add(el);
  if (!resizeBatchScheduled) {
    resizeBatchScheduled = true;
    const flush = () => {
      resizeBatchScheduled = false;
      const elements = Array.from(pendingTextareaResizes);
      pendingTextareaResizes.clear();
      const connected = [];
      for (let i = 0; i < elements.length; i++) {
        const node = elements[i];
        if (node && node.isConnected) {
          node.style.height = "auto";
          connected.push(node);
        }
      }
      const heights = new Array(connected.length);
      for (let i = 0; i < connected.length; i++) {
        heights[i] = Math.max(26, connected[i].scrollHeight);
      }
      for (let i = 0; i < connected.length; i++) {
        connected[i].style.height = `${heights[i]}px`;
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      Promise.resolve().then(flush);
    }
  }
}

function AutoResizeTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  isDirty,
  isSearchMatch = false,
  style = {},
  ...props
}) {
  const textareaRef = useRef(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const str = value !== null && value !== undefined ? String(value) : "";
    if (!str.includes("\n") && str.length <= 18) {
      el.style.height = "26px";
      return undefined;
    }
    scheduleTextareaResize(el);
    return () => {
      pendingTextareaResizes.delete(el);
    };
  }, [value]);

  const restBg = isSearchMatch ? "#fefce8" : "transparent";
  const restBorder = isDirty ? "1px solid #f59e0b" : isSearchMatch ? "1px solid #fde047" : "1px solid transparent";
  const restBorderColor = isDirty ? "#f59e0b" : isSearchMatch ? "#fde047" : "transparent";

  return (
    <textarea
      ref={textareaRef}
      value={value}
      rows={1}
      onChange={(e) => {
        if (onChange) onChange(e);
        e.target.style.height = "auto";
        e.target.style.height = `${Math.max(26, e.target.scrollHeight)}px`;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.target.blur();
        }
        if (onKeyDown) onKeyDown(e);
      }}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "4px 6px",
        borderRadius: "5px",
        border: restBorder,
        background: restBg,
        fontSize: "13px",
        outline: "none",
        boxSizing: "border-box",
        resize: "none",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        fontFamily: "inherit",
        lineHeight: "1.35",
        display: "block",
        minHeight: "26px",
        fieldSizing: "content",
        ...style
      }}
      onFocus={(e) => {
        e.target.style.background = "#ffffff";
        e.target.style.borderColor = "#3b82f6";
      }}
      onBlur={(e) => {
        e.target.style.background = restBg;
        e.target.style.borderColor = restBorderColor;
      }}
      {...props}
    />
  );
}

export default function JobsView({
  allOutgoingsClients,
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient,
  isAdmin: propIsAdmin
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth?.user?.isReadOnly && !!(auth?.user?.isAdmin || auth?.user?.role === "Admin"));
  const isSysAdmin = Boolean(!auth?.user?.isReadOnly && (auth?.user?.isAdmin || auth?.user?.role === "Admin"));
  const { outgoingsPullPendingRef, assignedAppIds, setAssignedAppIds } = useAppGlobals();

  const {
    jobsClient, setJobsClient,
    jobsTab, setJobsTab,
    jobsSortBy, setJobsSortBy,
    jobsData, setJobsData,
    jobsLoading, setJobsLoading,
    jobsLoadError,
    jobsExpanded, setJobsExpanded,
    jobsEditSplit, setJobsEditSplit,
    productLines,
    leadSources,
    existingClients,
    hasAccountingIntegration,
    crmTool,
    crmDrives,
    clientMode,
    splitEnabled,
    jobsLastUpdatedAt,
    noEndDateRetainerMonths,
    loadJobsData
  } = useJobs(managedClient || initialClient);

  const [showPullFromSheetConfirm, setShowPullFromSheetConfirm] = useState(false);
  const [pullingFromSheet, setPullingFromSheet] = useState(false);
  const [assignModalConfig, setAssignModalConfig] = useState(null); // null | { itemType, job }
  const [retainersEditJob, setRetainersEditJob] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState("all");
  const [sortByRelevance, setSortByRelevance] = useState(true);
  const hasActiveSearch = Boolean(searchQuery.trim());

  useEffect(() => {
    if (!hasActiveSearch) {
      setSortByRelevance(true);
    }
  }, [hasActiveSearch]);

  const toggleJobsSort = (colBase, defaultDir = "asc") => {
    const ascKey = colBase === "clientName" ? "clientName" : colBase === "rowNumber" ? "rowNumber" : `${colBase}Asc`;
    const descKey = colBase === "clientName" ? "clientDesc" : colBase === "rowNumber" ? "rowNumberDesc" : `${colBase}Desc`;
    if (searchQuery.trim()) {
      setSortByRelevance(false);
    }
    setJobsSortBy((prev) => (prev === ascKey ? descKey : prev === descKey ? ascKey : (defaultDir === "desc" ? descKey : ascKey)));
  };

  const renderSortableTh = ({ label, colBase, defaultDir = "asc", style = {}, title = undefined }) => {
    const ascKey = colBase === "clientName" ? "clientName" : colBase === "rowNumber" ? "rowNumber" : `${colBase}Asc`;
    const descKey = colBase === "clientName" ? "clientDesc" : colBase === "rowNumber" ? "rowNumberDesc" : `${colBase}Desc`;
    const isAsc = jobsSortBy === ascKey || (colBase === "clientName" && jobsSortBy === "clientAsc");
    const isDesc = jobsSortBy === descKey;
    const isRelevanceOverride = Boolean(searchQuery.trim() && sortByRelevance);
    const isActive = (isAsc || isDesc) && !isRelevanceOverride;
    const arrow = isAsc ? "▲" : isDesc ? "▼" : "⇅";
    return (
      <th
        key={colBase}
        onClick={() => toggleJobsSort(colBase, defaultDir)}
        title={title || `Sort by ${label}`}
        style={{
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
          color: isActive ? "#1d4ed8" : isRelevanceOverride ? "#64748b" : style.color,
          ...style,
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: "10px", marginLeft: "4px", color: isActive ? "#1d4ed8" : isRelevanceOverride ? "#cbd5e1" : "#94a3b8" }}>{arrow}</span>
      </th>
    );
  };

  const prevInitialClientRef = useRef(null);
  const prevManagedClientRef = useRef(null);
  // Auto-select managedClient when in manage mode, or initialClient when passed, or clear when manage mode cancelled
  useEffect(() => {
    if (managedClient) {
      const currentName = managedClient.clientName?.toLowerCase();
      const hasFullClient = Boolean(jobsClient?.clientSheetId);
      const clientWithSheet = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName && c.clientSheetId) || (managedClient.clientSheetId ? managedClient : null);
      if (prevManagedClientRef.current !== currentName || (!hasFullClient && clientWithSheet)) {
        prevManagedClientRef.current = currentName;
        const clientObj = clientWithSheet || (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName) || managedClient;
        setJobsClient(clientObj);
        if (clientObj?.clientSheetId) {
          loadJobsData(clientObj, "All");
        }
      }
    } else if (initialClient && (initialClient !== prevInitialClientRef.current || (!jobsClient?.clientSheetId && initialClient.clientSheetId))) {
      prevInitialClientRef.current = initialClient;
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === initialClient.clientName?.toLowerCase()) || initialClient;
      setJobsClient(clientObj);
      if (clientObj?.clientSheetId) {
        loadJobsData(clientObj, "All");
      }
    } else if (prevManagedClientRef.current) {
      prevManagedClientRef.current = null;
      setJobsClient(null);
      setJobsData(null);
      setDraftEdits({});
      recentlyDeletedJobKeysRef.current.clear();
      recentlyDeletedJobRowsRef.current.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedClient, initialClient, allOutgoingsClients, jobsClient?.clientSheetId]);

  const handlePullJobsFromSheet = async () => {
    if (!isSysAdmin || !jobsClient?.clientName || pullingFromSheet) return;
    setPullingFromSheet(true);
    setActionError(null);
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed_client_sheet", clientName: jobsClient.clientName }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to pull latest jobs from sheet");
      }
      setShowPullFromSheetConfirm(false);
      await loadJobsData(jobsClient, "All", true);
    } catch (e) {
      setActionError(e.message || "Failed to pull latest jobs from sheet");
    } finally {
      setPullingFromSheet(false);
    }
  };

  // Mode: "modern" (default, user-friendly combined view) or "legacy" (spreadsheet view for admins)
  const [viewMode, setViewMode] = useState("modern");
  const effectiveViewMode = isAdmin ? viewMode : "modern";

  // Modern view filter: 'all' | 'confirmed' | 'pipeline'
  const [filterType, setFilterType] = useState("all");
  const [showZeroPercentJobs, setShowZeroPercentJobs] = useState(false);
  const [visibleJobsCount, setVisibleJobsCount] = useState(80);
  const loadMoreJobsSentinelRef = useRef(null);

  // Set of expanded job IDs in modern view
  const [expandedJobIds, setExpandedJobIds] = useState(() => new Set());

  // Draft edits keyed by job identifier: { [jobKey]: { [field]: newValue } }
  const [draftEdits, setDraftEdits] = useState({});
  const draftEditsRef = useRef(draftEdits);
  draftEditsRef.current = draftEdits;
  const [rechargedToggleByKey, setRechargedToggleByKey] = useState({});

  // Loading / saving states
  const [savingJobKeys, setSavingJobKeys] = useState(() => new Set());
  const savingJobKeysRef = useRef(savingJobKeys);
  savingJobKeysRef.current = savingJobKeys;
  const jobsLastUpdatedAtRef = useRef(jobsLastUpdatedAt);
  jobsLastUpdatedAtRef.current = jobsLastUpdatedAt;
  const jobsLoadingRef = useRef(jobsLoading);
  jobsLoadingRef.current = jobsLoading;
  const pullingFromSheetRef = useRef(pullingFromSheet);
  pullingFromSheetRef.current = pullingFromSheet;
  const jobsClientRef = useRef(jobsClient);
  jobsClientRef.current = jobsClient;
  const jobsClientSheetId = jobsClient?.clientSheetId || "";

  // Silently revalidate jobs when user returns to the tab/window after >30s
  // with no active edits or in-flight saves.
  useEffect(() => {
    if (!jobsClientSheetId) return undefined;
    const handleFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") {
        return;
      }
      const activeClient = jobsClientRef.current;
      if (!activeClient?.clientSheetId) return;
      if (jobsLoadingRef.current || pullingFromSheetRef.current) return;
      if (savingJobKeysRef.current && savingJobKeysRef.current.size > 0) return;
      if (Object.keys(draftEditsRef.current || {}).length > 0) return;
      const lastTs = jobsLastUpdatedAtRef.current ? new Date(jobsLastUpdatedAtRef.current).getTime() : 0;
      if (Date.now() - lastTs < 30000) return;
      const targetTab = effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All";
      loadJobsData(activeClient, targetTab, true);
    };
    window.addEventListener("focus", handleFocusOrVisible);
    document.addEventListener("visibilitychange", handleFocusOrVisible);
    return () => {
      window.removeEventListener("focus", handleFocusOrVisible);
      document.removeEventListener("visibilitychange", handleFocusOrVisible);
    };
  }, [jobsClientSheetId, effectiveViewMode, jobsTab, loadJobsData]);
  const [confirmingJobKeys, setConfirmingJobKeys] = useState(() => new Set());
  const [markingAlreadyConfirmedKeys, setMarkingAlreadyConfirmedKeys] = useState(() => new Set());
  const [deletingJobKeys, setDeletingJobKeys] = useState(() => new Set());
  const [deletingJob, setDeletingJob] = useState(null);
  const [movingInvoicesForDelete, setMovingInvoicesForDelete] = useState(false);
  const [deleteJobMoveSearch, setDeleteJobMoveSearch] = useState("");
  const [targetJobForMoveDelete, setTargetJobForMoveDelete] = useState(null);
  const [movingInvoiceThenDeleteLoading, setMovingInvoiceThenDeleteLoading] = useState(false);
  const [recentlySavedKeys, setRecentlySavedKeys] = useState(() => new Set());
  const [actionError, setActionError] = useState(null);

  const deletingJobRealInvoices = useMemo(() => {
    if (!deletingJob?.rows) return [];
    const list = [];
    deletingJob.rows.forEach((r) => {
      (r.invoiceSlots || []).forEach((sl) => {
        if (sl.ref && !isPlaceholderInvoice(sl.ref, sl.status)) {
          list.push({
            ...sl,
            rowNum: r.rowNum,
            slotNum: sl.slotNum,
            client: r.client || deletingJob.client,
            jobName: r.jobName || deletingJob.jobName
          });
        }
      });
    });
    return list;
  }, [deletingJob]);

  // Set of recently deleted job identifiers (jobKeys and tab+rowNum) to prevent stale Google Sheets API reads from restoring deleted jobs
  const recentlyDeletedJobKeysRef = useRef(new Set());
  const recentlyDeletedJobRowsRef = useRef(new Map()); // tabName -> Set of row numbers

  // Modals state
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);
  const [showAddJobModal, setShowAddJobModal] = useState(false);
  const [newJobModalInitialData, setNewJobModalInitialData] = useState(null);
  const [crmWarningPrompt, setCrmWarningPrompt] = useState(null);
  const [cellNoteModalConfig, setCellNoteModalConfig] = useState(null);

  const openJobNoteModal = (job) => {
    const parentRow = job.rows?.[0] || {};
    const tabName = job.tabName || parentRow.tabName || "Confirmed";
    const currentNote = job.note || parentRow.note || "";
    setCellNoteModalConfig({
      isOpen: true,
      title: "Job note",
      subtitle: `${job.client || parentRow.client || ""} · ${job.jobName || parentRow.jobName || ""}${isAdmin ? ` (${tabName} Row ${parentRow.rowNum})` : ""}`,
      initialNote: currentNote,
      tabName,
      sheetRow: parentRow.rowNum,
      colLetter: "A",
      onSaveSuccess: (savedNote) => {
        setJobsData((prev) => {
          if (!prev) return prev;
          return prev.map((j) => {
            if (getJobKey(j) === getJobKey(job)) {
              const updatedRows = (j.rows || []).map((r, rIdx) =>
                rIdx === 0 ? { ...r, note: savedNote } : r
              );
              return { ...j, note: savedNote, rows: updatedRows };
            }
            return j;
          });
        });
      }
    });
  };

  const openSlotNoteModal = ({ item, type, job }) => {
    const rowNum = item.rowNum;
    const slotNum = item.slotNum;
    const tabName = item.row?.tabName || job?.tabName || "Confirmed";
    const colLetter = type === "invoice"
      ? (slotNum === 1 ? "AP" : slotNum === 2 ? "AW" : "BD")
      : (slotNum === 1 ? "BX" : slotNum === 2 ? "CE" : "CL");
    const currentNote = item.slot?.note || "";

    const invRefDisplay = item.slot?.ref ? `#${item.slot.ref}` : (item.label || "Invoice");
    setCellNoteModalConfig({
      isOpen: true,
      title: type === "invoice" ? `Invoice note (${invRefDisplay})` : `Direct cost note (${item.label})`,
      subtitle: `${job?.client || ""} · ${job?.jobName || ""}${isAdmin ? ` (${tabName} Row ${rowNum})` : ""}`,
      initialNote: currentNote,
      tabName,
      sheetRow: rowNum,
      colLetter,
      onSaveSuccess: (savedNote) => {
        setJobsData((prev) => {
          if (!prev) return prev;
          return prev.map((j) => {
            if (getJobKey(j) === getJobKey(job)) {
              const updatedRows = (j.rows || []).map((r) => {
                if (r.rowNum === rowNum) {
                  if (type === "invoice") {
                    const nextInvoiceSlots = (r.invoiceSlots || []).map((s) =>
                      s.slotNum === slotNum ? { ...s, note: savedNote } : s
                    );
                    return { ...r, invoiceSlots: nextInvoiceSlots };
                  } else {
                    const nextExpenseSlots = (r.expenseSlots || []).map((s) =>
                      s.slotNum === slotNum ? { ...s, note: savedNote } : s
                    );
                    return { ...r, expenseSlots: nextExpenseSlots };
                  }
                }
                return r;
              });
              return { ...j, rows: updatedRows };
            }
            return j;
          });
        });
      }
    });
  };

  const handleSaveCellNote = async (newNote) => {
    if (!cellNoteModalConfig || !jobsClient?.clientSheetId) return;
    const { tabName, sheetRow, colLetter, onSaveSuccess } = cellNoteModalConfig;
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_cell_note",
        clientSheetId: jobsClient.clientSheetId,
        clientName: jobsClient.clientName || "",
        tab: tabName,
        sheetRow,
        colLetter,
        note: newNote,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || "Failed to update cell note");
    }
    if (onSaveSuccess) onSaveSuccess(newNote);
  };

  const handleAddNewInvoicePlaceholder = (job) => {
    if (!job) return;
    const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
    const parentRow = job.rows?.[0] || job;
    const metrics = getJobFinancialMetrics(job, isRetainer, filterType !== "pipeline", undefined, undefined, noEndDateRetainerMonths);

    let targetRowNum = null;
    let targetSlotNum = null;
    let createNewRow = false;

    for (const r of (job.rows || [])) {
      const slots = r.invoiceSlots || [];
      for (let sNum = 1; sNum <= 3; sNum++) {
        const existing = slots.find((s) => s.slotNum === sNum);
        const isOccupied = existing && Boolean(
          (existing.ref && String(existing.ref).trim() !== "") ||
          (existing.amount && String(existing.amount).trim() !== "") ||
          isPlaceholderInvoice(existing.ref, existing.status)
        );
        if (!isOccupied) {
          targetRowNum = r.rowNum;
          targetSlotNum = sNum;
          break;
        }
      }
      if (targetRowNum) break;
    }

    if (!targetRowNum) {
      const lastRow = job.rows?.[job.rows.length - 1];
      targetRowNum = lastRow ? lastRow.rowNum : (job.rowNum || 2);
      targetSlotNum = 1;
      createNewRow = true;
    }

    const defaultAmt = metrics.leftToInvoice > 0 ? String(metrics.leftToInvoice) : "";
    const defaultRef = "";

    setInvoicesEditSlot({
      rowNum: targetRowNum,
      slotNum: targetSlotNum,
      createNewRow,
      isNewPlaceholder: true,
      slot: {
        ref: defaultRef,
        amount: defaultAmt,
        status: "",
        sentDate: "",
        daysToPay: 30
      },
      jobClient: parentRow.client || job.client,
      jobName: parentRow.jobName || job.jobName,
      slotLabel: "New placeholder",
      tabName: parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
      job
    });
  };

  const handleAddNewExpensePlaceholder = (job) => {
    if (!job) return;
    const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
    const parentRow = job.rows?.[0] || job;
    const metrics = getJobFinancialMetrics(job, isRetainer, filterType !== "pipeline", undefined, undefined, noEndDateRetainerMonths);

    let targetRowNum = null;
    let targetSlotNum = null;
    let createNewRow = false;

    for (const r of (job.rows || [])) {
      const slots = r.expenseSlots || [];
      for (let sNum = 1; sNum <= 3; sNum++) {
        const existing = slots.find((s) => s.slotNum === sNum);
        const isOccupied = existing && Boolean(
          (existing.description && String(existing.description).trim() !== "") ||
          (existing.amount && String(existing.amount).trim() !== "") ||
          (existing.transactionId && String(existing.transactionId).trim() !== "") ||
          isPlaceholderExpense(existing)
        );
        if (!isOccupied) {
          targetRowNum = r.rowNum;
          targetSlotNum = sNum;
          break;
        }
      }
      if (targetRowNum) break;
    }

    if (!targetRowNum) {
      const lastRow = job.rows?.[job.rows.length - 1];
      targetRowNum = lastRow ? lastRow.rowNum : (job.rowNum || 2);
      targetSlotNum = 1;
      createNewRow = true;
    }

    const defaultAmt = metrics.costsLeftToReceive > 0 ? String(metrics.costsLeftToReceive) : "";
    const defaultDesc = "Direct cost placeholder";

    setDirectCostsEditSlot({
      rowNum: targetRowNum,
      slotNum: targetSlotNum,
      createNewRow,
      isNewPlaceholder: true,
      slot: {
        description: defaultDesc,
        amount: defaultAmt,
        vat: "Yes",
        date: "",
        daysToPay: 30,
        status: "",
        transactionId: ""
      },
      jobName: parentRow.jobName || job.jobName,
      jobClient: parentRow.client || job.client,
      slotLabel: "New placeholder",
      tabName: parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
      job
    });
  };

  const noJobsClient = !jobsClient && !managedClient;

  // Toggle expand for a job in modern view
  const toggleJobExpanded = (jobKey) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobKey)) next.delete(jobKey);
      else next.add(jobKey);
      return next;
    });
  };

  // Expand a job row (without collapsing if already open) and scroll to a specific card section
  const expandAndFocusJobSection = (jobKey, section) => {
    setExpandedJobIds((prev) => {
      if (prev.has(jobKey)) return prev;
      const next = new Set(prev);
      next.add(jobKey);
      return next;
    });
    if (section && typeof document !== "undefined") {
      setTimeout(() => {
        const el = document.getElementById(`pma-job-card-${jobKey}-${section}`);
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }, 60);
    }
  };

  // Helper to extract a job key
  const getJobKey = useCallback((job) => {
    if (!job) return "";
    return job.id || `${job.tabName || "confirmed"}_${job.rows?.[0]?.rowNum || 0}`;
  }, []);

  // Check if a specific job has unsaved changes
  const isJobDirty = (jobKey) => {
    return Boolean(draftEdits[jobKey] && Object.keys(draftEdits[jobKey]).length > 0);
  };

  // Helper to check if a job belongs to Pipeline
  const isPipelineJob = useCallback((job) => {
    if (!job) return false;
    const tab = String(job.tabName || job.status || job.rows?.[0]?.tabName || "").toLowerCase();
    return tab === "pipeline" || tab.includes("pipe");
  }, []);

  // Helper to check if a pipeline job was copied to Confirmed tab (Column DD == "Yes")
  const isJobCopiedToConfirmed = useCallback((job) => {
    if (!job || !isPipelineJob(job)) return false;
    const parentRow = job.rows?.[0] || {};
    const copiedVal = String(job.copiedToConf || parentRow.copiedToConf || "").trim().toLowerCase();
    return copiedVal === "yes" || copiedVal === "y";
  }, [isPipelineJob]);

  // Helper to check if a pipeline job has 0% likelihood
  const isJobZeroPercent = useCallback((job) => {
    if (!job || !isPipelineJob(job)) return false;
    const jobKey = getJobKey(job);
    // If the user has an active draft edit on this job, keep it visible while editing so they can save
    const hasDraft = draftEdits[jobKey]?.likelihood !== undefined;
    if (hasDraft) return false;

    const parentRow = job.rows?.[0] || {};
    const lVal = parseLikelihoodValue(parentRow.likelihood ?? job.likelihood);
    return lVal !== null && lVal === 0;
  }, [isPipelineJob, getJobKey, draftEdits]);

  // Get field value (from draft if edited, otherwise from sheet data)
  const getJobFieldValue = useCallback((job, fieldKey) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0] || {};
    if (draftEdits[jobKey] && draftEdits[jobKey][fieldKey] !== undefined) {
      return draftEdits[jobKey][fieldKey];
    }
    const raw = parentRow[fieldKey] !== undefined ? parentRow[fieldKey] : "";
    if ((fieldKey === "revenue" || fieldKey === "directCosts") && raw !== "" && raw !== null && raw !== undefined) {
      return formatCurrency(raw);
    }
    if (fieldKey === "likelihood" && raw !== "" && raw !== null && raw !== undefined) {
      return formatLikelihood(raw);
    }
    return raw;
  }, [getJobKey, draftEdits]);

  // Helper to extract parsed Date Confirmed timestamp for a job on Confirmed tab
  const getJobDateConfTs = useCallback((job) => {
    if (!job) return null;
    const tab = String(job.tabName || job.status || job.rows?.[0]?.tabName || "Confirmed").toLowerCase();
    const isConfirmed = tab === "confirmed" || (!tab.includes("pipeline") && !tab.includes("pipe"));
    if (!isConfirmed) return null;
    const rawVal = getJobFieldValue(job, "dateConf") || job.dateConf || job.rows?.[0]?.dateConf;
    return rawVal ? parseSheetDateToTs(rawVal) : null;
  }, [getJobFieldValue]);

  // Check if at least one confirmed job has a non-empty Date Confirmed
  const hasDateConfirmed = useMemo(() => {
    if (!jobsData || !Array.isArray(jobsData)) return false;
    return jobsData.some((j) => {
      const tab = String(j.tabName || j.status || j.rows?.[0]?.tabName || "Confirmed").toLowerCase();
      const isConfirmed = tab === "confirmed" || (!tab.includes("pipeline") && !tab.includes("pipe"));
      if (!isConfirmed) return false;
      const rawVal = getJobFieldValue(j, "dateConf") || j.dateConf || j.rows?.[0]?.dateConf;
      const s = String(rawVal || "").trim();
      return s !== "" && s !== "-" && s !== "—";
    });
  }, [jobsData, getJobFieldValue]);

  // Update a single draft field for a job
  const handleDraftFieldChange = (job, fieldKey, newValue) => {
    const jobKey = getJobKey(job);
    setDraftEdits((prev) => ({
      ...prev,
      [jobKey]: {
        ...(prev[jobKey] || {}),
        [fieldKey]: newValue
      }
    }));
  };

  // Discard draft edits for a job
  const handleDiscardChanges = (job) => {
    const jobKey = getJobKey(job);
    setDraftEdits((prev) => {
      const next = { ...prev };
      delete next[jobKey];
      return next;
    });
  };

  // KeyDown handler to exit edit mode on Escape (undoing draft change) or Enter (blurring)
  const handleFieldKeyDown = (e, job, fieldKey) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const jobKey = getJobKey(job);
      setDraftEdits((prev) => {
        if (!prev[jobKey] || prev[jobKey][fieldKey] === undefined) return prev;
        const jobDraft = { ...prev[jobKey] };
        delete jobDraft[fieldKey];
        const next = { ...prev };
        if (Object.keys(jobDraft).length === 0) {
          delete next[jobKey];
        } else {
          next[jobKey] = jobDraft;
        }
        return next;
      });
      if (e.target && typeof e.target.blur === "function") {
        e.target.blur();
      }
    } else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
      e.target.blur();
    }
  };

  // Helper to persist non-excluded draft fields to the current tab row before moving tabs
  const saveJobFieldsDirect = async (job, fieldsToExclude = []) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    if (!parentRow || !isJobDirty(jobKey)) return;

    const currentDraft = draftEdits[jobKey] || {};
    const tabName = job.tabName || parentRow.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed");
    const parentRowNum = parentRow.rowNum;

    if (
      (!fieldsToExclude.includes("startDate") && currentDraft.startDate !== undefined) ||
      (!fieldsToExclude.includes("endDate") && currentDraft.endDate !== undefined)
    ) {
      const effStart = !fieldsToExclude.includes("startDate") && currentDraft.startDate !== undefined
        ? currentDraft.startDate
        : (parentRow.startDate || "");
      const effEnd = !fieldsToExclude.includes("endDate") && currentDraft.endDate !== undefined
        ? currentDraft.endDate
        : (parentRow.endDate || "");
      const isRet = String(
        (!fieldsToExclude.includes("projectRetainer") && currentDraft.projectRetainer !== undefined)
          ? currentDraft.projectRetainer
          : (parentRow.projectRetainer || "")
      ).toLowerCase().includes("retainer");
      const startIsFormula = typeof effStart === "string" && effStart.trim().startsWith("=");
      const endIsFormula = typeof effEnd === "string" && effEnd.trim().startsWith("=");
      if (!startIsFormula && !endIsFormula) {
        const dateCheck = validateDateRange(effStart, effEnd, {
          allowNoEndDate: isRet && isNoEndDateSentinel(effEnd),
          requireStart: false,
          requireEnd: false,
        });
        if (!dateCheck.valid) {
          throw new Error(dateCheck.error || "End date cannot be earlier than start date.");
        }
      }
    }

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
      likelihood: { colLetter: "AN", fieldName: "Likelihood" },
      ...(tabName === "Confirmed" ? { rechargedExpenses: { colLetter: "R", fieldName: "Recharged expenses" } } : {})
    };

    const updates = [];
    Object.keys(currentDraft).forEach((fieldKey) => {
      if (fieldsToExclude.includes(fieldKey)) return;
      const meta = FIELD_MAP[fieldKey];
      if (!meta) return;
      let val = currentDraft[fieldKey];
      if (meta.isDate && val) {
        val = toSheetDateFormat(val);
      } else if (fieldKey === "likelihood") {
        val = normalizeLikelihoodInput(val);
      }
      updates.push({
        colLetter: meta.colLetter,
        rowNum: parentRowNum,
        cellRef: `${meta.colLetter}${parentRowNum}`,
        fieldName: meta.fieldName,
        value: val
      });

      if ((fieldKey === "client" || fieldKey === "jobName") && job.rows && job.rows.length > 1) {
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

    if (updates.length > 0) {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId: jobsClient?.clientSheetId,
          clientName: jobsClient?.clientName || jobsClient?.name || "",
          tabName,
          rowNum: parentRowNum,
          ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
          endClientName: currentDraft.client || parentRow.client || job.client,
          jobName: currentDraft.jobName || parentRow.jobName || job.jobName,
          updates
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update job fields");
      }
    }
  };

  // Confirm a Pipeline job (moves to Confirmed tab)
  const handleConfirmJob = async (job) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    if (!parentRow || !jobsClient?.clientSheetId) return;

    if (isCrmDeal(job, crmTool, crmDrives)) {
      setActionError(`Cannot confirm deal: Status must be updated directly in ${getCrmDisplayName(crmTool)}.`);
      return;
    }

    const pipelineRowNum = parentRow.rowNum;
    if (!pipelineRowNum || pipelineRowNum < 2) return;

    setConfirmingJobKeys((prev) => new Set(prev).add(jobKey));
    setActionError(null);

    try {
      // 1. If non-likelihood fields are modified, save them first to Pipeline
      if (isJobDirty(jobKey)) {
        await saveJobFieldsDirect(job, ["likelihood"]);
      }

      // 2. Call confirm endpoint
      const res = await fetch("/api/portal/confirm-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          pipelineRow: pipelineRowNum,
          ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
        })
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to confirm job");
      }

      // 3. Clear draft for this job
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });

      // 4. Optimistically update local jobsData to mark confirmed
      setJobsData((prev) => {
        if (!prev || !Array.isArray(prev)) return prev;
        return prev.map((j) => {
          if (getJobKey(j) !== jobKey) return j;
          const confRowNum = resData.confirmedRow || resData.rowNumber || j.rows?.[0]?.rowNum;
          return {
            ...j,
            status: "Confirmed",
            tabName: "Confirmed",
            type: "Confirmed",
            likelihood: "100%",
            copiedToConf: "Yes",
            rows: (j.rows || []).map((r, idx) => ({
              ...r,
              status: "Confirmed",
              tabName: "Confirmed",
              type: "Confirmed",
              likelihood: "100%",
              copiedToConf: "Yes",
              rowNum: idx === 0 && confRowNum ? confRowNum : r.rowNum,
            })),
          };
        });
      });

      // 5. Reload jobs data in background without blocking UI
      loadJobsData(jobsClient, "All", true);
      if (resData.backgroundProvisioning) {
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 4000);
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 8000);
      }
    } catch (err) {
      console.error("Confirm job error:", err);
      setActionError(`Failed to confirm ${job.jobName || "job"}: ${err.message}`);
    } finally {
      setConfirmingJobKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Unconfirm a Confirmed job (moves to Pipeline tab)
  const handleUnconfirmJob = async (job, optionalLikelihood) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    if (!parentRow || !jobsClient?.clientSheetId) return;

    const confirmedRowNum = parentRow.rowNum;
    if (!confirmedRowNum || confirmedRowNum < 2) return;

    if (jobHasActualInvoicesOrExpenses(job)) {
      setActionError(`Cannot unconfirm ${job.jobName || "job"}: Actual invoices or expenses are assigned to this job.`);
      return;
    }

    setConfirmingJobKeys((prev) => new Set(prev).add(jobKey));
    setActionError(null);

    try {
      // 1. If non-likelihood fields are modified, save them first to Confirmed
      if (isJobDirty(jobKey)) {
        await saveJobFieldsDirect(job, ["likelihood"]);
      }

      const currentDraft = draftEdits[jobKey] || {};
      const rawTargetLikelihood = optionalLikelihood || currentDraft.likelihood;
      const targetLikelihood = rawTargetLikelihood ? normalizeLikelihoodInput(rawTargetLikelihood) : "";

      const payload = {
        clientSheetId: jobsClient.clientSheetId,
        clientName: jobsClient.clientName || jobsClient.name || "",
        confirmedRow: confirmedRowNum,
        ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
      };
      if (targetLikelihood) {
        payload.likelihood = targetLikelihood;
      }

      const res = await fetch("/api/portal/unconfirm-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to unconfirm job");
      }

      // Clear draft for this job
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });

      // Optimistically update local jobsData to mark as unconfirmed/pipeline
      setJobsData((prev) => {
        if (!prev || !Array.isArray(prev)) return prev;
        return prev.map((j) => {
          if (getJobKey(j) !== jobKey) return j;
          const pipeRowNum = resData.pipelineRow || resData.rowNumber || j.rows?.[0]?.rowNum;
          return {
            ...j,
            status: "Pipeline",
            tabName: "Pipeline",
            type: "Pipeline",
            likelihood: targetLikelihood || "50%",
            copiedToConf: "No",
            rows: (j.rows || []).map((r, idx) => ({
              ...r,
              status: "Pipeline",
              tabName: "Pipeline",
              type: "Pipeline",
              likelihood: targetLikelihood || "50%",
              copiedToConf: "No",
              rowNum: idx === 0 && pipeRowNum ? pipeRowNum : r.rowNum,
            })),
          };
        });
      });

      // Reload jobs data in background without blocking UI
      loadJobsData(jobsClient, "All", true, true);
    } catch (err) {
      console.error("Unconfirm job error:", err);
      setActionError(`Failed to unconfirm ${job.jobName || "job"}: ${err.message}`);
    } finally {
      setConfirmingJobKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Mark a Pipeline job as already confirmed (sets likelihood to 100% and Copied to confirmed to Yes)
  const handleMarkAlreadyConfirmed = async (job) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    if (!parentRow || !jobsClient?.clientSheetId) return;

    if (isCrmDeal(job, crmTool, crmDrives)) {
      setActionError(`Cannot mark deal as confirmed: Status must be updated directly in ${getCrmDisplayName(crmTool)}.`);
      return;
    }

    const pipelineRowNum = parentRow.rowNum;
    if (!pipelineRowNum || pipelineRowNum < 2) return;

    setMarkingAlreadyConfirmedKeys((prev) => new Set(prev).add(jobKey));
    setActionError(null);

    try {
      // Collect any pending non-likelihood draft edits on this job to save along with marking confirmed
      const currentDraft = draftEdits[jobKey] || {};
      const updates = [];
      const FIELD_MAP = {
        client: { colLetter: "A" },
        jobName: { colLetter: "B" },
        projectCode: { colLetter: "C" },
        dateConf: { colLetter: "D", isDate: true },
        leadSrc: { colLetter: "E" },
        revenue: { colLetter: "AG" },
        directCosts: { colLetter: "AH" },
        vat: { colLetter: "AI" },
        projectRetainer: { colLetter: "AJ" },
        prodLine: { colLetter: "AK" },
        startDate: { colLetter: "AL", isDate: true },
        endDate: { colLetter: "AM", isDate: true },
      };

      Object.keys(currentDraft).forEach((fieldKey) => {
        if (fieldKey === "likelihood") return;
        const meta = FIELD_MAP[fieldKey];
        if (!meta) return;
        let val = currentDraft[fieldKey];
        if (meta.isDate && val) val = toSheetDateFormat(val);
        updates.push({
          cellRef: `${meta.colLetter}${pipelineRowNum}`,
          value: val,
        });
      });

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mark_pipeline_already_confirmed",
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          jobName: currentDraft.jobName || parentRow.jobName || job.jobName,
          endClientName: currentDraft.client || parentRow.client || job.client,
          rowNum: pipelineRowNum,
          ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
          updates,
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to mark job as already confirmed");
      }

      // Clear draft for this job
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });

      // Optimistically update local jobsData to mark as copied to confirmed
      setJobsData((prev) => {
        if (!prev) return prev;
        return prev.map((j) => {
          if (getJobKey(j) !== jobKey) return j;
          return {
            ...j,
            copiedToConf: "Yes",
            rows: (j.rows || []).map((r) => ({ ...r, copiedToConf: "Yes", likelihood: "100%" }))
          };
        });
      });

      // Reload jobs data in background without blocking UI
      loadJobsData(jobsClient, "All", true, true);
    } catch (err) {
      console.error("Mark already confirmed error:", err);
      setActionError(`Failed to mark ${job.jobName || "job"} as already confirmed: ${err.message}`);
    } finally {
      setMarkingAlreadyConfirmedKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Delete a job entirely by clearing the relevant cells on the row
  const handleDeleteJobDirect = async (job) => {
    if (!job || !jobsClient?.clientSheetId) return;
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    const rowNums = (job.rows && job.rows.length > 0)
      ? job.rows.map((r) => r.rowNum).filter((n) => n && n >= 2)
      : [parentRow?.rowNum].filter((n) => n && n >= 2);

    if (rowNums.length === 0) return;

    const tabName = job.tabName || parentRow?.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed");
    const tabLower = tabName.toLowerCase();

    // 1. Record in tombstone refs (scoped by row + client + jobName) to defend against stale Google Sheets API reads
    const delSig = `${Number(parentRow?.rowNum || rowNums[0])}:${String(parentRow?.client || job.client || "").trim().toLowerCase()}:${String(parentRow?.jobName || job.jobName || "").trim().toLowerCase()}`;
    recentlyDeletedJobKeysRef.current.add(delSig);
    if (!recentlyDeletedJobRowsRef.current.has(tabLower)) {
      recentlyDeletedJobRowsRef.current.set(tabLower, new Set());
    }
    rowNums.forEach((rn) => recentlyDeletedJobRowsRef.current.get(tabLower).add(`${Number(rn)}:${String(parentRow?.client || job.client || "").trim().toLowerCase()}:${String(parentRow?.jobName || job.jobName || "").trim().toLowerCase()}`));

    setDeletingJobKeys((prev) => new Set(prev).add(jobKey));
    setActionError(null);

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_direct_job",
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          tabName,
          rowNums,
          ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
          jobName: parentRow?.jobName || job.jobName || "",
          endClientName: parentRow?.client || job.client || "",
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to delete job");
      }

      // Remove job from local jobsData state and close modal
      setJobsData((prev) => {
        if (!prev || !Array.isArray(prev)) return prev;
        return prev.filter((j) => {
          const k = getJobKey(j);
          if (k === jobKey || j.id === jobKey || j.id === job.id) return false;
          const jTab = (j.tabName || j.rows?.[0]?.tabName || "").toLowerCase();
          const jRow = Number(j.rows?.[0]?.rowNum);
          if (jTab === tabLower && rowNums.map(Number).includes(jRow)) return false;
          return true;
        });
      });
      setExpandedJobIds((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });
      setDeletingJob(null);

      if (resData.unassignedInvoices && resData.unassignedInvoices.length > 0) {
        const unassignedRefs = new Set(resData.unassignedInvoices.map(inv => String(inv.invoiceNo || "").trim().toLowerCase()));
        if (setAssignedAppIds) {
          setAssignedAppIds((prev) => {
            const next = new Set(prev);
            unassignedRefs.forEach((ref) => {
              next.delete(ref);
            });
            return next;
          });
        }
        if (jobsClient?.masterSheetId) {
          outgoingsPullPendingRef.current = jobsClient.masterSheetId;
        }
      }

      // Reload jobs data from server in background without blocking UI
      loadJobsData(jobsClient, "All", true, true);
    } catch (err) {
      console.error("Delete job error:", err);
      setActionError(`Failed to delete ${job.jobName || "job"}: ${err.message}`);
      setDeletingJob(null);
      // Re-sync with server if error occurred
      await loadJobsData(jobsClient, "All", true, true);
    } finally {
      setDeletingJobKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Move real invoices to another job, then delete the original job
  const handleMoveInvoicesThenDelete = async (targetJob) => {
    if (!deletingJob || !targetJob) return;
    setMovingInvoiceThenDeleteLoading(true);
    try {
      const realInvoices = deletingJobRealInvoices;
      for (const inv of realInvoices) {
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "move_invoice_to_job",
            clientSheetId: jobsClient.clientSheetId,
            masterSheetId: jobsClient.masterSheetId || "",
            tabName: deletingJob.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
            sourceRowNum: inv.rowNum,
            sourceSlotNum: inv.slotNum,
            sourceJobClient: inv.client || deletingJob.client,
            sourceJobName: inv.jobName || deletingJob.jobName,
            invoiceRef: inv.ref,
            targetJobClient: targetJob.client,
            targetJobName: targetJob.jobName,
            createNewRow: true,
            targetJobLastRow: targetJob.rows?.[targetJob.rows.length - 1]?.rowNum,
            invoice: {
              invoiceNo: inv.ref,
              amount: parseFloat(stripCurrency(inv.amount)) || 0,
              sentDate: inv.sentDate || "",
              daysToPay: parseInt(inv.daysToPay, 10) || 30,
              status: inv.status || ""
            }
          })
        });
      }
      setMovingInvoicesForDelete(false);
      await handleDeleteJobDirect(deletingJob);
    } catch (err) {
      console.error("Error moving invoices then deleting:", err);
      alert("Failed to move invoices before deleting: " + err.message);
    } finally {
      setMovingInvoiceThenDeleteLoading(false);
    }
  };

  const handleDuplicateJobClick = (job) => {
    if (isCrmDeal(job, crmTool, crmDrives)) {
      setCrmWarningPrompt({ type: "duplicate", job });
      return;
    }
    applyDuplicateJob(job);
  };

  const handleRenewalJobClick = (job) => {
    if (isCrmDeal(job, crmTool, crmDrives)) {
      setCrmWarningPrompt({ type: "renewal", job });
      return;
    }
    applyRenewalJob(job);
  };

  const applyDuplicateJob = (job) => {
    if (!job) return;
    const parentRow = job?.rows?.[0] || job;
    const jobKey = getJobKey(job);
    const draft = draftEdits[jobKey] || {};

    const clientVal = draft.client !== undefined ? draft.client : (parentRow.client || job.client || "");
    const jobNameVal = draft.jobName !== undefined ? draft.jobName : (parentRow.jobName || job.jobName || "");
    const typeVal = draft.projectRetainer !== undefined ? draft.projectRetainer : (parentRow.projectRetainer || job.projectRetainer || "Project");
    const isRetainer = String(typeVal).toLowerCase().includes("retainer");
    const revVal = draft.revenue !== undefined ? draft.revenue : (parentRow.revenue !== undefined ? parentRow.revenue : job.revenue);
    const dcVal = draft.directCosts !== undefined ? draft.directCosts : (parentRow.directCosts !== undefined ? parentRow.directCosts : job.directCosts);
    const startDateVal = draft.startDate !== undefined ? draft.startDate : (parentRow.startDate || job.startDate || "");
    const endDateVal = draft.endDate !== undefined ? draft.endDate : (parentRow.endDate || job.endDate || "");
    const hasNoEndDate = Boolean(isNoEndDateSentinel(endDateVal) || (isRetainer && (draft.noEndDate || job.noEndDate)));

    const newJobName = generateDuplicateJobName(jobNameVal);
    const numRevenue = stripCurrency(revVal);
    const numDirectCosts = stripCurrency(dcVal);

    setNewJobModalInitialData({
      client: clientVal,
      jobName: newJobName,
      projectRetainer: isRetainer ? "Retainer" : "Project",
      status: "Confirmed",
      likelihood: "100%",
      revenue: numRevenue !== "" ? (parseFloat(numRevenue) || 0).toFixed(2) : "0.00",
      directCosts: numDirectCosts !== "" ? (parseFloat(numDirectCosts) || 0).toFixed(2) : "0.00",
      startDate: toInputDateFormat(startDateVal),
      endDate: hasNoEndDate ? "" : toInputDateFormat(endDateVal),
      noEndDate: hasNoEndDate,
      leadSource: parentRow.leadSrc || job.leadSrc || "",
      productLine: parentRow.prodLine || job.prodLine || "",
      vat: parentRow.vat || job.vat || "Yes",
      projectCode: "",
      modalTitle: "Add new job (duplicated)"
    });
    setShowAddJobModal(true);
  };

  const applyRenewalJob = (job) => {
    if (!job) return;
    const parentRow = job?.rows?.[0] || job;
    const jobKey = getJobKey(job);
    const draft = draftEdits[jobKey] || {};

    const clientVal = draft.client !== undefined ? draft.client : (parentRow.client || job.client || "");
    const jobNameVal = draft.jobName !== undefined ? draft.jobName : (parentRow.jobName || job.jobName || "");
    const revVal = draft.revenue !== undefined ? draft.revenue : (parentRow.revenue !== undefined ? parentRow.revenue : job.revenue);
    const dcVal = draft.directCosts !== undefined ? draft.directCosts : (parentRow.directCosts !== undefined ? parentRow.directCosts : job.directCosts);
    const startDateVal = draft.startDate !== undefined ? draft.startDate : (parentRow.startDate || job.startDate || "");
    const endDateVal = draft.endDate !== undefined ? draft.endDate : (parentRow.endDate || job.endDate || "");

    const dates = calculateRenewalDates(startDateVal, endDateVal);
    if (!dates) {
      setActionError("Cannot create a renewal for a retainer job without an end date.");
      return;
    }

    const renewalName = generateRenewalJobName(jobNameVal, dates.renewalStartDate);
    const numRevenue = stripCurrency(revVal);
    const numDirectCosts = stripCurrency(dcVal);

    setNewJobModalInitialData({
      client: clientVal,
      jobName: renewalName,
      projectRetainer: "Retainer",
      status: "Pipeline",
      likelihood: "50%",
      revenue: numRevenue !== "" ? (parseFloat(numRevenue) || 0).toFixed(2) : "0.00",
      directCosts: numDirectCosts !== "" ? (parseFloat(numDirectCosts) || 0).toFixed(2) : "0.00",
      startDate: dates.startDateISO,
      endDate: dates.endDateISO,
      noEndDate: false,
      leadSource: parentRow.leadSrc || job.leadSrc || "",
      productLine: parentRow.prodLine || job.prodLine || "",
      vat: parentRow.vat || job.vat || "Yes",
      projectCode: "",
      modalTitle: "Add renewal in pipeline"
    });
    setShowAddJobModal(true);
  };

  // Save changes for a single job (with automatic confirm/unconfirm triggers when likelihood is edited)
  const handleSaveJob = async (job) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0];
    if (!parentRow || !isJobDirty(jobKey)) return;

    const currentDraft = draftEdits[jobKey] || {};
    const tabName = job.tabName || parentRow.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed");
    const isConfirmed = tabName.toLowerCase() === "confirmed";

    // Auto-trigger confirm/unconfirm if likelihood changed across the 100% threshold
    if (currentDraft.likelihood !== undefined) {
      const parsedL = parseLikelihoodValue(currentDraft.likelihood);
      if (!isConfirmed && parsedL !== null && parsedL >= 100) {
        if (isCrmDeal(job, crmTool, crmDrives)) {
          setActionError(`Cannot promote deal to Confirmed: Status must be updated directly in ${getCrmDisplayName(crmTool)}.`);
          return;
        }
        // Pipeline job changed to 100% -> Confirm Job!
        return await handleConfirmJob(job);
      }
      if (isConfirmed && parsedL !== null && parsedL < 100) {
        if (jobHasActualInvoicesOrExpenses(job)) {
          setActionError(`Cannot unconfirm ${job.jobName || "job"} because it has actual invoices or expenses assigned to it.`);
          return;
        }
        // Confirmed job changed to < 100% -> Unconfirm Job!
        return await handleUnconfirmJob(job, currentDraft.likelihood);
      }
    }

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
      likelihood: { colLetter: "AN", fieldName: "Likelihood" },
      ...(tabName === "Confirmed" ? { rechargedExpenses: { colLetter: "R", fieldName: "Recharged expenses" } } : {})
    };

    if (tabName === "Confirmed" && currentDraft.rechargedExpenses !== undefined) {
      const parseAmt = (v) => parseFloat(String(v ?? "").replace(/[£$€,\s]/g, "")) || 0;
      const newRechNum = Math.max(0, Math.round(parseAmt(currentDraft.rechargedExpenses) * 100) / 100);
      const effRevNum = parseAmt(currentDraft.revenue !== undefined ? currentDraft.revenue : parentRow?.revenue);
      let nonAutoRechgdSum = 0;
      let nonAutoGrossSum = 0;
      (job.rows || []).forEach((r) => {
        (r.invoiceSlots || []).forEach((sl) => {
          const refStr = String(sl.ref || "").trim();
          const amt = parseAmt(sl.amount);
          const rech = parseAmt(sl.ofWhichRechgd);
          const isAuto = refStr.toUpperCase().startsWith("PLACE-INV-");
          const isEmpty = !refStr && Math.abs(amt) < 0.005 && Math.abs(rech) < 0.005;
          if (!isAuto && !isEmpty) {
            nonAutoRechgdSum += rech;
            nonAutoGrossSum += amt;
          }
        });
      });
      const remainingForAuto = (effRevNum + newRechNum) - nonAutoGrossSum;
      if (nonAutoRechgdSum > newRechNum + 0.01 || (remainingForAuto <= 0.01 && Math.abs(nonAutoRechgdSum - newRechNum) > 0.01)) {
        const msg = `Invoice 'of which recharged' amounts (${formatCurrency(nonAutoRechgdSum)}) must add up to total recharged expenses (${formatCurrency(newRechNum)}). Please adjust the invoices first.`;
        setActionError(msg);
        alert(msg);
        return;
      }
    }

    if (currentDraft.startDate !== undefined || currentDraft.endDate !== undefined) {
      const effStart = currentDraft.startDate !== undefined ? currentDraft.startDate : (parentRow.startDate || "");
      const effEnd = currentDraft.endDate !== undefined ? currentDraft.endDate : (parentRow.endDate || "");
      const isRet = String(
        currentDraft.projectRetainer !== undefined ? currentDraft.projectRetainer : (parentRow.projectRetainer || "")
      ).toLowerCase().includes("retainer");
      const startIsFormula = typeof effStart === "string" && effStart.trim().startsWith("=");
      const endIsFormula = typeof effEnd === "string" && effEnd.trim().startsWith("=");
      if (!startIsFormula && !endIsFormula) {
        const dateCheck = validateDateRange(effStart, effEnd, {
          allowNoEndDate: isRet && isNoEndDateSentinel(effEnd),
          requireStart: false,
          requireEnd: false,
        });
        if (!dateCheck.valid) {
          const msg = dateCheck.error || "End date cannot be earlier than start date.";
          setActionError(msg);
          alert(msg);
          return;
        }
      }
    }

    const updates = [];
    Object.keys(currentDraft).forEach((fieldKey) => {
      const meta = FIELD_MAP[fieldKey];
      if (!meta) return;
      let val = currentDraft[fieldKey];
      if (meta.isDate && val) {
        val = toSheetDateFormat(val);
      } else if (fieldKey === "likelihood") {
        val = normalizeLikelihoodInput(val);
      }
      updates.push({
        colLetter: meta.colLetter,
        rowNum: parentRowNum,
        cellRef: `${meta.colLetter}${parentRowNum}`,
        fieldName: meta.fieldName,
        value: val
      });

      // If client name, job name, or VAT changed, also update child rows to keep sheet synchronized
      if ((fieldKey === "client" || fieldKey === "jobName" || fieldKey === "vat") && job.rows && job.rows.length > 1) {
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

    setActionError(null);
    setSavingJobKeys((prev) => new Set(prev).add(jobKey));

    const parentTypeVal = currentDraft.projectRetainer !== undefined
      ? currentDraft.projectRetainer
      : (parentRow.projectRetainer || job.projectRetainer || "");
    const isRetainerJob = String(parentTypeVal).trim().toLowerCase().includes("retainer");
    const isRetainerEndDateEdit = isConfirmed && isRetainerJob && currentDraft.endDate !== undefined;
    const preSaveJobSnapshot = isRetainerEndDateEdit ? job : null;
    const preSaveDraftSnapshot = isRetainerEndDateEdit ? { ...currentDraft } : null;

    const applyDraftFieldsToJob = (baseJob, baseRows, invUpdatesMap, expUpdatesMap) => {
      const updatedRows = baseRows.map((r, rIdx) => {
        const nextRow = { ...r };
        Object.keys(currentDraft).forEach((f) => {
          let nextVal = currentDraft[f];
          if (FIELD_MAP[f]?.isDate && nextVal) nextVal = toSheetDateFormat(nextVal);
          if ((f === "revenue" || f === "directCosts" || f === "rechargedExpenses") && nextVal !== "" && nextVal !== null && nextVal !== undefined) {
            nextVal = formatCurrency(nextVal);
          }
          if (f === "likelihood" && nextVal !== "" && nextVal !== null && nextVal !== undefined) {
            nextVal = normalizeLikelihoodInput(nextVal);
          }
          if (rIdx === 0 || f === "client" || f === "jobName" || f === "vat") {
            nextRow[f] = nextVal;
          }
        });
        if (invUpdatesMap && invUpdatesMap.size > 0 && Array.isArray(nextRow.invoiceSlots)) {
          nextRow.invoiceSlots = nextRow.invoiceSlots.map((sl) => {
            const match = invUpdatesMap.get(`${r.rowNum}_${sl.slotNum}`);
            return match ? { ...sl, ...match } : sl;
          });
        }
        if (expUpdatesMap && expUpdatesMap.size > 0 && Array.isArray(nextRow.expenseSlots)) {
          nextRow.expenseSlots = nextRow.expenseSlots.map((sl) => {
            const match = expUpdatesMap.get(`${r.rowNum}_${sl.slotNum}`);
            return match ? { ...sl, ...match } : sl;
          });
        }
        return nextRow;
      });
      return {
        ...baseJob,
        client: currentDraft.client || baseJob.client,
        jobName: currentDraft.jobName || baseJob.jobName,
        projectCode: currentDraft.projectCode !== undefined ? currentDraft.projectCode : baseJob.projectCode,
        rows: updatedRows
      };
    };

    // Optimistically reflect retainer end-date placeholder changes on screen immediately
    // before the backend row add/trim finishes.
    if (isRetainerEndDateEdit) {
      const projectedRows = projectRetainerRowsForEndDate(
        job,
        currentDraft.endDate,
        currentDraft.revenue
      );
      setJobsData((prevJobs) => {
        if (!prevJobs) return prevJobs;
        return prevJobs.map((j) =>
          getJobKey(j) === jobKey ? applyDraftFieldsToJob(j, projectedRows, null, null) : j
        );
      });
      setDraftEdits((prev) => {
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId: jobsClient.clientSheetId,
          masterSheetId: jobsClient.masterSheetId || "",
          clientName: jobsClient.clientName || jobsClient.name || "",
          tabName,
          rowNum: parentRowNum,
          ...(job.jobUuid ? { jobUuid: job.jobUuid } : {}),
          isRetainer: isRetainerJob,
          endClientName: currentDraft.client || parentRow.client || job.client,
          jobName: currentDraft.jobName || parentRow.jobName || job.jobName,
          updates
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update job");
      }

      // Reconcile local jobsData with exact server updates (trimmed rows & newly provisioned child rows)
      const invUpdatesMap = new Map();
      (data.invoiceSlotUpdates || []).forEach((u) => {
        invUpdatesMap.set(`${u.rowNum}_${u.slotNum}`, {
          ...u,
          amount: u.amount !== "" && u.amount !== undefined && u.amount !== null ? formatCurrency(u.amount) : ""
        });
      });
      const expUpdatesMap = new Map();
      (data.expenseSlotUpdates || []).forEach((u) => {
        expUpdatesMap.set(`${u.rowNum}_${u.slotNum}`, {
          ...u,
          amount: u.amount !== "" && u.amount !== undefined && u.amount !== null ? formatCurrency(u.amount) : ""
        });
      });

      const trimmedSet = new Set((data.trimmedRowNums || []).map((n) => Number(n)));

      setJobsData((prevJobs) => {
        if (!prevJobs) return prevJobs;
        return prevJobs.map((j) => {
          if (getJobKey(j) !== jobKey) return j;
          // When we applied an optimistic retainer projection, reconcile against the pre-save rows
          // so any temporary placeholder rows are replaced with the authoritative server rows.
          const sourceRows = preSaveJobSnapshot ? preSaveJobSnapshot.rows : j.rows;
          const filteredRows = (sourceRows || []).filter(
            (r, rIdx) => !r.isOptimisticPlaceholder && (rIdx === 0 || !trimmedSet.has(Number(r.rowNum)))
          );
          const reconciled = applyDraftFieldsToJob(j, filteredRows, invUpdatesMap, expUpdatesMap);

          if (Array.isArray(data.addedChildRows) && data.addedChildRows.length > 0) {
            const existingNums = new Set(reconciled.rows.map((r) => Number(r.rowNum)));
            const parentUpdated = reconciled.rows[0] || {};
            const formattedAdded = data.addedChildRows
              .filter((ar) => !existingNums.has(Number(ar.rowNum)))
              .map((ar) => ({
                ...ar,
                client: parentUpdated.client || ar.client || "",
                jobName: parentUpdated.jobName || ar.jobName || "",
                vat: parentUpdated.vat || ar.vat || "",
                invoiceSlots: (ar.invoiceSlots || []).map((sl) => ({
                  ...sl,
                  amount: sl.amount !== "" && sl.amount !== undefined && sl.amount !== null ? formatCurrency(sl.amount) : "",
                })),
              }));
            if (formattedAdded.length > 0) {
              const parentOnly = reconciled.rows.slice(0, 1);
              const childrenCombined = [...reconciled.rows.slice(1), ...formattedAdded].sort(
                (a, b) => Number(a.rowNum) - Number(b.rowNum)
              );
              reconciled.rows = [...parentOnly, ...childrenCombined];
            }
          }

          return reconciled;
        });
      });

      // Clear draft for this job
      setDraftEdits((prev) => {
        if (!prev[jobKey]) return prev;
        const next = { ...prev };
        delete next[jobKey];
        return next;
      });

      // Show brief success badge
      setRecentlySavedKeys((prev) => new Set(prev).add(jobKey));
      setTimeout(() => {
        setRecentlySavedKeys((prev) => {
          const next = new Set(prev);
          next.delete(jobKey);
          return next;
        });
      }, 3000);

      if (data.backgroundProvisioning) {
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 4000);
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 8000);
      }
    } catch (err) {
      console.error("Save job failed:", err);
      if (preSaveJobSnapshot) {
        setJobsData((prevJobs) => {
          if (!prevJobs) return prevJobs;
          return prevJobs.map((j) => (getJobKey(j) === jobKey ? preSaveJobSnapshot : j));
        });
      }
      if (preSaveDraftSnapshot) {
        setDraftEdits((prev) => ({ ...prev, [jobKey]: preSaveDraftSnapshot }));
      }
      setActionError(`Save failed for ${job.jobName || "job"}: ${err.message}`);
    } finally {
      setSavingJobKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Base matched jobs and filter pill counts computed in a single pass
  const { baseMatchedJobs, counts } = useMemo(() => {
    if (!jobsData || !Array.isArray(jobsData)) {
      return { baseMatchedJobs: [], counts: { all: 0, confirmed: 0, pipeline: 0 } };
    }
    const hasSearch = Boolean(searchQuery.trim());
    const matched = [];
    let conf = 0;
    let pipe = 0;

    for (let i = 0; i < jobsData.length; i++) {
      const j = jobsData[i];
      const jTab = (j.tabName || j.rows?.[0]?.tabName || "").toLowerCase();
      const jRowNum = Number(j.rows?.[0]?.rowNum);
      const jClient = String(j.rows?.[0]?.client || j.client || "").trim().toLowerCase();
      const jName = String(j.rows?.[0]?.jobName || j.jobName || "").trim().toLowerCase();
      const sig = `${jRowNum}:${jClient}:${jName}`;
      if (recentlyDeletedJobKeysRef.current.has(sig)) continue;
      if (jTab && jRowNum && recentlyDeletedJobRowsRef.current.get(jTab)?.has(sig)) continue;

      // Exclude pipeline jobs copied to confirmed tab (Column DD == "Yes")
      if (isJobCopiedToConfirmed(j)) continue;

      const isPipe = isPipelineJob(j);

      // Exclude 0% likelihood pipeline jobs unless showZeroPercentJobs is true
      if (isPipe && !showZeroPercentJobs && isJobZeroPercent(j)) continue;

      // Filter by search query across selected scope (using cached structured search index)
      if (hasSearch && !isJobMatchSearch(j, searchQuery, draftEdits, searchScope)) continue;

      matched.push(j);
      if (isPipe) pipe++;
      else conf++;
    }

    if (effectiveViewMode !== "modern") {
      return {
        baseMatchedJobs: matched,
        counts: { all: conf + pipe, confirmed: conf, pipeline: pipe }
      };
    }

    // Group Confirmed [VarRetainer] monthly rows into a single series row in modern view
    const finalMatched = [];
    const varSeriesOrder = [];
    const varSeriesMap = Object.create(null);

    for (const j of matched) {
      if (!isPipelineJob(j) && j.isVariableRetainer) {
        const meta = j.varRetainerMeta || {};
        const clientStr = String(j.rows?.[0]?.client || j.client || "").trim();
        const rawJobStr = String(j.rows?.[0]?.jobName || j.jobName || "").trim();
        const seriesName = meta.seriesName || rawJobStr.replace(/\s*-\s*[A-Za-z]{3}\s+\d{4}$/, "").trim();
        const k = `${clientStr.toLowerCase()}||${seriesName.toLowerCase()}`;
        if (!varSeriesMap[k]) {
          varSeriesMap[k] = [];
          varSeriesOrder.push(k);
        }
        varSeriesMap[k].push(j);
      } else {
        finalMatched.push(j);
      }
    }

    let groupedConf = finalMatched.filter((x) => !isPipelineJob(x)).length;
    for (const k of varSeriesOrder) {
      const mList = varSeriesMap[k];
      mList.sort((a, b) => (parseSheetDateToTs(a.rows?.[0]?.startDate) || 0) - (parseSheetDateToTs(b.rows?.[0]?.startDate) || 0));
      const firstM = mList[0];
      const lastM = mList[mList.length - 1];
      const firstParent = firstM.rows?.[0] || {};
      const lastParent = lastM.rows?.[0] || {};
      const meta = lastM.varRetainerMeta || firstM.varRetainerMeta || {};
      const seriesName = meta.seriesName || String(firstParent.jobName || firstM.jobName || "").replace(/\s*-\s*[A-Za-z]{3}\s+\d{4}$/, "").trim();
      const baseRevNum = Number(meta.baseRev ?? parseFloat(stripCurrency(firstParent.revenue))) || 0;
      const baseDcNum = Number(meta.baseDC ?? parseFloat(stripCurrency(firstParent.directCosts))) || 0;
      const monthRows = mList.map((m) => {
        const p = m.rows?.[0] || {};
        return {
          ...p,
          isRevOverridden: Boolean(m.varRetainerMeta?.overrideRev),
          isDcOverridden: Boolean(m.varRetainerMeta?.overrideDc),
          varRetainerMeta: m.varRetainerMeta,
          expenseSlots: (m.rows || []).flatMap((rr) => (rr.expenseSlots || []).map((es) => ({ ...es, rowNum: rr.rowNum }))),
        };
      });
      const baseRevFormatted = `£${baseRevNum.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const baseDcFormatted = `£${baseDcNum.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const seriesEndDate = meta.noEndDate ? NO_END_DATE_SHEET_VALUE : (meta.endDate || lastParent.endDate || "");
      const summaryParentRow = {
        ...firstParent,
        jobName: seriesName,
        revenue: baseRevFormatted,
        directCosts: baseDcFormatted,
        startDate: firstParent.startDate || "",
        endDate: seriesEndDate,
        likelihood: "100%",
        projectRetainer: "Retainer",
      };

      finalMatched.push({
        id: `varret_${firstParent.rowNum || 0}_${seriesName}`,
        tabName: "Confirmed",
        client: firstParent.client || firstM.client,
        jobName: seriesName,
        seriesName,
        projectCode: firstParent.projectCode || "",
        projectRetainer: "Retainer",
        revenue: baseRevFormatted,
        directCosts: baseDcFormatted,
        baseRevenue: baseRevNum,
        baseDirectCosts: baseDcNum,
        sendDay: meta.sendDay || 28,
        startDate: firstParent.startDate || "",
        endDate: seriesEndDate,
        noEndDate: Boolean(meta.noEndDate),
        vat: firstParent.vat || "Yes",
        likelihood: "100%",
        parentRowNum: firstParent.rowNum,
        isVariableRetainer: true,
        isVariableRetainerSeries: true,
        varRetainerMeta: meta,
        varSeriesMonths: monthRows,
        rows: [summaryParentRow, ...monthRows.slice(1)],
      });
      groupedConf++;
    }

    return {
      baseMatchedJobs: finalMatched,
      counts: { all: groupedConf + pipe, confirmed: groupedConf, pipeline: pipe }
    };
  }, [jobsData, showZeroPercentJobs, draftEdits, searchQuery, searchScope, isJobCopiedToConfirmed, isJobZeroPercent, isPipelineJob, effectiveViewMode]);

  // Filtered and sorted jobs list
  const processedJobs = useMemo(() => {
    if (!baseMatchedJobs.length) return [];
    let list = baseMatchedJobs;

    // 1. Filter by Confirmed / Pipeline in modern view
    if (effectiveViewMode === "modern") {
      if (filterType === "confirmed") {
        list = list.filter((j) => {
          const tab = String(j.tabName || j.status || j.rows?.[0]?.tabName || "").toLowerCase();
          return tab === "confirmed" || (!tab.includes("pipeline") && j.rows?.[0]?.likelihood === "100%");
        });
      } else if (filterType === "pipeline") {
        list = list.filter((j) => {
          const tab = String(j.tabName || j.status || j.rows?.[0]?.tabName || "").toLowerCase();
          return tab === "pipeline" || tab.includes("pipe");
        });
      } else {
        list = [...list];
      }
    } else {
      // In legacy view, filter by jobsTab ("Confirmed" or "Pipeline" or "All")
      if (jobsTab && jobsTab.toLowerCase() !== "all") {
        const targetTabLower = jobsTab.toLowerCase();
        list = list.filter((j) => {
          const tab = String(j.tabName || j.status || j.rows?.[0]?.tabName || "Confirmed").toLowerCase();
          return tab === targetTabLower;
        });
      } else {
        list = [...list];
      }
    }

    // 2. Sort jobs (always using persisted row values, never unsaved draftEdits; blank dates always sort last)
    const compareDateTsBlankLast = (tsA, tsB, asc) => {
      if (tsA === null && tsB === null) return 0;
      if (tsA === null) return 1;
      if (tsB === null) return -1;
      return asc ? tsA - tsB : tsB - tsA;
    };
    const parseMoneyVal = (v) => parseFloat(String(v || "0").replace(/[£$€,\s]/g, "")) || 0;

    const useRelevanceSort = Boolean(searchQuery.trim() && sortByRelevance);
    const relevanceScores = useRelevanceSort ? new Map() : null;
    if (relevanceScores) {
      for (let i = 0; i < list.length; i++) {
        relevanceScores.set(list[i], getJobSearchScore(list[i], searchQuery, searchScope));
      }
    }

    return list.sort((a, b) => {
      if (relevanceScores) {
        const scoreDiff = (relevanceScores.get(b) || 0) - (relevanceScores.get(a) || 0);
        if (scoreDiff !== 0) return scoreDiff;
      }

      const rowA = a.rows?.[0] || {};
      const rowB = b.rows?.[0] || {};
      const tieRow = () => (rowA.rowNum || 0) - (rowB.rowNum || 0);

      switch (jobsSortBy) {
        case "statusAsc":
        case "statusDesc": {
          const sA = String(a.tabName || rowA.tabName || "Confirmed").trim();
          const sB = String(b.tabName || rowB.tabName || "Confirmed").trim();
          const cmp = jobsSortBy === "statusAsc" ? sA.localeCompare(sB) : sB.localeCompare(sA);
          return cmp !== 0 ? cmp : compareDateTsBlankLast(parseSheetDateToTs(rowA.startDate), parseSheetDateToTs(rowB.startDate), false);
        }
        case "startDateAsc": {
          const cmp = compareDateTsBlankLast(parseSheetDateToTs(rowA.startDate), parseSheetDateToTs(rowB.startDate), true);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "endDateDesc": {
          const cmp = compareDateTsBlankLast(parseSheetDateToTs(rowA.endDate), parseSheetDateToTs(rowB.endDate), false);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "endDateAsc": {
          const cmp = compareDateTsBlankLast(parseSheetDateToTs(rowA.endDate), parseSheetDateToTs(rowB.endDate), true);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "dateConfDesc": {
          const cmp = compareDateTsBlankLast(getJobDateConfTs(a), getJobDateConfTs(b), false);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "dateConfAsc": {
          const cmp = compareDateTsBlankLast(getJobDateConfTs(a), getJobDateConfTs(b), true);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "revDesc": {
          const diff = parseMoneyVal(rowB.revenue) - parseMoneyVal(rowA.revenue);
          return diff !== 0 ? diff : tieRow();
        }
        case "revAsc": {
          const diff = parseMoneyVal(rowA.revenue) - parseMoneyVal(rowB.revenue);
          return diff !== 0 ? diff : tieRow();
        }
        case "costsDesc": {
          const diff = parseMoneyVal(rowB.directCosts) - parseMoneyVal(rowA.directCosts);
          return diff !== 0 ? diff : tieRow();
        }
        case "costsAsc": {
          const diff = parseMoneyVal(rowA.directCosts) - parseMoneyVal(rowB.directCosts);
          return diff !== 0 ? diff : tieRow();
        }
        case "clientName":
        case "clientAsc":
        case "clientDesc": {
          const nameA = String(a.client || rowA.client || "").trim();
          const nameB = String(b.client || rowB.client || "").trim();
          const cmp = jobsSortBy === "clientDesc"
            ? nameB.localeCompare(nameA, undefined, { sensitivity: "base", numeric: true })
            : nameA.localeCompare(nameB, undefined, { sensitivity: "base", numeric: true });
          if (cmp !== 0) return cmp;
          const jobA = String(a.jobName || rowA.jobName || "").trim();
          const jobB = String(b.jobName || rowB.jobName || "").trim();
          return jobA.localeCompare(jobB, undefined, { sensitivity: "base", numeric: true });
        }
        case "jobNameAsc":
        case "jobNameDesc": {
          const jA = String(a.jobName || rowA.jobName || "").trim();
          const jB = String(b.jobName || rowB.jobName || "").trim();
          const cmp = jobsSortBy === "jobNameDesc"
            ? jB.localeCompare(jA, undefined, { sensitivity: "base", numeric: true })
            : jA.localeCompare(jB, undefined, { sensitivity: "base", numeric: true });
          if (cmp !== 0) return cmp;
          return String(a.client || rowA.client || "").localeCompare(String(b.client || rowB.client || ""));
        }
        case "typeAsc":
        case "typeDesc": {
          const tA = String(rowA.projectRetainer || "Project").trim();
          const tB = String(rowB.projectRetainer || "Project").trim();
          const cmp = jobsSortBy === "typeDesc" ? tB.localeCompare(tA) : tA.localeCompare(tB);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "codeAsc":
        case "codeDesc": {
          const cA = String(rowA.projectCode || "").trim();
          const cB = String(rowB.projectCode || "").trim();
          const cmp = jobsSortBy === "codeDesc"
            ? cB.localeCompare(cA, undefined, { sensitivity: "base", numeric: true })
            : cA.localeCompare(cB, undefined, { sensitivity: "base", numeric: true });
          return cmp !== 0 ? cmp : tieRow();
        }
        case "leadSrcAsc":
        case "leadSrcDesc": {
          const lA = String(rowA.leadSrc || "").trim();
          const lB = String(rowB.leadSrc || "").trim();
          const cmp = jobsSortBy === "leadSrcDesc" ? lB.localeCompare(lA) : lA.localeCompare(lB);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "prodLineAsc":
        case "prodLineDesc": {
          const pA = String(rowA.prodLine || "").trim();
          const pB = String(rowB.prodLine || "").trim();
          const cmp = jobsSortBy === "prodLineDesc" ? pB.localeCompare(pA) : pA.localeCompare(pB);
          return cmp !== 0 ? cmp : tieRow();
        }
        case "likelihoodDesc":
        case "likelihoodAsc": {
          const lA = parseFloat(String(rowA.likelihood || "0").replace(/[^0-9.-]/g, "")) || 0;
          const lB = parseFloat(String(rowB.likelihood || "0").replace(/[^0-9.-]/g, "")) || 0;
          const diff = jobsSortBy === "likelihoodAsc" ? lA - lB : lB - lA;
          return diff !== 0 ? diff : tieRow();
        }
        case "rowNumber": {
          return (rowA.rowNum || 0) - (rowB.rowNum || 0);
        }
        case "rowNumberDesc": {
          return (rowB.rowNum || 0) - (rowA.rowNum || 0);
        }
        case "startDateDesc":
        default: {
          const cmp = compareDateTsBlankLast(parseSheetDateToTs(rowA.startDate), parseSheetDateToTs(rowB.startDate), false);
          return cmp !== 0 ? cmp : tieRow();
        }
      }
    });
  }, [baseMatchedJobs, effectiveViewMode, filterType, jobsTab, jobsSortBy, getJobDateConfTs, searchQuery, searchScope, sortByRelevance]);

  // Reset progressive render window when filter, tab, client, or search changes
  useEffect(() => {
    setVisibleJobsCount(80);
  }, [searchQuery, searchScope, sortByRelevance, filterType, jobsTab, effectiveViewMode, jobsClientSheetId]);

  const visibleJobs = useMemo(() => {
    if (processedJobs.length <= visibleJobsCount) return processedJobs;
    let limit = visibleJobsCount;
    if (expandedJobIds.size > 0 || recentlySavedKeys.size > 0) {
      for (let i = limit; i < processedJobs.length; i++) {
        const k = getJobKey(processedJobs[i]);
        if (expandedJobIds.has(k) || recentlySavedKeys.has(k)) {
          limit = i + 1;
        }
      }
    }
    return processedJobs.slice(0, limit);
  }, [processedJobs, visibleJobsCount, expandedJobIds, recentlySavedKeys, getJobKey]);

  const hasMoreVisibleJobs = visibleJobs.length < processedJobs.length;

  useEffect(() => {
    if (!hasMoreVisibleJobs) return undefined;
    const node = loadMoreJobsSentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleJobsCount((prev) => prev + 80);
        }
      },
      { rootMargin: "300px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreVisibleJobs, visibleJobs.length]);

  // Number of unsaved dirty jobs
  const dirtyCount = Object.keys(draftEdits).length;

  // ============================================================================
  // LEGACY INLINE CELL FOR SPREADSHEET VIEW
  // ============================================================================
  const LegacyEditableCell = ({ value, colLetter, rowNum, type = "text", onSave, customStyle = {}, isCurrency = false, title = "Click to edit" }) => {
    const [isEditing, setIsEditing] = React.useState(false);
    const [val, setVal] = React.useState(value || "");
    const inputRef = React.useRef(null);
    const isCancelledRef = React.useRef(false);

    React.useEffect(() => { setVal(value || ""); }, [value]);
    React.useEffect(() => { if (isEditing && inputRef.current) inputRef.current.focus(); }, [isEditing]);

    const handleBlur = () => {
      if (isCancelledRef.current) {
        isCancelledRef.current = false;
        return;
      }
      setIsEditing(false);
      if (val !== (value || "")) onSave(colLetter, rowNum, val);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Enter") handleBlur();
      if (e.key === "Escape") {
        isCancelledRef.current = true;
        setVal(value || "");
        setIsEditing(false);
      }
    };

    if (isEditing) {
      return (
        <input
          ref={inputRef}
          type={type}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          title={title}
          style={{ width: "100%", boxSizing: "border-box", padding: "2px 4px", fontSize: "12px", border: "1px solid #0066cc", borderRadius: "3px" }}
        />
      );
    }

    return (
      <div
        onClick={() => setIsEditing(true)}
        style={{ minHeight: "20px", cursor: "text", padding: "2px", borderRadius: "3px", ...customStyle }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = customStyle.backgroundColor ? customStyle.backgroundColor : "rgba(0,102,204,0.05)"}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = customStyle.backgroundColor || "transparent"}
        title={title}
      >
        {val ? (isCurrency ? formatCurrency(val) : val) : <span style={{ color: "#ccc" }}>-</span>}
      </div>
    );
  };

  const handleLegacyInlineUpdate = async (colLetter, rowNum, newValue) => {
    const effectiveValue = colLetter === "AN" ? normalizeLikelihoodInput(newValue) : newValue;
    let targetEndClient = "";
    let targetJobName = "";
    let targetJobUuid = null;
    let targetRowOffset = 0;
    let matchedRow = null;
    if (jobsData) {
      for (const job of jobsData) {
        const matchRow = (job.rows || []).find((r) => r.rowNum === rowNum);
        if (matchRow) {
          matchedRow = matchRow;
          targetEndClient = matchRow.client || job.client || "";
          targetJobName = matchRow.jobName || job.jobName || "";
          targetJobUuid = job.jobUuid || job.rows?.[0]?.jobUuid || null;
          targetRowOffset = Math.max(0, Number(rowNum) - Number(job.rows?.[0]?.rowNum || rowNum));
          break;
        }
      }
    }

    if (["AL", "AM", "F", "G"].includes(colLetter)) {
      const effStart = (colLetter === "AL" || colLetter === "F") ? newValue : (matchedRow?.startDate || "");
      const effEnd = (colLetter === "AM" || colLetter === "G") ? newValue : (matchedRow?.endDate || "");
      const startIsFormula = typeof effStart === "string" && effStart.trim().startsWith("=");
      const endIsFormula = typeof effEnd === "string" && effEnd.trim().startsWith("=");
      if (!startIsFormula && !endIsFormula) {
        const dateCheck = validateDateRange(effStart, effEnd, {
          allowNoEndDate: isNoEndDateSentinel(effEnd),
          requireStart: false,
          requireEnd: false,
        });
        if (!dateCheck.valid) {
          const msg = dateCheck.error || "End date cannot be earlier than start date.";
          setActionError(msg);
          alert(msg);
          return;
        }
      }
    }

    const FIELD_NAMES = {
      A: "Client", B: "Job Name", C: "Project Code", D: "Date Confirmed",
      E: "Lead Source", R: "Recharged expenses", AE: "Revenue Split", AG: "Revenue", AH: "Direct Costs",
      AI: "VAT", AJ: "Type", AK: "Product Line", AL: "Start Date",
      AM: "End Date", AN: "Likelihood", DD: "Copied to Confirmed"
    };
    const fieldName = FIELD_NAMES[colLetter] || `Field ${colLetter}`;

    setJobsData((prev) =>
      prev.map((job) => {
        const isParentVatEdit = colLetter === "AI" && job.rows?.[0]?.rowNum === rowNum;
        return {
          ...job,
          rows: job.rows.map((r) => {
            if (r.rowNum !== rowNum && !isParentVatEdit) return r;
            const updated = { ...r };
            if (isParentVatEdit) {
              updated.vat = newValue;
              return updated;
            }
            if (colLetter === "A") updated.client = newValue;
            if (colLetter === "B") updated.jobName = newValue;
            if (colLetter === "C") updated.projectCode = newValue;
            if (colLetter === "R") updated.rechargedExpenses = newValue !== "" && newValue !== null && newValue !== undefined ? formatCurrency(newValue) : "";
            if (colLetter === "AG") updated.revenue = newValue !== "" && newValue !== null && newValue !== undefined ? formatCurrency(newValue) : "";
            if (colLetter === "AH") updated.directCosts = newValue !== "" && newValue !== null && newValue !== undefined ? formatCurrency(newValue) : "";
            if (colLetter === "AI") updated.vat = newValue;
            if (colLetter === "AJ") updated.projectRetainer = newValue;
            if (colLetter === "AL") updated.startDate = newValue;
            if (colLetter === "AM") updated.endDate = newValue;
            if (colLetter === "AN") updated.likelihood = effectiveValue;
            if (colLetter === "DD") updated.copiedToConf = newValue;
            if (colLetter === "D") updated.dateConf = newValue;
            if (colLetter === "E") updated.leadSrc = newValue;
            if (colLetter === "AK") updated.prodLine = newValue;
            return updated;
          })
        };
      })
    );

    try {
      const inlineRes = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_field",
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          tabName: jobsTab,
          cellRef: `${colLetter}${rowNum}`,
          colLetter,
          rowNum,
          ...(targetJobUuid ? { jobUuid: targetJobUuid, rowOffset: targetRowOffset } : {}),
          fieldName,
          endClientName: targetEndClient,
          jobName: targetJobName,
          value: effectiveValue
        })
      });
      const inlineData = await inlineRes.json().catch(() => ({}));
      if (!inlineRes.ok || inlineData?.success === false) {
        const errMsg = inlineData?.error || "Failed to update job field.";
        setActionError(errMsg);
        alert(errMsg);
        loadJobsData(jobsClient, "All", true, true);
        return;
      }
      if (inlineData?.invoiceSlotUpdates?.length > 0 || inlineData?.expenseSlotUpdates?.length > 0) {
        const invMap = new Map((inlineData.invoiceSlotUpdates || []).map(u => [`${u.rowNum}_${u.slotNum}`, u]));
        const expMap = new Map((inlineData.expenseSlotUpdates || []).map(u => [`${u.rowNum}_${u.slotNum}`, u]));
        setJobsData((prev) =>
          (prev || []).map((job) => ({
            ...job,
            rows: (job.rows || []).map((r) => ({
              ...r,
              invoiceSlots: (r.invoiceSlots || []).map((sl) => invMap.get(`${r.rowNum}_${sl.slotNum}`) ? { ...sl, ...invMap.get(`${r.rowNum}_${sl.slotNum}`) } : sl),
              expenseSlots: (r.expenseSlots || []).map((sl) => expMap.get(`${r.rowNum}_${sl.slotNum}`) ? { ...sl, ...expMap.get(`${r.rowNum}_${sl.slotNum}`) } : sl),
            }))
          }))
        );
      }
      if (inlineData?.backgroundProvisioning) {
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 4000);
        setTimeout(() => loadJobsData(jobsClient, "All", true, true), 8000);
      }
    } catch (e) {
      console.error("Inline update failed:", e);
    }
  };

  return (
    <>
      {/* Modals reused across views */}
      {deletingJob && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px"
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !deletingJobKeys.has(getJobKey(deletingJob)) && !movingInvoiceThenDeleteLoading) {
              setDeletingJob(null);
              setMovingInvoicesForDelete(false);
              setTargetJobForMoveDelete(null);
            }
          }}
        >
          {movingInvoicesForDelete ? (
            <div
              style={{
                background: "#ffffff",
                borderRadius: "12px",
                padding: "24px",
                width: "min(92vw, 560px)",
                maxHeight: "85vh",
                overflowY: "auto",
                boxShadow: "0 20px 60px rgba(0,0,0,0.3)"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#1e293b" }}>
                    Move invoice to a different job
                  </h3>
                  <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "4px" }}>
                    Select the destination job for the invoice{deletingJobRealInvoices.length > 1 ? "s" : ""} from <strong>&ldquo;{deletingJob.jobName}&rdquo;</strong> before deleting.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setMovingInvoicesForDelete(false); setTargetJobForMoveDelete(null); }}
                  disabled={movingInvoiceThenDeleteLoading}
                  style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}
                >
                  ×
                </button>
              </div>

              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "6px" }}>
                  Invoices to be moved ({deletingJobRealInvoices.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {deletingJobRealInvoices.map((inv, idx) => (
                    <div key={idx} style={{ fontSize: "12.5px", color: "#334155", display: "flex", justifyContent: "space-between" }}>
                      <span><strong>{inv.ref}</strong></span>
                      <span>{inv.amount ? formatCurrency(inv.amount) : "£0.00"}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <DeferredSearchInput
                  type="text"
                  placeholder="Search destination jobs by client or job name..."
                  value={deleteJobMoveSearch}
                  onChange={(e) => setDeleteJobMoveSearch(e.target.value)}
                  showClearButton
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    boxSizing: "border-box"
                  }}
                />
              </div>

              <div style={{ maxHeight: "240px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", marginBottom: "20px" }}>
                {(() => {
                  const candidates = (jobsData || []).filter(j => getJobKey(j) !== getJobKey(deletingJob));
                  const filtered = candidates.filter(j => {
                    if (!deleteJobMoveSearch.trim()) return true;
                    const q = deleteJobMoveSearch.toLowerCase();
                    return (j.client || "").toLowerCase().includes(q) || (j.jobName || "").toLowerCase().includes(q);
                  });
                  if (filtered.length === 0) {
                    return (
                      <div style={{ padding: "16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
                        No matching jobs found
                      </div>
                    );
                  }
                  return filtered.map((cJob) => {
                    const isSelected = targetJobForMoveDelete && getJobKey(targetJobForMoveDelete) === getJobKey(cJob);
                    return (
                      <div
                        key={getJobKey(cJob)}
                        onClick={() => setTargetJobForMoveDelete(cJob)}
                        style={{
                          padding: "10px 12px",
                          borderBottom: "1px solid #f1f5f9",
                          cursor: "pointer",
                          background: isSelected ? "#eff6ff" : "#ffffff",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          transition: "background 0.15s ease"
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#f8fafc"; }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "#ffffff"; }}
                      >
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: "600", color: isSelected ? "#1d4ed8" : "#1e293b" }}>
                            {cJob.client || "No client"} · {cJob.jobName || "Unnamed job"}
                          </div>
                          <div style={{ fontSize: "11px", color: "#64748b" }}>
                            Revenue: {formatCurrency(cJob.revenue || 0)} · {cJob.tabName || "Confirmed"}
                          </div>
                        </div>
                        <input
                          type="radio"
                          name="deleteMoveJobSelection"
                          checked={isSelected}
                          onChange={() => setTargetJobForMoveDelete(cJob)}
                          style={{ cursor: "pointer" }}
                        />
                      </div>
                    );
                  });
                })()}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => { setMovingInvoicesForDelete(false); setTargetJobForMoveDelete(null); }}
                  disabled={movingInvoiceThenDeleteLoading}
                  style={{
                    padding: "8px 16px",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    color: "#475569",
                    cursor: "pointer"
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveInvoicesThenDelete(targetJobForMoveDelete)}
                  disabled={!targetJobForMoveDelete || movingInvoiceThenDeleteLoading}
                  style={{
                    padding: "8px 20px",
                    background: "#2563eb",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    color: "#ffffff",
                    cursor: !targetJobForMoveDelete || movingInvoiceThenDeleteLoading ? "not-allowed" : "pointer",
                    opacity: !targetJobForMoveDelete || movingInvoiceThenDeleteLoading ? 0.6 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px"
                  }}
                >
                  {movingInvoiceThenDeleteLoading ? <><Spinner size={12} color="#ffffff" /> Moving and deleting...</> : "Move and delete job"}
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                background: "#ffffff",
                borderRadius: "12px",
                padding: "24px",
                width: "min(92vw, 500px)",
                maxHeight: "85vh",
                overflowY: "auto",
                boxShadow: "0 20px 60px rgba(0,0,0,0.3)"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#991b1b" }}>
                    Delete job
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => { setDeletingJob(null); setMovingInvoicesForDelete(false); setTargetJobForMoveDelete(null); }}
                  disabled={deletingJobKeys.has(getJobKey(deletingJob))}
                  style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}
                >
                  ×
                </button>
              </div>

              <p style={{ fontSize: "14px", color: "#334155", lineHeight: "1.5", marginTop: 0, marginBottom: "14px" }}>
                Are you sure you want to delete <strong>&ldquo;{deletingJob.jobName || "this job"}&rdquo;</strong>?
              </p>

              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "12.5px" }}>
                <div style={{ marginBottom: "6px" }}>
                  <span style={{ color: "#7f1d1d", fontWeight: "600", display: "inline-block", width: "70px" }}>Client:</span>
                  <strong style={{ color: "#1e293b" }}>{deletingJob.client || "—"}</strong>
                </div>
                <div style={{ marginBottom: isAdmin ? "6px" : 0 }}>
                  <span style={{ color: "#7f1d1d", fontWeight: "600", display: "inline-block", width: "70px" }}>{isAdmin ? "Tab:" : "Section:"}</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{deletingJob.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed")}</span>
                </div>
                {isAdmin && (
                  <div>
                    <span style={{ color: "#7f1d1d", fontWeight: "600", display: "inline-block", width: "70px" }}>Rows:</span>
                    <span style={{ color: "#475569" }}>
                      {deletingJob.rows?.map(r => `Row ${r.rowNum}`).join(", ") || `Row ${deletingJob.rows?.[0]?.rowNum || "—"}`}
                    </span>
                  </div>
                )}
              </div>

              {deletingJobRealInvoices.length > 0 && (
                <div style={{ background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "12.5px" }}>
                  <div style={{ fontWeight: "700", color: "#92400e", marginBottom: "6px" }}>
                    This job contains {deletingJobRealInvoices.length} active invoice{deletingJobRealInvoices.length > 1 ? "s" : ""}:
                  </div>
                  <ul style={{ margin: "0 0 10px 0", paddingLeft: "18px", fontSize: "12px", color: "#78350f" }}>
                    {deletingJobRealInvoices.map((inv, idx) => (
                      <li key={idx}>
                        <strong>{inv.ref}</strong> — {inv.amount ? formatCurrency(inv.amount) : "£0.00"}{inv.status ? ` (${inv.status})` : ""}
                      </li>
                    ))}
                  </ul>
                  <div style={{ fontSize: "12px", color: "#92400e", lineHeight: "1.45" }}>
                    Would you like to move {deletingJobRealInvoices.length > 1 ? "these invoices" : "this invoice"} to a different job before deleting? If you choose not to, {deletingJobRealInvoices.length > 1 ? "they" : "it"} will immediately return to your &ldquo;invoices to assign&rdquo; list and create a missing invoice alert.
                  </div>
                </div>
              )}

              <div style={{ fontSize: "12px", color: "#64748b", lineHeight: "1.45", marginBottom: "20px" }}>
                {isAdmin
                  ? "⚠️ The job will be removed entirely from the sheet by clearing the relevant cells on the row (preserving all formula columns, formatting, and surrounding structure). This action cannot be undone."
                  : "⚠️ This job and its associated entries will be permanently removed from Pulse. This action cannot be undone."}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => { setDeletingJob(null); setMovingInvoicesForDelete(false); setTargetJobForMoveDelete(null); }}
                  disabled={deletingJobKeys.has(getJobKey(deletingJob))}
                  style={{
                    padding: "8px 16px",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    color: "#475569",
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                {deletingJobRealInvoices.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMovingInvoicesForDelete(true)}
                    disabled={deletingJobKeys.has(getJobKey(deletingJob))}
                    style={{
                      padding: "8px 16px",
                      background: "#2563eb",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: "600",
                      color: "#ffffff",
                      cursor: "pointer"
                    }}
                  >
                    Move invoice to different job
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDeleteJobDirect(deletingJob)}
                  disabled={deletingJobKeys.has(getJobKey(deletingJob))}
                  style={{
                    padding: "8px 20px",
                    background: deletingJobRealInvoices.length > 0 ? "#ffffff" : "#dc2626",
                    border: deletingJobRealInvoices.length > 0 ? "1px solid #dc2626" : "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    color: deletingJobRealInvoices.length > 0 ? "#dc2626" : "#ffffff",
                    cursor: deletingJobKeys.has(getJobKey(deletingJob)) ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    opacity: deletingJobKeys.has(getJobKey(deletingJob)) ? 0.75 : 1
                  }}
                >
                  {deletingJobKeys.has(getJobKey(deletingJob)) ? (
                    <><Spinner size={12} color={deletingJobRealInvoices.length > 0 ? "#dc2626" : "#ffffff"} /> Deleting...</>
                  ) : (
                    deletingJobRealInvoices.length > 0 ? "Delete without moving" : "Yes, delete job"
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {jobsEditSplit && (
        <UnevenSplitModal
          editSplit={jobsEditSplit}
          client={jobsClient}
          tabName={jobsEditSplit.tabName || jobsTab}
          allowEnableSplit={splitEnabled}
          onClose={() => setJobsEditSplit(null)}
          onUpdateJobsData={(rNum, splitStr, updatedFields) => {
            setJobsData((prev) =>
              prev.map((j) => ({
                ...j,
                rows: j.rows.map((r) => {
                  if (r.rowNum === rNum) {
                    const updatedRow = { ...r, unevenSplit: splitStr };
                    if (updatedFields?.startDate) updatedRow.startDate = toSheetDateFormat(updatedFields.startDate);
                    if (updatedFields?.endDate) updatedRow.endDate = toSheetDateFormat(updatedFields.endDate);
                    if (updatedFields?.revenue !== undefined) updatedRow.revenue = updatedFields.revenue;
                    return updatedRow;
                  }
                  return r;
                })
              }))
            );
            // Clear the draft edits for this job since they were saved atomically with the split
            if (jobsEditSplit?.jobRow?.jobKey && updatedFields) {
              setDraftEdits((prev) => {
                const jKey = jobsEditSplit.jobRow.jobKey;
                if (!prev[jKey]) return prev;
                const nextDraft = { ...prev[jKey] };
                if (updatedFields.startDate) delete nextDraft.startDate;
                if (updatedFields.endDate) delete nextDraft.endDate;
                if (updatedFields.revenue !== undefined) delete nextDraft.revenue;
                if (Object.keys(nextDraft).length === 0) {
                  const nextAll = { ...prev };
                  delete nextAll[jKey];
                  return nextAll;
                }
                return { ...prev, [jKey]: nextDraft };
              });
            }
          }}
        />
      )}

      {invoicesEditSlot && (
        <InvoicesEditModal
          editSlot={invoicesEditSlot}
          invoicesClient={jobsClient}
          availableJobs={jobsData}
          isAdmin={isAdmin}
          hasAccountingIntegration={hasAccountingIntegration}
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => (outgoingsPullPendingRef.current = masterId)}
          onInvoiceMoved={async () => {
            await loadJobsData(jobsClient, "All");
          }}
          onUpdateInvoiceJobs={(rNum, sNum, newData, resData) => {
            if (invoicesEditSlot?.createNewRow || resData?.placeholderAdjustment?.newChildRowCreated) {
              loadJobsData(jobsClient, "All");
              return;
            }
            setJobsData((prev) =>
              prev &&
              prev.map((j) => {
                const hasRow = j.rows?.some(r => r.rowNum === rNum);
                let updatedJob = j;
                if (hasRow && resData?.placeholderAdjustment) {
                  const { rowNum: pRow, slotNum: pSlot, newAmount: pAmt } = resData.placeholderAdjustment;
                  updatedJob = {
                    ...updatedJob,
                    rows: updatedJob.rows.map(r => {
                      if (r.rowNum === pRow) {
                        return {
                          ...r,
                          invoiceSlots: (r.invoiceSlots || []).map(sl =>
                            sl.slotNum === pSlot ? { ...sl, amount: pAmt > 0 ? String(pAmt) : "" } : sl
                          )
                        };
                      }
                      return r;
                    })
                  };
                }
                if (hasRow && resData?.updatedRevenue !== undefined) {
                  updatedJob = {
                    ...updatedJob,
                    revenue: resData.updatedRevenue,
                    rows: updatedJob.rows.map(r => ({ ...r, revenue: resData.updatedRevenue }))
                  };
                }
                if (hasRow && resData?.updatedRechargedExpenses !== undefined) {
                  updatedJob = {
                    ...updatedJob,
                    rechargedExpenses: resData.updatedRechargedExpenses,
                    rows: updatedJob.rows.map(r => ({ ...r, rechargedExpenses: resData.updatedRechargedExpenses }))
                  };
                }
                const placeholderSlotUpdates = hasRow && Array.isArray(resData?.placeholderAdjustment?.slotUpdates)
                  ? resData.placeholderAdjustment.slotUpdates
                  : [];
                const normalizedSlotUpdates = hasRow && Array.isArray(resData?.normalizedSlots)
                  ? resData.normalizedSlots
                  : [];
                const restored = hasRow ? resData?.restoredPlaceholderSlot : null;
                return {
                  ...updatedJob,
                  rows: updatedJob.rows.map((r) => {
                    const matchesEditedRow = r.rowNum === rNum;
                    const matchesRestoredRow = restored && Number(r.rowNum) === Number(restored.rowNum);
                    const rowPlaceholderUpdates = placeholderSlotUpdates.filter((u) => Number(u.rowNum) === Number(r.rowNum));
                    const rowNormalizedUpdates = normalizedSlotUpdates.filter((u) => Number(u.rowNum) === Number(r.rowNum));
                    if (!matchesEditedRow && !matchesRestoredRow && rowPlaceholderUpdates.length === 0 && rowNormalizedUpdates.length === 0) return r;
                    return {
                      ...r,
                      invoiceSlots: r.invoiceSlots.map((sl) => {
                        const nUpd = rowNormalizedUpdates.find((u) => Number(u.slotNum) === Number(sl.slotNum));
                        if (nUpd) {
                          return {
                            ...sl,
                            amount: nUpd.amount ?? sl.amount,
                            ref: nUpd.ref ?? sl.ref,
                            sentDate: nUpd.sentDate ?? sl.sentDate,
                            daysToPay: nUpd.daysToPay ?? sl.daysToPay,
                            status: nUpd.status ?? sl.status,
                            ofWhichRechgd: nUpd.ofWhichRechgd !== undefined ? nUpd.ofWhichRechgd : sl.ofWhichRechgd,
                            costMonth: nUpd.costMonth !== undefined ? nUpd.costMonth : sl.costMonth,
                          };
                        }
                        if (matchesEditedRow && sl.slotNum === sNum) return { ...sl, ...newData };
                        const pUpd = rowPlaceholderUpdates.find((u) => Number(u.slotNum) === Number(sl.slotNum));
                        if (pUpd) {
                          return {
                            ...sl,
                            amount: pUpd.amount ?? sl.amount,
                            ref: pUpd.ref ?? sl.ref,
                            sentDate: pUpd.sentDate ?? sl.sentDate,
                            daysToPay: pUpd.daysToPay ?? sl.daysToPay,
                            status: pUpd.status ?? sl.status,
                            ofWhichRechgd: pUpd.ofWhichRechgd !== undefined ? pUpd.ofWhichRechgd : sl.ofWhichRechgd,
                            costMonth: pUpd.costMonth !== undefined ? pUpd.costMonth : sl.costMonth,
                          };
                        }
                        if (
                          matchesRestoredRow &&
                          Number(sl.slotNum) === Number(restored.slotNum || 1) &&
                          !(matchesEditedRow && Number(sNum) === Number(restored.slotNum || 1))
                        ) {
                          return {
                            ...sl,
                            ref: restored.ref || "",
                            amount: restored.amount || "",
                            sentDate: restored.sentDate || "",
                            daysToPay: restored.daysToPay || "",
                            status: restored.status || ""
                          };
                        }
                        return sl;
                      })
                    };
                  })
                };
              })
            );
          }}
        />
      )}

      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={jobsClient}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => (outgoingsPullPendingRef.current = masterId)}
          onUpdateJobs={(rNum, sNum, newData, resData) => {
            if (directCostsEditSlot?.createNewRow || resData?.placeholderAdjustment?.newChildRowCreated) {
              loadJobsData(jobsClient, "All");
              return;
            }
            setJobsData((prev) =>
              prev &&
              prev.map((j) => {
                const hasRow = j.rows?.some(r => r.rowNum === rNum);
                if (!hasRow) return j;
                const placeholderSlotUpdates = Array.isArray(resData?.placeholderAdjustment?.slotUpdates)
                  ? resData.placeholderAdjustment.slotUpdates
                  : [];
                const normalizedSlotUpdates = Array.isArray(resData?.normalizedSlots)
                  ? resData.normalizedSlots
                  : [];
                return {
                  ...j,
                  rows: j.rows.map((r) => {
                    const matchesEditedRow = r.rowNum === rNum;
                    const rowPlaceholderUpdates = placeholderSlotUpdates.filter((u) => Number(u.rowNum) === Number(r.rowNum));
                    const rowNormalizedUpdates = normalizedSlotUpdates.filter((u) => Number(u.rowNum) === Number(r.rowNum));
                    if (!matchesEditedRow && rowPlaceholderUpdates.length === 0 && rowNormalizedUpdates.length === 0) return r;
                    return {
                      ...r,
                      expenseSlots: (r.expenseSlots || []).map((sl) => {
                        const nUpd = rowNormalizedUpdates.find((u) => Number(u.slotNum) === Number(sl.slotNum));
                        if (nUpd) {
                          return {
                            ...sl,
                            description: nUpd.description ?? sl.description,
                            amount: nUpd.amount ?? sl.amount,
                            vat: nUpd.vat ?? sl.vat,
                            date: nUpd.date ?? sl.date,
                            daysToPay: nUpd.daysToPay ?? sl.daysToPay,
                            status: nUpd.status ?? sl.status,
                            transactionId: nUpd.transactionId ?? sl.transactionId,
                          };
                        }
                        if (matchesEditedRow && sl.slotNum === sNum) return { ...sl, ...newData };
                        const pUpd = rowPlaceholderUpdates.find((u) => Number(u.slotNum) === Number(sl.slotNum));
                        if (pUpd) {
                          return {
                            ...sl,
                            description: pUpd.description ?? sl.description,
                            amount: pUpd.amount ?? sl.amount,
                            vat: pUpd.vat ?? sl.vat,
                            date: pUpd.date ?? sl.date,
                            daysToPay: pUpd.daysToPay ?? sl.daysToPay,
                            status: pUpd.status ?? sl.status,
                            transactionId: pUpd.transactionId ?? sl.transactionId,
                          };
                        }
                        return sl;
                      })
                    };
                  })
                };
              })
            );
          }}
        />
      )}

      {showAddJobModal && (
        <JobsNewJobModal
          jobsClient={jobsClient}
          initialTab={newJobModalInitialData?.status || (filterType === "pipeline" ? "Pipeline" : "Confirmed")}
          productLines={productLines}
          leadSources={leadSources}
          existingClients={existingClients}
          splitEnabled={splitEnabled}
          initialJobData={newJobModalInitialData}
          onClose={() => {
            setShowAddJobModal(false);
            setNewJobModalInitialData(null);
          }}
          onSuccess={(targetTab, targetRow, resData) => {
            setShowAddJobModal(false);
            setNewJobModalInitialData(null);
            const tabClean = targetTab || "Confirmed";
            const tabLower = tabClean.toLowerCase();
            if (targetTab) {
              setFilterType(tabLower === "pipeline" ? "pipeline" : "confirmed");
            }
            setSearchQuery("");

            // Clear any deleted-row tombstones for this row so even if the user re-creates an identical job on the same row, it shows immediately
            recentlyDeletedJobKeysRef.current.clear();
            recentlyDeletedJobRowsRef.current.clear();

            if (targetRow && targetTab) {
              const newKey = `${tabLower}_${targetRow}`;
              setRecentlySavedKeys((prev) => new Set(prev).add(newKey));
              setExpandedJobIds((prev) => new Set(prev).add(newKey));

              const scrollToNewJob = () => {
                const el = document.getElementById(`pma-job-row-${newKey}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  return true;
                }
                return false;
              };
              setTimeout(scrollToNewJob, 120);
              setTimeout(scrollToNewJob, 600);
              setTimeout(scrollToNewJob, 1500);
            }

            if (resData?.newJob && isJobZeroPercent(resData.newJob)) {
              setShowZeroPercentJobs(true);
            }

            // Optimistically insert the newly created job into jobsData so it is visible at 0ms
            if (resData?.newJob) {
              setJobsData((prev) => {
                const base = Array.isArray(prev) ? prev.filter((j) => getJobKey(j) !== getJobKey(resData.newJob)) : [];
                return [resData.newJob, ...base];
              });
            }

            loadJobsData(jobsClient, "All", true, true);
            if (resData?.backgroundProvisioning) {
              setTimeout(() => loadJobsData(jobsClient, "All", true, true), 3500);
              setTimeout(() => loadJobsData(jobsClient, "All", true, true), 7500);
            }
          }}
        />
      )}

      {cellNoteModalConfig && (
        <CellNoteModal
          isOpen={cellNoteModalConfig.isOpen}
          title={cellNoteModalConfig.title}
          subtitle={cellNoteModalConfig.subtitle}
          initialNote={cellNoteModalConfig.initialNote}
          onSave={handleSaveCellNote}
          onClose={() => setCellNoteModalConfig(null)}
        />
      )}

      {/* CRM sync warning confirmation modal */}
      {crmWarningPrompt && (
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
            padding: "1rem"
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCrmWarningPrompt(null);
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
              border: "1px solid #e2e8f0"
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "1rem" }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "50%",
                  backgroundColor: "#fef3c7",
                  color: "#d97706",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <h4 style={{ margin: "0 0 6px 0", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>CRM sync confirmation</h4>
                <p style={{ margin: 0, fontSize: "13.5px", color: "#475569", lineHeight: "1.5" }}>
                  The original job was syncing with your CRM, but the new job won&apos;t be. Please confirm.
                </p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "1.25rem" }}>
              <button
                type="button"
                onClick={() => setCrmWarningPrompt(null)}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  color: "#475569",
                  padding: "7px 15px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const { type, job } = crmWarningPrompt;
                  setCrmWarningPrompt(null);
                  if (type === "duplicate") {
                    applyDuplicateJob(job);
                  } else if (type === "renewal") {
                    applyRenewalJob(job);
                  }
                }}
                style={{
                  background: "#2563eb",
                  border: "none",
                  color: "#ffffff",
                  padding: "7px 16px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(37, 99, 235, 0.2)"
                }}
              >
                Confirm and continue
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
        {/* Top Header Card */}
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
            {jobsClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (managedClient && onClearManagedClient) {
                    onClearManagedClient();
                  } else {
                    setJobsClient(null);
                    setJobsData(null);
                    setDraftEdits({});
                    recentlyDeletedJobKeysRef.current.clear();
                    recentlyDeletedJobRowsRef.current.clear();
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
                <span>Jobs</span>
                {isAdmin && jobsClient && (
                  <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "12px", fontWeight: "600" }}>
                    {effectiveViewMode === "modern" ? "Modern view" : "Legacy view"}
                  </span>
                )}
              </h1>
              {jobsClient && (
                <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {jobsClient.clientName}
                </div>
              )}
            </div>
          </div>

          {jobsClient && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              {jobsLastUpdatedAt && (
                <span style={{ fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                  Updated {new Date(jobsLastUpdatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}

              <button
                type="button"
                onClick={() => loadJobsData(jobsClient, effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All", true)}
                disabled={jobsLoading || pullingFromSheet}
                style={{
                  padding: "7px 13px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: (jobsLoading || pullingFromSheet) ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                  opacity: (jobsLoading || pullingFromSheet) ? 0.7 : 1,
                }}
                title="Refresh jobs data"
              >
                {jobsLoading ? (
                  <><Spinner size={13} color="#334155" /> Refreshing...</>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                    <span>Refresh</span>
                  </>
                )}
              </button>

              {isSysAdmin && clientMode === "supabase" && (
                <button
                  type="button"
                  onClick={() => setShowPullFromSheetConfirm(true)}
                  disabled={pullingFromSheet || jobsLoading}
                  style={{
                    padding: "7px 13px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#334155",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: (pullingFromSheet || jobsLoading) ? "default" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                    opacity: (pullingFromSheet || jobsLoading) ? 0.7 : 1,
                  }}
                  title="Re-read this client's spreadsheet tabs into Supabase"
                >
                  {pullingFromSheet ? <><Spinner size={13} color="#334155" /> Pulling...</> : "Pull from sheet"}
                </button>
              )}

              {/* Legacy View Toggle Button - Admins only */}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setViewMode((prev) => (prev === "modern" ? "legacy" : "modern"))}
                  style={{
                    padding: "7px 14px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: effectiveViewMode === "legacy" ? "#0f172a" : "#ffffff",
                    color: effectiveViewMode === "legacy" ? "#ffffff" : "#334155",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                  title={effectiveViewMode === "modern" ? "Switch to traditional spreadsheet view" : "Switch to improved modern view"}
                >
                  <span>{effectiveViewMode === "modern" ? "Legacy view" : "Modern view"}</span>
                </button>
              )}

              {/* Add job Button */}
              <button
                type="button"
                onClick={() => {
                  setNewJobModalInitialData(null);
                  setShowAddJobModal(true);
                }}
                style={{
                  padding: "7px 15px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 3px rgba(37,99,235,0.3)"
                }}
              >
                <span style={{ fontSize: "15px", fontWeight: "bold" }}>+</span> Add job
              </button>
            </div>
          )}
        </div>

        {/* Global Error Banner if any */}
        {actionError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", color: "#991b1b", fontSize: "13px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} style={{ background: "none", border: "none", color: "#991b1b", fontSize: "16px", cursor: "pointer" }}>✕</button>
          </div>
        )}

        {/* Client Selection Screen (when no client chosen) */}
        {noJobsClient && (
          <EditClientSelector
            clients={allOutgoingsClients || []}
            onSelectClient={(c) => {
              const targetName = String(c?.clientName || c?.name || "").trim().toLowerCase();
              const fullC =
                (allOutgoingsClients || []).find(item => String(item.clientName || "").trim().toLowerCase() === targetName && item.clientSheetId) ||
                c;
              prevInitialClientRef.current = fullC;
              setJobsClient(fullC);
              setJobsData(null);
              setJobsLoading(true);
              onSelectClient?.(fullC);
              if (fullC.clientSheetId) {
                loadJobsData(fullC, "All");
              }
            }}
            loading={(allOutgoingsClients || []).length === 0}
            title="Select a client to view and manage jobs:"
          />
        )}

        {/* Main Content when Client is selected */}
        {!noJobsClient && (
          <>
            {/* ========================================================================= */}
            {/* MODERN VIEW                                                               */}
            {/* ========================================================================= */}
            {effectiveViewMode === "modern" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* Filter and Control Bar */}
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: "10px",
                    border: "1px solid #e2e8f0",
                    padding: "14px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
                  }}
                >
                  {/* Top row: Filter Pills on left, Sort and actions on right */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "12px"
                    }}
                  >
                    {/* Filter Pills (All / Confirmed / Pipeline) */}
                    <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "3px", borderRadius: "8px" }}>
                      {[
                        { key: "all", label: "All jobs", count: counts.all },
                        { key: "confirmed", label: "Confirmed", count: counts.confirmed },
                        { key: "pipeline", label: "Pipeline", count: counts.pipeline }
                      ].map((tab) => {
                        const isActive = filterType === tab.key;
                        return (
                          <button
                            key={tab.key}
                            type="button"
                            onClick={() => setFilterType(tab.key)}
                            style={{
                              padding: "6px 14px",
                              border: "none",
                              borderRadius: "6px",
                              background: isActive ? "#ffffff" : "transparent",
                              color: isActive ? "#0f172a" : "#64748b",
                              fontWeight: isActive ? "700" : "500",
                              fontSize: "13px",
                              cursor: "pointer",
                              boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              transition: "all 0.15s ease"
                            }}
                          >
                            <span>{tab.label}</span>
                            <span
                              style={{
                                fontSize: "11px",
                                padding: "1px 6px",
                                borderRadius: "10px",
                                background: isActive ? "#eff6ff" : "#e2e8f0",
                                color: isActive ? "#1d4ed8" : "#64748b",
                                fontWeight: "600"
                              }}
                            >
                              {tab.count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Secondary controls: Show 0% jobs, Refresh */}
                    <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                      {/* Show 0% jobs toggle checkbox */}
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "13px",
                          fontWeight: "500",
                          color: showZeroPercentJobs ? "#1d4ed8" : "#475569",
                          cursor: "pointer",
                          userSelect: "none",
                          padding: "5px 10px",
                          borderRadius: "6px",
                          background: showZeroPercentJobs ? "#eff6ff" : "#ffffff",
                          border: `1px solid ${showZeroPercentJobs ? "#93c5fd" : "#cbd5e1"}`,
                          boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                          transition: "all 0.15s ease"
                        }}
                        title="Toggle visibility of pipeline jobs with 0% likelihood"
                      >
                        <input
                          type="checkbox"
                          checked={showZeroPercentJobs}
                          onChange={(e) => setShowZeroPercentJobs(e.target.checked)}
                          style={{
                            cursor: "pointer",
                            accentColor: "#2563eb",
                            width: "14px",
                            height: "14px",
                            margin: 0
                          }}
                        />
                        <span>Show 0% jobs</span>
                      </label>

                      {/* Refresh button */}
                      <button
                        type="button"
                        onClick={() => loadJobsData(jobsClient, "All", true)}
                        disabled={jobsLoading}
                        style={{
                          background: "none",
                          border: "1px solid #e2e8f0",
                          padding: "5px 10px",
                          borderRadius: "6px",
                          color: "#475569",
                          cursor: jobsLoading ? "default" : "pointer",
                          fontSize: "12px",
                          fontWeight: "500",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          opacity: jobsLoading ? 0.7 : 1
                        }}
                      >
                        {jobsLoading ? <><Spinner size={12} color="#475569" /> Refreshing...</> : "Refresh"}
                      </button>
                    </div>
                  </div>

                  {/* Second row: Search bar, scope filter, and relevance toggle */}
                  {(() => {
                    const activeScopeMeta = JOB_SEARCH_SCOPES.find((s) => s.id === searchScope) || JOB_SEARCH_SCOPES[0];
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", width: "100%" }}>
                        <div style={{ flex: "1 1 320px", minWidth: "240px", position: "relative" }}>
                          <span
                            style={{
                              position: "absolute",
                              left: "12px",
                              top: "50%",
                              transform: "translateY(-50%)",
                              color: "#94a3b8",
                              display: "flex",
                              alignItems: "center",
                              pointerEvents: "none"
                            }}
                          >
                            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="8.5" cy="8.5" r="5.5" />
                              <line x1="13" y1="13" x2="18" y2="18" />
                            </svg>
                          </span>
                          <DeferredSearchInput
                            bare
                            type="text"
                            placeholder={activeScopeMeta.placeholder}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            style={{
                              width: "100%",
                              boxSizing: "border-box",
                              padding: "8px 120px 8px 36px",
                              borderRadius: "7px",
                              border: "1px solid #cbd5e1",
                              fontSize: "13px",
                              outline: "none",
                              color: "#1e293b",
                              background: "#f8fafc",
                              transition: "all 0.15s ease"
                            }}
                            onFocus={(e) => {
                              e.target.style.background = "#ffffff";
                              e.target.style.borderColor = "#3b82f6";
                              e.target.style.boxShadow = "0 0 0 3px rgba(59, 130, 246, 0.12)";
                            }}
                            onBlur={(e) => {
                              e.target.style.background = "#f8fafc";
                              e.target.style.borderColor = "#cbd5e1";
                              e.target.style.boxShadow = "none";
                            }}
                            renderRight={({ localValue, isFiltering, clear }) => {
                              if (!localValue && !isFiltering) return null;
                              return (
                                <div
                                  style={{
                                    position: "absolute",
                                    right: "10px",
                                    top: "50%",
                                    transform: "translateY(-50%)",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px"
                                  }}
                                >
                                  {isFiltering && (
                                    <Spinner size={13} color="#3b82f6" style={{ marginRight: 0 }} />
                                  )}
                                  {searchQuery ? (
                                    <span
                                      style={{
                                        fontSize: "11px",
                                        color: "#64748b",
                                        background: "#e2e8f0",
                                        padding: "1px 7px",
                                        borderRadius: "10px",
                                        fontWeight: "500"
                                      }}
                                    >
                                      {processedJobs.length} {processedJobs.length === 1 ? "match" : "matches"}
                                    </span>
                                  ) : null}
                                  {localValue ? (
                                    <button
                                      type="button"
                                      onClick={clear}
                                      style={{
                                        background: "none",
                                        border: "none",
                                        color: "#94a3b8",
                                        cursor: "pointer",
                                        fontSize: "14px",
                                        lineHeight: 1,
                                        padding: 0
                                      }}
                                      title="Clear search"
                                    >
                                      ✕
                                    </button>
                                  ) : null}
                                </div>
                              );
                            }}
                          />
                        </div>

                        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flexShrink: 0 }}>
                          <div
                            role="group"
                            aria-label="Search scope"
                            style={{
                              display: "inline-flex",
                              background: "#f1f5f9",
                              padding: "3px",
                              borderRadius: "7px",
                              border: "1px solid #e2e8f0"
                            }}
                          >
                            {JOB_SEARCH_SCOPES.map((scopeItem) => {
                              const isActive = searchScope === scopeItem.id;
                              return (
                                <button
                                  key={scopeItem.id}
                                  type="button"
                                  onClick={() => setSearchScope(scopeItem.id)}
                                  style={{
                                    padding: "5px 10px",
                                    border: "none",
                                    borderRadius: "5px",
                                    background: isActive ? "#ffffff" : "transparent",
                                    color: isActive ? "#1d4ed8" : "#64748b",
                                    fontWeight: isActive ? "600" : "500",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                    whiteSpace: "nowrap",
                                    boxShadow: isActive ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                                    transition: "all 0.15s ease"
                                  }}
                                >
                                  {scopeItem.label}
                                </button>
                              );
                            })}
                          </div>

                          {searchQuery.trim() ? (
                            <button
                              type="button"
                              onClick={() => setSortByRelevance((prev) => !prev)}
                              title={sortByRelevance ? "Sorted by best search match first; click to use column sort" : "Click to sort best search matches first"}
                              style={{
                                padding: "6px 10px",
                                borderRadius: "7px",
                                border: `1px solid ${sortByRelevance ? "#93c5fd" : "#cbd5e1"}`,
                                background: sortByRelevance ? "#eff6ff" : "#ffffff",
                                color: sortByRelevance ? "#1d4ed8" : "#475569",
                                fontSize: "12px",
                                fontWeight: "600",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                transition: "all 0.15s ease"
                              }}
                            >
                              {sortByRelevance ? "Sorted by relevance" : "Sort by relevance"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Action Error Banner */}
                {actionError && (
                  <div
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      borderRadius: "8px",
                      padding: "9px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      color: "#991b1b",
                      fontSize: "13px",
                      fontWeight: "500",
                      marginBottom: "12px"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span>❌</span>
                      <span>{actionError}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActionError(null)}
                      style={{ background: "none", border: "none", color: "#991b1b", cursor: "pointer", fontWeight: "700", fontSize: "14px" }}
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Unsaved Changes Banner */}
                {dirtyCount > 0 && (
                  <div
                    style={{
                      background: "#fffbeb",
                      border: "1px solid #fef3c7",
                      borderRadius: "8px",
                      padding: "9px 14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      color: "#92400e",
                      fontSize: "13px",
                      fontWeight: "500"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span>⚠️</span>
                      <span>
                        You have unsaved changes across <strong>{dirtyCount} {dirtyCount === 1 ? "job" : "jobs"}</strong>. Click &ldquo;Save&rdquo; on any modified job to save changes to Pulse.
                      </span>
                    </div>
                  </div>
                )}

                {/* Loading State */}
                {!jobsData ? (
                  jobsLoading ? (
                    <PmaJobsTableSkeleton />
                  ) : (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "36px 24px",
                        background: "#ffffff",
                        borderRadius: "10px",
                        border: "1px solid #fecaca",
                        color: "#334155",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: "700", color: "#991b1b", marginBottom: "6px" }}>
                        Could not load jobs
                      </div>
                      <div style={{ fontSize: "13px", color: "#64748b", marginBottom: "14px" }}>
                        {jobsLoadError || "Could not load jobs right now."}
                      </div>
                      <button
                        type="button"
                        onClick={() => loadJobsData(jobsClient, effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All", true)}
                        style={{
                          padding: "7px 14px",
                          borderRadius: "6px",
                          border: "1px solid #1d4ed8",
                          background: "#1d4ed8",
                          color: "#ffffff",
                          fontSize: "12.5px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  )
                ) : processedJobs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "48px 0", background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", color: "#64748b" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>No jobs found</div>
                    <div style={{ fontSize: "13px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", flexWrap: "wrap" }}>
                      {searchQuery ? (
                        searchScope !== "all" ? (
                          <>
                            <span>
                              No jobs matched &ldquo;{searchQuery}&rdquo; in {(JOB_SEARCH_SCOPES.find((s) => s.id === searchScope)?.label || "this scope").toLowerCase()}.
                            </span>
                            <button
                              type="button"
                              onClick={() => setSearchScope("all")}
                              style={{
                                padding: "4px 10px",
                                borderRadius: "6px",
                                border: "1px solid #93c5fd",
                                background: "#eff6ff",
                                color: "#1d4ed8",
                                fontSize: "12px",
                                fontWeight: "600",
                                cursor: "pointer"
                              }}
                            >
                              Search all fields
                            </button>
                          </>
                        ) : (
                          `No jobs matched query "${searchQuery}".`
                        )
                      ) : (
                        `No ${filterType === "all" ? "" : filterType} jobs found for this client.`
                      )}
                    </div>
                  </div>
                ) : (
                  /* Modern Table Container */
                  <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left", minWidth: "1220px" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontWeight: "600", fontSize: "12px", letterSpacing: "0.02em" }}>
                          <th style={{ padding: "10px 10px", width: "36px", textAlign: "center" }}></th>
                          {renderSortableTh({ label: "Status", colBase: "status", defaultDir: "asc", style: { padding: "10px 10px", width: "95px" } })}
                          <th style={{ padding: "10px 4px", width: "36px", textAlign: "center" }} title="Job notes"></th>
                          {renderSortableTh({ label: "Client", colBase: "clientName", defaultDir: "asc", style: { padding: "10px 10px", width: "180px", minWidth: "160px" } })}
                          {renderSortableTh({ label: "Job name", colBase: "jobName", defaultDir: "asc", style: { padding: "10px 10px", width: "240px", minWidth: "200px" } })}
                          {renderSortableTh({ label: "Type", colBase: "type", defaultDir: "asc", style: { padding: "10px 10px", width: "115px" } })}
                          {renderSortableTh({ label: "Revenue", colBase: "rev", defaultDir: "desc", style: { padding: "10px 10px", width: "125px" } })}
                          {renderSortableTh({ label: "Direct costs", colBase: "costs", defaultDir: "desc", style: { padding: "10px 10px", width: "125px" } })}
                          {renderSortableTh({ label: "Start date", colBase: "startDate", defaultDir: "desc", style: { padding: "10px 10px", width: "130px" } })}
                          {renderSortableTh({ label: "End date", colBase: "endDate", defaultDir: "desc", style: { padding: "10px 10px", width: "130px" } })}
                          {renderSortableTh({ label: "Likelihood", colBase: "likelihood", defaultDir: "desc", style: { padding: "10px 10px", width: "100px" } })}
                          <th style={{ padding: "10px 12px", width: "110px", textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleJobs.map((job) => {
                          const jobKey = getJobKey(job);
                          const isExpanded = expandedJobIds.has(jobKey);
                          const isDirty = isJobDirty(jobKey);
                          const isSaving = savingJobKeys.has(jobKey);
                          const isConfirming = confirmingJobKeys.has(jobKey);
                          const recentlySaved = recentlySavedKeys.has(jobKey);

                          const parentRow = job.rows?.[0] || {};
                          const tabName = job.tabName || parentRow.tabName || "Confirmed";
                          const isConfirmed = tabName.toLowerCase() === "confirmed";
                          const isJobFromCrm = isCrmDeal(job, crmTool, crmDrives);
                          const crmDisplayName = getCrmDisplayName(crmTool);

                          // Current values (draft if modified, else parentRow)
                          const clientVal = getJobFieldValue(job, "client");
                          const jobNameVal = getJobFieldValue(job, "jobName");
                          const typeVal = getJobFieldValue(job, "projectRetainer") || "Project";
                          const isRetainer = String(typeVal).toLowerCase().includes("retainer");
                          const revVal = getJobFieldValue(job, "revenue");
                          const directCostsVal = getJobFieldValue(job, "directCosts");
                          const startDateVal = getJobFieldValue(job, "startDate");
                          const endDateVal = getJobFieldValue(job, "endDate");
                          const likelihoodVal = getJobFieldValue(job, "likelihood");

                          // Expanded values
                          const dateConfVal = getJobFieldValue(job, "dateConf");
                          const leadSrcVal = getJobFieldValue(job, "leadSrc");
                          const prodLineVal = getJobFieldValue(job, "prodLine");
                          const vatVal = getJobFieldValue(job, "vat") || "Yes";
                          const projectCodeVal = getJobFieldValue(job, "projectCode");
                          const rechVal = isConfirmed ? getJobFieldValue(job, "rechargedExpenses") : "";
                          const unevenSplitVal = getJobFieldValue(job, "unevenSplit") || parentRow.unevenSplit || "";
                          const leftToInvoiceVal = parentRow.leftToInvoice || "";
                          const costsOutstandingVal = parentRow.costsOutstanding || "";

                          const jobDraft = isDirty ? draftEdits[jobKey] : null;
                          const hasFinancialDraft = Boolean(
                            jobDraft &&
                            (jobDraft.revenue !== undefined ||
                              jobDraft.directCosts !== undefined ||
                              jobDraft.endDate !== undefined ||
                              jobDraft.rechargedExpenses !== undefined)
                          );

                          const shouldProjectRetainerPreview = Boolean(
                            isRetainer &&
                            isConfirmed &&
                            isDirty &&
                            jobDraft?.endDate !== undefined
                          );
                          const effectiveJobForDisplay = shouldProjectRetainerPreview
                            ? {
                              ...job,
                              rows: projectRetainerRowsForEndDate(
                                job,
                                endDateVal,
                                jobDraft?.revenue !== undefined ? revVal : undefined
                              ),
                            }
                            : job;

                          // Calculate real revenue and direct cost metrics strictly excluding gap sweep placeholders (cached when unedited)
                          const metrics = hasFinancialDraft
                            ? getJobFinancialMetrics(effectiveJobForDisplay, isRetainer, isConfirmed, revVal, directCostsVal, noEndDateRetainerMonths, endDateVal, rechVal)
                            : getJobFinancialMetrics(effectiveJobForDisplay, isRetainer, isConfirmed, undefined, undefined, noEndDateRetainerMonths);

                          // Distinct product line and lead source options (computed only when row is expanded)
                          const plOptions = isExpanded ? Array.from(new Set([...(productLines || []), prodLineVal].filter(Boolean))).sort() : [];
                          const lsOptions = isExpanded ? Array.from(new Set([...(leadSources || []), leadSrcVal].filter(Boolean))).sort() : [];
                          const hasSearch = Boolean(searchQuery.trim());
                          const showCoreHighlights = hasSearch && (searchScope === "all" || searchScope === "core");
                          const clientMatched = showCoreHighlights && textMatchesQuery(clientVal, searchQuery);
                          const jobNameMatched = showCoreHighlights && textMatchesQuery(jobNameVal, searchQuery);
                          const nestedMatchSummary = hasSearch
                            ? getJobNestedMatchSummary(job, searchQuery, {
                              maxItems: 2,
                              scope: searchScope,
                              clientText: clientVal,
                              jobNameText: jobNameVal
                            })
                            : null;

                          return (
                            <React.Fragment key={jobKey}>
                              {/* Main Job Row */}
                              <tr
                                id={`pma-job-row-${jobKey}`}
                                data-job-key={jobKey}
                                onClick={(e) => {
                                  // Don't toggle if user clicked directly inside an input, select, or button
                                  const tag = e.target.tagName.toLowerCase();
                                  if (tag === "input" || tag === "select" || tag === "button" || e.target.closest("button")) {
                                    return;
                                  }
                                  toggleJobExpanded(jobKey);
                                }}
                                style={{
                                  borderBottom: isExpanded ? "none" : "1px solid #f1f5f9",
                                  backgroundColor: isDirty ? "#fffbeb" : isExpanded ? "#f8fafc" : "#ffffff",
                                  borderLeft: isDirty ? "4px solid #f59e0b" : "4px solid transparent",
                                  transition: "background-color 0.1s ease",
                                  cursor: "pointer"
                                }}
                                onMouseEnter={(e) => {
                                  if (!isDirty && !isExpanded) e.currentTarget.style.backgroundColor = "#f8fafc";
                                }}
                                onMouseLeave={(e) => {
                                  if (!isDirty && !isExpanded) e.currentTarget.style.backgroundColor = "#ffffff";
                                }}
                              >
                                {/* Chevron expand toggle */}
                                <td style={{ padding: "9px 10px", textAlign: "center", verticalAlign: "middle" }}>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                      transition: "transform 0.15s ease",
                                      color: "#64748b",
                                      fontSize: "11px",
                                      userSelect: "none"
                                    }}
                                  >
                                    ▶
                                  </span>
                                </td>

                                {/* Status Badge */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "2px 8px",
                                        borderRadius: "12px",
                                        fontSize: "11px",
                                        fontWeight: "600",
                                        background: isConfirmed ? "#dcfce7" : "#e0f2fe",
                                        color: isConfirmed ? "#15803d" : "#0369a1",
                                        border: isConfirmed ? "1px solid #bbf7d0" : "1px solid #bae6fd"
                                      }}
                                    >
                                      {isConfirmed ? "Confirmed" : "Pipeline"}
                                    </span>
                                    {isJobFromCrm && <CrmSyncBadge crmDisplayName={crmDisplayName} />}
                                  </div>
                                </td>

                                {/* Job Note Indicator / Button */}
                                <td style={{ padding: "9px 4px", textAlign: "center", verticalAlign: "middle" }} onClick={(e) => e.stopPropagation()}>
                                  <NoteIndicatorButton
                                    note={job.note || parentRow.note || ""}
                                    onClick={() => openJobNoteModal(job)}
                                    title={job.note || parentRow.note ? `Job note: ${job.note || parentRow.note}` : "Add note to job"}
                                  />
                                </td>

                                {/* Client Name (Inline Editable) */}
                                <td style={{ padding: "6px 8px", verticalAlign: "middle", wordBreak: "break-word", overflowWrap: "break-word" }}>
                                  <AutoResizeTextarea
                                    value={clientVal}
                                    onChange={(e) => handleDraftFieldChange(job, "client", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "client")}
                                    placeholder="Client name"
                                    isDirty={isDirty && draftEdits[jobKey]?.client !== undefined}
                                    isSearchMatch={clientMatched}
                                    style={{
                                      fontWeight: "600",
                                      color: "#0f172a"
                                    }}
                                  />
                                </td>

                                {/* Job Name (Inline Editable) */}
                                <td style={{ padding: "6px 8px", verticalAlign: "middle", wordBreak: "break-word", overflowWrap: "break-word" }}>
                                  <AutoResizeTextarea
                                    value={jobNameVal}
                                    onChange={(e) => handleDraftFieldChange(job, "jobName", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "jobName")}
                                    placeholder="Job name"
                                    isDirty={isDirty && draftEdits[jobKey]?.jobName !== undefined}
                                    isSearchMatch={jobNameMatched}
                                    style={{
                                      fontWeight: "500",
                                      color: "#334155"
                                    }}
                                  />
                                  {nestedMatchSummary && nestedMatchSummary.totalCount > 0 && (
                                    nestedMatchSummary.collapseToSummary ? (
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px", paddingLeft: "4px" }}>
                                        {nestedMatchSummary.countsBySection.expenses > 0 && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              expandAndFocusJobSection(jobKey, "expenses");
                                            }}
                                            title="Click to expand and view matching direct costs"
                                            style={{
                                              fontSize: "11px",
                                              fontWeight: "600",
                                              color: "#854d0e",
                                              background: "#fefce8",
                                              border: "1px solid #fde68a",
                                              padding: "1px 7px",
                                              borderRadius: "999px",
                                              cursor: "pointer",
                                              whiteSpace: "nowrap"
                                            }}
                                          >
                                            {nestedMatchSummary.countsBySection.expenses} matching direct {nestedMatchSummary.countsBySection.expenses === 1 ? "cost" : "costs"}
                                          </button>
                                        )}
                                        {nestedMatchSummary.countsBySection.invoices > 0 && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              expandAndFocusJobSection(jobKey, "invoices");
                                            }}
                                            title="Click to expand and view matching invoices"
                                            style={{
                                              fontSize: "11px",
                                              fontWeight: "600",
                                              color: "#854d0e",
                                              background: "#fefce8",
                                              border: "1px solid #fde68a",
                                              padding: "1px 7px",
                                              borderRadius: "999px",
                                              cursor: "pointer",
                                              whiteSpace: "nowrap"
                                            }}
                                          >
                                            {nestedMatchSummary.countsBySection.invoices} matching {nestedMatchSummary.countsBySection.invoices === 1 ? "invoice" : "invoices"}
                                          </button>
                                        )}
                                        {nestedMatchSummary.countsBySection.details > 0 && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              expandAndFocusJobSection(jobKey, "details");
                                            }}
                                            title="Click to expand and view matching job details"
                                            style={{
                                              fontSize: "11px",
                                              fontWeight: "600",
                                              color: "#854d0e",
                                              background: "#fefce8",
                                              border: "1px solid #fde68a",
                                              padding: "1px 7px",
                                              borderRadius: "999px",
                                              cursor: "pointer",
                                              whiteSpace: "nowrap"
                                            }}
                                          >
                                            {nestedMatchSummary.countsBySection.details} matching {nestedMatchSummary.countsBySection.details === 1 ? "detail" : "details"}
                                          </button>
                                        )}
                                      </div>
                                    ) : (
                                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px", marginTop: "4px", paddingLeft: "4px", maxWidth: "100%" }}>
                                        {nestedMatchSummary.items.map((m, i) => (
                                          <button
                                            key={i}
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              expandAndFocusJobSection(jobKey, m.section);
                                            }}
                                            title={m.title}
                                            style={{
                                              display: "-webkit-box",
                                              WebkitLineClamp: 2,
                                              WebkitBoxOrient: "vertical",
                                              overflow: "hidden",
                                              maxWidth: "100%",
                                              textAlign: "left",
                                              fontSize: "11px",
                                              lineHeight: "1.35",
                                              background: "#fefce8",
                                              border: "1px solid #fde68a",
                                              color: "#713f12",
                                              padding: "2px 7px",
                                              borderRadius: "5px",
                                              cursor: "pointer",
                                              wordBreak: "break-word"
                                            }}
                                          >
                                            <span style={{ fontSize: "10px", color: "#a16207", fontWeight: "700", marginRight: "4px" }}>{m.label}:</span>
                                            <HighlightText text={m.snippet} query={searchQuery} />
                                          </button>
                                        ))}
                                        {nestedMatchSummary.totalCount > nestedMatchSummary.items.length && (() => {
                                          const remaining = nestedMatchSummary.totalCount - nestedMatchSummary.items.length;
                                          const firstSection = nestedMatchSummary.items[0]?.section || "details";
                                          return (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                expandAndFocusJobSection(jobKey, firstSection);
                                              }}
                                              style={{
                                                fontSize: "11px",
                                                fontWeight: "600",
                                                color: "#854d0e",
                                                background: "#fef9c3",
                                                border: "1px solid #fde68a",
                                                padding: "1px 7px",
                                                borderRadius: "999px",
                                                cursor: "pointer",
                                                whiteSpace: "nowrap"
                                              }}
                                            >
                                              +{remaining} more {remaining === 1 ? "match" : "matches"}
                                            </button>
                                          );
                                        })()}
                                      </div>
                                    )
                                  )}
                                </td>

                                {/* Job Type (Project / Retainer) */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  {job.isVariableRetainerSeries || job.isVariableRetainer ? (
                                    <div style={{ display: "inline-flex", flexDirection: "column", gap: "3px" }}>
                                      <span
                                        style={{
                                          padding: "3px 7px",
                                          borderRadius: "5px",
                                          border: "1px solid #bae6fd",
                                          background: "#e0f2fe",
                                          color: "#0369a1",
                                          fontSize: "11px",
                                          fontWeight: "600",
                                          display: "inline-block",
                                          whiteSpace: "nowrap"
                                        }}
                                      >
                                        Retainer
                                      </span>
                                      <span
                                        style={{
                                          padding: "1px 6px",
                                          borderRadius: "999px",
                                          background: "#f0f9ff",
                                          border: "1px solid #bae6fd",
                                          color: "#0284c7",
                                          fontSize: "10px",
                                          fontWeight: "600",
                                          textAlign: "center",
                                          whiteSpace: "nowrap"
                                        }}
                                      >
                                        Variable
                                      </span>
                                    </div>
                                  ) : (
                                    <select
                                      value={isRetainer ? "Retainer" : "Project"}
                                      onChange={(e) => handleDraftFieldChange(job, "projectRetainer", e.target.value)}
                                      onKeyDown={(e) => handleFieldKeyDown(e, job, "projectRetainer")}
                                      style={{
                                        padding: "3px 6px",
                                        borderRadius: "5px",
                                        border: isDirty && draftEdits[jobKey]?.projectRetainer !== undefined ? "1px solid #f59e0b" : "1px solid #e2e8f0",
                                        background: isRetainer ? "#e0f2fe" : "#f3e8ff",
                                        color: isRetainer ? "#0284c7" : "#7e22ce",
                                        fontSize: "11px",
                                        fontWeight: "600",
                                        cursor: "pointer",
                                        outline: "none"
                                      }}
                                    >
                                      <option value="Project">Project</option>
                                      <option value="Retainer">Retainer</option>
                                    </select>
                                  )}
                                </td>

                                {/* Revenue */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                                    <input
                                      type="text"
                                      value={revVal}
                                      onChange={(e) => handleDraftFieldChange(job, "revenue", e.target.value)}
                                      onKeyDown={(e) => handleFieldKeyDown(e, job, "revenue")}
                                      placeholder="0.00"
                                      title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes to data will be overwritten by CRM data at the next sync.` : undefined}
                                      style={{
                                        width: "100%",
                                        padding: "4px 6px",
                                        borderRadius: "5px",
                                        border: isDirty && draftEdits[jobKey]?.revenue !== undefined ? "1px solid #f59e0b" : "1px solid transparent",
                                        background: "transparent",
                                        fontSize: "13px",
                                        fontWeight: "600",
                                        color: "#0f172a",
                                        outline: "none",
                                        boxSizing: "border-box"
                                      }}
                                      onFocus={(e) => {
                                        e.target.style.background = "#ffffff";
                                        e.target.style.borderColor = "#3b82f6";
                                      }}
                                      onBlur={(e) => {
                                        e.target.style.background = "transparent";
                                        e.target.style.borderColor = isDirty && draftEdits[jobKey]?.revenue !== undefined ? "#f59e0b" : "transparent";
                                        if (draftEdits[jobKey]?.revenue !== undefined) {
                                          const fmt = formatCurrency(e.target.value);
                                          if (fmt && fmt !== draftEdits[jobKey].revenue) {
                                            handleDraftFieldChange(job, "revenue", fmt);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                  {isConfirmed && metrics.rechargedExpenses > 0 && (
                                    <div style={{ fontSize: "10.5px", fontWeight: "600", color: "#0369a1", marginTop: "2px", paddingLeft: "4px" }}>
                                      + {formatCurrency(metrics.rechargedExpenses)} recharged
                                    </div>
                                  )}
                                  {isConfirmed && (metrics.revenue > 0 || metrics.rechargedExpenses > 0) && (
                                    metrics.leftToInvoice > 0 ? (
                                      <div style={{ marginTop: "3px" }}>
                                        <span
                                          style={{
                                            fontSize: "10px",
                                            padding: "1px 6px",
                                            borderRadius: "6px",
                                            fontWeight: "600",
                                            background: "#fef3c7",
                                            color: "#92400e",
                                            border: "1px solid #fde68a",
                                            display: "inline-block",
                                            whiteSpace: "nowrap"
                                          }}
                                          title={
                                            isRetainer
                                              ? `Prior month unbilled revenue: ${formatCurrency(metrics.leftToInvoice)} (${metrics.priorMonthsUninvoicedCount} prior month${metrics.priorMonthsUninvoicedCount === 1 ? "" : "s"} uninvoiced) · Real invoiced to date: ${formatCurrency(metrics.realInvoiced)}`
                                              : `${metrics.rechargedExpenses > 0 ? `Fee revenue: ${formatCurrency(metrics.revenue)} · Recharged expenses: ${formatCurrency(metrics.rechargedExpenses)} · Total billable: ${formatCurrency(metrics.totalBillable)}` : `Total revenue: ${formatCurrency(metrics.revenue)}`} · Real invoiced: ${formatCurrency(metrics.realInvoiced)} · Left to invoice: ${formatCurrency(metrics.leftToInvoice)}${metrics.draftInvoiced > 0 ? ` · Excludes ${formatCurrency(metrics.draftInvoiced)} in draft invoices` : ""}${metrics.placeholderInvoiced > 0 ? ` · Excludes ${formatCurrency(metrics.placeholderInvoiced)} in gap placeholders` : ""}`
                                          }
                                        >
                                          Left to inv: {formatCurrency(metrics.leftToInvoice)}
                                        </span>
                                      </div>
                                    ) : (
                                      !isRetainer && (
                                        <div style={{ marginTop: "3px" }}>
                                          <span
                                            style={{
                                              fontSize: "10px",
                                              padding: "1px 6px",
                                              borderRadius: "6px",
                                              fontWeight: "600",
                                              background: "#dcfce7",
                                              color: "#166534",
                                              border: "1px solid #bbf7d0",
                                              display: "inline-block",
                                              whiteSpace: "nowrap"
                                            }}
                                            title={`${metrics.rechargedExpenses > 0 ? `Fee revenue: ${formatCurrency(metrics.revenue)} · Recharged expenses: ${formatCurrency(metrics.rechargedExpenses)} · Total billable: ${formatCurrency(metrics.totalBillable)}` : `Total revenue: ${formatCurrency(metrics.revenue)}`} · Real invoiced: ${formatCurrency(metrics.realInvoiced)}`}
                                          >
                                            ✓ Invoiced
                                          </span>
                                        </div>
                                      )
                                    )
                                  )}
                                </td>

                                {/* Direct Costs */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <input
                                    type="text"
                                    value={directCostsVal}
                                    onChange={(e) => handleDraftFieldChange(job, "directCosts", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "directCosts")}
                                    placeholder="0.00"
                                    title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes to data will be overwritten by CRM data at the next sync.` : undefined}
                                    style={{
                                      width: "100%",
                                      padding: "4px 6px",
                                      borderRadius: "5px",
                                      border: isDirty && draftEdits[jobKey]?.directCosts !== undefined ? "1px solid #f59e0b" : "1px solid transparent",
                                      background: "transparent",
                                      fontSize: "13px",
                                      color: "#475569",
                                      outline: "none",
                                      boxSizing: "border-box"
                                    }}
                                    onFocus={(e) => {
                                      e.target.style.background = "#ffffff";
                                      e.target.style.borderColor = "#3b82f6";
                                    }}
                                    onBlur={(e) => {
                                      e.target.style.background = "transparent";
                                      e.target.style.borderColor = isDirty && draftEdits[jobKey]?.directCosts !== undefined ? "#f59e0b" : "transparent";
                                      if (draftEdits[jobKey]?.directCosts !== undefined) {
                                        const fmt = formatCurrency(e.target.value);
                                        if (fmt && fmt !== draftEdits[jobKey].directCosts) {
                                          handleDraftFieldChange(job, "directCosts", fmt);
                                        }
                                      }
                                    }}
                                  />
                                  {isConfirmed && metrics.directCosts > 0 && (
                                    metrics.costsLeftToReceive > 0 ? (
                                      <div style={{ marginTop: "3px" }}>
                                        <span
                                          style={{
                                            fontSize: "10px",
                                            padding: "1px 6px",
                                            borderRadius: "6px",
                                            fontWeight: "600",
                                            background: "#fef3c7",
                                            color: "#92400e",
                                            border: "1px solid #fde68a",
                                            display: "inline-block",
                                            whiteSpace: "nowrap"
                                          }}
                                          title={
                                            isRetainer
                                              ? `Prior month unreceived costs: ${formatCurrency(metrics.costsLeftToReceive)} (${metrics.priorMonthsUnreceivedCount} prior month${metrics.priorMonthsUnreceivedCount === 1 ? "" : "s"} unreceived) · Real costs to date: ${formatCurrency(metrics.realCostsReceived)}`
                                              : `Costs budget: ${formatCurrency(metrics.directCosts)} · Real received: ${formatCurrency(metrics.realCostsReceived)} · Left to receive: ${formatCurrency(metrics.costsLeftToReceive)}${metrics.draftCosts > 0 ? ` · Excludes ${formatCurrency(metrics.draftCosts)} in draft costs` : ""}${metrics.placeholderCosts > 0 ? ` · Excludes ${formatCurrency(metrics.placeholderCosts)} in gap placeholders` : ""}`
                                          }
                                        >
                                          Left to rec: {formatCurrency(metrics.costsLeftToReceive)}
                                        </span>
                                      </div>
                                    ) : (
                                      !isRetainer && (
                                        <div style={{ marginTop: "3px" }}>
                                          <span
                                            style={{
                                              fontSize: "10px",
                                              padding: "1px 6px",
                                              borderRadius: "6px",
                                              fontWeight: "600",
                                              background: "#dcfce7",
                                              color: "#166534",
                                              border: "1px solid #bbf7d0",
                                              display: "inline-block",
                                              whiteSpace: "nowrap"
                                            }}
                                            title={`Costs budget: ${formatCurrency(metrics.directCosts)} · 100% received (${formatCurrency(metrics.realCostsReceived)})`}
                                          >
                                            ✓ Received
                                          </span>
                                        </div>
                                      )
                                    )
                                  )}
                                </td>

                                {/* Start Date */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <JobDateInput
                                    value={startDateVal}
                                    onChange={(val) => handleDraftFieldChange(job, "startDate", val)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "startDate")}
                                    isDirty={isDirty && draftEdits[jobKey]?.startDate !== undefined}
                                    title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes to data will be overwritten by CRM data at the next sync.` : undefined}
                                  />
                                </td>

                                {/* End Date */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }} onClick={(e) => e.stopPropagation()}>
                                  {isNoEndDateSentinel(endDateVal) ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                      <div
                                        style={{
                                          padding: "3px 6px",
                                          borderRadius: "5px",
                                          border: isDirty && draftEdits[jobKey]?.endDate !== undefined ? "1px solid #f59e0b" : "1px solid #e2e8f0",
                                          background: "#f8fafc",
                                          fontSize: "12px",
                                          color: "#64748b",
                                          fontWeight: "500",
                                          whiteSpace: "nowrap"
                                        }}
                                      >
                                        No end date
                                      </div>
                                      {isRetainer && (
                                        <label
                                          style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "4px",
                                            fontSize: "10px",
                                            fontWeight: "600",
                                            color: "#475569",
                                            cursor: "pointer",
                                            userSelect: "none"
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={true}
                                            onChange={(e) => {
                                              if (!e.target.checked) {
                                                handleDraftFieldChange(job, "endDate", startDateVal || "");
                                              }
                                            }}
                                            style={{ margin: 0, cursor: "pointer" }}
                                          />
                                          No end date
                                        </label>
                                      )}
                                    </div>
                                  ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                      <JobDateInput
                                        value={endDateVal}
                                        onChange={(val) => handleDraftFieldChange(job, "endDate", val)}
                                        onKeyDown={(e) => handleFieldKeyDown(e, job, "endDate")}
                                        isDirty={isDirty && draftEdits[jobKey]?.endDate !== undefined}
                                        title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes to data will be overwritten by CRM data at the next sync.` : undefined}
                                      />
                                      {isRetainer && (
                                        <label
                                          style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "4px",
                                            fontSize: "10px",
                                            fontWeight: "600",
                                            color: "#475569",
                                            cursor: "pointer",
                                            userSelect: "none"
                                          }}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={false}
                                            onChange={(e) => {
                                              if (e.target.checked) {
                                                handleDraftFieldChange(job, "endDate", NO_END_DATE_SHEET_VALUE);
                                              }
                                            }}
                                            style={{ margin: 0, cursor: "pointer" }}
                                          />
                                          No end date
                                        </label>
                                      )}
                                    </div>
                                  )}
                                </td>

                                {/* Likelihood (%) */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <input
                                    type="text"
                                    value={likelihoodVal !== undefined && likelihoodVal !== "" ? likelihoodVal : (isConfirmed ? "100%" : "")}
                                    onChange={(e) => handleDraftFieldChange(job, "likelihood", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "likelihood")}
                                    placeholder={isConfirmed ? "100%" : "50%"}
                                    title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes will be overwritten at next sync.` : (isConfirmed ? "Confirmed (100%). Change to <100% and save to unconfirm." : "Pipeline likelihood. Change to 100% and save to confirm.")}
                                    style={{
                                      width: "60px",
                                      padding: "3px 5px",
                                      borderRadius: "5px",
                                      border: isDirty && draftEdits[jobKey]?.likelihood !== undefined ? "1px solid #f59e0b" : "1px solid transparent",
                                      background: isConfirmed && (draftEdits[jobKey]?.likelihood === undefined || draftEdits[jobKey]?.likelihood === "100%") ? "#f0fdf4" : "transparent",
                                      fontSize: "12px",
                                      fontWeight: "600",
                                      color: isConfirmed && (draftEdits[jobKey]?.likelihood === undefined || draftEdits[jobKey]?.likelihood === "100%") ? "#15803d" : "#0369a1",
                                      outline: "none"
                                    }}
                                    onFocus={(e) => {
                                      e.target.style.background = "#ffffff";
                                      e.target.style.borderColor = "#3b82f6";
                                    }}
                                    onBlur={(e) => {
                                      e.target.style.background = isConfirmed && (draftEdits[jobKey]?.likelihood === undefined || draftEdits[jobKey]?.likelihood === "100%") ? "#f0fdf4" : "transparent";
                                      e.target.style.borderColor = isDirty && draftEdits[jobKey]?.likelihood !== undefined ? "#f59e0b" : "transparent";
                                      if (draftEdits[jobKey]?.likelihood !== undefined) {
                                        const fmt = normalizeLikelihoodInput(e.target.value);
                                        if (fmt && fmt !== draftEdits[jobKey].likelihood) {
                                          handleDraftFieldChange(job, "likelihood", fmt);
                                        }
                                      }
                                    }}
                                  />
                                </td>

                                {/* Row Actions (Save / Cancel or Saved check) */}
                                <td style={{ padding: "9px 12px", verticalAlign: "middle", textAlign: "right" }}>
                                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                    {isDirty ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleSaveJob(job);
                                          }}
                                          disabled={isSaving || isConfirming}
                                          style={{
                                            padding: "4px 10px",
                                            borderRadius: "5px",
                                            border: "none",
                                            background: "#16a34a",
                                            color: "#ffffff",
                                            fontSize: "12px",
                                            fontWeight: "600",
                                            cursor: isSaving || isConfirming ? "not-allowed" : "pointer",
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "4px",
                                            boxShadow: "0 1px 2px rgba(22,163,74,0.2)",
                                            opacity: isSaving || isConfirming ? 0.7 : 1
                                          }}
                                        >
                                          {isSaving || isConfirming ? <Spinner size={10} color="#ffffff" /> : "💾"} Save
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDiscardChanges(job);
                                          }}
                                          disabled={isSaving || isConfirming}
                                          title="Discard changes"
                                          style={{
                                            padding: "4px 8px",
                                            borderRadius: "5px",
                                            border: "1px solid #e2e8f0",
                                            background: "#ffffff",
                                            color: "#64748b",
                                            fontSize: "12px",
                                            cursor: isSaving || isConfirming ? "not-allowed" : "pointer"
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </>
                                    ) : isSaving ? (
                                      <span style={{ fontSize: "11px", fontWeight: "600", color: "#0369a1", background: "#eff6ff", padding: "3px 8px", borderRadius: "10px", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                        <Spinner size={10} color="#0369a1" /> Saving...
                                      </span>
                                    ) : recentlySaved ? (
                                      <span style={{ fontSize: "11px", fontWeight: "600", color: "#16a34a", background: "#f0fdf4", padding: "3px 8px", borderRadius: "10px" }}>
                                        ✓ Saved
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleJobExpanded(jobKey);
                                        }}
                                        style={{
                                          background: "none",
                                          border: "none",
                                          color: "#64748b",
                                          cursor: "pointer",
                                          fontSize: "11px",
                                          fontWeight: "500",
                                          padding: "3px 6px"
                                        }}
                                      >
                                        {isExpanded ? "Collapse" : "Expand"}
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>

                              {/* Expanded Panel Details */}
                              {isExpanded && job.isVariableRetainerSeries && (
                                <tr>
                                  <td colSpan={12} style={{ padding: 0, borderBottom: "1px solid #e2e8f0" }}>
                                    <div style={{ background: "#f8fafc", padding: "18px 24px 22px", borderTop: "1px solid #e2e8f0" }}>
                                      <div style={{ background: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", padding: "14px 16px" }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "10px", paddingBottom: "8px", borderBottom: "1px solid #f1f5f9" }}>
                                          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>Monthly schedule</span>
                                            <span style={{ fontSize: "11px", padding: "1px 7px", borderRadius: "10px", background: "#f1f5f9", color: "#475569", fontWeight: "600" }}>
                                              {(job.varSeriesMonths || []).length} {(job.varSeriesMonths || []).length === 1 ? "month" : "months"}
                                            </span>
                                            <span style={{ fontSize: "11.5px", color: "#64748b" }}>
                                              Base forecast: {job.revenue}/month revenue · {job.directCosts}/month direct costs
                                            </span>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRetainersEditJob({
                                                ...job,
                                                rows: job.varSeriesMonths || [],
                                              });
                                            }}
                                            style={{
                                              padding: "5px 12px",
                                              borderRadius: "6px",
                                              border: "1px solid #0284c7",
                                              background: "#f0f9ff",
                                              color: "#0369a1",
                                              fontSize: "12px",
                                              fontWeight: "600",
                                              cursor: "pointer"
                                            }}
                                          >
                                            Manage base &amp; overrides
                                          </button>
                                        </div>

                                        {/* Shared Job Details Strip */}
                                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: "8px 14px", padding: "8px 10px", marginBottom: "12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "11.5px" }}>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>Project code</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>{job.projectCode || "—"}</div>
                                          </div>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>VAT?</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>{job.vat || "Yes"}</div>
                                          </div>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>Date confirmed</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>{job.dateConfirmed || "—"}</div>
                                          </div>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>Product line</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>{job.productLine || "—"}</div>
                                          </div>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>Lead source</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>{job.leadSource || "—"}</div>
                                          </div>
                                          <div>
                                            <div style={{ color: "#64748b", fontSize: "10.5px", fontWeight: 600 }}>Contract dates</div>
                                            <div style={{ color: "#1e293b", fontWeight: 600 }}>
                                              {job.startDate || "—"} – {isNoEndDateSentinel(job.endDate) ? "Ongoing" : (job.endDate || "—")}
                                            </div>
                                          </div>
                                        </div>

                                        <div style={{ overflowX: "auto", maxHeight: "340px", overflowY: "auto" }}>
                                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                                            <thead>
                                              <tr style={{ borderBottom: "1px solid #e2e8f0", color: "#64748b", textAlign: "left" }}>
                                                <th style={{ padding: "6px 8px" }}>Month</th>
                                                <th style={{ padding: "6px 8px" }}>Status</th>
                                                <th style={{ padding: "6px 8px", textAlign: "right" }}>Revenue</th>
                                                <th style={{ padding: "6px 8px", textAlign: "right" }}>Direct costs</th>
                                                <th style={{ padding: "6px 8px" }}>Invoices</th>
                                                <th style={{ padding: "6px 8px" }}>Direct bills</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {(job.varSeriesMonths || []).map((mr, mIdx) => {
                                                const mLabel = getRetainerRowMonthLabel(mr, mIdx, job);
                                                const realInvs = (mr.invoiceSlots || []).filter((s) => {
                                                  const r = String(s.ref || "").trim();
                                                  const st = String(s.status || "").trim().toLowerCase();
                                                  return (r && !isPlaceholderInvoice(r, st)) || st.includes("sent") || st.includes("paid");
                                                });
                                                const visibleExpSlots = (mr.expenseSlots || []).filter((es) =>
                                                  (es.description && String(es.description).trim() !== "") ||
                                                  (es.transactionId && String(es.transactionId).trim() !== "") ||
                                                  (parseFloat(stripCurrency(es.amount)) || 0) > 0
                                                );
                                                const isOverridden = Boolean(mr.isRevOverridden || mr.isDcOverridden);
                                                const stLabel = realInvs.length > 0 ? "Invoiced" : (isOverridden ? "Overridden" : "Base forecast");
                                                const stStyle = realInvs.length > 0
                                                  ? { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }
                                                  : isOverridden
                                                    ? { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }
                                                    : { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
                                                return (
                                                  <tr key={mr.rowNum || mIdx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                                                    <td style={{ padding: "7px 8px", fontWeight: "600", color: "#1e293b", whiteSpace: "nowrap" }}>
                                                      {mLabel}
                                                      {isSysAdmin && <span style={{ color: "#94a3b8", fontWeight: "400", marginLeft: "6px" }}>#{mr.rowNum}</span>}
                                                    </td>
                                                    <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>
                                                      <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "999px", fontWeight: "600", ...stStyle }}>
                                                        {stLabel}
                                                      </span>
                                                    </td>
                                                    <td style={{ padding: "7px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                                                      {formatCurrency(mr.revenue) || "£0.00"}
                                                    </td>
                                                    <td style={{ padding: "7px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#475569" }}>
                                                      {formatCurrency(mr.directCosts) || "£0.00"}
                                                    </td>
                                                    <td style={{ padding: "7px 8px" }}>
                                                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                                                        {(mr.invoiceSlots || [])
                                                          .filter((s) => (s.ref && String(s.ref).trim() !== "") || (parseFloat(stripCurrency(s.amount)) || 0) > 0)
                                                          .map((s) => {
                                                            const isPlace = isPlaceholderInvoice(s.ref, s.status);
                                                            return (
                                                              <button
                                                                key={`${s.rowNum || mr.rowNum}_${s.slotNum}`}
                                                                type="button"
                                                                onClick={(e) => {
                                                                  e.stopPropagation();
                                                                  setInvoicesEditSlot({
                                                                    rowNum: s.rowNum || mr.rowNum,
                                                                    slotNum: s.slotNum,
                                                                    slot: s,
                                                                    jobClient: mr.client || job.client,
                                                                    jobName: mr.jobName || job.jobName,
                                                                    slotLabel: s.ref ? `#${s.ref}` : "Placeholder",
                                                                    tabName: "Confirmed",
                                                                    job,
                                                                  });
                                                                }}
                                                                style={{
                                                                  fontSize: "10px",
                                                                  padding: "1px 6px",
                                                                  borderRadius: "6px",
                                                                  border: "1px solid #cbd5e1",
                                                                  background: isPlace ? "#faf5ff" : "#eff6ff",
                                                                  color: isPlace ? "#6b21a8" : "#1d4ed8",
                                                                  cursor: "pointer",
                                                                  fontWeight: "600"
                                                                }}
                                                              >
                                                                {isPlace ? "Forecast" : `#${s.ref}`} ({formatCurrency(s.amount)})
                                                              </button>
                                                            );
                                                          })}
                                                      </div>
                                                    </td>
                                                    <td style={{ padding: "7px 8px" }}>
                                                      {visibleExpSlots.length > 0 ? (
                                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                                                          {visibleExpSlots.map((es, eIdx) => {
                                                            const isPlace = isPlaceholderExpense(es.transactionId, es.description, es.status);
                                                            const billLabel = isPlace
                                                              ? "Forecast"
                                                              : (es.description || es.transactionId || `Bill ${eIdx + 1}`);
                                                            return (
                                                              <button
                                                                key={`${es.rowNum || mr.rowNum}_${es.slotNum}_${eIdx}`}
                                                                type="button"
                                                                onClick={(e) => {
                                                                  e.stopPropagation();
                                                                  setDirectCostsEditSlot({
                                                                    rowNum: es.rowNum || mr.rowNum,
                                                                    slotNum: es.slotNum,
                                                                    slot: es,
                                                                    jobClient: mr.client || job.client,
                                                                    jobName: mr.jobName || job.jobName,
                                                                    slotLabel: billLabel,
                                                                    tabName: "Confirmed",
                                                                  });
                                                                }}
                                                                style={{
                                                                  fontSize: "10px",
                                                                  padding: "1px 6px",
                                                                  borderRadius: "6px",
                                                                  border: "1px solid #cbd5e1",
                                                                  background: isPlace ? "#faf5ff" : "#f0fdf4",
                                                                  color: isPlace ? "#6b21a8" : "#166534",
                                                                  cursor: "pointer",
                                                                  fontWeight: "600"
                                                                }}
                                                              >
                                                                {billLabel} ({formatCurrency(es.amount)})
                                                              </button>
                                                            );
                                                          })}
                                                        </div>
                                                      ) : (
                                                        <span style={{ color: "#94a3b8" }}>—</span>
                                                      )}
                                                    </td>
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              {isExpanded && !job.isVariableRetainerSeries && (
                                <tr>
                                  <td colSpan={12} style={{ padding: 0, borderBottom: "1px solid #e2e8f0" }}>
                                    <div
                                      style={{
                                        background: "#f8fafc",
                                        padding: "18px 24px 22px",
                                        borderTop: "1px solid #e2e8f0",
                                        boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)"
                                      }}
                                    >
                                      {/* CRM Sync Overwrite Warning Banner */}
                                      {isJobFromCrm && (
                                        <div
                                          style={{
                                            background: "#fffbeb",
                                            border: "1px solid #fef3c7",
                                            borderRadius: "8px",
                                            padding: "10px 14px",
                                            marginBottom: "14px",
                                            color: "#92400e",
                                            fontSize: "12px",
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "8px"
                                          }}
                                        >
                                          <CrmSyncIcon size={14} color="#b45309" strokeWidth={2.2} />
                                          <span>
                                            <strong>Synced with {crmDisplayName}:</strong> Changes to data will be overwritten by CRM data at the next sync.
                                          </span>
                                        </div>
                                      )}

                                      {/* Sub-grid of cards */}
                                      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1.4fr", gap: "16px", marginBottom: "16px" }}>
                                        {/* Card 1: Additional Job Details */}
                                        <div
                                          id={`pma-job-card-${jobKey}-details`}
                                          style={{
                                            background: "#ffffff",
                                            borderRadius: "8px",
                                            border: "1px solid #e2e8f0",
                                            padding: "14px 16px",
                                            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                          }}
                                        >
                                          <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                                            Additional Information
                                          </div>

                                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                            {/* Date Confirmed / Date Added */}
                                            <div>
                                              <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                                                {isConfirmed ? "Date Confirmed" : "Date Added"}
                                              </label>
                                              <JobDateInput
                                                value={dateConfVal}
                                                onChange={(val) => handleDraftFieldChange(job, "dateConf", val)}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "dateConf")}
                                                isDirty={isDirty && draftEdits[jobKey]?.dateConf !== undefined}
                                                defaultBorder="1px solid #cbd5e1"
                                                defaultBg="#ffffff"
                                                style={{ width: "100%", padding: "5px 7px", boxSizing: "border-box" }}
                                              />
                                            </div>

                                            {/* % Likelihood */}
                                            <div>
                                              <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                                                % Likelihood {isConfirmed ? "(100% = Confirmed)" : ""} {isJobFromCrm ? `(${crmDisplayName} synced)` : ""}
                                              </label>
                                              <input
                                                type="text"
                                                value={likelihoodVal !== undefined && likelihoodVal !== "" ? likelihoodVal : (isConfirmed ? "100%" : "")}
                                                onChange={(e) => handleDraftFieldChange(job, "likelihood", e.target.value)}
                                                onBlur={(e) => {
                                                  if (draftEdits[jobKey]?.likelihood !== undefined) {
                                                    const fmt = normalizeLikelihoodInput(e.target.value);
                                                    if (fmt && fmt !== draftEdits[jobKey].likelihood) {
                                                      handleDraftFieldChange(job, "likelihood", fmt);
                                                    }
                                                  }
                                                }}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "likelihood")}
                                                placeholder={isConfirmed ? "100%" : "50%"}
                                                title={isConfirmed ? "Confirmed (100%). Change to <100% and save to unconfirm." : "Pipeline likelihood. Change to 100% and save to confirm."}
                                                style={{
                                                  width: "100%",
                                                  padding: "5px 7px",
                                                  borderRadius: "5px",
                                                  border: isDirty && draftEdits[jobKey]?.likelihood !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                  fontSize: "12px",
                                                  fontWeight: "600",
                                                  color: isConfirmed && (draftEdits[jobKey]?.likelihood === undefined || draftEdits[jobKey]?.likelihood === "100%") ? "#15803d" : "#0369a1",
                                                  outline: "none",
                                                  boxSizing: "border-box"
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
                                                onChange={(e) => handleDraftFieldChange(job, "leadSrc", e.target.value)}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "leadSrc")}
                                                style={{
                                                  width: "100%",
                                                  padding: "5px 7px",
                                                  borderRadius: "5px",
                                                  border: isDirty && draftEdits[jobKey]?.leadSrc !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                  fontSize: "12px",
                                                  outline: "none",
                                                  background: "#ffffff",
                                                  cursor: "pointer",
                                                  boxSizing: "border-box"
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
                                                onChange={(e) => handleDraftFieldChange(job, "prodLine", e.target.value)}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "prodLine")}
                                                style={{
                                                  width: "100%",
                                                  padding: "5px 7px",
                                                  borderRadius: "5px",
                                                  border: isDirty && draftEdits[jobKey]?.prodLine !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                  fontSize: "12px",
                                                  outline: "none",
                                                  background: "#ffffff",
                                                  cursor: "pointer",
                                                  boxSizing: "border-box"
                                                }}
                                              >
                                                <option value="">Select Product Line...</option>
                                                {plOptions.map((opt) => (
                                                  <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                              </select>
                                            </div>

                                            {/* VAT Status */}
                                            <div>
                                              <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                                                VAT Applicable?
                                              </label>
                                              <select
                                                value={vatVal}
                                                onChange={(e) => handleDraftFieldChange(job, "vat", e.target.value)}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "vat")}
                                                style={{
                                                  width: "100%",
                                                  padding: "5px 7px",
                                                  borderRadius: "5px",
                                                  border: isDirty && draftEdits[jobKey]?.vat !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                  fontSize: "12px",
                                                  outline: "none",
                                                  background: "#ffffff",
                                                  cursor: "pointer",
                                                  boxSizing: "border-box"
                                                }}
                                              >
                                                <option value="Yes">Yes</option>
                                                <option value="No">No</option>
                                              </select>
                                            </div>

                                            {/* Project Code */}
                                            <div>
                                              <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                                                Project Code {isJobFromCrm ? `(${crmDisplayName} ID)` : ""}
                                              </label>
                                              <input
                                                type="text"
                                                value={projectCodeVal || ""}
                                                onChange={(e) => !isJobFromCrm && handleDraftFieldChange(job, "projectCode", e.target.value)}
                                                onKeyDown={(e) => handleFieldKeyDown(e, job, "projectCode")}
                                                placeholder="e.g. PRJ-2026-01"
                                                disabled={isJobFromCrm}
                                                title={isJobFromCrm ? `Project code is the ${crmDisplayName} deal ID and cannot be modified directly` : undefined}
                                                style={{
                                                  width: "100%",
                                                  padding: "5px 7px",
                                                  borderRadius: "5px",
                                                  border: isDirty && draftEdits[jobKey]?.projectCode !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                  fontSize: "12px",
                                                  outline: "none",
                                                  boxSizing: "border-box",
                                                  background: isJobFromCrm ? "#f1f5f9" : "#ffffff",
                                                  color: isJobFromCrm ? "#64748b" : "inherit",
                                                  cursor: isJobFromCrm ? "not-allowed" : "text"
                                                }}
                                              />
                                              {searchQuery.trim() && (searchScope === "all" || searchScope === "core") && textMatchesQuery(projectCodeVal, searchQuery) && (
                                                <div style={{ fontSize: "11px", color: "#a16207", marginTop: "2px" }}>
                                                  Match: <HighlightText text={projectCodeVal} query={searchQuery} />
                                                </div>
                                              )}
                                            </div>

                                            {/* Recharged expenses (Confirmed only) */}
                                            {isConfirmed && (() => {
                                              const rechNum = parseFloat(String(rechVal || "0").replace(/[£$€,\s]/g, "")) || 0;
                                              const isRechOpen = Boolean(rechargedToggleByKey[jobKey]) || rechNum > 0;
                                              return (
                                                <div style={{ gridColumn: "span 2", marginTop: "4px", padding: "8px 10px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                                                    <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "700", color: "#334155", cursor: "pointer", margin: 0 }}>
                                                      <input
                                                        type="checkbox"
                                                        checked={isRechOpen}
                                                        onChange={(e) => {
                                                          const checked = e.target.checked;
                                                          setRechargedToggleByKey((prev) => ({ ...prev, [jobKey]: checked }));
                                                          if (!checked) {
                                                            handleDraftFieldChange(job, "rechargedExpenses", "");
                                                          }
                                                        }}
                                                      />
                                                      Recharged expenses?
                                                    </label>
                                                    {isRechOpen && (
                                                      <span style={{ fontSize: "11px", color: "#475569", fontWeight: "600" }}>
                                                        Total billable: {formatCurrency(metrics.totalBillable)}
                                                      </span>
                                                    )}
                                                  </div>
                                                  {isRechOpen && (
                                                    <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                                                      <label style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", whiteSpace: "nowrap" }}>
                                                        Recharged expenses (excl. VAT)
                                                      </label>
                                                      <input
                                                        type="text"
                                                        value={rechVal ?? ""}
                                                        onChange={(e) => handleDraftFieldChange(job, "rechargedExpenses", e.target.value)}
                                                        onKeyDown={(e) => handleFieldKeyDown(e, job, "rechargedExpenses")}
                                                        placeholder="0.00"
                                                        style={{
                                                          width: "120px",
                                                          padding: "4px 7px",
                                                          borderRadius: "5px",
                                                          border: isDirty && draftEdits[jobKey]?.rechargedExpenses !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                                                          fontSize: "12px",
                                                          outline: "none",
                                                          background: "#ffffff",
                                                          textAlign: "right",
                                                          boxSizing: "border-box"
                                                        }}
                                                      />
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })()}

                                            {/* Uneven Revenue Split */}
                                            {(splitEnabled || String(unevenSplitVal).toLowerCase().startsWith("[split]")) && (
                                              <div style={{ gridColumn: "span 2", marginTop: "4px", padding: "8px 10px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                  <div>
                                                    <div style={{ fontSize: "11px", fontWeight: "700", color: "#334155" }}>Revenue split</div>
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
                                                        const currentDraft = draftEdits[jobKey] || {};
                                                        const mergedJobRow = {
                                                          ...parentRow,
                                                          ...currentDraft,
                                                          startDate: currentDraft.startDate !== undefined ? currentDraft.startDate : parentRow.startDate,
                                                          endDate: currentDraft.endDate !== undefined ? currentDraft.endDate : parentRow.endDate,
                                                          revenue: currentDraft.revenue !== undefined ? currentDraft.revenue : parentRow.revenue,
                                                          client: currentDraft.client !== undefined ? currentDraft.client : parentRow.client,
                                                          jobName: currentDraft.jobName !== undefined ? currentDraft.jobName : parentRow.jobName,
                                                          hasDraftDates: Boolean(currentDraft.startDate !== undefined || currentDraft.endDate !== undefined),
                                                          hasDraftRevenue: Boolean(currentDraft.revenue !== undefined),
                                                          jobKey
                                                        };
                                                        setJobsEditSplit({ jobRow: mergedJobRow, tabName });
                                                      }}
                                                      style={{
                                                        padding: "4px 9px",
                                                        borderRadius: "5px",
                                                        border: "1px solid #cbd5e1",
                                                        background: String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#0284c7" : "#ffffff",
                                                        color: String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#ffffff" : "#0284c7",
                                                        fontSize: "11px",
                                                        fontWeight: "600",
                                                        cursor: "pointer"
                                                      }}
                                                    >
                                                      Configure split
                                                    </button>
                                                  )}
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        </div>

                                        {/* Card 2: Invoices */}
                                        {(() => {
                                          const invoiceItems = groupSlotItemsForDisplay(getJobInvoiceItems(effectiveJobForDisplay, isRetainer), "invoice");
                                          return (
                                            <div
                                              id={`pma-job-card-${jobKey}-invoices`}
                                              style={{
                                                background: "#ffffff",
                                                borderRadius: "8px",
                                                border: "1px solid #e2e8f0",
                                                padding: "14px 16px",
                                                boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                                display: "flex",
                                                flexDirection: "column"
                                              }}
                                            >
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px", gap: "8px", flexWrap: "wrap" }}>
                                                <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                                  Invoices ({invoiceItems.length})
                                                </div>
                                                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                                                  {isConfirmed && (metrics.revenue > 0 || metrics.rechargedExpenses > 0) && (
                                                    metrics.leftToInvoice > 0 ? (
                                                      <span
                                                        style={{
                                                          fontSize: "11px",
                                                          padding: "3px 9px",
                                                          borderRadius: "12px",
                                                          fontWeight: "600",
                                                          background: "#fef3c7",
                                                          color: "#92400e",
                                                          border: "1px solid #fde68a",
                                                          display: "inline-flex",
                                                          alignItems: "center",
                                                          gap: "4px"
                                                        }}
                                                        title={
                                                          isRetainer
                                                            ? `Prior month unbilled revenue: ${formatCurrency(metrics.leftToInvoice)} (${metrics.priorMonthsUninvoicedCount} prior month${metrics.priorMonthsUninvoicedCount === 1 ? "" : "s"} uninvoiced) · Real invoiced to date: ${formatCurrency(metrics.realInvoiced)}`
                                                            : `${metrics.rechargedExpenses > 0 ? `Fee revenue: ${formatCurrency(metrics.revenue)} · Recharged expenses: ${formatCurrency(metrics.rechargedExpenses)} · Total billable: ${formatCurrency(metrics.totalBillable)}` : `Total revenue: ${formatCurrency(metrics.revenue)}`} · Real invoiced: ${formatCurrency(metrics.realInvoiced)} · Left to invoice: ${formatCurrency(metrics.leftToInvoice)}${metrics.draftInvoiced > 0 ? ` · Excludes ${formatCurrency(metrics.draftInvoiced)} in draft invoices` : ""}${metrics.placeholderInvoiced > 0 ? ` · Excludes ${formatCurrency(metrics.placeholderInvoiced)} in gap placeholders` : ""}`
                                                        }
                                                      >
                                                        <span>⚠️</span> Left to invoice: {formatCurrency(metrics.leftToInvoice)}
                                                      </span>
                                                    ) : (
                                                      !isRetainer && (
                                                        <span
                                                          style={{
                                                            fontSize: "11px",
                                                            padding: "3px 9px",
                                                            borderRadius: "12px",
                                                            fontWeight: "600",
                                                            background: "#dcfce7",
                                                            color: "#166534",
                                                            border: "1px solid #bbf7d0",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px"
                                                          }}
                                                          title={`${metrics.rechargedExpenses > 0 ? `Fee revenue: ${formatCurrency(metrics.revenue)} · Recharged expenses: ${formatCurrency(metrics.rechargedExpenses)} · Total billable: ${formatCurrency(metrics.totalBillable)}` : `Total revenue: ${formatCurrency(metrics.revenue)}`} · 100% invoiced (${formatCurrency(metrics.realInvoiced)})`}
                                                        >
                                                          <span>✓</span> Fully invoiced
                                                        </span>
                                                      )
                                                    )
                                                  )}
                                                  {isConfirmed && hasAccountingIntegration && !auth?.user?.isReadOnly && (
                                                    <button
                                                      type="button"
                                                      onClick={() => setAssignModalConfig({ itemType: "invoice", job: effectiveJobForDisplay, metrics, isRetainer })}
                                                      style={{
                                                        padding: "3px 9px",
                                                        borderRadius: "5px",
                                                        border: "1px solid #bfdbfe",
                                                        background: "#eff6ff",
                                                        color: "#1d4ed8",
                                                        fontSize: "11px",
                                                        fontWeight: "600",
                                                        cursor: "pointer",
                                                      }}
                                                    >
                                                      Assign invoice
                                                    </button>
                                                  )}
                                                </div>
                                              </div>

                                              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
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
                                                          onClick={() => {
                                                            const targetSlotItem = item.balanceTranche || item.receivedTranches[0] || item;
                                                            setInvoicesEditSlot({
                                                              rowNum: targetSlotItem.rowNum,
                                                              slotNum: targetSlotItem.slotNum,
                                                              slot: targetSlotItem.slot,
                                                              jobClient: targetSlotItem.row?.client || parentRow.client || job.client,
                                                              jobName: targetSlotItem.row?.jobName || parentRow.jobName || job.jobName,
                                                              slotLabel: item.label,
                                                              tabName: item.row?.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
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
                                                              {hasAccountingIntegration && item.slot.ref && (
                                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                                                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                                </svg>
                                                              )}
                                                              {isRetainer && item.row && (
                                                                <span style={{ fontSize: "10px", color: "#64748b" }}>
                                                                  ({getRetainerRowMonthLabel(item.row, 0, effectiveJobForDisplay)})
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
                                                    const isPendingPlaceholder = Boolean(item.row?.isOptimisticPlaceholder || item.rowNum < 0);
                                                    const hasData = Boolean((slot.ref && String(slot.ref).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                                                    const isPlaceholder = isPlaceholderInvoice(slot.ref, slot.status);
                                                    const pillStyle = getStatusPill(slot.status);
                                                    const isPaid = String(slot.status || "").trim().toLowerCase() === "paid";
                                                    const isInvoiceMatched = Boolean(searchQuery.trim() && (searchScope === "all" || searchScope === "invoices") && (textMatchesQuery(slot.ref, searchQuery) || textMatchesQuery(slot.note, searchQuery) || textMatchesQuery(slot.status, searchQuery)));
                                                    return (
                                                      <div
                                                        key={item.id}
                                                        onClick={isPendingPlaceholder ? undefined : () => {
                                                          setInvoicesEditSlot({
                                                            rowNum: item.rowNum,
                                                            slotNum: item.slotNum,
                                                            slot,
                                                            jobClient: item.row.client || parentRow.client || job.client,
                                                            jobName: item.row.jobName || parentRow.jobName || job.jobName,
                                                            slotLabel: slot.ref ? `#${slot.ref}` : (isPlaceholder ? "Placeholder" : (isAdmin ? `Slot ${item.slotNum}` : `Invoice ${item.slotNum}`)),
                                                            tabName: item.row.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
                                                            job,
                                                          });
                                                        }}
                                                        style={{
                                                          padding: "9px 12px",
                                                          borderRadius: "7px",
                                                          border: isInvoiceMatched ? "1px solid #fde047" : (isPendingPlaceholder ? "1px dashed #93c5fd" : "1px solid #e2e8f0"),
                                                          background: isInvoiceMatched ? "#fefce8" : (isPendingPlaceholder ? "#f8fafc" : "#ffffff"),
                                                          cursor: isPendingPlaceholder ? "default" : "pointer",
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
                                                        title={
                                                          isPendingPlaceholder
                                                            ? (isSaving ? "Syncing retainer schedule in background..." : "Save job changes before editing this placeholder")
                                                            : (hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== ""
                                                              ? (isConfirmed
                                                                ? "Synced from accounting software. Click to view or edit days to pay or recharged expenses."
                                                                : "Synced from accounting software. Click to view or edit days to pay.")
                                                              : "Click to edit invoice")
                                                        }
                                                        onMouseEnter={(e) => { if (!isPendingPlaceholder) { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; } }}
                                                        onMouseLeave={(e) => { if (!isPendingPlaceholder) { e.currentTarget.style.borderColor = isInvoiceMatched ? "#fde047" : "#e2e8f0"; e.currentTarget.style.background = isInvoiceMatched ? "#fefce8" : "#ffffff"; } }}
                                                      >
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                            {isPlaceholder ? (
                                                              <PlaceholderPill isAuto={isAutoPlaceholder(slot.ref)} size="sm" />
                                                            ) : slot.ref ? (
                                                              <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                                #<HighlightText text={slot.ref} query={searchQuery} />
                                                              </span>
                                                            ) : (
                                                              <span style={{ fontSize: "12px", fontWeight: "600", color: "#475569" }}>
                                                                Invoice
                                                              </span>
                                                            )}

                                                            {isPendingPlaceholder && (
                                                              <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" }}>
                                                                {isSaving ? "Syncing..." : "Preview"}
                                                              </span>
                                                            )}

                                                            {hasData && slot.status && (
                                                              <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                                                <HighlightText text={slot.status} query={searchQuery} />
                                                              </span>
                                                            )}

                                                            {hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== "" && (
                                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                              </svg>
                                                            )}

                                                            {!isPendingPlaceholder && (
                                                              <NoteIndicatorButton
                                                                size="sm"
                                                                note={slot.note || ""}
                                                                onClick={() => openSlotNoteModal({ item, type: "invoice", job })}
                                                                title={slot.note ? `Invoice note: ${slot.note}` : "Add note to invoice"}
                                                              />
                                                            )}

                                                            {isRetainer && item.row && (
                                                              <span style={{ fontSize: "10px", color: "#64748b" }}>
                                                                ({getRetainerRowMonthLabel(item.row, 0, effectiveJobForDisplay)})
                                                              </span>
                                                            )}
                                                          </div>

                                                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                                            {formatCurrency(slot.amount)}
                                                          </span>
                                                        </div>

                                                        {isConfirmed && (parseFloat(String(slot.ofWhichRechgd || "0").replace(/[£$€,\s]/g, "")) || 0) > 0 && (
                                                          <div style={{ fontSize: "10px", fontWeight: "600", color: "#0369a1" }}>
                                                            incl. {formatCurrency(slot.ofWhichRechgd)} recharged
                                                            {slot.costMonth
                                                              ? ` (${String(slot.costMonth).trim().startsWith("[Split]") ? "split" : slot.costMonth})`
                                                              : ""}
                                                          </div>
                                                        )}

                                                        {/* Progress bar (100% green if Paid) */}
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
                                                                {slot.sentDate ? <span>Sent: <HighlightText text={toSheetDateFormat(slot.sentDate)} query={searchQuery} /></span> : ""}
                                                                {slot.daysToPay ? ` · Paid: ${slot.daysToPay}d` : ""}
                                                              </span>
                                                            </div>
                                                          ) : (
                                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                                              <span style={{ color: "#b45309", fontWeight: 600 }}>
                                                                {calculatePaymentDate(slot.sentDate, slot.daysToPay || 30) ? (
                                                                  `Due: ${calculatePaymentDate(slot.sentDate, slot.daysToPay || 30)}`
                                                                ) : (
                                                                  `Expected in ${slot.daysToPay || 30}d`
                                                                )}
                                                              </span>
                                                              <span style={{ color: "#64748b" }}>
                                                                {slot.sentDate ? <span>Sent: <HighlightText text={toSheetDateFormat(slot.sentDate)} query={searchQuery} /> ({slot.daysToPay || 30}d)</span> : `Terms: ${slot.daysToPay || 30}d`}
                                                              </span>
                                                            </div>
                                                          )
                                                        )}

                                                        {slot.note && isInvoiceMatched && textMatchesQuery(slot.note, searchQuery) && (
                                                          <div style={{ fontSize: "10px", color: "#a16207", marginTop: "2px" }}>
                                                            Note: <HighlightText text={slot.note} query={searchQuery} />
                                                          </div>
                                                        )}
                                                      </div>
                                                    );
                                                  })
                                                )}
                                                <button
                                                  type="button"
                                                  onClick={() => handleAddNewInvoicePlaceholder(job)}
                                                  style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    gap: "6px",
                                                    padding: "8px 12px",
                                                    borderRadius: "6px",
                                                    border: "1px dashed #cbd5e1",
                                                    background: "#f8fafc",
                                                    color: "#475569",
                                                    fontSize: "12px",
                                                    fontWeight: "600",
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                    marginTop: "2px"
                                                  }}
                                                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#94a3b8"; e.currentTarget.style.background = "#f1f5f9"; e.currentTarget.style.color = "#0f172a"; }}
                                                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.background = "#f8fafc"; e.currentTarget.style.color = "#475569"; }}
                                                >
                                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="12" y1="5" x2="12" y2="19" />
                                                    <line x1="5" y1="12" x2="19" y2="12" />
                                                  </svg>
                                                  Add new
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })()}

                                        {/* Card 3: Direct Costs / Expenses */}
                                        {(() => {
                                          const expenseItems = groupSlotItemsForDisplay(getJobExpenseItems(job, isRetainer), "expense");
                                          return (
                                            <div
                                              id={`pma-job-card-${jobKey}-expenses`}
                                              style={{
                                                background: "#ffffff",
                                                borderRadius: "8px",
                                                border: "1px solid #e2e8f0",
                                                padding: "14px 16px",
                                                boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                                display: "flex",
                                                flexDirection: "column"
                                              }}
                                            >
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px", gap: "8px", flexWrap: "wrap" }}>
                                                <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                                  Direct Costs ({expenseItems.length})
                                                </div>
                                                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                                                  {isConfirmed && metrics.directCosts > 0 && (
                                                    metrics.costsLeftToReceive > 0 ? (
                                                      <span
                                                        style={{
                                                          fontSize: "11px",
                                                          padding: "3px 9px",
                                                          borderRadius: "12px",
                                                          fontWeight: "600",
                                                          background: "#fef3c7",
                                                          color: "#92400e",
                                                          border: "1px solid #fde68a",
                                                          display: "inline-flex",
                                                          alignItems: "center",
                                                          gap: "4px"
                                                        }}
                                                        title={
                                                          isRetainer
                                                            ? `Prior month unreceived costs: ${formatCurrency(metrics.costsLeftToReceive)} (${metrics.priorMonthsUnreceivedCount} prior month${metrics.priorMonthsUnreceivedCount === 1 ? "" : "s"} unreceived) · Real costs to date: ${formatCurrency(metrics.realCostsReceived)}`
                                                            : `Costs budget: ${formatCurrency(metrics.directCosts)} · Real received: ${formatCurrency(metrics.realCostsReceived)} · Left to receive: ${formatCurrency(metrics.costsLeftToReceive)}${metrics.draftCosts > 0 ? ` · Excludes ${formatCurrency(metrics.draftCosts)} in draft costs` : ""}${metrics.placeholderCosts > 0 ? ` · Excludes ${formatCurrency(metrics.placeholderCosts)} in gap placeholders` : ""}`
                                                        }
                                                      >
                                                        <span>⚠️</span> Left to receive: {formatCurrency(metrics.costsLeftToReceive)}
                                                      </span>
                                                    ) : (
                                                      !isRetainer && (
                                                        <span
                                                          style={{
                                                            fontSize: "11px",
                                                            padding: "3px 9px",
                                                            borderRadius: "12px",
                                                            fontWeight: "600",
                                                            background: "#dcfce7",
                                                            color: "#166534",
                                                            border: "1px solid #bbf7d0",
                                                            display: "inline-flex",
                                                            alignItems: "center",
                                                            gap: "4px"
                                                          }}
                                                          title={`Costs budget: ${formatCurrency(metrics.directCosts)} · 100% received (${formatCurrency(metrics.realCostsReceived)})`}
                                                        >
                                                          <span>✓</span> Fully received
                                                        </span>
                                                      )
                                                    )
                                                  )}
                                                  {isConfirmed && hasAccountingIntegration && !auth?.user?.isReadOnly && (
                                                    <button
                                                      type="button"
                                                      onClick={() => setAssignModalConfig({ itemType: "directCost", job: effectiveJobForDisplay, metrics, isRetainer })}
                                                      style={{
                                                        padding: "3px 9px",
                                                        borderRadius: "5px",
                                                        border: "1px solid #bfdbfe",
                                                        background: "#eff6ff",
                                                        color: "#1d4ed8",
                                                        fontSize: "11px",
                                                        fontWeight: "600",
                                                        cursor: "pointer",
                                                      }}
                                                    >
                                                      Assign direct cost
                                                    </button>
                                                  )}
                                                </div>
                                              </div>

                                              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
                                                {expenseItems.length === 0 ? (
                                                  <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                                                    No direct costs found.
                                                  </div>
                                                ) : (
                                                  expenseItems.map((item) => {
                                                    if (item.isComposite) {
                                                      return (
                                                        <div
                                                          key={item.id}
                                                          onClick={() => {
                                                            const targetSlotItem = item.balanceTranche || item.receivedTranches[0] || item;
                                                            setDirectCostsEditSlot({
                                                              rowNum: targetSlotItem.rowNum,
                                                              slotNum: targetSlotItem.slotNum,
                                                              slot: targetSlotItem.slot,
                                                              jobName: targetSlotItem.row?.jobName || parentRow.jobName || job.jobName,
                                                              jobClient: targetSlotItem.row?.client || parentRow.client || job.client,
                                                              slotLabel: item.label,
                                                              tabName: item.row?.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
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
                                                          title="Part-paid expense. Click to view or edit balance payment terms."
                                                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#bfdbfe"; e.currentTarget.style.background = "#ffffff"; }}
                                                        >
                                                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                              <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                                {item.slot.description || item.slot.transactionId || "Expense"}
                                                              </span>
                                                              <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", background: item.isFullyPaid ? "#dcfce7" : "#eff6ff", color: item.isFullyPaid ? "#166534" : "#1d4ed8", border: item.isFullyPaid ? "1px solid #bbf7d0" : "1px solid #bfdbfe" }}>
                                                                {item.isFullyPaid ? `Paid in full (${item.receivedTranches.length} payments)` : `Part-paid (${item.percentPaid.toFixed(1)}%)`}
                                                              </span>
                                                            </div>
                                                            <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                                              {formatCurrency(item.totalAmount)}
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
                                                                    {t.slot?.date ? `Date: ${toSheetDateFormat(t.slot.date)}` : ""}
                                                                    {t.slot?.daysToPay ? ` · Paid: ${t.slot.daysToPay}d` : ""}
                                                                  </span>
                                                                </div>
                                                              ))}
                                                            </div>
                                                          ) : (
                                                            <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                                <span style={{ color: "#166534", fontWeight: "600" }}>
                                                                  ✓ {formatCurrency(item.receivedAmount)} paid
                                                                </span>
                                                                <span style={{ color: "#64748b" }}>
                                                                  {item.receivedTranches[0]?.slot?.date ? `Date: ${toSheetDateFormat(item.receivedTranches[0].slot.date)}` : ""}
                                                                  {item.receivedTranches[0]?.slot?.daysToPay ? ` · Paid: ${item.receivedTranches[0].slot.daysToPay}d` : ""}
                                                                </span>
                                                              </div>
                                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                                <span style={{ color: "#b45309", fontWeight: "600" }}>
                                                                  ⏳ {formatCurrency(item.balanceAmount)} balance
                                                                </span>
                                                                <span style={{ color: "#64748b" }}>
                                                                  {item.balanceTranche?.slot?.date && calculatePaymentDate(item.balanceTranche.slot.date, item.balanceTranche.slot.daysToPay || 30) ? (
                                                                    `Due: ${calculatePaymentDate(item.balanceTranche.slot.date, item.balanceTranche.slot.daysToPay || 30)} (${item.balanceTranche.slot.daysToPay || 30}d)`
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
                                                    const hasData = Boolean((slot.description && String(slot.description).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                                                    const isPlaceholder = isPlaceholderExpense(slot);
                                                    const pillStyle = getStatusPill(slot.status);
                                                    const isPaid = String(slot.status || "").trim().toLowerCase() === "paid";
                                                    const isExpenseMatched = Boolean(searchQuery.trim() && (searchScope === "all" || searchScope === "expenses") && (textMatchesQuery(slot.description, searchQuery) || textMatchesQuery(slot.transactionId, searchQuery) || textMatchesQuery(slot.note, searchQuery) || textMatchesQuery(slot.status, searchQuery)));
                                                    return (
                                                      <div
                                                        key={item.id}
                                                        onClick={() => {
                                                          setDirectCostsEditSlot({
                                                            rowNum: item.rowNum,
                                                            slotNum: item.slotNum,
                                                            slot,
                                                            jobName: item.row?.jobName || parentRow.jobName || job.jobName,
                                                            jobClient: item.row?.client || parentRow.client || job.client,
                                                            slotLabel: item.label,
                                                            tabName: item.row?.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
                                                          });
                                                        }}
                                                        style={{
                                                          padding: "9px 12px",
                                                          borderRadius: "7px",
                                                          border: isExpenseMatched ? "1px solid #fde047" : "1px solid #e2e8f0",
                                                          background: isExpenseMatched ? "#fefce8" : "#ffffff",
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
                                                        title={
                                                          hasAccountingIntegration && !isPlaceholder && slot.transactionId && String(slot.transactionId).trim() !== ""
                                                            ? "Synced from accounting software. Click to view or edit days to pay."
                                                            : "Click to edit direct cost slot"
                                                        }
                                                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = isExpenseMatched ? "#fde047" : "#e2e8f0"; e.currentTarget.style.background = isExpenseMatched ? "#fefce8" : "#ffffff"; }}
                                                      >
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                            {isPlaceholder ? (
                                                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                                {slot.description && !String(slot.description).trim().toUpperCase().startsWith("PLACE") && (
                                                                  <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                                    <HighlightText text={slot.description} query={searchQuery} />
                                                                  </span>
                                                                )}
                                                                <PlaceholderPill isAuto={isAutoPlaceholder(slot.transactionId || slot.description)} size="sm" />
                                                              </div>
                                                            ) : (
                                                              <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                                                <HighlightText text={slot.description || (slot.transactionId ? `#${slot.transactionId}` : "Expense")} query={searchQuery} />
                                                              </span>
                                                            )}

                                                            {hasData && slot.status && (
                                                              <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                                                <HighlightText text={slot.status} query={searchQuery} />
                                                              </span>
                                                            )}

                                                            {hasAccountingIntegration && !isPlaceholder && slot.transactionId && String(slot.transactionId).trim() !== "" && (
                                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                              </svg>
                                                            )}

                                                            <NoteIndicatorButton
                                                              size="sm"
                                                              note={slot.note || ""}
                                                              onClick={() => openSlotNoteModal({ item, type: "expense", job })}
                                                              title={slot.note ? `Cost note: ${slot.note}` : "Add note to direct cost slot"}
                                                            />

                                                            {isRetainer && item.row && (
                                                              <span style={{ fontSize: "10px", color: "#64748b" }}>
                                                                ({getRetainerRowMonthLabel(item.row, 0, job)})
                                                              </span>
                                                            )}
                                                          </div>

                                                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                                            {formatCurrency(slot.amount)}
                                                          </span>
                                                        </div>

                                                        {/* Progress bar (100% green if Paid) */}
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
                                                                {slot.date ? <span>Date: <HighlightText text={toSheetDateFormat(slot.date)} query={searchQuery} /></span> : ""}
                                                                {slot.daysToPay ? ` · Paid: ${slot.daysToPay}d` : ""}
                                                                {slot.vat ? ` · VAT: ${slot.vat}` : ""}
                                                              </span>
                                                            </div>
                                                          ) : (
                                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                                              <span style={{ color: "#b45309", fontWeight: 600 }}>
                                                                {calculatePaymentDate(slot.date, slot.daysToPay || 30) ? (
                                                                  `Due: ${calculatePaymentDate(slot.date, slot.daysToPay || 30)}`
                                                                ) : (
                                                                  `Expected in ${slot.daysToPay || 30}d`
                                                                )}
                                                              </span>
                                                              <span style={{ color: "#64748b" }}>
                                                                {slot.date ? <span>Date: <HighlightText text={toSheetDateFormat(slot.date)} query={searchQuery} /> ({slot.daysToPay || 30}d)</span> : `Terms: ${slot.daysToPay || 30}d`}
                                                                {slot.vat ? ` · VAT: ${slot.vat}` : ""}
                                                              </span>
                                                            </div>
                                                          )
                                                        )}

                                                        {slot.transactionId && slot.description && isExpenseMatched && textMatchesQuery(slot.transactionId, searchQuery) && (
                                                          <div style={{ fontSize: "10px", color: "#a16207", marginTop: "1px" }}>
                                                            ID: <HighlightText text={slot.transactionId} query={searchQuery} />
                                                          </div>
                                                        )}

                                                        {slot.note && isExpenseMatched && textMatchesQuery(slot.note, searchQuery) && (
                                                          <div style={{ fontSize: "10px", color: "#a16207", marginTop: "1px" }}>
                                                            Note: <HighlightText text={slot.note} query={searchQuery} />
                                                          </div>
                                                        )}
                                                      </div>
                                                    );
                                                  })
                                                )}
                                                <button
                                                  type="button"
                                                  onClick={() => handleAddNewExpensePlaceholder(job)}
                                                  style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    gap: "6px",
                                                    padding: "8px 12px",
                                                    borderRadius: "6px",
                                                    border: "1px dashed #cbd5e1",
                                                    background: "#f8fafc",
                                                    color: "#475569",
                                                    fontSize: "12px",
                                                    fontWeight: "600",
                                                    cursor: "pointer",
                                                    transition: "all 0.15s ease",
                                                    marginTop: "2px"
                                                  }}
                                                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#94a3b8"; e.currentTarget.style.background = "#f1f5f9"; e.currentTarget.style.color = "#0f172a"; }}
                                                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.background = "#f8fafc"; e.currentTarget.style.color = "#475569"; }}
                                                >
                                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="12" y1="5" x2="12" y2="19" />
                                                    <line x1="5" y1="12" x2="19" y2="12" />
                                                  </svg>
                                                  Add new
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })()}
                                      </div>

                                      {/* Bottom Save Bar for Expanded Row */}
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #e2e8f0", paddingTop: "12px", flexWrap: "wrap", gap: "10px" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                          <button
                                            type="button"
                                            onClick={() => setDeletingJob({ ...job, tabName })}
                                            disabled={isSaving || isConfirming || markingAlreadyConfirmedKeys.has(jobKey) || deletingJobKeys.has(jobKey)}
                                            style={{
                                              background: "#ffffff",
                                              border: "1px solid #fecaca",
                                              color: "#dc2626",
                                              padding: "6px 12px",
                                              borderRadius: "6px",
                                              fontSize: "12px",
                                              fontWeight: "600",
                                              cursor: "pointer",
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: "5px",
                                              transition: "all 0.15s ease"
                                            }}
                                            onMouseEnter={(e) => { e.currentTarget.style.background = "#fef2f2"; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.background = "#ffffff"; }}
                                            title="Delete job entirely"
                                          >
                                            <span>🗑️ Delete job</span>
                                          </button>

                                          {/* Mark job as already confirmed (Pipeline only) - sits next to Delete job */}
                                          {!isConfirmed && !isJobFromCrm && (
                                            <button
                                              type="button"
                                              onClick={() => handleMarkAlreadyConfirmed(job)}
                                              disabled={isSaving || isConfirming || markingAlreadyConfirmedKeys.has(jobKey) || deletingJobKeys.has(jobKey)}
                                              style={{
                                                background: "#f0f7ff",
                                                border: "1px solid #bae6fd",
                                                color: "#0369a1",
                                                padding: "6px 12px",
                                                borderRadius: "6px",
                                                fontSize: "12px",
                                                fontWeight: "600",
                                                cursor: markingAlreadyConfirmedKeys.has(jobKey) ? "wait" : "pointer",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                opacity: markingAlreadyConfirmedKeys.has(jobKey) ? 0.7 : 1,
                                                transition: "all 0.15s ease"
                                              }}
                                              onMouseEnter={(e) => { e.currentTarget.style.background = "#e0f2fe"; }}
                                              onMouseLeave={(e) => { e.currentTarget.style.background = "#f0f7ff"; }}
                                              title={isAdmin ? "Sets likelihood to 100% and puts Yes into 'Copied to confirmed tab' column" : "Marks pipeline opportunity as won (100% likelihood) and promotes to Confirmed jobs"}
                                            >
                                              {markingAlreadyConfirmedKeys.has(jobKey) ? <Spinner size={12} color="#0369a1" /> : null}
                                              <span>{markingAlreadyConfirmedKeys.has(jobKey) ? "Marking..." : "Mark job as already confirmed"}</span>
                                            </button>
                                          )}

                                          {/* Duplicate job button */}
                                          <button
                                            type="button"
                                            onClick={() => handleDuplicateJobClick(job)}
                                            disabled={isSaving || isConfirming || deletingJobKeys.has(jobKey)}
                                            style={{
                                              background: "#ffffff",
                                              border: "1px solid #cbd5e1",
                                              color: "#334155",
                                              padding: "6px 12px",
                                              borderRadius: "6px",
                                              fontSize: "12px",
                                              fontWeight: "600",
                                              cursor: isSaving || isConfirming || deletingJobKeys.has(jobKey) ? "not-allowed" : "pointer",
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: "5px",
                                              transition: "all 0.15s ease"
                                            }}
                                            onMouseEnter={(e) => { e.currentTarget.style.background = "#f8fafc"; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.background = "#ffffff"; }}
                                            title="Create a new job based on the details in this job"
                                          >
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                            </svg>
                                            <span>Duplicate job</span>
                                          </button>

                                          {/* Add renewal in pipeline (Retainers only) */}
                                          {isRetainer && (() => {
                                            const hasNoEndDate = Boolean(!endDateVal || isNoEndDateSentinel(endDateVal));
                                            return (
                                              <button
                                                type="button"
                                                onClick={hasNoEndDate ? undefined : () => handleRenewalJobClick(job)}
                                                disabled={isSaving || isConfirming || deletingJobKeys.has(jobKey) || hasNoEndDate}
                                                style={{
                                                  background: hasNoEndDate ? "#f8fafc" : "#ffffff",
                                                  border: `1px solid ${hasNoEndDate ? "#e2e8f0" : "#cbd5e1"}`,
                                                  color: hasNoEndDate ? "#94a3b8" : "#334155",
                                                  padding: "6px 12px",
                                                  borderRadius: "6px",
                                                  fontSize: "12px",
                                                  fontWeight: "600",
                                                  cursor: hasNoEndDate ? "not-allowed" : (isSaving || isConfirming || deletingJobKeys.has(jobKey) ? "not-allowed" : "pointer"),
                                                  display: "inline-flex",
                                                  alignItems: "center",
                                                  gap: "5px",
                                                  opacity: hasNoEndDate ? 0.7 : 1,
                                                  transition: "all 0.15s ease"
                                                }}
                                                onMouseEnter={(e) => { if (!hasNoEndDate) e.currentTarget.style.background = "#f8fafc"; }}
                                                onMouseLeave={(e) => { if (!hasNoEndDate) e.currentTarget.style.background = "#ffffff"; }}
                                                title={hasNoEndDate ? "Pipeline renewals can only be created for jobs that have an end date" : "Create a new pipeline job for a potential contract renewal"}
                                              >
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                                </svg>
                                                <span>Add renewal in pipeline</span>
                                              </button>
                                            );
                                          })()}
                                        </div>

                                        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                                          <div style={{ fontSize: "12px", color: isDirty ? "#b45309" : "#64748b", fontWeight: isDirty ? "600" : "400" }}>
                                            {isDirty ? "⚠️ Unsaved changes to this job." : "✓ All job details saved"}
                                          </div>

                                          {/* Confirm / Unconfirm Button */}
                                          {isConfirmed ? (() => {
                                            const hasActuals = jobHasActualInvoicesOrExpenses(job);
                                            return (
                                              <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: "3px" }}>
                                                <button
                                                  type="button"
                                                  onClick={() => !hasActuals && handleUnconfirmJob(job, draftEdits[jobKey]?.likelihood)}
                                                  disabled={isSaving || isConfirming || hasActuals}
                                                  style={{
                                                    background: hasActuals ? "#f1f5f9" : "#fffbeb",
                                                    border: `1px solid ${hasActuals ? "#cbd5e1" : "#f59e0b"}`,
                                                    color: hasActuals ? "#94a3b8" : "#b45309",
                                                    padding: "6px 14px",
                                                    borderRadius: "6px",
                                                    fontSize: "12px",
                                                    fontWeight: "600",
                                                    cursor: hasActuals ? "not-allowed" : (isConfirming ? "wait" : "pointer"),
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "6px",
                                                    opacity: isConfirming ? 0.7 : 1
                                                  }}
                                                  title={
                                                    hasActuals
                                                      ? "Cannot unconfirm a job that has actual invoices or expenses assigned to it. Reassign or remove them before moving this job back to the pipeline."
                                                      : "Move job from confirmed back to pipeline"
                                                  }
                                                >
                                                  {isConfirming ? <Spinner size={12} color="#b45309" /> : null}
                                                  <span>{isConfirming ? "Unconfirming..." : "Unconfirm job"}</span>
                                                </button>
                                                {hasActuals && (
                                                  <span style={{ fontSize: "10.5px", color: "#64748b", maxWidth: "260px", lineHeight: "1.25" }}>
                                                    Cannot be unconfirmed while actual invoices or expenses are assigned.
                                                  </span>
                                                )}
                                              </div>
                                            );
                                          })() : isJobFromCrm ? null : (
                                            <button
                                              type="button"
                                              onClick={() => handleConfirmJob(job)}
                                              disabled={isSaving || isConfirming}
                                              style={{
                                                background: "#16a34a",
                                                border: "none",
                                                color: "#ffffff",
                                                padding: "6px 14px",
                                                borderRadius: "6px",
                                                fontSize: "12px",
                                                fontWeight: "600",
                                                cursor: isConfirming ? "wait" : "pointer",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "6px",
                                                opacity: isConfirming ? 0.7 : 1,
                                                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)"
                                              }}
                                              title="Mark job as 100% confirmed and move to Confirmed"
                                            >
                                              {isConfirming ? <Spinner size={12} color="#ffffff" /> : null}
                                              <span>{isConfirming ? "Confirming..." : "Confirm Job"}</span>
                                            </button>
                                          )}

                                          {isDirty && (
                                            <button
                                              type="button"
                                              onClick={() => handleDiscardChanges(job)}
                                              disabled={isSaving || isConfirming}
                                              style={{
                                                padding: "6px 14px",
                                                borderRadius: "6px",
                                                border: "1px solid #cbd5e1",
                                                background: "#ffffff",
                                                color: "#475569",
                                                fontSize: "12px",
                                                fontWeight: "600",
                                                cursor: isSaving || isConfirming ? "not-allowed" : "pointer"
                                              }}
                                            >
                                              Discard Changes
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => handleSaveJob(job)}
                                            disabled={!isDirty || isSaving || isConfirming}
                                            style={{
                                              padding: "6px 16px",
                                              borderRadius: "6px",
                                              border: "none",
                                              background: isDirty && !isSaving && !isConfirming ? "#16a34a" : "#cbd5e1",
                                              color: "#ffffff",
                                              fontSize: "12px",
                                              fontWeight: "600",
                                              cursor: !isDirty || isSaving || isConfirming ? "not-allowed" : "pointer",
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: "6px"
                                            }}
                                          >
                                            {isSaving || isConfirming ? <><Spinner size={12} color="#ffffff" /> Saving...</> : "💾 Save Job"}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {hasMoreVisibleJobs && (
                          <tr ref={loadMoreJobsSentinelRef}>
                            <td colSpan={12} style={{ padding: "14px 16px", textAlign: "center", background: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
                                <span style={{ fontSize: "12.5px", color: "#64748b" }}>
                                  Showing {visibleJobs.length} of {processedJobs.length} jobs
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setVisibleJobsCount((prev) => prev + 80)}
                                  style={{
                                    padding: "5px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #cbd5e1",
                                    background: "#ffffff",
                                    color: "#1e293b",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    cursor: "pointer"
                                  }}
                                >
                                  Show {Math.min(80, processedJobs.length - visibleJobs.length)} more
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setVisibleJobsCount(processedJobs.length)}
                                  style={{
                                    padding: "5px 12px",
                                    borderRadius: "6px",
                                    border: "1px solid #cbd5e1",
                                    background: "#ffffff",
                                    color: "#2563eb",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    cursor: "pointer"
                                  }}
                                >
                                  Show all {processedJobs.length}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ========================================================================= */}
            {/* LEGACY VIEW (PRESERVED SPREADSHEET TABLE FOR ADMINS)                      */}
            {/* ========================================================================= */}
            {effectiveViewMode === "legacy" && (
              <div>
                <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e0e0e0", alignItems: "center" }}>
                  {["Confirmed", "Pipeline"].map((tab) => (
                    <button
                      key={tab}
                      onClick={() => {
                        setJobsTab(tab);
                        loadJobsData(jobsClient, tab);
                      }}
                      style={{
                        padding: "8px 16px",
                        background: "none",
                        border: "none",
                        borderBottom: jobsTab === tab ? "2px solid #0066cc" : "2px solid transparent",
                        color: jobsTab === tab ? "#0066cc" : "#666",
                        fontWeight: jobsTab === tab ? "700" : "500",
                        fontSize: "14px",
                        cursor: "pointer"
                      }}
                    >
                      {tab}
                    </button>
                  ))}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "14px", marginBottom: "4px" }}>
                    {jobsTab === "Pipeline" && (
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "13px",
                          fontWeight: "500",
                          color: showZeroPercentJobs ? "#1d4ed8" : "#475569",
                          cursor: "pointer",
                          userSelect: "none",
                          padding: "4px 8px",
                          borderRadius: "6px",
                          background: showZeroPercentJobs ? "#eff6ff" : "#ffffff",
                          border: `1px solid ${showZeroPercentJobs ? "#93c5fd" : "#cbd5e1"}`
                        }}
                        title="Toggle visibility of pipeline jobs with 0% likelihood"
                      >
                        <input
                          type="checkbox"
                          checked={showZeroPercentJobs}
                          onChange={(e) => setShowZeroPercentJobs(e.target.checked)}
                          style={{ cursor: "pointer", accentColor: "#2563eb", width: "14px", height: "14px", margin: 0 }}
                        />
                        <span>Show 0% jobs</span>
                      </label>
                    )}
                    <button
                      onClick={() => loadJobsData(jobsClient, jobsTab, true)}
                      disabled={jobsLoading}
                      style={{ background: "none", border: "none", color: "#666", cursor: jobsLoading ? "default" : "pointer", fontSize: "13px", display: "inline-flex", alignItems: "center", gap: "4px", opacity: jobsLoading ? 0.7 : 1 }}
                    >
                      {jobsLoading ? <><Spinner size={12} color="#666" /> Refreshing...</> : "Refresh"}
                    </button>
                  </div>
                </div>

                {!jobsData ? (
                  jobsLoading ? (
                    <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
                  ) : (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "32px 24px",
                        background: "#ffffff",
                        borderRadius: "8px",
                        border: "1px solid #fecaca",
                        color: "#334155",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: "700", color: "#991b1b", marginBottom: "6px" }}>
                        Could not load jobs
                      </div>
                      <div style={{ fontSize: "13px", color: "#64748b", marginBottom: "14px" }}>
                        {jobsLoadError || "Could not load jobs right now."}
                      </div>
                      <button
                        type="button"
                        onClick={() => loadJobsData(jobsClient, effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All", true)}
                        style={{
                          padding: "7px 14px",
                          borderRadius: "6px",
                          border: "1px solid #1d4ed8",
                          background: "#1d4ed8",
                          color: "#ffffff",
                          fontSize: "12.5px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  )
                ) : (
                  <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "2000px", tableLayout: "fixed" }}>
                      <thead>
                        <tr style={{ background: "#f5f6fa" }}>
                          {[
                            { label: "" },
                            { label: "Row", colBase: "rowNumber", defaultDir: "asc" },
                            { label: "Client", colBase: "clientName", defaultDir: "asc" },
                            { label: "Job name", colBase: "jobName", defaultDir: "asc" },
                            { label: "Code", colBase: "code", defaultDir: "asc" },
                            { label: jobsTab === "Pipeline" ? "Date added" : "Date conf", colBase: "dateConf", defaultDir: "desc" },
                            { label: "Lead src", colBase: "leadSrc", defaultDir: "asc" },
                            { label: "Type", colBase: "type", defaultDir: "asc" },
                            { label: "Prod. line", colBase: "prodLine", defaultDir: "asc" },
                            { label: "Split" },
                            { label: "Revenue", colBase: "rev", defaultDir: "desc" },
                            { label: "Costs", colBase: "costs", defaultDir: "desc" },
                            { label: "VAT" },
                            { label: "Start", colBase: "startDate", defaultDir: "desc" },
                            { label: "End", colBase: "endDate", defaultDir: "desc" },
                            ...(jobsTab === "Pipeline"
                              ? [{ label: "Likelihood", colBase: "likelihood", defaultDir: "desc" }, { label: "Copied?" }]
                              : []),
                            { label: "InvSlot1" },
                            { label: "InvSlot2" },
                            { label: "InvSlot3" },
                            { label: "Left to inv." },
                            { label: "ExpSlot1" },
                            { label: "ExpSlot2" },
                            { label: "ExpSlot3" },
                            { label: "Costs outst." },
                          ].map((col, i) =>
                            col.colBase ? (
                              renderSortableTh({
                                label: col.label,
                                colBase: col.colBase,
                                defaultDir: col.defaultDir,
                                style: { padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd" },
                              })
                            ) : (
                              <th key={`legacy-col-${i}`} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>
                                {col.label}
                              </th>
                            )
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleJobs.flatMap((job, jobIdx) => {
                          const isRetainer = String(job.rows[0]?.projectRetainer || "").toLowerCase().includes("retainer");
                          const isExpanded = jobsExpanded.has(job.rows[0]?.rowNum);
                          const isJobFromCrm = isCrmDeal(job, crmTool, crmDrives);
                          const crmDisplayName = getCrmDisplayName(crmTool);
                          const crmWarningTitle = isJobFromCrm
                            ? `Synced with ${crmDisplayName}: Changes will be overwritten at next sync.`
                            : undefined;
                          const visibleRows = (isRetainer && !isExpanded) ? job.rows.slice(0, 1) : job.rows;

                          return visibleRows.map((r, rIdx) => {
                            const isParent = r.isParent;
                            const showFields = !isRetainer || isParent;
                            const showIdentity = isParent;

                            return (
                              <tr key={r.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#f1f5f9" }}>
                                <td style={{ padding: "7px 4px", borderBottom: "1px solid #eee", textAlign: "center", verticalAlign: "top" }}>
                                  {rIdx === 0 && isRetainer && job.rows.length > 1 && (
                                    <span
                                      onClick={() =>
                                        setJobsExpanded((prev) => {
                                          const n = new Set(prev);
                                          if (n.has(r.rowNum)) n.delete(r.rowNum);
                                          else n.add(r.rowNum);
                                          return n;
                                        })
                                      }
                                      style={{ cursor: "pointer", color: "#7c3aed", fontSize: "11px", userSelect: "none" }}
                                    >
                                      {isExpanded ? "▼" : "▶"}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888", verticalAlign: "top" }}>{r.rowNum}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showIdentity && <LegacyEditableCell value={r.client} colLetter="A" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showIdentity && <LegacyEditableCell value={r.jobName} colLetter="B" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && (
                                    isJobFromCrm ? (
                                      <span style={{ color: "#64748b", fontStyle: "italic" }} title={`Synced ${crmDisplayName} deal ID (read-only)`}>
                                        {r.projectCode || "-"}
                                      </span>
                                    ) : (
                                      <LegacyEditableCell value={r.projectCode} colLetter="C" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />
                                    )
                                  )}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.dateConf} colLetter="D" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.leadSrc} colLetter="E" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.projectRetainer} colLetter="AJ" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.prodLine} colLetter="AK" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", textAlign: "center", verticalAlign: "top" }}>
                                  {showFields && !isRetainer && isParent && (splitEnabled || String(r.unevenSplit || "").toLowerCase().startsWith("[split]")) && (
                                    <button
                                      onClick={() => setJobsEditSplit({ jobRow: r, tabName: jobsTab })}
                                      style={{
                                        background: String(r.unevenSplit || "").toLowerCase().startsWith("[split]") ? "#0066cc" : "#f0f0f0",
                                        color: String(r.unevenSplit || "").toLowerCase().startsWith("[split]") ? "#fff" : "#666",
                                        border: "none",
                                        borderRadius: "4px",
                                        padding: "2px 6px",
                                        fontSize: "10px",
                                        cursor: "pointer"
                                      }}
                                    >
                                      Split
                                    </button>
                                  )}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.revenue} colLetter="AG" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} isCurrency={true} title={crmWarningTitle} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.directCosts} colLetter="AH" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} isCurrency={true} title={crmWarningTitle} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.vat} colLetter="AI" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} isCurrency={true} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.startDate} colLetter="AL" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} title={crmWarningTitle} />}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && <LegacyEditableCell value={r.endDate ? formatJobEndDateDisplay(r.endDate, "") : ""} colLetter="AM" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} title={crmWarningTitle} />}
                                </td>
                                {jobsTab === "Pipeline" && (
                                  <>
                                    <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                      {showFields && <LegacyEditableCell value={r.likelihood ? formatLikelihood(r.likelihood) : ""} colLetter="AN" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} title={crmWarningTitle} />}
                                    </td>
                                    <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                      {showFields && (
                                        isJobFromCrm ? (
                                          <span style={{ color: "#888" }} title={`Controlled by ${crmDisplayName}`}>
                                            {r.copiedToConf || "No"}
                                          </span>
                                        ) : (
                                          <LegacyEditableCell value={r.copiedToConf} colLetter="DD" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} />
                                        )
                                      )}
                                    </td>
                                  </>
                                )}
                                {r.invoiceSlots.map((s) => {
                                  const isLocked = Boolean(hasAccountingIntegration && !isPlaceholderInvoice(s.ref, s.status) && s.ref && String(s.ref).trim() !== "");
                                  return (
                                    <td
                                      key={`legacy_inv${s.slotNum}`}
                                      onClick={() => setInvoicesEditSlot({ rowNum: r.rowNum, slotNum: s.slotNum, slot: s, jobClient: r.client || job.client, jobName: r.jobName || job.jobName, tabName: r.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"), job })}
                                      title={isLocked ? (jobsTab === "Confirmed" ? "Synced from accounting software. Click to view or edit days to pay or recharged expenses." : "Synced from accounting software. Click to view or edit days to pay.") : "Click to edit invoice slot"}
                                      style={{ padding: "7px 10px", borderBottom: "1px solid #eee", cursor: "pointer" }}
                                    >
                                      {!s.ref && !s.amount ? (
                                        <span style={{ color: "#ccc" }}>-</span>
                                      ) : (
                                        <div>
                                          <div style={{ fontWeight: "600", display: "flex", alignItems: "center", gap: "4px" }}>
                                            {isPlaceholderInvoice(s.ref, s.status) ? (
                                              <PlaceholderPill isAuto={isAutoPlaceholder(s.ref)} size="sm" />
                                            ) : (
                                              <span>{s.ref}</span>
                                            )}
                                            {isLocked && (
                                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                              </svg>
                                            )}
                                          </div>
                                          <div style={{ color: "#888", fontSize: "10px", marginTop: "3px" }}>
                                            <span>{formatCurrency(s.amount)}</span>
                                            {s.sentDate ? <span> · {s.sentDate}</span> : null}
                                            {s.status ? <span style={{ marginLeft: "4px", ...getStatusPill(s.status) }}>{s.status}</span> : null}
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                  );
                                })}
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && formatCurrency(r.leftToInvoice)}
                                </td>
                                {r.expenseSlots.map((s) => (
                                  <td
                                    key={`legacy_exp${s.slotNum}`}
                                    onClick={() => setDirectCostsEditSlot({ rowNum: r.rowNum, slotNum: s.slotNum, slot: s, jobName: r.jobName || job.jobName, jobClient: r.client || job.client, tabName: r.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed") })}
                                    style={{ padding: "7px 10px", borderBottom: "1px solid #eee", cursor: "pointer" }}
                                  >
                                    {!s.description && !s.amount ? (
                                      <span style={{ color: "#ccc" }}>-</span>
                                    ) : (
                                      <div>
                                        <div style={{ fontWeight: "600" }}>
                                          {isPlaceholderExpense(s.transactionId, s.description, s.status) ? (
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                              {s.description && !String(s.description).trim().toUpperCase().startsWith("PLACE") && (
                                                <span>{s.description}</span>
                                              )}
                                              <PlaceholderPill isAuto={isAutoPlaceholder(s.transactionId || s.description)} size="sm" />
                                            </div>
                                          ) : (
                                            <span>{s.description || s.transactionId}</span>
                                          )}
                                        </div>
                                        <div style={{ color: "#888", fontSize: "10px", marginTop: "3px" }}>
                                          <span>{formatCurrency(s.amount)}</span>
                                          {s.date ? <span> · {s.date}</span> : null}
                                          {s.status ? <span style={{ marginLeft: "4px", ...getStatusPill(s.status) }}>{s.status}</span> : null}
                                        </div>
                                      </div>
                                    )}
                                  </td>
                                ))}
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {showFields && formatCurrency(r.costsOutstanding)}
                                </td>
                              </tr>
                            );
                          });
                        })}
                        {hasMoreVisibleJobs && (
                          <tr ref={loadMoreJobsSentinelRef}>
                            <td colSpan={jobsTab === "Pipeline" ? 25 : 23} style={{ padding: "12px 16px", textAlign: "left", background: "#f8fafc", borderTop: "1px solid #e0e0e0" }}>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                                <span style={{ fontSize: "12px", color: "#64748b" }}>
                                  Showing {visibleJobs.length} of {processedJobs.length} jobs
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setVisibleJobsCount((prev) => prev + 80)}
                                  style={{
                                    padding: "4px 10px",
                                    borderRadius: "5px",
                                    border: "1px solid #cbd5e1",
                                    background: "#ffffff",
                                    color: "#1e293b",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    cursor: "pointer"
                                  }}
                                >
                                  Show {Math.min(80, processedJobs.length - visibleJobs.length)} more
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setVisibleJobsCount(processedJobs.length)}
                                  style={{
                                    padding: "4px 10px",
                                    borderRadius: "5px",
                                    border: "1px solid #cbd5e1",
                                    background: "#ffffff",
                                    color: "#2563eb",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    cursor: "pointer"
                                  }}
                                >
                                  Show all {processedJobs.length}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {isSysAdmin && showPullFromSheetConfirm && jobsClient && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.45)",
            zIndex: 1100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
          onClick={() => !pullingFromSheet && setShowPullFromSheetConfirm(false)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "10px",
              padding: "22px 24px",
              width: "100%",
              maxWidth: "430px",
              boxShadow: "0 14px 36px rgba(15, 23, 42, 0.22)",
              border: "1px solid #e2e8f0",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Pull latest jobs from sheet
            </h3>
            <p style={{ margin: "0 0 18px", fontSize: "13px", color: "#475569", lineHeight: 1.5 }}>
              Re-read {jobsClient.clientName}&apos;s Confirmed, Pipeline, and CRM tabs directly from Google Sheets and refresh Supabase?
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                disabled={pullingFromSheet}
                onClick={() => setShowPullFromSheetConfirm(false)}
                style={{
                  padding: "7px 14px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: pullingFromSheet ? "default" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pullingFromSheet}
                onClick={handlePullJobsFromSheet}
                style={{
                  padding: "7px 15px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: pullingFromSheet ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  opacity: pullingFromSheet ? 0.75 : 1,
                }}
              >
                {pullingFromSheet ? <><Spinner size={13} color="#ffffff" /> Pulling...</> : "Pull from sheet"}
              </button>
            </div>
          </div>
        </div>
      )}

      {assignModalConfig && jobsClient && (
        <AssignAccountingItemsModal
          isOpen={Boolean(assignModalConfig)}
          onClose={() => setAssignModalConfig(null)}
          itemType={assignModalConfig.itemType}
          surface="pma"
          isAdmin={isAdmin}
          clientName={jobsClient.clientName || ""}
          clientSheetId={jobsClient.clientSheetId || ""}
          masterSheetId={jobsClient.masterSheetId || ""}
          targetJob={(() => {
            const j = assignModalConfig.job;
            const pRow = j?.rows?.[0] || j || {};
            const m = assignModalConfig.metrics || {};
            return {
              client: pRow.client || j?.client || "",
              jobName: pRow.jobName || j?.jobName || "",
              projectCode: pRow.projectCode || j?.projectCode || "",
              ...((pRow.jobUuid || j?.jobUuid) ? { jobUuid: pRow.jobUuid || j?.jobUuid } : {}),
              isRetainer: Boolean(assignModalConfig.isRetainer),
              startDate: pRow.startDate || "",
              endDate: pRow.endDate || "",
              revenue: m.revenue ?? 0,
              rechargedExpenses: m.rechargedExpenses ?? 0,
              directCosts: m.directCosts ?? 0,
              isJobCosting: Boolean(j?.isJobCosting),
              rowNum: pRow.rowNum || j?.rowNum,
              currentRealInvoiced: m.realInvoiced ?? 0,
              currentRealDirectCosts: m.realCostsReceived ?? 0,
            };
          })()}
          onCompleted={() => {
            if (jobsClient?.masterSheetId) {
              outgoingsPullPendingRef.current = jobsClient.masterSheetId;
            }
            loadJobsData(jobsClient, effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All", true);
          }}
        />
      )}
      {retainersEditJob && jobsClient && (
        <RetainersEditModal
          job={retainersEditJob}
          clientName={jobsClient.clientName || ""}
          clientSheetId={jobsClient.clientSheetId || ""}
          masterSheetId={jobsClient.masterSheetId || ""}
          onClose={() => setRetainersEditJob(null)}
          onRenamedInPlace={() => setRetainersEditJob(null)}
          onNeedsReload={() => {
            if (jobsClient?.masterSheetId) {
              outgoingsPullPendingRef.current = jobsClient.masterSheetId;
            }
            loadJobsData(jobsClient, effectiveViewMode === "legacy" ? (jobsTab || "Confirmed") : "All", true);
          }}
        />
      )}
    </>
  );
}