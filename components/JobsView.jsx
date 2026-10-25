import React, { useState, useMemo, useEffect, useRef } from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaJobsTableSkeleton } from "./Skeleton";
import UnevenSplitModal from "./UnevenSplitModal";
import InvoicesEditModal from "./InvoicesEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import JobsNewJobModal from "./JobsNewJobModal";
import EditClientSelector from "./EditClientSelector";
import CellNoteModal from "./CellNoteModal";
import NoteIndicatorButton from "./NoteIndicatorButton";
import CrmSyncBadge, { CrmSyncIcon } from "./CrmSyncBadge";
import PlaceholderPill, { isAutoPlaceholder } from "./PlaceholderPill";
import { useJobs } from "../hooks/useJobs";
import { useAppGlobals } from "../hooks/useAppGlobals";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  getRetainerRowMonthLabel,
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  isCrmDeal,
  getCrmDisplayName
} from "../utils/helpers";

export const parseSheetDate = (dStr) => {
  if (!dStr) return null;
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
  const s = String(dStr).trim();
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mIdx = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(yr, mIdx, day);
  }

  // 2. DD-Mon-YY or DD-Mon-YYYY
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mIdx = months[m[2].toLowerCase()];
    if (mIdx !== undefined) {
      let yr = parseInt(m[3], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      return new Date(yr, mIdx, parseInt(m[1], 10));
    }
  }

  // 3. Mon-YY or Mon-YYYY
  const myMatch = s.match(/^([A-Za-z]{3})[-/\s](\d{2,4})$/);
  if (myMatch) {
    const mIdx = months[myMatch[1].toLowerCase()];
    if (mIdx !== undefined) {
      let yr = parseInt(myMatch[2], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      return new Date(yr, mIdx, 1);
    }
  }

  // 4. DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
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
  const d = parseSheetDate(dStr);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const toSheetDateFormat = (dStr) => {
  if (!dStr) return "";
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
  ...rest
}) => {
  const inputRef = React.useRef(null);
  const isFocusedRef = React.useRef(false);
  const isCancelledRef = React.useRef(false);
  const isoValue = React.useMemo(() => toInputDateFormat(value), [value]);

  React.useEffect(() => {
    if (inputRef.current && !isFocusedRef.current) {
      inputRef.current.value = isoValue;
    }
  }, [isoValue]);

  const handleChange = (e) => {
    const newVal = e.target.value;
    if (newVal) {
      onChange(newVal);
    }
    // If newVal is "", the user is in an intermediate state while typing in Chrome.
    // We intentionally avoid updating the DOM node with empty string, preserving other segments.
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

    const finalVal = e.target.value;
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

/**
 * Searches across ALL parts of a job, including:
 * - Client name, job name, project code, product line, lead source, type, dates, likelihood
 * - Revenues, direct costs, VAT, left to invoice, costs outstanding, row numbers, notes
 * - All invoice slots (references / invoice numbers, amounts, dates, days to pay, status, notes)
 * - All expense slots (descriptions, transaction IDs / expense IDs, amounts, dates, VAT, status, notes)
 * - In-flight draft edits (unsaved values)
 */
export const isJobMatchSearch = (job, query, draftEdits = {}) => {
  if (!query || !query.trim()) return true;
  if (!job) return false;

  const q = query.toLowerCase().trim();
  const searchTokens = q.split(/\s+/).filter(Boolean);
  const parts = [];

  const add = (val) => {
    if (val !== null && val !== undefined) {
      const s = String(val).trim();
      if (s) parts.push(s.toLowerCase());
    }
  };

  // Top-level job properties
  add(job.client);
  add(job.jobName);
  add(job.projectCode);
  add(job.status);
  add(job.tabName);
  add(job.note);
  add(job.id);

  // In-memory draft edits for this job if any
  const jobKey = job.id || (job.rows?.[0] ? `${(job.tabName || job.rows[0].tabName || "").toLowerCase()}_${job.rows[0].rowNum}` : null);
  if (jobKey && draftEdits[jobKey]) {
    const draft = draftEdits[jobKey];
    Object.values(draft).forEach(add);
  }

  // Iterate over all rows and nested invoice/expense slots
  if (Array.isArray(job.rows)) {
    job.rows.forEach((r) => {
      if (!r) return;
      Object.entries(r).forEach(([key, val]) => {
        if (key === "invoiceSlots" || key === "expenseSlots") return;
        add(val);
      });

      // Invoice slots: refs / numbers, amounts, status, sentDate, daysToPay, note
      if (Array.isArray(r.invoiceSlots)) {
        r.invoiceSlots.forEach((inv) => {
          if (!inv) return;
          Object.values(inv).forEach(add);
        });
      }

      // Expense slots: description, transactionId, amount, vat, date, status, daysToPay, note
      if (Array.isArray(r.expenseSlots)) {
        r.expenseSlots.forEach((exp) => {
          if (!exp) return;
          Object.values(exp).forEach(add);
        });
      }
    });
  }

  const combinedText = parts.join(" ");

  // Direct substring match or all search tokens present
  if (combinedText.includes(q)) return true;
  if (searchTokens.length > 1 && searchTokens.every((tok) => combinedText.includes(tok))) {
    return true;
  }

  return false;
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

export const textMatchesQuery = (text, query) => {
  if (!text || !query || !query.trim()) return false;
  const q = query.toLowerCase().trim();
  const s = String(text).toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return s.includes(q) || tokens.some((t) => s.includes(t));
};

export const HighlightText = ({ text, query }) => {
  const str = text !== null && text !== undefined ? String(text) : "";
  if (!str || !query || !query.trim()) return <>{str}</>;

  const q = query.trim();
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (tokens.length === 0) return <>{str}</>;

  const regex = new RegExp(`(${tokens.join("|")})`, "gi");
  const parts = str.split(regex);

  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const isMatch = tokens.some((t) => t.toLowerCase() === part.toLowerCase());
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

export const getJobNestedMatches = (job, query, maxItems = 4) => {
  if (!job || !query || !query.trim()) return [];
  const matches = [];
  const seen = new Set();

  const addMatch = (label, matchText, title) => {
    if (!matchText) return;
    const key = `${label}:${String(matchText).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ label, matchText: String(matchText), title });
  };

  const pCode = job.projectCode || job.rows?.[0]?.projectCode;
  if (textMatchesQuery(pCode, query)) {
    addMatch("Code", pCode, `Matched project code: ${pCode}`);
  }

  if (Array.isArray(job.rows)) {
    job.rows.forEach((r) => {
      if (!r) return;
      if (textMatchesQuery(r.projectCode, query)) {
        addMatch("Code", r.projectCode, `Matched project code: ${r.projectCode}`);
      }
      if (textMatchesQuery(r.note, query)) {
        addMatch("Note", r.note, `Matched note: ${r.note}`);
      }
      if (textMatchesQuery(r.prodLine, query)) {
        addMatch("Prod. line", r.prodLine, `Matched product line: ${r.prodLine}`);
      }
      if (textMatchesQuery(r.leadSrc, query)) {
        addMatch("Lead src", r.leadSrc, `Matched lead source: ${r.leadSrc}`);
      }

      if (Array.isArray(r.invoiceSlots)) {
        r.invoiceSlots.forEach((inv) => {
          if (!inv) return;
          if (textMatchesQuery(inv.ref, query)) {
            const extra = inv.amount ? ` (${formatCurrency(inv.amount)})` : "";
            addMatch("Invoice", `${inv.ref}${extra}`, `Matched invoice ${inv.ref}`);
          }
          if (textMatchesQuery(inv.note, query)) {
            addMatch("Invoice note", inv.note, `Matched invoice note`);
          }
        });
      }

      if (Array.isArray(r.expenseSlots)) {
        r.expenseSlots.forEach((exp) => {
          if (!exp) return;
          if (textMatchesQuery(exp.transactionId, query)) {
            addMatch("Expense ID", exp.transactionId, `Matched expense ID: ${exp.transactionId}`);
          }
          if (textMatchesQuery(exp.description, query)) {
            const extra = exp.amount ? ` (${formatCurrency(exp.amount)})` : "";
            addMatch("Expense", `${exp.description}${extra}`, `Matched expense description: ${exp.description}`);
          }
          if (textMatchesQuery(exp.note, query)) {
            addMatch("Expense note", exp.note, `Matched expense note`);
          }
        });
      }
    });
  }

  if (textMatchesQuery(job.note, query)) {
    addMatch("Note", job.note, `Matched note: ${job.note}`);
  }

  return matches.slice(0, maxItems);
};

export const getJobInvoiceItems = (job, isRetainer) => {
  if (!job || !job.rows || job.rows.length === 0) return [];
  const items = [];

  if (isRetainer) {
    job.rows.forEach((r, rIdx) => {
      const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
      const slots = r.invoiceSlots || [];

      const mainSlot = slots.find((s) => s.slotNum === 1) || {
        slotNum: 1, amount: "", ref: "", sentDate: "", daysToPay: "", status: ""
      };
      items.push({
        id: `ret_inv_${r.rowNum}_1`,
        rowNum: r.rowNum,
        slotNum: 1,
        slot: mainSlot,
        row: r,
        label: monthLabel,
        subLabel: `Row ${r.rowNum}${mainSlot.sentDate ? ` · ${mainSlot.sentDate}` : ""}`
      });

      slots.filter((s) => s.slotNum > 1).forEach((extraSlot) => {
        const hasData = Boolean(
          (extraSlot.ref && String(extraSlot.ref).trim() !== "") ||
          (extraSlot.amount && String(extraSlot.amount).trim() !== "")
        );
        if (hasData) {
          const isPartPaid = String(extraSlot.status || "").toLowerCase().includes("part");
          const slotTag = isPartPaid ? `Part payment ${extraSlot.slotNum}` : `Extra inv ${extraSlot.slotNum}`;
          items.push({
            id: `ret_inv_${r.rowNum}_${extraSlot.slotNum}`,
            rowNum: r.rowNum,
            slotNum: extraSlot.slotNum,
            slot: extraSlot,
            row: r,
            label: `${monthLabel} (${slotTag})`,
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

export const getJobExpenseItems = (job, isRetainer) => {
  if (!job || !job.rows || job.rows.length === 0) return [];
  const items = [];

  if (isRetainer) {
    job.rows.forEach((r, rIdx) => {
      const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
      const slots = r.expenseSlots || [];

      slots.forEach((s) => {
        const hasData = Boolean(
          (s.description && String(s.description).trim() !== "") ||
          (s.amount && String(s.amount).trim() !== "") ||
          (s.transactionId && String(s.transactionId).trim() !== "")
        );
        if (hasData || (rIdx === 0 && s.slotNum === 1)) {
          items.push({
            id: `ret_exp_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            slot: s,
            row: r,
            label: s.slotNum === 1 ? `${monthLabel} Cost` : `${monthLabel} Cost ${s.slotNum}`,
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

export const getJobFinancialMetrics = (job, isRetainer, isConfirmed, currentRevVal, currentCostVal) => {
  if (!job || !job.rows || job.rows.length === 0) {
    return {
      revenue: 0,
      realInvoiced: 0,
      placeholderInvoiced: 0,
      leftToInvoice: 0,
      priorMonthsUninvoicedCount: 0,
      directCosts: 0,
      realCostsReceived: 0,
      placeholderCosts: 0,
      costsLeftToReceive: 0,
      priorMonthsUnreceivedCount: 0,
      isRetainer: false,
      isConfirmed: false
    };
  }

  const parentRow = job.rows[0];
  const tabName = job.tabName || parentRow.tabName || "Confirmed";
  const confirmed = isConfirmed !== undefined ? Boolean(isConfirmed) : (String(tabName).toLowerCase() === "confirmed");

  const rawRev = parseFloat(String(currentRevVal !== undefined ? currentRevVal : (parentRow.revenue || "0")).replace(/[£$€,\s]/g, "")) || 0;
  const rawCost = parseFloat(String(currentCostVal !== undefined ? currentCostVal : (parentRow.directCosts || "0")).replace(/[£$€,\s]/g, "")) || 0;

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
    const eDate = parseSheetDate(parentRow.endDate);
    let monthsCount = job.rows.length;
    if (sDate && eDate && eDate > sDate) {
      const diffDays = (eDate.getTime() - sDate.getTime()) / (24 * 60 * 60 * 1000);
      const diffMonths = Math.round(diffDays / 30.4375);
      monthsCount = Math.max(job.rows.length, diffMonths);
    }
    totalRevenue = rawRev * monthsCount;
    totalDirectCosts = rawCost * monthsCount;

    if (sDate) {
      let expectedPriorRevenue = 0;
      let expectedPriorCosts = 0;
      let priorPeriodsCount = 0;

      for (let p = 0; p < monthsCount; p++) {
        const nextPStart = addMonths(sDate, p + 1);
        const pEnd = new Date(nextPStart.getFullYear(), nextPStart.getMonth(), nextPStart.getDate() - 1, 23, 59, 59, 999);

        if (pEnd < now) {
          priorPeriodsCount++;
          const periodRev = job.rows[p]?.revenue ? (parseFloat(String(job.rows[p].revenue).replace(/[£$€,\s]/g, "")) || rawRev) : rawRev;
          expectedPriorRevenue += periodRev;

          const periodCost = job.rows[p]?.directCosts ? (parseFloat(String(job.rows[p].directCosts).replace(/[£$€,\s]/g, "")) || rawCost) : rawCost;
          expectedPriorCosts += periodCost;
        }
      }

      leftToInvoice = Math.max(0, expectedPriorRevenue - realInvoiced);
      priorMonthsUninvoicedCount = rawRev > 0 ? Math.ceil(leftToInvoice / rawRev) : (leftToInvoice > 0 ? 1 : 0);

      costsLeftToReceive = Math.max(0, expectedPriorCosts - realCostsReceived);
      priorMonthsUnreceivedCount = rawCost > 0 ? Math.ceil(costsLeftToReceive / rawCost) : (costsLeftToReceive > 0 ? 1 : 0);
    } else {
      leftToInvoice = 0;
      costsLeftToReceive = 0;
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
    priorMonthsUninvoicedCount,
    directCosts: totalDirectCosts,
    realCostsReceived,
    placeholderCosts,
    costsLeftToReceive,
    priorMonthsUnreceivedCount,
    isRetainer,
    isConfirmed: confirmed
  };
};

export default function JobsView({
  allOutgoingsClients,
  styles = {},
  managedClient,
  onClearManagedClient
}) {
  const { outgoingsPullPendingRef, assignedAppIds, setAssignedAppIds } = useAppGlobals();

  const {
    jobsClient, setJobsClient,
    jobsTab, setJobsTab,
    jobsSortBy, setJobsSortBy,
    jobsData, setJobsData,
    jobsLoading,
    jobsExpanded, setJobsExpanded,
    jobsEditSplit, setJobsEditSplit,
    productLines,
    leadSources,
    existingClients,
    hasAccountingIntegration,
    crmTool,
    crmDrives,
    loadJobsData
  } = useJobs(managedClient);

  const prevManagedClientRef = useRef(null);
  // Auto-select managedClient when in manage mode, or clear when manage mode cancelled
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
    } else if (prevManagedClientRef.current) {
      prevManagedClientRef.current = null;
      setJobsClient(null);
      setJobsData(null);
      setDraftEdits({});
      recentlyDeletedJobKeysRef.current.clear();
      recentlyDeletedJobRowsRef.current.clear();
    }
  }, [managedClient, allOutgoingsClients, jobsClient?.clientSheetId]);

  // Mode: "modern" (default, user-friendly combined view) or "legacy" (spreadsheet view for admins)
  const [viewMode, setViewMode] = useState("modern");

  // Modern view filter: 'all' | 'confirmed' | 'pipeline'
  const [filterType, setFilterType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showZeroPercentJobs, setShowZeroPercentJobs] = useState(false);

  // Set of expanded job IDs in modern view
  const [expandedJobIds, setExpandedJobIds] = useState(() => new Set());

  // Draft edits keyed by job identifier: { [jobKey]: { [field]: newValue } }
  const [draftEdits, setDraftEdits] = useState({});

  // Loading / saving states
  const [savingJobKeys, setSavingJobKeys] = useState(() => new Set());
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
  const [cellNoteModalConfig, setCellNoteModalConfig] = useState(null);

  const openJobNoteModal = (job) => {
    const parentRow = job.rows?.[0] || {};
    const tabName = job.tabName || parentRow.tabName || "Confirmed";
    const currentNote = job.note || parentRow.note || "";
    setCellNoteModalConfig({
      isOpen: true,
      title: "Job note",
      subtitle: `${job.client || parentRow.client || ""} · ${job.jobName || parentRow.jobName || ""} (${tabName} Row ${parentRow.rowNum})`,
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

    setCellNoteModalConfig({
      isOpen: true,
      title: type === "invoice" ? `Invoice note (${item.label})` : `Direct cost note (${item.label})`,
      subtitle: `${job?.client || ""} · ${job?.jobName || ""} (${tabName} Row ${rowNum})`,
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

  // Helper to extract a job key
  const getJobKey = (job) => {
    if (!job) return "";
    return job.id || `${job.tabName || "confirmed"}_${job.rows?.[0]?.rowNum || 0}`;
  };

  // Check if a specific job has unsaved changes
  const isJobDirty = (jobKey) => {
    return Boolean(draftEdits[jobKey] && Object.keys(draftEdits[jobKey]).length > 0);
  };

  // Helper to check if a job belongs to Pipeline
  const isPipelineJob = (job) => {
    if (!job) return false;
    const tab = String(job.tabName || job.status || job.rows?.[0]?.tabName || "").toLowerCase();
    return tab === "pipeline" || tab.includes("pipe");
  };

  // Helper to check if a pipeline job was copied to Confirmed tab (Column DD == "Yes")
  const isJobCopiedToConfirmed = (job) => {
    if (!job || !isPipelineJob(job)) return false;
    const parentRow = job.rows?.[0] || {};
    const copiedVal = String(job.copiedToConf || parentRow.copiedToConf || "").trim().toLowerCase();
    return copiedVal === "yes" || copiedVal === "y";
  };

  // Helper to check if a pipeline job has 0% likelihood
  const isJobZeroPercent = (job) => {
    if (!job || !isPipelineJob(job)) return false;
    const jobKey = getJobKey(job);
    // If the user has an active draft edit on this job, keep it visible while editing so they can save
    const hasDraft = draftEdits[jobKey]?.likelihood !== undefined;
    if (hasDraft) return false;

    const parentRow = job.rows?.[0] || {};
    const lVal = parseLikelihoodValue(parentRow.likelihood ?? job.likelihood);
    return lVal !== null && lVal === 0;
  };

  // Get field value (from draft if edited, otherwise from sheet data)
  const getJobFieldValue = (job, fieldKey) => {
    const jobKey = getJobKey(job);
    const parentRow = job?.rows?.[0] || {};
    if (draftEdits[jobKey] && draftEdits[jobKey][fieldKey] !== undefined) {
      return draftEdits[jobKey][fieldKey];
    }
    return parentRow[fieldKey] !== undefined ? parentRow[fieldKey] : "";
  };

  // Helper to extract parsed Date Confirmed for a job on Confirmed tab
  const getJobDateConf = (job) => {
    if (!job) return null;
    const tab = String(job.tabName || job.status || job.rows?.[0]?.tabName || "Confirmed").toLowerCase();
    const isConfirmed = tab === "confirmed" || (!tab.includes("pipeline") && !tab.includes("pipe"));
    if (!isConfirmed) return null;
    const rawVal = getJobFieldValue(job, "dateConf") || job.dateConf || job.rows?.[0]?.dateConf;
    return rawVal ? parseSheetDate(rawVal) : null;
  };

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
  }, [jobsData, draftEdits]);

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
    Object.keys(currentDraft).forEach((fieldKey) => {
      if (fieldsToExclude.includes(fieldKey)) return;
      const meta = FIELD_MAP[fieldKey];
      if (!meta) return;
      let val = currentDraft[fieldKey];
      if (meta.isDate && val) {
        val = toSheetDateFormat(val);
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
          pipelineRow: pipelineRowNum
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

      // 4. Reload jobs data
      await loadJobsData(jobsClient, "All");
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
      const targetLikelihood = optionalLikelihood || currentDraft.likelihood;

      const payload = {
        clientSheetId: jobsClient.clientSheetId,
        clientName: jobsClient.clientName || jobsClient.name || "",
        confirmedRow: confirmedRowNum
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

      // Reload jobs data
      await loadJobsData(jobsClient, "All");
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

      // Reload jobs data
      await loadJobsData(jobsClient, "All");
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

    // 1. Record in tombstone refs to defend against stale Google Sheets API reads
    recentlyDeletedJobKeysRef.current.add(jobKey);
    if (job.id) recentlyDeletedJobKeysRef.current.add(job.id);
    if (!recentlyDeletedJobRowsRef.current.has(tabLower)) {
      recentlyDeletedJobRowsRef.current.set(tabLower, new Set());
    }
    rowNums.forEach((rn) => recentlyDeletedJobRowsRef.current.get(tabLower).add(Number(rn)));

    // 2. Immediately remove job optimistically from local jobsData state
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

    // 3. Close delete modal immediately and clear selection / draft states
    setDeletingJob(null);
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
          jobName: parentRow?.jobName || job.jobName || "",
          endClientName: parentRow?.client || job.client || "",
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to delete job");
      }

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

      // Reload jobs data from server to keep counts and surrounding data synchronized
      await loadJobsData(jobsClient, "All");
    } catch (err) {
      console.error("Delete job error:", err);
      setActionError(`Failed to delete ${job.jobName || "job"}: ${err.message}`);
      // Re-sync with server if error occurred
      await loadJobsData(jobsClient, "All");
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
              status: inv.status || "Sent"
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
      likelihood: { colLetter: "AN", fieldName: "Likelihood" }
    };

    const updates = [];
    Object.keys(currentDraft).forEach((fieldKey) => {
      const meta = FIELD_MAP[fieldKey];
      if (!meta) return;
      let val = currentDraft[fieldKey];
      if (meta.isDate && val) {
        val = toSheetDateFormat(val);
      }
      updates.push({
        colLetter: meta.colLetter,
        rowNum: parentRowNum,
        cellRef: `${meta.colLetter}${parentRowNum}`,
        fieldName: meta.fieldName,
        value: val
      });

      // If client name or job name changed, also update child rows to keep sheet synchronized
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

    if (updates.length === 0) return;

    setActionError(null);
    setSavingJobKeys((prev) => new Set(prev).add(jobKey));

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId: jobsClient.clientSheetId,
          clientName: jobsClient.clientName || jobsClient.name || "",
          tabName,
          rowNum: parentRowNum,
          endClientName: currentDraft.client || parentRow.client || job.client,
          jobName: currentDraft.jobName || parentRow.jobName || job.jobName,
          updates
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update job");
      }

      // Optimistically update local jobsData
      setJobsData((prevJobs) => {
        if (!prevJobs) return prevJobs;
        return prevJobs.map((j) => {
          if (getJobKey(j) !== jobKey) return j;
          const updatedRows = j.rows.map((r, rIdx) => {
            const nextRow = { ...r };
            Object.keys(currentDraft).forEach((f) => {
              let nextVal = currentDraft[f];
              if (FIELD_MAP[f]?.isDate && nextVal) nextVal = toSheetDateFormat(nextVal);
              if (rIdx === 0 || f === "client" || f === "jobName") {
                nextRow[f] = nextVal;
              }
            });
            return nextRow;
          });
          return {
            ...j,
            client: currentDraft.client || j.client,
            jobName: currentDraft.jobName || j.jobName,
            projectCode: currentDraft.projectCode !== undefined ? currentDraft.projectCode : j.projectCode,
            rows: updatedRows
          };
        });
      });

      // Clear draft for this job
      setDraftEdits((prev) => {
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
    } catch (err) {
      console.error("Save job failed:", err);
      setActionError(`Save failed for ${job.jobName || "job"}: ${err.message}`);
    } finally {
      setSavingJobKeys((prev) => {
        const next = new Set(prev);
        next.delete(jobKey);
        return next;
      });
    }
  };

  // Filtered and sorted jobs list
  const processedJobs = useMemo(() => {
    if (!jobsData || !Array.isArray(jobsData)) return [];
    let list = [...jobsData];

    // Exclude any jobs that have been deleted in this session (defending against stale Google Sheets API reads)
    list = list.filter((j) => {
      const k = getJobKey(j);
      if (recentlyDeletedJobKeysRef.current.has(k) || (j.id && recentlyDeletedJobKeysRef.current.has(j.id))) return false;
      const jTab = (j.tabName || j.rows?.[0]?.tabName || "").toLowerCase();
      const jRowNum = Number(j.rows?.[0]?.rowNum);
      if (jTab && jRowNum && recentlyDeletedJobRowsRef.current.get(jTab)?.has(jRowNum)) return false;
      return true;
    });

    // Exclude pipeline jobs that have been copied to confirmed tab (Column DD == "Yes")
    list = list.filter((j) => !isJobCopiedToConfirmed(j));

    // Exclude 0% likelihood pipeline jobs unless showZeroPercentJobs is true
    if (!showZeroPercentJobs) {
      list = list.filter((j) => !isJobZeroPercent(j));
    }

    // 1. Filter by Confirmed / Pipeline in modern view
    if (viewMode === "modern") {
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
      }
    } else {
      // In legacy view, filter by jobsTab ("Confirmed" or "Pipeline" or "All")
      if (jobsTab && jobsTab.toLowerCase() !== "all") {
        list = list.filter((j) => {
          const tab = String(j.tabName || j.status || j.rows?.[0]?.tabName || "Confirmed").toLowerCase();
          return tab === jobsTab.toLowerCase();
        });
      }
    }

    // Filter by search query across ALL parts of the job (client, job name, project code, invoice numbers, expense IDs, expense descriptions, etc.)
    if (searchQuery.trim()) {
      list = list.filter((j) => isJobMatchSearch(j, searchQuery, draftEdits));
    }

    // 2. Sort jobs
    return list.sort((a, b) => {
      const rowA = a.rows?.[0] || {};
      const rowB = b.rows?.[0] || {};

      switch (jobsSortBy) {
        case "startDateAsc": {
          const da = parseSheetDate(rowA.startDate);
          const db = parseSheetDate(rowB.startDate);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          return da.getTime() - db.getTime();
        }
        case "endDateDesc": {
          const da = parseSheetDate(rowA.endDate);
          const db = parseSheetDate(rowB.endDate);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          return db.getTime() - da.getTime();
        }
        case "endDateAsc": {
          const da = parseSheetDate(rowA.endDate);
          const db = parseSheetDate(rowB.endDate);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          return da.getTime() - db.getTime();
        }
        case "dateConfDesc": {
          const da = getJobDateConf(a);
          const db = getJobDateConf(b);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          const diff = db.getTime() - da.getTime();
          return diff !== 0 ? diff : (rowA.rowNum || 0) - (rowB.rowNum || 0);
        }
        case "dateConfAsc": {
          const da = getJobDateConf(a);
          const db = getJobDateConf(b);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          const diff = da.getTime() - db.getTime();
          return diff !== 0 ? diff : (rowA.rowNum || 0) - (rowB.rowNum || 0);
        }
        case "revDesc": {
          const revA = parseFloat(String(rowA.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
          const revB = parseFloat(String(rowB.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
          return revB - revA;
        }
        case "revAsc": {
          const revA = parseFloat(String(rowA.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
          const revB = parseFloat(String(rowB.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
          return revA - revB;
        }
        case "clientName": {
          const nameA = String(a.client || rowA.client || "").trim();
          const nameB = String(b.client || rowB.client || "").trim();
          const cmp = nameA.localeCompare(nameB, undefined, { sensitivity: "base", numeric: true });
          if (cmp !== 0) return cmp;
          const jobA = String(a.jobName || rowA.jobName || "").trim();
          const jobB = String(b.jobName || rowB.jobName || "").trim();
          return jobA.localeCompare(jobB, undefined, { sensitivity: "base", numeric: true });
        }
        case "likelihoodDesc": {
          const lA = parseFloat(String(rowA.likelihood || "0").replace(/[^0-9.-]/g, "")) || 0;
          const lB = parseFloat(String(rowB.likelihood || "0").replace(/[^0-9.-]/g, "")) || 0;
          return lB - lA;
        }
        case "rowNumber": {
          return (rowA.rowNum || 0) - (rowB.rowNum || 0);
        }
        case "startDateDesc":
        default: {
          const da = parseSheetDate(rowA.startDate);
          const db = parseSheetDate(rowB.startDate);
          if (!da && !db) return (rowA.rowNum || 0) - (rowB.rowNum || 0);
          if (!da) return 1;
          if (!db) return -1;
          return db.getTime() - da.getTime();
        }
      }
    });
  }, [jobsData, viewMode, filterType, jobsTab, searchQuery, jobsSortBy, showZeroPercentJobs, draftEdits]);

  // Counts for filter pills
  const counts = useMemo(() => {
    if (!jobsData || !Array.isArray(jobsData)) return { all: 0, confirmed: 0, pipeline: 0 };
    let conf = 0;
    let pipe = 0;
    jobsData.forEach((j) => {
      const k = getJobKey(j);
      if (recentlyDeletedJobKeysRef.current.has(k) || (j.id && recentlyDeletedJobKeysRef.current.has(j.id))) return;
      const jTab = (j.tabName || j.rows?.[0]?.tabName || "").toLowerCase();
      const jRowNum = Number(j.rows?.[0]?.rowNum);
      if (jTab && jRowNum && recentlyDeletedJobRowsRef.current.get(jTab)?.has(jRowNum)) return;

      // Exclude pipeline jobs copied to confirmed tab
      if (isJobCopiedToConfirmed(j)) return;

      const isPipe = isPipelineJob(j);

      // Exclude 0% likelihood pipeline jobs unless showZeroPercentJobs is true
      if (isPipe && !showZeroPercentJobs && isJobZeroPercent(j)) {
        return;
      }

      // If search query is active, only count matching jobs
      if (searchQuery.trim() && !isJobMatchSearch(j, searchQuery, draftEdits)) {
        return;
      }

      if (isPipe) pipe++;
      else conf++;
    });
    return { all: conf + pipe, confirmed: conf, pipeline: pipe };
  }, [jobsData, showZeroPercentJobs, draftEdits, searchQuery]);

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
    let targetEndClient = "";
    let targetJobName = "";
    if (jobsData) {
      for (const job of jobsData) {
        const matchRow = (job.rows || []).find((r) => r.rowNum === rowNum);
        if (matchRow) {
          targetEndClient = matchRow.client || job.client || "";
          targetJobName = matchRow.jobName || job.jobName || "";
          break;
        }
      }
    }

    const FIELD_NAMES = {
      A: "Client", B: "Job Name", C: "Project Code", D: "Date Confirmed",
      E: "Lead Source", AE: "Revenue Split", AG: "Revenue", AH: "Direct Costs",
      AI: "VAT", AJ: "Type", AK: "Product Line", AL: "Start Date",
      AM: "End Date", AN: "Likelihood", DD: "Copied to Confirmed"
    };
    const fieldName = FIELD_NAMES[colLetter] || `Field ${colLetter}`;

    setJobsData((prev) =>
      prev.map((job) => ({
        ...job,
        rows: job.rows.map((r) => {
          if (r.rowNum !== rowNum) return r;
          const updated = { ...r };
          if (colLetter === "A") updated.client = newValue;
          if (colLetter === "B") updated.jobName = newValue;
          if (colLetter === "C") updated.projectCode = newValue;
          if (colLetter === "AG") updated.revenue = newValue;
          if (colLetter === "AH") updated.directCosts = newValue;
          if (colLetter === "AI") updated.vat = newValue;
          if (colLetter === "AJ") updated.projectRetainer = newValue;
          if (colLetter === "AL") updated.startDate = newValue;
          if (colLetter === "AM") updated.endDate = newValue;
          if (colLetter === "AN") updated.likelihood = newValue;
          if (colLetter === "DD") updated.copiedToConf = newValue;
          if (colLetter === "D") updated.dateConf = newValue;
          if (colLetter === "E") updated.leadSrc = newValue;
          if (colLetter === "AK") updated.prodLine = newValue;
          return updated;
        })
      }))
    );

    try {
      await fetch("/api/triage", {
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
          fieldName,
          endClientName: targetEndClient,
          jobName: targetJobName,
          value: newValue
        })
      });
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
                <input
                  type="text"
                  placeholder="Search destination jobs by client or job name..."
                  value={deleteJobMoveSearch}
                  onChange={(e) => setDeleteJobMoveSearch(e.target.value)}
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
                <div style={{ marginBottom: "6px" }}>
                  <span style={{ color: "#7f1d1d", fontWeight: "600", display: "inline-block", width: "70px" }}>Tab:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{deletingJob.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed")}</span>
                </div>
                <div>
                  <span style={{ color: "#7f1d1d", fontWeight: "600", display: "inline-block", width: "70px" }}>Rows:</span>
                  <span style={{ color: "#475569" }}>
                    {deletingJob.rows?.map(r => `Row ${r.rowNum}`).join(", ") || `Row ${deletingJob.rows?.[0]?.rowNum || "—"}`}
                  </span>
                </div>
              </div>

              {deletingJobRealInvoices.length > 0 && (
                <div style={{ background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "12.5px" }}>
                  <div style={{ fontWeight: "700", color: "#92400e", marginBottom: "6px" }}>
                    This job contains {deletingJobRealInvoices.length} active invoice{deletingJobRealInvoices.length > 1 ? "s" : ""}:
                  </div>
                  <ul style={{ margin: "0 0 10px 0", paddingLeft: "18px", fontSize: "12px", color: "#78350f" }}>
                    {deletingJobRealInvoices.map((inv, idx) => (
                      <li key={idx}>
                        <strong>{inv.ref}</strong> — {inv.amount ? formatCurrency(inv.amount) : "£0.00"} ({inv.status || "Sent"})
                      </li>
                    ))}
                  </ul>
                  <div style={{ fontSize: "12px", color: "#92400e", lineHeight: "1.45" }}>
                    Would you like to move {deletingJobRealInvoices.length > 1 ? "these invoices" : "this invoice"} to a different job before deleting? If you choose not to, {deletingJobRealInvoices.length > 1 ? "they" : "it"} will immediately return to your &ldquo;invoices to assign&rdquo; list and create a missing invoice alert.
                  </div>
                </div>
              )}

              <div style={{ fontSize: "12px", color: "#64748b", lineHeight: "1.45", marginBottom: "20px" }}>
                ⚠️ The job will be removed entirely from the sheet by clearing the relevant cells on the row (preserving all formula columns, formatting, and surrounding structure). This action cannot be undone.
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
          hasAccountingIntegration={hasAccountingIntegration}
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => (outgoingsPullPendingRef.current = masterId)}
          onInvoiceMoved={async () => {
            await loadJobsData(jobsClient, "All");
          }}
          onUpdateInvoiceJobs={(rNum, sNum, newData, resData) => {
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
                return {
                  ...updatedJob,
                  rows: updatedJob.rows.map((r) =>
                    r.rowNum !== rNum
                      ? r
                      : {
                        ...r,
                        invoiceSlots: r.invoiceSlots.map((sl) =>
                          sl.slotNum !== sNum ? sl : { ...sl, ...newData }
                        )
                      }
                  )
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
          onUpdateJobs={(rNum, sNum, newData) => {
            setJobsData((prev) =>
              prev &&
              prev.map((j) => ({
                ...j,
                rows: j.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                      ...r,
                      expenseSlots: r.expenseSlots.map((sl) =>
                        sl.slotNum !== sNum ? sl : { ...sl, ...newData }
                      )
                    }
                )
              }))
            );
          }}
        />
      )}

      {showAddJobModal && (
        <JobsNewJobModal
          jobsClient={jobsClient}
          initialTab={filterType === "pipeline" ? "Pipeline" : "Confirmed"}
          productLines={productLines}
          leadSources={leadSources}
          existingClients={existingClients}
          onClose={() => setShowAddJobModal(false)}
          onSuccess={(targetTab, targetRow) => {
            setShowAddJobModal(false);
            if (targetTab) {
              setFilterType(targetTab.toLowerCase() === "pipeline" ? "pipeline" : "confirmed");
            }
            setSearchQuery("");
            loadJobsData(jobsClient, "All");
            if (targetRow && targetTab) {
              const newKey = `${targetTab.toLowerCase()}_${targetRow}`;
              setRecentlySavedKeys((prev) => new Set(prev).add(newKey));
              setExpandedJobIds((prev) => new Set(prev).add(newKey));
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

      <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
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
                {jobsClient && (
                  <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "12px", fontWeight: "600" }}>
                    {viewMode === "modern" ? "Modern view" : "Legacy view"}
                  </span>
                )}
              </h1>
              {jobsClient ? (
                <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {jobsClient.clientName}
                </div>
              ) : (
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                  Select a client to view and manage jobs
                </p>
              )}
            </div>
          </div>

          {jobsClient && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              {/* Legacy View Toggle Button */}
              <button
                type="button"
                onClick={() => setViewMode((prev) => (prev === "modern" ? "legacy" : "modern"))}
                style={{
                  padding: "7px 14px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: viewMode === "legacy" ? "#0f172a" : "#ffffff",
                  color: viewMode === "legacy" ? "#ffffff" : "#334155",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                }}
                title={viewMode === "modern" ? "Switch to traditional spreadsheet view" : "Switch to improved modern view"}
              >
                <span>{viewMode === "modern" ? "📋 Legacy view" : "✨ Modern view"}</span>
              </button>

              {/* Add job Button */}
              <button
                type="button"
                onClick={() => setShowAddJobModal(true)}
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
              setJobsClient(c);
              loadJobsData(c, "All");
            }}
            loading={jobsLoading}
            title="Select a client to view and manage jobs:"
          />
        )}

        {/* Main Content when Client is selected */}
        {!noJobsClient && (
          <>
            {/* ========================================================================= */}
            {/* MODERN VIEW                                                               */}
            {/* ========================================================================= */}
            {viewMode === "modern" && (
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

                    {/* Secondary controls: Show 0% jobs, Sort, Refresh */}
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

                      {/* Sort Select */}
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#64748b" }}>Sort:</label>
                        <select
                          value={jobsSortBy}
                          onChange={(e) => setJobsSortBy(e.target.value)}
                          style={{
                            padding: "5px 10px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            fontSize: "13px",
                            fontWeight: "500",
                            color: "#1e293b",
                            background: "#ffffff",
                            cursor: "pointer",
                            outline: "none"
                          }}
                        >
                          <option value="startDateDesc">Start Date (Newest first)</option>
                          <option value="startDateAsc">Start Date (Oldest first)</option>
                          <option value="endDateDesc">End Date (Newest first)</option>
                          <option value="endDateAsc">End Date (Oldest first)</option>
                          {hasDateConfirmed && (
                            <>
                              <option value="dateConfDesc">Date confirmed (descending)</option>
                              <option value="dateConfAsc">Date confirmed (ascending)</option>
                            </>
                          )}
                          <option value="revDesc">Revenue (Highest first)</option>
                          <option value="revAsc">Revenue (Lowest first)</option>
                          <option value="clientName">Client Name (A - Z)</option>
                          <option value="likelihoodDesc">% Likelihood (Highest first)</option>
                        </select>
                      </div>

                      {/* Refresh Button */}
                      <button
                        type="button"
                        onClick={() => loadJobsData(jobsClient, "All")}
                        disabled={jobsLoading}
                        style={{
                          background: "none",
                          border: "1px solid #e2e8f0",
                          padding: "5px 10px",
                          borderRadius: "6px",
                          color: "#475569",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: "500",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px"
                        }}
                      >
                        {jobsLoading ? <><Spinner size={12} /> Refreshing</> : "↻ Refresh"}
                      </button>
                    </div>
                  </div>

                  {/* Second row: Search bar on its own line below the selector */}
                  <div style={{ position: "relative", width: "100%" }}>
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
                    <input
                      type="text"
                      placeholder="Search jobs by client, job name, project code, invoice number, expense ID, or description..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setSearchQuery("");
                      }}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "8px 36px 8px 36px",
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
                    />
                    {searchQuery ? (
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
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
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
                      </div>
                    ) : null}
                  </div>
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
                        You have unsaved changes across <strong>{dirtyCount} {dirtyCount === 1 ? "job" : "jobs"}</strong>. Click &ldquo;Save&rdquo; on any modified row to commit changes to the spreadsheet.
                      </span>
                    </div>
                  </div>
                )}

                {/* Loading State */}
                {(jobsLoading || !jobsData) ? (
                  <PmaJobsTableSkeleton />
                ) : processedJobs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "48px 0", background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", color: "#64748b" }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", color: "#334155", marginBottom: "4px" }}>No jobs found</div>
                    <div style={{ fontSize: "13px" }}>
                      {searchQuery ? `No jobs matched query "${searchQuery}".` : `No ${filterType === "all" ? "" : filterType} jobs found for this client.`}
                    </div>
                  </div>
                ) : (
                  /* Modern Table Container */
                  <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left", minWidth: "1220px" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontWeight: "600", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                          <th style={{ padding: "10px 10px", width: "36px", textAlign: "center" }}></th>
                          <th style={{ padding: "10px 10px", width: "95px" }}>Status</th>
                          <th style={{ padding: "10px 4px", width: "36px", textAlign: "center" }} title="Job notes"></th>
                          <th style={{ padding: "10px 10px", width: "160px" }}>Client</th>
                          <th style={{ padding: "10px 10px", width: "210px" }}>Job Name</th>
                          <th style={{ padding: "10px 10px", width: "115px" }}>Type</th>
                          <th style={{ padding: "10px 10px", width: "125px" }}>Revenue</th>
                          <th style={{ padding: "10px 10px", width: "125px" }}>Direct Costs</th>
                          <th style={{ padding: "10px 10px", width: "130px" }}>Start Date</th>
                          <th style={{ padding: "10px 10px", width: "130px" }}>End Date</th>
                          <th style={{ padding: "10px 10px", width: "100px" }}>Likelihood</th>
                          <th style={{ padding: "10px 12px", width: "110px", textAlign: "right" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processedJobs.map((job) => {
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
                          const unevenSplitVal = getJobFieldValue(job, "unevenSplit") || parentRow.unevenSplit || "";
                          const leftToInvoiceVal = parentRow.leftToInvoice || "";
                          const costsOutstandingVal = parentRow.costsOutstanding || "";

                          // Calculate real revenue and direct cost metrics strictly excluding gap sweep placeholders
                          const metrics = getJobFinancialMetrics(job, isRetainer, isConfirmed, revVal, directCostsVal);

                          // Distinct product line and lead source options including current value
                          const plOptions = Array.from(new Set([...(productLines || []), prodLineVal].filter(Boolean))).sort();
                          const lsOptions = Array.from(new Set([...(leadSources || []), leadSrcVal].filter(Boolean))).sort();
                          const nestedMatches = searchQuery.trim() ? getJobNestedMatches(job, searchQuery) : [];

                          return (
                            <React.Fragment key={jobKey}>
                              {/* Main Job Row */}
                              <tr
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
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <input
                                    type="text"
                                    value={clientVal}
                                    onChange={(e) => handleDraftFieldChange(job, "client", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "client")}
                                    placeholder="Client Name"
                                    style={{
                                      width: "100%",
                                      padding: "4px 6px",
                                      borderRadius: "5px",
                                      border: isDirty && draftEdits[jobKey]?.client !== undefined ? "1px solid #f59e0b" : "1px solid transparent",
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
                                      e.target.style.borderColor = isDirty && draftEdits[jobKey]?.client !== undefined ? "#f59e0b" : "transparent";
                                    }}
                                  />
                                  {searchQuery.trim() && textMatchesQuery(clientVal, searchQuery) && (
                                    <div style={{ fontSize: "11px", marginTop: "2px", color: "#64748b", paddingLeft: "6px" }}>
                                      <HighlightText text={clientVal} query={searchQuery} />
                                    </div>
                                  )}
                                </td>

                                {/* Job Name (Inline Editable) */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <input
                                    type="text"
                                    value={jobNameVal}
                                    onChange={(e) => handleDraftFieldChange(job, "jobName", e.target.value)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "jobName")}
                                    placeholder="Job Name"
                                    style={{
                                      width: "100%",
                                      padding: "4px 6px",
                                      borderRadius: "5px",
                                      border: isDirty && draftEdits[jobKey]?.jobName !== undefined ? "1px solid #f59e0b" : "1px solid transparent",
                                      background: "transparent",
                                      fontSize: "13px",
                                      fontWeight: "500",
                                      color: "#334155",
                                      outline: "none",
                                      boxSizing: "border-box"
                                    }}
                                    onFocus={(e) => {
                                      e.target.style.background = "#ffffff";
                                      e.target.style.borderColor = "#3b82f6";
                                    }}
                                    onBlur={(e) => {
                                      e.target.style.background = "transparent";
                                      e.target.style.borderColor = isDirty && draftEdits[jobKey]?.jobName !== undefined ? "#f59e0b" : "transparent";
                                    }}
                                  />
                                  {searchQuery.trim() && textMatchesQuery(jobNameVal, searchQuery) && (
                                    <div style={{ fontSize: "11px", marginTop: "2px", color: "#64748b", paddingLeft: "6px" }}>
                                      <HighlightText text={jobNameVal} query={searchQuery} />
                                    </div>
                                  )}
                                  {nestedMatches.length > 0 && (
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "3px", paddingLeft: "4px" }}>
                                      {nestedMatches.map((m, i) => (
                                        <span
                                          key={i}
                                          style={{
                                            fontSize: "11px",
                                            lineHeight: "1.3",
                                            background: "#fefce8",
                                            border: "1px solid #fef08a",
                                            color: "#713f12",
                                            padding: "1px 6px",
                                            borderRadius: "4px",
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "3px"
                                          }}
                                          title={m.title}
                                        >
                                          <span style={{ fontSize: "10px", color: "#a16207", fontWeight: "600" }}>{m.label}:</span>
                                          <HighlightText text={m.matchText} query={searchQuery} />
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </td>

                                {/* Job Type (Project / Retainer) */}
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
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
                                      }}
                                    />
                                  </div>
                                  {isConfirmed && metrics.revenue > 0 && (
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
                                              ? `Prior month unbilled revenue: ${formatCurrency(metrics.leftToInvoice)} (${metrics.priorMonthsUninvoicedCount} prior month${metrics.priorMonthsUninvoicedCount === 1 ? "" : "s"} uninvoiced) · Real Invoiced to date: ${formatCurrency(metrics.realInvoiced)}`
                                              : `Total Revenue: ${formatCurrency(metrics.revenue)} · Real Invoiced: ${formatCurrency(metrics.realInvoiced)} · Excludes ${formatCurrency(metrics.placeholderInvoiced)} in gap placeholders`
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
                                            title={`Total Revenue: ${formatCurrency(metrics.revenue)} · Real Invoiced: ${formatCurrency(metrics.realInvoiced)}`}
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
                                              ? `Prior month unreceived costs: ${formatCurrency(metrics.costsLeftToReceive)} (${metrics.priorMonthsUnreceivedCount} prior month${metrics.priorMonthsUnreceivedCount === 1 ? "" : "s"} unreceived) · Real Costs to date: ${formatCurrency(metrics.realCostsReceived)}`
                                              : `Budget: ${formatCurrency(metrics.directCosts)} · Real Received: ${formatCurrency(metrics.realCostsReceived)} · Excludes ${formatCurrency(metrics.placeholderCosts)} in gap placeholders`
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
                                            title={`Budget: ${formatCurrency(metrics.directCosts)} · 100% Received`}
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
                                <td style={{ padding: "9px 10px", verticalAlign: "middle" }}>
                                  <JobDateInput
                                    value={endDateVal}
                                    onChange={(val) => handleDraftFieldChange(job, "endDate", val)}
                                    onKeyDown={(e) => handleFieldKeyDown(e, job, "endDate")}
                                    isDirty={isDirty && draftEdits[jobKey]?.endDate !== undefined}
                                    title={isJobFromCrm ? `Synced with ${crmDisplayName}: Changes to data will be overwritten by CRM data at the next sync.` : undefined}
                                  />
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
                              {isExpanded && (
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
                                              {searchQuery.trim() && textMatchesQuery(projectCodeVal, searchQuery) && (
                                                <div style={{ fontSize: "11px", color: "#a16207", marginTop: "2px" }}>
                                                  Match: <HighlightText text={projectCodeVal} query={searchQuery} />
                                                </div>
                                              )}
                                            </div>

                                            {/* Uneven Revenue Split */}
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
                                                    Configure Split
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        </div>

                                        {/* Card 2: Invoices */}
                                        {(() => {
                                          const invoiceItems = getJobInvoiceItems(job, isRetainer);
                                          return (
                                            <div
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
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                                                <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                                  Invoices ({invoiceItems.length})
                                                </div>
                                                {isConfirmed && metrics.revenue > 0 && (
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
                                                          ? `Prior month unbilled revenue: ${formatCurrency(metrics.leftToInvoice)} (${metrics.priorMonthsUninvoicedCount} prior month${metrics.priorMonthsUninvoicedCount === 1 ? "" : "s"} uninvoiced) · Real Invoiced to date: ${formatCurrency(metrics.realInvoiced)}`
                                                          : `Total Revenue: ${formatCurrency(metrics.revenue)} · Real Invoiced: ${formatCurrency(metrics.realInvoiced)} · Excludes ${formatCurrency(metrics.placeholderInvoiced)} in gap placeholders`
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
                                                        title={`Total Revenue: ${formatCurrency(metrics.revenue)} · 100% Invoiced (${formatCurrency(metrics.realInvoiced)})`}
                                                      >
                                                        <span>✓</span> Fully invoiced
                                                      </span>
                                                    )
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
                                                    const isInvoiceMatched = searchQuery.trim() && (textMatchesQuery(slot.ref, searchQuery) || textMatchesQuery(slot.note, searchQuery) || textMatchesQuery(slot.status, searchQuery));
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
                                                            tabName: item.row.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
                                                            job,
                                                          });
                                                        }}
                                                        style={{
                                                          padding: "8px 10px",
                                                          borderRadius: "6px",
                                                          border: isInvoiceMatched ? "1px solid #fde047" : "1px solid #e2e8f0",
                                                          background: isInvoiceMatched ? "#fefce8" : (hasData ? "#f8fafc" : "#ffffff"),
                                                          cursor: "pointer",
                                                          transition: "border-color 0.15s ease"
                                                        }}
                                                        title={
                                                          hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== ""
                                                            ? "Synced from accounting software. Click to view or edit days to pay."
                                                            : "Click to edit invoice slot"
                                                        }
                                                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#93c5fd"; e.currentTarget.style.background = "#eff6ff"; }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = isInvoiceMatched ? "#fde047" : "#e2e8f0"; e.currentTarget.style.background = isInvoiceMatched ? "#fefce8" : (hasData ? "#f8fafc" : "#ffffff"); }}
                                                      >
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                            <span style={{ fontSize: "11px", fontWeight: "700", color: "#475569" }}>
                                                              {item.label}
                                                            </span>
                                                            {hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== "" && (
                                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                              </svg>
                                                            )}
                                                            <NoteIndicatorButton
                                                              size="sm"
                                                              note={slot.note || ""}
                                                              onClick={() => openSlotNoteModal({ item, type: "invoice", job })}
                                                              title={slot.note ? `Invoice note: ${slot.note}` : "Add note to invoice slot"}
                                                            />
                                                          </div>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                                                            {item.subLabel && (
                                                              <span style={{ fontSize: "10px", color: "#94a3b8" }}>{item.subLabel}</span>
                                                            )}
                                                            {slot.status && (
                                                              <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                                                <HighlightText text={slot.status} query={searchQuery} />
                                                              </span>
                                                            )}
                                                          </div>
                                                        </div>
                                                        {hasData ? (
                                                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "4px" }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                              {isPlaceholder ? (
                                                                <PlaceholderPill isAuto={isAutoPlaceholder(slot.ref)} size="sm" />
                                                              ) : (
                                                                <span style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a" }}>
                                                                  <HighlightText text={slot.ref || "Invoice"} query={searchQuery} />
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
                                                            Sent: <HighlightText text={slot.sentDate} query={searchQuery} /> ({slot.daysToPay || 30} days)
                                                          </div>
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
                                              </div>
                                            </div>
                                          );
                                        })()}

                                        {/* Card 3: Direct Costs / Expenses */}
                                        {(() => {
                                          const expenseItems = getJobExpenseItems(job, isRetainer);
                                          return (
                                            <div
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
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                                                <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                                  Direct Costs ({expenseItems.length})
                                                </div>
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
                                                          ? `Prior month unreceived costs: ${formatCurrency(metrics.costsLeftToReceive)} (${metrics.priorMonthsUnreceivedCount} prior month${metrics.priorMonthsUnreceivedCount === 1 ? "" : "s"} unreceived) · Real Costs to date: ${formatCurrency(metrics.realCostsReceived)}`
                                                          : `Costs Budget: ${formatCurrency(metrics.directCosts)} · Real Received: ${formatCurrency(metrics.realCostsReceived)} · Excludes ${formatCurrency(metrics.placeholderCosts)} in gap placeholders`
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
                                                        title={`Costs Budget: ${formatCurrency(metrics.directCosts)} · 100% Received (${formatCurrency(metrics.realCostsReceived)})`}
                                                      >
                                                        <span>✓</span> Fully received
                                                      </span>
                                                    )
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
                                                    const isExpenseMatched = searchQuery.trim() && (textMatchesQuery(slot.description, searchQuery) || textMatchesQuery(slot.transactionId, searchQuery) || textMatchesQuery(slot.note, searchQuery) || textMatchesQuery(slot.status, searchQuery));
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
                                                            tabName: item.row.tabName || parentRow.tabName || job.tabName || (filterType === "pipeline" ? "Pipeline" : "Confirmed"),
                                                          });
                                                        }}
                                                        style={{
                                                          padding: "8px 10px",
                                                          borderRadius: "6px",
                                                          border: isExpenseMatched ? "1px solid #fde047" : "1px solid #e2e8f0",
                                                          background: isExpenseMatched ? "#fefce8" : (hasData ? "#f8fafc" : "#ffffff"),
                                                          cursor: "pointer",
                                                          transition: "border-color 0.15s ease"
                                                        }}
                                                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#93c5fd"; e.currentTarget.style.background = "#eff6ff"; }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = isExpenseMatched ? "#fde047" : "#e2e8f0"; e.currentTarget.style.background = isExpenseMatched ? "#fefce8" : (hasData ? "#f8fafc" : "#ffffff"); }}
                                                      >
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                                            <span style={{ fontSize: "11px", fontWeight: "700", color: "#475569" }}>
                                                              {item.label}
                                                            </span>
                                                            <NoteIndicatorButton
                                                              size="sm"
                                                              note={slot.note || ""}
                                                              onClick={() => openSlotNoteModal({ item, type: "expense", job })}
                                                              title={slot.note ? `Cost note: ${slot.note}` : "Add note to direct cost slot"}
                                                            />
                                                          </div>
                                                          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                                                            {item.subLabel && (
                                                              <span style={{ fontSize: "10px", color: "#94a3b8" }}>{item.subLabel}</span>
                                                            )}
                                                            {slot.status && (
                                                              <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                                                <HighlightText text={slot.status} query={searchQuery} />
                                                              </span>
                                                            )}
                                                          </div>
                                                        </div>
                                                        {hasData ? (
                                                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "4px" }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                                                              {isPlaceholder ? (
                                                                <PlaceholderPill isAuto={isAutoPlaceholder(slot.transactionId || slot.description)} size="sm" />
                                                              ) : (
                                                                <span style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "160px" }}>
                                                                  <HighlightText text={slot.description || slot.transactionId || "Expense"} query={searchQuery} />
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
                                                        {slot.transactionId && slot.description && isExpenseMatched && textMatchesQuery(slot.transactionId, searchQuery) && (
                                                          <div style={{ fontSize: "10px", color: "#a16207", marginTop: "1px" }}>
                                                            ID: <HighlightText text={slot.transactionId} query={searchQuery} />
                                                          </div>
                                                        )}
                                                        {slot.date && (
                                                          <div style={{ fontSize: "10px", color: "#64748b", marginTop: "2px" }}>
                                                            Date: <HighlightText text={slot.date} query={searchQuery} /> {slot.vat ? `· VAT: ${slot.vat}` : ""}
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
                                              title="Sets likelihood to 100% and puts Yes into 'Copied to confirmed tab' column"
                                            >
                                              {markingAlreadyConfirmedKeys.has(jobKey) ? <Spinner size={12} color="#0369a1" /> : null}
                                              <span>{markingAlreadyConfirmedKeys.has(jobKey) ? "Marking..." : "Mark job as already confirmed"}</span>
                                            </button>
                                          )}
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
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ========================================================================= */}
            {/* LEGACY VIEW (PRESERVED SPREADSHEET TABLE FOR ADMINS)                      */}
            {/* ========================================================================= */}
            {viewMode === "legacy" && (
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
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <label htmlFor="legacy-sort-select" style={{ fontSize: "13px", fontWeight: "600", color: "#475569" }}>
                        Sort:
                      </label>
                      <select
                        id="legacy-sort-select"
                        value={jobsSortBy}
                        onChange={(e) => setJobsSortBy(e.target.value)}
                        style={{
                          padding: "5px 10px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          fontSize: "13px",
                          fontWeight: "500",
                          color: "#1e293b",
                          background: "#fff",
                          cursor: "pointer",
                          outline: "none"
                        }}
                      >
                        <option value="startDateDesc">By job start date - descending</option>
                        <option value="endDateDesc">By job end date - descending</option>
                        <option value="startDateAsc">By job start date - ascending</option>
                        <option value="endDateAsc">By job end date - ascending</option>
                        {hasDateConfirmed && (
                          <>
                            <option value="dateConfDesc">Date confirmed (descending)</option>
                            <option value="dateConfAsc">Date confirmed (ascending)</option>
                          </>
                        )}
                        <option value="clientName">By client name</option>
                        <option value="rowNumber">By row number</option>
                      </select>
                    </div>
                    <button
                      onClick={() => loadJobsData(jobsClient, jobsTab)}
                      disabled={jobsLoading}
                      style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: "13px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    >
                      {jobsLoading ? <><Spinner size={12} /> Refreshing</> : "↻ Refresh"}
                    </button>
                  </div>
                </div>

                {(jobsLoading || !jobsData) ? (
                  <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
                ) : (
                  <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "2000px", tableLayout: "fixed" }}>
                      <thead>
                        <tr style={{ background: "#f5f6fa" }}>
                          {["", "Row", "Client", "Job name", "Code", jobsTab === "Pipeline" ? "Date Added" : "Date Conf", "Lead src", "Type", "Prod. line", "Split", "Revenue", "Costs", "VAT", "Start", "End",
                            ...(jobsTab === "Pipeline" ? ["Likelihood", "Copied?"] : []),
                            "InvSlot1", "InvSlot2", "InvSlot3", "Left to inv.",
                            "ExpSlot1", "ExpSlot2", "ExpSlot3", "Costs outst."].map((h, i) => (
                              <th key={i} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {processedJobs.flatMap((job, jobIdx) => {
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
                                  {showFields && !isRetainer && isParent && (
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
                                  {showFields && <LegacyEditableCell value={r.endDate} colLetter="AM" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} title={crmWarningTitle} />}
                                </td>
                                {jobsTab === "Pipeline" && (
                                  <>
                                    <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                      {showFields && <LegacyEditableCell value={r.likelihood} colLetter="AN" rowNum={r.rowNum} onSave={handleLegacyInlineUpdate} title={crmWarningTitle} />}
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
                                      title={isLocked ? "Synced from accounting software. Click to view or edit days to pay." : "Click to edit invoice slot"}
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
                                            <PlaceholderPill isAuto={isAutoPlaceholder(s.transactionId || s.description)} size="sm" />
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
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}