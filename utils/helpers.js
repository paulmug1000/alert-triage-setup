export function stripCurrency(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
  // Strip currency symbols (£, $, €), commas, and any non-numeric chars except dot and minus
  const clean = s.replace(/[^\d.-]/g, "").trim();
  return isNaN(Number(clean)) || clean === "" ? "" : clean;
}

export function formatCurrency(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  const hasSymbol = /^[£$€]/.test(s);
  const symbol = hasSymbol ? s.charAt(0) : "£";
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return symbol + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function isPlaceholderInvoice(ref, status) {
  const s = String(typeof ref === "object" ? (ref?.ref || "") : ref || "").trim().toUpperCase();
  const st = String(typeof ref === "object" ? (ref?.status || "") : status || "").trim().toUpperCase();
  // A blank, missing, or fallback reference makes the invoice a placeholder
  if (!s || s === "NO REF" || s === "REF" || s === "-") return true;
  return (
    s.startsWith("PLACE") ||
    s.includes("PLACE-INV") ||
    s.includes("MANUAL-INV") ||
    s.startsWith("MANUAL") ||
    s.includes("PLACEHOLDER") ||
    st.includes("PLACEHOLDER")
  );
}

export function isPlaceholderExpense(appId, description, status) {
  const id = String(typeof appId === "object" ? (appId?.transactionId || appId?.appId || appId?.id || appId?.ref || "") : appId || "").trim().toUpperCase();
  const desc = String(typeof appId === "object" ? (appId?.description || appId?.desc || appId?.rawDesc || "") : description || "").trim().toUpperCase();
  const st = String(typeof appId === "object" ? (appId?.status || "") : status || "").trim().toUpperCase();

  // A blank, missing, or fallback reference makes the expense a placeholder / manual entry
  if (!id || id === "NO REF" || id === "REF" || id === "-") return true;

  const tags = ["PLACE-EXP", "MANUAL-ENTRY", "UNRECON-GAP", "PLACE-GAP", "MANUAL-GAP", "PLACEHOLDER"];
  return (
    tags.some((t) => id.includes(t) || desc.includes(t) || st.includes(t)) ||
    id.startsWith("PLACE") ||
    desc.startsWith("PLACE") ||
    id.startsWith("MANUAL") ||
    desc.startsWith("MANUAL")
  );
}

export function isDraftInvoice(ref, status) {
  let st = "";
  if (typeof ref === "object" && ref !== null) {
    st = String(ref.status || "").trim().toLowerCase();
  } else if (status !== undefined) {
    st = String(status || "").trim().toLowerCase();
  } else {
    st = String(ref || "").trim().toLowerCase();
  }
  return st === "draft" || st.includes("draft") || st.includes("awaiting") || st.includes("submitted");
}

export function isDraftExpense(item, status) {
  let st = "";
  if (typeof item === "object" && item !== null) {
    st = String(item.status || "").trim().toLowerCase();
  } else if (status !== undefined) {
    st = String(status || "").trim().toLowerCase();
  } else {
    st = String(item || "").trim().toLowerCase();
  }
  return st === "draft" || st.includes("draft");
}

export const INVOICE_STATUS_OPTIONS = [
  "Draft",
  "Sent",
  "Paid",
  "Part-paid (received)",
  "Part-paid (balance)",
];

export const EXPENSE_STATUS_OPTIONS = [
  "Received",
  "Paid",
  "Part-paid (paid)",
  "Part-paid (balance)",
];

export function canonicalizeInvoiceStatus(st) {
  if (!st) return "";
  const s = String(st).trim();
  const lower = s.toLowerCase();
  if (lower === "draft") return "Draft";
  if (lower === "sent") return "Sent";
  if (lower === "paid") return "Paid";
  if (lower.includes("balance")) return "Part-paid (balance)";
  if (lower.includes("part-paid") || lower.includes("part paid") || lower.includes("partpaid")) {
    if (lower.includes("balance")) return "Part-paid (balance)";
    return "Part-paid (received)";
  }
  return s;
}

export function canonicalizeExpenseStatus(st) {
  if (!st) return "";
  const s = String(st).trim();
  const lower = s.toLowerCase();
  if (lower === "received") return "Received";
  if (lower === "paid") return "Paid";
  if (lower.includes("balance")) return "Part-paid (balance)";
  if (lower.includes("part-paid") || lower.includes("part paid") || lower.includes("partpaid")) {
    if (lower.includes("balance")) return "Part-paid (balance)";
    return "Part-paid (paid)";
  }
  return s;
}

export function getStatusPill(status) {
  const s = String(status || "").trim();
  const lower = s.toLowerCase();
  if (lower === "paid") return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  if (lower === "draft") return { background: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
  if (lower === "sent" || lower === "received") return { background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  if (lower.includes("part-paid") || lower.includes("part paid") || lower.includes("partpaid")) {
    return { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  return { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
}

/**
 * Groups raw invoice slots for display on Job views/modals.
 * Invoices sharing the same non-placeholder reference where at least one tranche
 * is part-paid (or one is received/paid and one is balance) are collapsed into a
 * single composite object. The underlying array indices are preserved so that edits
 * (e.g. days to pay on the balance tranche) can update the exact slot in editingJob.invoices.
 */
export function groupInvoicesForDisplay(invoices) {
  if (!Array.isArray(invoices) || invoices.length === 0) return [];

  // 1. Identify companion groups by normalized reference
  const groupsByRef = new Map();
  invoices.forEach((inv, idx) => {
    const rawRef = String(inv?.ref || "").trim();
    const isPlaceholder = isPlaceholderInvoice(rawRef, inv?.status);
    if (rawRef && !isPlaceholder) {
      const key = rawRef.toUpperCase();
      if (!groupsByRef.has(key)) {
        groupsByRef.set(key, []);
      }
      groupsByRef.get(key).push({ ...inv, originalIndex: idx });
    }
  });

  const processedIndices = new Set();
  const result = [];

  invoices.forEach((inv, idx) => {
    if (processedIndices.has(idx)) return;

    const rawRef = String(inv?.ref || "").trim();
    const isPlaceholder = isPlaceholderInvoice(rawRef, inv?.status);
    const key = rawRef ? rawRef.toUpperCase() : null;
    const group = key ? groupsByRef.get(key) : null;
    // Check if this invoice is part of a multi-slot part-paid or multi-tranche group
    const isMultiTranche = group && group.length > 1;

    if (isMultiTranche) {
      group.forEach((item) => processedIndices.add(item.originalIndex));

      const receivedTranches = [];
      let balanceTranche = null;

      group.forEach((item) => {
        const st = String(item.status || "").toLowerCase();
        if (st.includes("balance")) {
          if (!balanceTranche) {
            balanceTranche = item;
          } else {
            receivedTranches.push(item);
          }
        } else {
          receivedTranches.push(item);
        }
      });

      let totalAmount = 0;
      let receivedAmount = 0;
      let balanceAmount = 0;

      group.forEach((item) => {
        const amt = parseFloat(stripCurrency(item.amount)) || 0;
        totalAmount += amt;
        const st = String(item.status || "").toLowerCase();
        if (st.includes("balance")) {
          balanceAmount += amt;
        } else {
          receivedAmount += amt;
        }
      });

      const allMarkedPaid = group.every((item) => {
        const st = String(item.status || "").toLowerCase();
        return st === "paid" || st.includes("paid in full");
      });

      if (allMarkedPaid || (!balanceTranche && balanceAmount <= 0.005)) {
        receivedAmount = totalAmount;
        balanceAmount = 0;
        balanceTranche = null;
      } else if (balanceAmount === 0 && balanceTranche) {
        balanceAmount = Math.max(0, totalAmount - receivedAmount);
      }

      const percentPaid = totalAmount > 0 ? Math.min(100, Math.max(0, (receivedAmount / totalAmount) * 100)) : (allMarkedPaid ? 100 : 0);
      const isFullyPaid = allMarkedPaid || balanceAmount <= 0.005 || !balanceTranche || String(balanceTranche.status || "").toLowerCase() === "paid";
      const primaryTranche = balanceTranche || receivedTranches[0] || group[0];

      result.push({
        ...primaryTranche,
        isComposite: true,
        ref: group[0].ref,
        totalAmount,
        receivedAmount,
        balanceAmount,
        percentPaid,
        isFullyPaid,
        status: isFullyPaid ? "Paid" : "Part-paid",
        receivedTranches,
        balanceTranche,
        allTranches: group,
        originalIndex: primaryTranche.originalIndex,
        originalIndices: group.map((g) => g.originalIndex),
      });
    } else {
      processedIndices.add(idx);
      result.push({
        ...inv,
        originalIndex: idx,
        isComposite: false,
      });
    }
  });

  return result;
}

/**
 * Groups raw expense slots for display on Job views/modals.
 */
export function groupExpensesForDisplay(expenses) {
  if (!Array.isArray(expenses) || expenses.length === 0) return [];

  const groupsByKey = new Map();
  expenses.forEach((exp, idx) => {
    const rawId = String(exp?.appId || exp?.transactionId || exp?.id || exp?.ref || "").trim();
    const isPlaceholder = isPlaceholderExpense(rawId, exp?.desc || exp?.description, exp?.status);
    if (rawId && !isPlaceholder) {
      const key = rawId.toUpperCase();
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, []);
      }
      groupsByKey.get(key).push({ ...exp, originalIndex: idx });
    }
  });

  const processedIndices = new Set();
  const result = [];

  expenses.forEach((exp, idx) => {
    if (processedIndices.has(idx)) return;

    const rawId = String(exp?.appId || exp?.transactionId || exp?.id || exp?.ref || "").trim();
    const isPlaceholder = isPlaceholderExpense(rawId, exp?.desc || exp?.description, exp?.status);
    const key = (rawId && !isPlaceholder) ? rawId.toUpperCase() : null;
    const group = key ? groupsByKey.get(key) : null;

    const isMultiTranche = group && group.length > 1;

    if (isMultiTranche) {
      group.forEach((item) => processedIndices.add(item.originalIndex));

      const paidTranches = [];
      let balanceTranche = null;

      group.forEach((item) => {
        const st = String(item.status || "").toLowerCase();
        if (st.includes("balance")) {
          if (!balanceTranche) balanceTranche = item;
          else paidTranches.push(item);
        } else {
          paidTranches.push(item);
        }
      });

      let totalAmount = 0;
      let paidAmount = 0;
      let balanceAmount = 0;

      group.forEach((item) => {
        const amt = parseFloat(stripCurrency(item.amount)) || 0;
        totalAmount += amt;
        const st = String(item.status || "").toLowerCase();
        if (st.includes("balance")) {
          balanceAmount += amt;
        } else {
          paidAmount += amt;
        }
      });

      const allMarkedPaid = group.every((item) => {
        const st = String(item.status || "").toLowerCase();
        return st === "paid" || st === "complete" || st.includes("paid in full");
      });

      if (allMarkedPaid || (!balanceTranche && balanceAmount <= 0.005)) {
        paidAmount = totalAmount;
        balanceAmount = 0;
        balanceTranche = null;
      } else if (balanceAmount === 0 && balanceTranche) {
        balanceAmount = Math.max(0, totalAmount - paidAmount);
      }

      const percentPaid = totalAmount > 0 ? Math.min(100, Math.max(0, (paidAmount / totalAmount) * 100)) : (allMarkedPaid ? 100 : 0);
      const isFullyPaid = allMarkedPaid || balanceAmount <= 0.005 || !balanceTranche || String(balanceTranche.status || "").toLowerCase() === "paid";
      const primaryTranche = balanceTranche || paidTranches[0] || group[0];

      result.push({
        ...primaryTranche,
        isComposite: true,
        desc: group[0].desc,
        appId: group[0].appId,
        totalAmount,
        paidAmount,
        balanceAmount,
        percentPaid,
        isFullyPaid,
        status: isFullyPaid ? "Paid" : "Part-paid",
        paidTranches,
        balanceTranche,
        allTranches: group,
        originalIndex: primaryTranche.originalIndex,
        originalIndices: group.map((g) => g.originalIndex),
      });
    } else {
      processedIndices.add(idx);
      result.push({
        ...exp,
        originalIndex: idx,
        isComposite: false,
      });
    }
  });

  return result;
}

/**
 * Groups slot items for JobDetailModal and JobsView.
 * Takes the output array of getJobInvoiceItems() or getJobExpenseItems()
 * (where each item is { id, rowNum, slotNum, slot, row, label, subLabel })
 * and groups multi-tranche part-paid companion slots into a unified composite item.
 */
export function groupSlotItemsForDisplay(items, type = "invoice") {
  if (!Array.isArray(items) || items.length === 0) return [];

  const groupsByKey = new Map();
  items.forEach((item, idx) => {
    const slot = item.slot || {};
    let key = null;
    if (type === "invoice") {
      const ref = String(slot.ref || "").trim();
      if (ref && !isPlaceholderInvoice(ref, slot.status)) {
        key = ref.toUpperCase();
      }
    } else {
      const id = String(slot.transactionId || slot.id || slot.appId || slot.ref || "").trim();
      const desc = String(slot.description || slot.desc || "").trim();
      if (id && !isPlaceholderExpense(id, desc, slot.status)) {
        key = id.toUpperCase();
      }
    }

    if (key) {
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key).push({ ...item, itemIndex: idx });
    }
  });

  const processedIndices = new Set();
  const result = [];

  items.forEach((item, idx) => {
    if (processedIndices.has(idx)) return;

    const slot = item.slot || {};
    let key = null;
    if (type === "invoice") {
      const ref = String(slot.ref || "").trim();
      if (ref && !isPlaceholderInvoice(ref, slot.status)) {
        key = ref.toUpperCase();
      }
    } else {
      const id = String(slot.transactionId || slot.id || slot.appId || slot.ref || "").trim();
      const desc = String(slot.description || slot.desc || "").trim();
      if (id && !isPlaceholderExpense(id, desc, slot.status)) {
        key = id.toUpperCase();
      }
    }

    const group = key ? groupsByKey.get(key) : null;
    const isMultiTranche = group && group.length > 1;

    if (isMultiTranche) {
      group.forEach((g) => processedIndices.add(g.itemIndex));

      const receivedTranches = [];
      let balanceTranche = null;

      let totalAmount = 0;
      let receivedAmount = 0;
      let balanceAmount = 0;

      group.forEach((g) => {
        const s = g.slot || {};
        const amt = parseFloat(stripCurrency(s.amount)) || 0;
        totalAmount += amt;
        const st = String(s.status || "").toLowerCase();
        if (st.includes("balance")) {
          balanceAmount += amt;
          if (!balanceTranche) balanceTranche = g;
          else receivedTranches.push(g);
        } else {
          receivedAmount += amt;
          receivedTranches.push(g);
        }
      });

      const allMarkedPaid = group.every((g) => {
        const st = String(g.slot?.status || "").toLowerCase();
        return st === "paid" || st === "complete" || st.includes("paid in full");
      });

      if (allMarkedPaid || (!balanceTranche && balanceAmount <= 0.005)) {
        receivedAmount = totalAmount;
        balanceAmount = 0;
        balanceTranche = null;
      } else if (balanceAmount === 0 && balanceTranche) {
        balanceAmount = Math.max(0, totalAmount - receivedAmount);
      }

      const percentPaid = totalAmount > 0 ? Math.min(100, Math.max(0, (receivedAmount / totalAmount) * 100)) : (allMarkedPaid ? 100 : 0);
      const isFullyPaid = allMarkedPaid || balanceAmount <= 0.005 || !balanceTranche || String(balanceTranche.slot?.status || "").toLowerCase() === "paid";
      const primaryItem = balanceTranche || receivedTranches[0] || group[0];

      // Reference by invoice number (e.g. #0844) or expense description/ref without sequential slot numbers
      const refStr = primaryItem.slot?.ref ? `#${primaryItem.slot.ref}` : null;
      const descStr = primaryItem.slot?.description || (primaryItem.slot?.transactionId ? `#${primaryItem.slot.transactionId}` : null);
      const combinedLabel = type === "invoice"
        ? (refStr || primaryItem.label)
        : (descStr || primaryItem.label || "Direct cost");

      result.push({
        ...primaryItem,
        id: `composite_${primaryItem.id}`,
        isComposite: true,
        type,
        label: combinedLabel,
        totalAmount,
        receivedAmount,
        balanceAmount,
        percentPaid,
        isFullyPaid,
        receivedTranches,
        balanceTranche,
        allTranches: group,
        slot: {
          ...primaryItem.slot,
          amount: totalAmount,
          status: isFullyPaid ? "Paid" : "Part-paid",
        },
      });
    } else {
      processedIndices.add(idx);
      result.push({
        ...item,
        isComposite: false,
      });
    }
  });

  return result;
}

export function hasActiveAccountingIntegration(accountingTool, integrations) {
  const s = String(accountingTool || "").toLowerCase().trim();
  if (s.includes("xero") || s.includes("quickbooks") || s.includes("qb")) return true;
  if (integrations?.xero?.connected || integrations?.quickbooks?.connected) return true;
  return false;
}

export function hasActiveCrmIntegration(crmTool) {
  if (!crmTool) return false;
  const s = String(crmTool).trim().toLowerCase();
  return s !== "none" && s !== "" && s !== "false";
}

export function isCrmDrivenTab(currentTab, crmDrives) {
  const tab = String(currentTab || "").trim().toLowerCase();
  const drives = String(crmDrives || "").trim().toLowerCase();
  if (drives === "pipeandconf") return true;
  if (drives === "pipeline" && tab === "pipeline") return true;
  return false;
}

export function isCrmDeal(job, crmTool, crmDrives) {
  if (!hasActiveCrmIntegration(crmTool)) return false;
  const tab = String(job?.tabName || job?.status || job?.type || job?.rows?.[0]?.tabName || "").trim().toLowerCase();
  if (!isCrmDrivenTab(tab, crmDrives)) return false;
  const code = String(job?.projectCode || job?.rows?.[0]?.projectCode || "").trim();
  return code !== "";
}

export function getCrmDisplayName(crmTool) {
  if (!crmTool || String(crmTool).trim().toLowerCase() === "none") return "CRM";
  const s = String(crmTool).trim().toLowerCase();
  if (s.includes("hubspot")) return "HubSpot";
  if (s.includes("pipedrive")) return "Pipedrive";
  if (s.includes("monday")) return "Monday";
  if (s.includes("close")) return "Close";
  if (s.includes("capsule")) return "Capsule";
  if (s.includes("clickup")) return "ClickUp";
  if (s.includes("harvest")) return "Harvest";
  if (s.includes("clockify")) return "Clockify";
  if (s.includes("workamajig")) return "Workamajig";
  if (s.includes("sheet")) return "Google Sheet";
  if (s.includes("excel")) return "Excel";
  return "CRM";
}


export function parseYearMonth(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return { year: val.getFullYear(), month: val.getMonth() + 1 };
  }
  const s = String(val).trim();
  // 1. ISO format: YYYY-MM or YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})/);
  if (isoMatch) {
    return { year: parseInt(isoMatch[1], 10), month: parseInt(isoMatch[2], 10) };
  }
  // 2. Month name and year: e.g. "Oct-26", "16-Oct-26", "Oct 2026", "October-2026"
  const monthMap = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };
  const mMatch = s.match(/(?:^|\b|\d{1,2}[-/ ])([a-zA-Z]{3,9})[-/ ]?(\d{2,4})(?:$|\b)/i);
  if (mMatch) {
    const mStr = mMatch[1].toLowerCase();
    const mNum = monthMap[mStr];
    let yr = parseInt(mMatch[2], 10);
    if (yr < 100) yr += 2000;
    if (mNum && yr) return { year: yr, month: mNum };
  }
  const revMatch = s.match(/(?:^|\b)(\d{2,4})[-/ ]([a-zA-Z]{3,9})(?:$|\b)/i);
  if (revMatch) {
    const mStr = revMatch[2].toLowerCase();
    const mNum = monthMap[mStr];
    let yr = parseInt(revMatch[1], 10);
    if (yr < 100) yr += 2000;
    if (mNum && yr) return { year: yr, month: mNum };
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  return null;
}

export function getAlertSummary(alert) {
  if (alert.type === "invoice" || alert.flagType === "invoiceDashboardDiscr") {
    const inv = alert.summary;
    const vatLabel = inv?.vatIncluded && inv.vatIncluded > 0 ? " +VAT" : " (no VAT)";
    return `Invoice #${inv?.invoiceNo || inv?.reference || "?"} - £${inv?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "expense" || alert.flagType === "expenseDashboardDiscr" || alert.flagType === "contractorsDashboardDiscr" || alert.flagType === "passThroughDashboardDiscr") {
    const exp = alert.summary;
    const vat = parseFloat(String(exp?.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
    const vatLabel = vat > 0 ? " +VAT" : " (no VAT)";
    return `${exp?.description || "Expense"} - £${exp?.amount?.toFixed(2) || "?"}${vatLabel}`;
  } else if (alert.type === "crm" || alert.flagType?.includes("crm")) {
    const crm = alert.data;
    const flagType = alert.alertType || alert.flagType || "";

    const isAppDiscr = flagType === "crmConfAppDiscr" || flagType === "crmPipeAppDiscr";
    const isDashDiscr = flagType === "crmPipeDashDiscr" || flagType === "crmConfDashDiscr";
    const src = isAppDiscr ? crm?.sheetData : crm?.crmData;
    const client = src?.[0] || "";
    const job = src?.[1] || "";
    const code = src?.[2] || "";
    const base = `${client}${job ? " - " + job : ""}${code ? " (" + code + ")" : ""}` || "CRM alert";
    if (isDashDiscr && alert.subType === "field_mismatch" && alert.mismatchFields?.length) {
      return `${base} - ⚠ ${alert.mismatchFields.join(", ")} mismatch`;
    }
    return base;
  }
  return "Alert";
}

export function eomWorkMonthToTargetMonth(workMonthKey) {
  const [y, m] = String(workMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function eomTargetMonthToWorkMonth(targetMonthKey) {
  const [y, m] = String(targetMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const PROACTIVE_TYPE_LABELS = {
  retainer_invoice: "Retainer invoice",
  crm_wipe: "CRM data wipe",
  crm_sync_blocked: "CRM sync paused",
  revenue_mismatch: "Revenue / invoiced mismatch",
  direct_costs_mismatch: "Direct costs / expenses mismatch",
  pipeline_confirmed_overlap: "Pipeline / Confirmed overlap",
  retainer_shrink_blocked: "Retainer row blocked from trimming",
  uninvoiced_new_job: "Uninvoiced new job",
  uninvoiced_revenue: "Uninvoiced revenue",
  deleted_invoice: "Deleted invoice",
  job_structure_error: "Job structure error",
  deleted_expense: "Deleted expense",
  unreceived_expenses: "Unreceived expenses",
  autolog_error: "Automation error",
  infinite_loop: "Infinite loop / automation conflict",
  stale_unrecon_gap: "Stale UNRECON-GAP expense",
  retroactive_outgoings_update: "Retroactive P&L outgoings update",
  unmapped_pl_category: "Unmapped P&L category",
  part_paid_balance: "Part-paid balance",
  salary_forecast_in_actual_month: "Payroll forecast in actual month",
};

export const KNOWN_PROACTIVE_ALERT_TYPES = new Set(Object.keys(PROACTIVE_TYPE_LABELS));

export const ADMIN_ONLY_FLAG_KEYS = new Set([
  "crmCopiedConfChecked",
  "crmCopiedConfUnchecked",
  "crmCopiedConfDelete",
  "retainerInvoicesCreated",
  "retainerInvoicesDeleted",
  "expenseAdded",
]);

export const ADMIN_ONLY_PROACTIVE_TYPES = new Set([
  "crm_wipe",
  "pipeline_confirmed_overlap",
  "retainer_shrink_blocked",
  "job_structure_error",
  "autolog_error",
  "infinite_loop",
]);

export const ADMIN_ONLY_ALERT_TYPES = new Set([
  ...ADMIN_ONLY_FLAG_KEYS,
  ...ADMIN_ONLY_PROACTIVE_TYPES,
]);

export function stripRowInfo(text) {
  if (!text || typeof text !== "string") return text;
  return text
    // Strip parenthesized combined row/slot/cell references: (Row 362, slot 1), (slot 1, Row 362), (Sheet Row 362, Slot 1), (Row 14, Cell D14)
    .replace(/\s*\(\s*(?:Confirmed|Pipeline|Outgoings)?\s*(?:sheet\s+|tab\s+)?rows?\s+\d+(?:\s*[-–—]\s*\d+)?(?:,\s*(?:slots?\s+\d+|cells?\s+[A-Z]{1,3}\d+|cols?\s+[A-Z]{1,3}))?\s*\)/gi, "")
    .replace(/\s*\(\s*slots?\s+\d+,\s*(?:Confirmed|Pipeline|Outgoings)?\s*(?:sheet\s+|tab\s+)?rows?\s+\d+\s*\)/gi, "")
    // Strip parenthesized row with description: (Row 42 — Hosting) -> (Hosting)
    .replace(/\(\s*(?:Confirmed|Pipeline|Outgoings)?\s*(?:sheet\s+|tab\s+)?rows?\s+\d+\s*[-–—:]\s*/gi, "(")
    // Strip standalone parenthesized slot, row, or cell: (slot 1), (Row 362), (Confirmed row 14), (Cell D14)
    .replace(/\s*\(\s*slots?\s+\d+\s*\)/gi, "")
    .replace(/\s*\(\s*cells?\s+[A-Z]{1,3}\d+\s*\)/gi, "")
    .replace(/\s*\(\s*(?:Confirmed|Pipeline|Outgoings)?\s*(?:sheet\s+|tab\s+)?rows?\s+\d+(?:\s*[-–—]\s*\d+)?\s*\)/gi, "")
    .replace(/\(\s*(?:sheet\s+)?rows?\s+\d+,\s*/gi, "(")
    .replace(/\(\s*(?:Confirmed|Pipeline|Outgoings)?\s*(?:sheet\s+|tab\s+)?rows?\s+\d+,\s*/gi, "(")
    // Strip inline Row / Slot / Cell references: "slot 1", "slot 2", "Row 362,", "Cell D14"
    .replace(/\b(?:Confirmed|Pipeline|Outgoings)?\s*(?:Sheet\s+|Tab\s+)?Row\s+\d+\s*\((?:parent|child)\)\s*:?\s*/gi, "")
    .replace(/\b(?:Confirmed|Pipeline|Outgoings)?\s*(?:Sheet\s+|Tab\s+)?Row\s+\d+,\s*/gi, "")
    .replace(/\b(Confirmed|Pipeline|Outgoings)\s+(?:sheet\s+|tab\s+)?rows?\s+\d+\b/gi, "$1")
    .replace(/\bchild\s+rows?\s+\d+\b/gi, "child entry")
    .replace(/\bchild\s+rows?\b/gi, "child entries")
    .replace(/\bparent\s+rows?\b/gi, "parent job")
    .replace(/\s*-\s*(?:sheet\s+)?rows?\s+\d+:\s*/gi, ": ")
    .replace(/\b(?:sheet\s+)?rows?\s+\d+:\s*/gi, "")
    .replace(/\b(?:in|into|on|at)\s+cells?\s+[A-Z]{1,3}\d+(?:\s*,\s*[A-Z]{1,3}\d+)*\b/gi, "")
    .replace(/,\s*cells?\s+[A-Z]{1,3}\d+\b/gi, "")
    .replace(/\bcells?\s+[A-Z]{1,3}\d+\b/gi, "")
    .replace(/\b(?:in|into|on|at)\s+slots?\s+\d+\b/gi, "")
    .replace(/\b(?:in|into|on|at)\s+(?:sheet\s+)?rows?\s+\d+\b/gi, "")
    .replace(/\bslots?\s+\d+\b/gi, "")
    .replace(/\bslot\s+amount\b/gi, "expected amount")
    .replace(/\b(?:invoice|expense)\s+slots?\b/gi, "entry")
    .replace(/\bslots?\b/gi, "entries")
    .replace(/\bmulti-row\b/gi, "recurring")
    .replace(/\bnew\s+row\b/gi, "new entry")
    .replace(/\bempty\s+slots?\b/gi, "unbilled entries")
    .replace(/Mismatched rows:/gi, "Mismatched entries:")
    // Replace internal tab / sheet terminology with Pulse domain terms
    .replace(/\bConfirmed\s+(?:tab|sheet)\b/gi, "Confirmed jobs")
    .replace(/\bPipeline\s+(?:tab|sheet)\b/gi, "Pipeline jobs")
    .replace(/\bOutgoings\s+(?:tab|sheet)\b/gi, "Outgoings")
    .replace(/\bBudget\s+(?:tab|sheet)\b/gi, "Budget")
    .replace(/\bNBtoFind\s+(?:tab|sheet)\b/gi, "NB to Find")
    .replace(/\bPerformance\s+(?:tab|sheet)\b/gi, "Performance")
    .replace(/\bDashboard\s+(?:tab|sheet)\b/gi, "Dashboard")
    .replace(/\bCash\s+(?:tab|sheet)\b/gi, "Cashflow")
    .replace(/\b(?:in|on)\s+the\s+(?:live\s+)?(?:client\s+|master\s+)?(?:spreadsheet|sheet)\b/gi, "in Pulse")
    .replace(/\bfrom\s+the\s+(?:live\s+)?(?:client\s+|master\s+)?(?:spreadsheet|sheet)\b/gi, "from Pulse")
    .replace(/\b(?:in|on)\s+(?:the\s+)?sheet\b/gi, "in Pulse")
    .replace(/\b(?:client|master)\s+(?:spreadsheet|sheet)\b/gi, "Pulse")
    .replace(/\bspreadsheet\b/gi, "Pulse")
    // Clean up trailing/dangling prepositions or punctuation: e.g. "Place in Job - Name - " -> "Place in Job - Name"
    .replace(/\s*-\s*-\s*/g, " - ")
    .replace(/\s*,\s*,/g, ",")
    .replace(/,\s*-\s*/g, " - ")
    .replace(/\b(?:on|in|at)\s*$/gi, "")
    .replace(/\b(?:on|in|at)\s+([.,;:!?])/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

export function cleanUserFacingText(text) {
  return stripRowInfo(text);
}

/**
 * Sanitizes any internal spreadsheet/tab/cell terminology from dynamic text before displaying to non-admin users (Rule 13).
 */
export function sanitizeSpreadsheetTerms(text) {
  if (!text || typeof text !== "string") return text || "";
  return stripRowInfo(text)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com/gi, "system service")
    .replace(/\bMaster\s+Sheet\s+bridge\b/gi, "Pulse data sync")
    .replace(/\b(?:Master|Client|Recon|Backup)\s+(?:spreadsheet|sheet|workbook|tab)s?\b/gi, "Pulse")
    .replace(/\b(?:Confirmed|Pipeline|Outgoings|Salaries|Performance|Dashboard|Budget|Cash|Delivered|Monthly|Calcs|ErrorCheck)\s+(?:tab|sheet)s?\b/gi, (m) =>
      m.replace(/\s+(?:tab|sheet)s?$/i, "")
    )
    .replace(/\bNBtoFind(?:\s+(?:tab|sheet))?\b/gi, "NB to Find")
    .replace(/\bStarterPL(?:\s+(?:tab|sheet))?\b/gi, "Opening P&L")
    .replace(/\b(?:KeyInfo|PLComp|InvComp|DirComp|CRMComp|TimeComp|DataFromCRM|CRMList|DataChgAlert|AutoUpdates|OutgNotes|ConfCalcs|PipeCalcs|AppData|PLAdds|Year0Data|GPbyPL|RevenueConf|RevenuePipe|InvoicesSent|CashIncomingConf|CashIncomingPipe|ContrPayments)(?:!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d*)?)?\b/g, "Pulse configuration")
    .replace(/!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d*)?/g, "")
    .replace(/\bIMPORTRANGE\b/gi, "data link")
    .replace(/\b(?:spreadsheet|workbook)s?\b/gi, "Pulse")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const getFlagName = (flagKey, alertOrSubType = null) => {
  if ((flagKey === "crmPipeAppDiscr" || flagKey === "crmConfAppDiscr") && alertOrSubType) {
    const tab = flagKey === "crmPipeAppDiscr" ? "Pipeline" : "Confirmed";
    if (typeof alertOrSubType === "string") {
      if (alertOrSubType === "field_mismatch") {
        return `Job discrepancy - details in Pulse do not match those in CRM (${tab})`;
      }
    } else if (typeof alertOrSubType === "object") {
      if (alertOrSubType.subType === "field_mismatch") {
        return `Job discrepancy - details in Pulse do not match those in CRM (${tab})`;
      }
      const nf = Number(alertOrSubType.notFound || 0);
      const fm = Number(alertOrSubType.fieldMismatch || 0);
      if (fm > 0 && nf === 0) {
        return `Job discrepancy - details in Pulse do not match those in CRM (${tab})`;
      }
      if (fm > 0 && nf > 0) {
        return `Job discrepancy - Pulse-CRM (${tab})`;
      }
    }
  }
  const flagNames = {
    "invoiceDashboardDiscr": "Invoice discrepancy",
    "crmPipeDashDiscr": "Job discrepancy - Pulse-CRM (Pipeline)",
    "crmPipeAppDiscr": "Job discrepancy - in Pulse but not in CRM (Pipeline)",
    "crmConfDashDiscr": "Job discrepancy - Pulse-CRM (Confirmed)",
    "crmConfAppDiscr": "Job discrepancy - in Pulse but not in CRM (Confirmed)",
    "crmCopiedConfChecked": "CRM copied to conf box checked",
    "crmCopiedConfUnchecked": "CRM copied to conf box UNchecked",
    "crmCopiedConfDelete": "CRM copied to conf box DELETE",
    "retainerInvoicesCreated": "Retainer invoices created",
    "retainerInvoicesDeleted": "Retainer invoices deleted",
    "contractorsDashboardDiscr": "Contractors discrepancies",
    "passThroughDashboardDiscr": "Pass-through discrepancies",
    "expenseDashboardDiscr": "Contractors discrepancies",
    "expenseAdded": "Expense added",
    "expenseUnreconGaps": "Stale unreceived expense date changed",
    "invoiceStaleUnsentChanges": "Stale unsent invoice send date changed",
  };
  return flagNames[flagKey] || flagKey;
};

export function matchesExpenseCategoryEntry(rawAcct, categoryEntry) {
  const acct = String(rawAcct || "").trim().toLowerCase();
  const entry = String(categoryEntry || "").trim().toLowerCase();
  if (!acct || !entry) return false;
  if (acct === entry) return true;
  const acctParts = acct.split(" - ");
  const entryParts = entry.split(" - ");
  const acctCode = acctParts.length > 1 ? acctParts[0].trim() : "";
  const acctName = acctParts.length > 1 ? acctParts.slice(1).join(" - ").trim() : acct;
  const entryCode = entryParts.length > 1 ? entryParts[0].trim() : "";
  const entryName = entryParts.length > 1 ? entryParts.slice(1).join(" - ").trim() : entry;
  if (acctCode && entryCode && acctCode === entryCode) return true;
  if (acctName && entryName && acctName === entryName) return true;
  return false;
}

export function classifyExpenseCategory(accountName, contractorsList = [], passThroughList = [], directCostsMode = "Contractors") {
  const mode = String(directCostsMode || "Contractors").trim() === "Pass-through" ? "Pass-through" : "Contractors";
  if (mode !== "Pass-through") {
    return { flagType: "contractorsDashboardDiscr", expenseCategoryType: "contractor" };
  }
  const isPassThrough = (passThroughList || []).some(entry => matchesExpenseCategoryEntry(accountName, entry));
  if (isPassThrough) {
    return { flagType: "passThroughDashboardDiscr", expenseCategoryType: "passthrough" };
  }
  const isContractor = (contractorsList || []).some(entry => matchesExpenseCategoryEntry(accountName, entry));
  if (isContractor) {
    return { flagType: "contractorsDashboardDiscr", expenseCategoryType: "contractor" };
  }
  if ((contractorsList || []).filter(Boolean).length === 0 && (passThroughList || []).filter(Boolean).length > 0) {
    return { flagType: "passThroughDashboardDiscr", expenseCategoryType: "passthrough" };
  }
  return { flagType: "contractorsDashboardDiscr", expenseCategoryType: "contractor" };
}

export const RICH_NOACTION_FLAG_GROUP = {
  crmCopiedConfChecked: "crm",
  crmCopiedConfUnchecked: "crm",
  crmCopiedConfDelete: "crm",
  retainerInvoicesCreated: "invoice",
  retainerInvoicesDeleted: "invoice",
  invoiceStaleUnsentChanges: "invoice",
  expenseUnreconGaps: "expense",
};

export const ALERT_CATEGORY_FLAGS = {
  invoice: ["invoiceDashboardDiscr", "invoiceStaleUnsentChanges"],
  expense: ["contractorsDashboardDiscr", "passThroughDashboardDiscr", "expenseDashboardDiscr", "expenseAdded", "expenseUnreconGaps"],
  crm: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr"],
};

export const EXPENSE_SUPPRESSIBLE = new Set(["contractorsDashboardDiscr", "passThroughDashboardDiscr", "expenseDashboardDiscr"]);

/**
 * Match assigned client identifier against an actual client name.
 * Strictly requires an exact match (case-insensitive and trimmed of whitespace).
 * Wildcard "*" grants access to all clients.
 */
export function matchesClientName(assignedIdentifier, actualClientName) {
  if (!assignedIdentifier || !actualClientName) return false;
  const sa = String(assignedIdentifier).trim().toLowerCase();
  const sb = String(actualClientName).trim().toLowerCase();
  if (sa === "*") return true;
  if (sa === sb) return true;
  const advisorAliases = ["advisor", "advisor account", "advisor_account", "central advisor", "central advisor account"];
  if (advisorAliases.includes(sa) && advisorAliases.includes(sb)) return true;
  return false;
}

/**
 * Check if a user is authorized to view or edit data for a given client
 */
export function isUserAuthorizedForClient(user, clientName) {
  if (!user) return false;
  // Only Admin is an internal staff role able to see all clients
  if (user.role === "Admin" || user.isAdmin) return true;
  if (!clientName) return false;

  const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];
  return assignedList.some(assigned => matchesClientName(assigned, clientName));
}

/**
 * Filter an array of client objects so non-admins only see assigned clients.
 * Expects client objects to have a `name` or `clientName` property.
 */
export function filterClientsForUser(allClients, user) {
  if (!allClients || !Array.isArray(allClients)) return [];
  if (!user) return [];
  // Only Admin is an internal staff role able to see all clients
  if (user.role === "Admin" || user.isAdmin) return allClients;

  const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];
  return allClients.filter(c => {
    const name = String(c.name || c.clientName || "").trim();
    return assignedList.some(assigned => matchesClientName(assigned, name));
  });
}

/**
 * Sanitize user inputs to prevent CSV / Spreadsheet formula injection (CWE-1236).
 * Neutralizes strings starting with =, +, -, @ by prefixing with a single quote ',
 * unless the string is a valid finite numeric value.
 */
export function sanitizeFormulaInput(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (!trimmed) return val;
  // If it's a valid finite number, it is safe (e.g. "-500", "+25.5")
  if (!isNaN(Number(trimmed))) return val;
  // If it starts with formula trigger characters (including after leading whitespace or quotes), neutralize it
  if (/^[\s'’]*[=+\-@]/.test(val)) {
    return `'${val.replace(/^[\s'’]+/, "")}`;
  }
  return val;
}

/**
 * Formats an invoice reference / code for spreadsheet entry.
 * Prevents Google Sheets from stripping leading zeroes or parsing refs as numbers/dates
 * when written with valueInputOption: "USER_ENTERED".
 */
export function formatInvoiceRefForSheet(ref) {
  if (ref === null || ref === undefined) return "";
  const s = String(ref).trim();
  if (!s) return "";
  if (s.startsWith("'")) return s;
  const sanitized = sanitizeFormulaInput(s);
  if (typeof sanitized === "string" && sanitized.startsWith("'")) return sanitized;
  // If reference consists purely of digits (e.g. "0008", "8", "0123"), force Google Sheets
  // to treat it as a text string literal by prefixing with a single quote.
  if (/^\d+$/.test(String(sanitized))) {
    return `'${sanitized}`;
  }
  return sanitized;
}

/**
 * Parse structured fields from an unreceived_expenses alert detail string
 * in case metadata was not populated or when reading from older cached alerts.
 */
export function parseUnreceivedExpensesDetail(detail = "") {
  const result = {};
  if (!detail || typeof detail !== "string") return result;

  const pipeIdx = detail.indexOf(" | ");
  if (pipeIdx !== -1) {
    result.endClientName = detail.slice(0, pipeIdx).trim();
    const afterPipe = detail.slice(pipeIdx + 3);
    const colonIdx = afterPipe.indexOf(":");
    if (colonIdx !== -1) {
      const jobPart = afterPipe.slice(0, colonIdx).trim();
      const codeMatch = jobPart.match(/\[([^\]]+)\]/);
      if (codeMatch) result.projectCode = codeMatch[1];
      const rowMatch = jobPart.match(/\(Row\s*(\d+)\)/i);
      if (rowMatch) result.confirmedRow = rowMatch[1];
      result.jobName = jobPart.replace(/\[([^\]]+)\]/, "").replace(/\(Row\s*(\d+)\)/i, "").trim();
    }
  }

  const dateMatch = detail.match(/job ended\s*([^,]+)/i);
  if (dateMatch) result.endDate = dateMatch[1].trim();

  const budgetMatch = detail.match(/direct cost budget\s*=\s*£?([\d,.]+)/i);
  if (budgetMatch) result.directCosts = budgetMatch[1].replace(/,/g, "");

  const unrecMatch = detail.match(/[-\u2014]\s*£?([\d,.]+)\s*unreceived/i);
  if (unrecMatch) result.unreceivedAmount = unrecMatch[1].replace(/,/g, "");

  const noteMatch = detail.match(/Note:\s*(\d+)\s*expense\(s\)\s*totalling\s*£?([\d,.]+)/i);
  if (noteMatch) {
    result.placeholderCount = noteMatch[1];
    result.placeholderTotal = noteMatch[2].replace(/,/g, "");
  }

  return result;
}

export function parseRevenueMismatchDetail(detail = "") {
  const result = {};
  if (!detail || typeof detail !== "string") return result;

  const pipeIdx = detail.indexOf(" | ");
  if (pipeIdx !== -1) {
    result.endClientName = detail.slice(0, pipeIdx).trim();
    const afterPipe = detail.slice(pipeIdx + 3);
    const colonIdx = afterPipe.indexOf(":");
    const jobPart = colonIdx !== -1 ? afterPipe.slice(0, colonIdx).trim() : afterPipe;
    const codeMatch = jobPart.match(/\[([^\]]+)\]/);
    if (codeMatch && !codeMatch[1].includes("tab") && !codeMatch[1].includes("retainer")) {
      result.projectCode = codeMatch[1].trim();
    }
    const rowMatch = jobPart.match(/\(Row\s*(\d+)\)/i);
    if (rowMatch) {
      result.confirmedRow = rowMatch[1];
      result.rowNum = rowMatch[1];
    }
    result.jobName = jobPart.replace(/\[([^\]]+)\]/g, "").replace(/\(Row\s*(\d+)\)/i, "").trim();
  }

  const dateMatch = detail.match(/job ended\s*([^,]+)/i);
  if (dateMatch) result.endDate = dateMatch[1].trim();

  const revMatch = detail.match(/(?:billable budget|revenue)\s*(?:=\s*£?|\(£?)([\d,.]+)/i);
  if (revMatch) result.revenue = revMatch[1].replace(/,/g, "");

  const revBreakdownMatch = detail.match(/billable budget\s*=\s*£?([\d,.]+)\s*\(£?([\d,.]+)\s*fee\s*\+\s*£?([\d,.]+)\s*recharged\)/i);
  if (revBreakdownMatch) {
    result.revenue = revBreakdownMatch[1].replace(/,/g, "");
    result.billableBudget = result.revenue;
    result.feeRevenue = revBreakdownMatch[2].replace(/,/g, "");
    result.rechargedExpenses = revBreakdownMatch[3].replace(/,/g, "");
  }

  const invMatch = detail.match(/total invoiced[^\d]*£?([\d,.]+)/i);
  if (invMatch) result.totalInvoiced = invMatch[1].replace(/,/g, "");

  const invBreakdownMatch = detail.match(/total invoiced[^=]*=\s*£?([\d,.]+)\s*\(£?([\d,.]+)\s*fee\s*\+\s*£?([\d,.]+)\s*recharged\)/i);
  if (invBreakdownMatch) {
    result.totalInvoiced = invBreakdownMatch[1].replace(/,/g, "");
    result.feeInvoiced = invBreakdownMatch[2].replace(/,/g, "");
    result.rechargedInvoiced = invBreakdownMatch[3].replace(/,/g, "");
  }

  const rechargedOnlyMatch = detail.match(/invoiced recharged expenses\s*\(£?([\d,.]+)\)\s*do not match job recharged expenses\s*\(£?([\d,.]+)\)/i);
  if (rechargedOnlyMatch) {
    result.rechargedInvoiced = rechargedOnlyMatch[1].replace(/,/g, "");
    result.rechargedExpenses = rechargedOnlyMatch[2].replace(/,/g, "");
    const budMatch = detail.match(/matches billable budget\s*\(£?([\d,.]+)\)/i);
    if (budMatch && !result.revenue) result.revenue = budMatch[1].replace(/,/g, "");
  }

  const diffMatch = detail.match(/difference of £?([\d,.]+)/i);
  if (diffMatch) result.diff = diffMatch[1].replace(/,/g, "");

  return result;
}

export function parseDirectCostsMismatchDetail(detail = "") {
  const result = {};
  if (!detail || typeof detail !== "string") return result;

  const pipeIdx = detail.indexOf(" | ");
  if (pipeIdx !== -1) {
    result.endClientName = detail.slice(0, pipeIdx).trim();
    const afterPipe = detail.slice(pipeIdx + 3);
    const colonIdx = afterPipe.indexOf(":");
    const jobPart = colonIdx !== -1 ? afterPipe.slice(0, colonIdx).trim() : afterPipe;
    const codeMatch = jobPart.match(/\[([A-Za-z0-9_-]+)\]/);
    if (codeMatch && !codeMatch[1].includes("tab") && !codeMatch[1].includes("retainer")) {
      result.projectCode = codeMatch[1].trim();
    }
    const rowMatch = jobPart.match(/\(Row\s*(\d+)\)/i);
    if (rowMatch) {
      result.rowNum = rowMatch[1];
    }
    result.jobName = jobPart.replace(/\[([^\]]+)\]/g, "").replace(/\(Row\s*(\d+)\)/i, "").trim();
  }

  const tabMatch = detail.match(/\[(Pipeline|Confirmed)\s+tab\]/i);
  if (tabMatch) result.tab = tabMatch[1];

  if (result.rowNum) {
    if (!result.tab || result.tab === "Confirmed") result.confirmedRow = result.rowNum;
    else if (result.tab === "Pipeline") result.pipelineRow = result.rowNum;
  }

  const dateMatch = detail.match(/job ended\s*([^,]+)/i);
  if (dateMatch) result.endDate = dateMatch[1].trim();

  const budgetMatch = detail.match(/(?:direct cost budget|monthly budget of)\s*=\s*£?([\d,.]+)/i) || detail.match(/monthly budget of £?([\d,.]+)/i);
  if (budgetMatch) result.directCosts = budgetMatch[1].replace(/,/g, "");

  const expMatch = detail.match(/(?:total expenses(?: on parent)?|expenses)\s*(?:=\s*)?£?([\d,.]+)/i) || detail.match(/£([\d,.]+)\s*expenses/i);
  if (expMatch) result.totalExpenses = expMatch[1].replace(/,/g, "");

  const diffMatch = detail.match(/(?:difference of|diff)\s*£?([\d,.]+)/i);
  if (diffMatch) result.diff = diffMatch[1].replace(/,/g, "");

  return result;
}

/**
 * Parse structured basic vs. detailed lines from a retroactive_outgoings_update alert detail.
 * Returns basic lines (intro + category deltas) and flags whether extra transaction-level
 * attribution details are available for inline expansion / modal view.
 */
export function parseRetroactiveOutgoingsDetail(detail = "") {
  const raw = String(detail || "").trim();
  if (!raw) {
    return {
      basicLines: [],
      basicText: "",
      fullText: "",
      hasMoreDetails: false,
    };
  }

  const lines = raw.split(/\r?\n/);
  const basicLines = [];
  let foundSubDetails = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect indented transaction-level sub-details (e.g. "  - Added new transaction...", "  - ...", "\t- ...")
    const isSubDetail = /^\s{2,}-|^\t+-|^\s+-\s+/i.test(line);

    if (isSubDetail) {
      foundSubDetails = true;
    } else {
      basicLines.push(line);
    }
  }

  const hasMoreDetails = foundSubDetails || lines.length > basicLines.length;

  return {
    basicLines,
    basicText: basicLines.join("\n"),
    fullText: raw,
    hasMoreDetails,
  };
}


export function filterAnalysisResultsForAlert(results, flagDetail) {
  if (!Array.isArray(results) || results.length <= 1 || !flagDetail) {
    return results || [];
  }

  const detailLower = flagDetail.toLowerCase();

  // Try extracting client and job directly from standard log patterns
  // Pattern 1: "... for ClientName | JobName"
  const forMatch = flagDetail.match(/for\s+([^|]+)\s*\|\s*([^\[\n]+)/i);
  // Pattern 2: "Row N, ClientName, JobName:"
  const rowMatch = !forMatch ? flagDetail.match(/Row\s+\d+,\s*([^,]+),\s*([^:]+):/i) : null;

  const targetClient = (forMatch ? forMatch[1] : rowMatch ? rowMatch[1] : "").trim().toLowerCase();
  const targetJob = (forMatch ? forMatch[2] : rowMatch ? rowMatch[2] : "").trim().toLowerCase();

  const matched = results.filter(r => {
    const job = String(r.jobName || "").trim().toLowerCase();
    const client = String(r.clientName || "").trim().toLowerCase();
    const code = String(r.projectCode || "").trim().toLowerCase();

    // If we extracted targetClient and targetJob from log line:
    if (targetJob && job) {
      const jobMatches = job === targetJob || targetJob.includes(job) || job.includes(targetJob);
      const clientMatches = !targetClient || !client || client === targetClient || targetClient.includes(client) || client.includes(targetClient);
      if (jobMatches && clientMatches) return true;
    }

    // Secondary check: project code in detail
    if (code && detailLower.includes(code)) return true;

    // Fallback: check if both client and job appear in flagDetail
    if (client && job && job !== "-") {
      if (detailLower.includes(client) && detailLower.includes(job)) return true;
    }

    // Fallback: job alone if distinctive and client is blank
    if (job && job !== "-" && !client && detailLower.includes(job)) return true;

    return false;
  });

  return matched.length > 0 ? matched : results;
}

export function parseStaleExpenseDetail(detail = "") {
  if (!detail || typeof detail !== "string") return null;
  const clean = detail.trim();

  // 1. Outgoings check:
  // e.g. "[Outgoings] Aug 26 - Toby Stickland (Row 13): Updated stale placeholder date - Pay: 28-Sep-26->28-Oct-26"
  // or non-admin: "[Outgoings] Aug 26 - Toby Stickland: Updated stale placeholder date - Pay: 28-Sep-26->28-Oct-26"
  // or legacy: "[Outgoings] Row 13, Toby Stickland: Updated stale Placeholder/Gap date (Rec: ...)"
  if (clean.includes("[Outgoings]") || clean.toLowerCase().includes("updated stale placeholder") || clean.toLowerCase().includes("placeholder/gap date") || clean.toLowerCase().includes("unrecon-gap")) {
    const res = { tab: "Outgoings" };
    const newMatch = clean.match(/(?:\[Outgoings\]\s*)?(?:([A-Za-z]{3}\s*\d{2})\s*[-–]\s*)?(.+?)(?:\s*\((?:Row\s*)?(\d+)\))?:\s*(?:£([0-9.,]+)\s*[-–]\s*)?Updated stale placeholder date(?:\s*[-–]\s*(.*))?$/i);
    if (newMatch) {
      res.month = newMatch[1] ? newMatch[1].trim() : null;
      res.contractor = newMatch[2] ? newMatch[2].trim() : "";
      res.rowNum = newMatch[3] ? parseInt(newMatch[3], 10) : null;
      res.amount = newMatch[4] ? `£${newMatch[4].trim()}` : null;
      res.changeText = newMatch[5] ? newMatch[5].trim() : "";
    } else {
      const legMatch = clean.match(/(?:\[Outgoings\]\s*)?(?:Row\s*(\d+),\s*)?(.+?):\s*Updated stale Placeholder\/Gap date\s*(?:\((.*)\))?/i);
      if (legMatch) {
        res.rowNum = legMatch[1] ? parseInt(legMatch[1], 10) : null;
        res.contractor = legMatch[2] ? legMatch[2].trim() : "";
        res.changeText = legMatch[3] ? legMatch[3].trim() : "";
      } else {
        res.rawText = clean.replace(/\[Outgoings\]\s*/i, "");
      }
    }

    // Fallback extraction for any missing fields:
    if (!res.month) {
      const mMatch = clean.match(/\b([A-Za-z]{3}\s*\d{2})\b/);
      if (mMatch) res.month = mMatch[1].trim();
    }
    if (!res.rowNum) {
      const rMatch = clean.match(/\bRow\s*(\d+)\b/i);
      if (rMatch) res.rowNum = parseInt(rMatch[1], 10);
    }
    if (!res.amount) {
      const aMatch = clean.match(/£([0-9.,]+)/);
      if (aMatch) res.amount = `£${aMatch[1].trim()}`;
    }
    if (!res.contractor) {
      const cMatch = clean.match(/(?:(?:[A-Za-z]{3}\s*\d{2}\s*[-–]\s*)|(?:\[Outgoings\]\s*))([^(:]+?)(?:\s*\(Row|\s*:)/i);
      if (cMatch) res.contractor = cMatch[1].trim();
    }

    if (res.changeText) {
      const parts = res.changeText.split(/,\s*/);
      res.changes = parts.map(p => {
        const arrowMatch = p.match(/(Rec(?:\s*Date)?|Pay(?:\s*Date)?):\s*([A-Za-z0-9-\/]+)\s*(?:->|→)\s*([A-Za-z0-9-\/]+)/i);
        if (arrowMatch) {
          const rawType = arrowMatch[1].trim();
          const isPay = rawType.toLowerCase().startsWith("pay");
          const type = isPay ? "Pay" : "Rec";
          const from = arrowMatch[2];
          const to = arrowMatch[3];
          if (!isPay) res.recDate = to;
          if (isPay) res.payDate = to;
          return {
            type,
            from,
            to,
            label: `${isPay ? "Pay date" : "Receive date"}: ${from} → ${to}`
          };
        }
        return { label: p.replace(/->/g, " → ") };
      }).filter(c => Boolean(c.label && c.label.trim()));
    }

    if (!res.rawText) {
      res.rawText = clean.replace(/^\[Outgoings\]\s*/i, "").replace(/\s*[-–]\s*$/, "").trim();
    }
    return res;
  }

  // 2. Confirmed check:
  // e.g. "[Confirmed] Row 202, Jenki Drinks LTD | Development - Jan, Slot 1: £1,050 - Rec Date updated 05-Sep-26 -> 05-Oct-26"
  // or non-admin: "[Confirmed] Jenki Drinks LTD | Development - Jan, Slot 1: £1,050 - Rec Date updated 05-Sep-26 -> 05-Oct-26"
  // or legacy: "[Confirmed] Stale Expense - Row 202, Jenki Drinks LTD | Development - Jan, Slot 1: Rec Date updated 05-Sep-26 -> 05-Oct-26"
  if (clean.includes("[Confirmed]")) {
    const res = { tab: "Confirmed" };
    const confMatch = clean.match(/\[Confirmed\]\s*(?:Stale Expense\s*[-–]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*([^,]+),\s*Slot\s*(\d+):\s*(?:£([0-9.,]+)\s*[-–]\s*)?Rec Date updated\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/i);
    if (confMatch) {
      res.rowNum = confMatch[1] ? parseInt(confMatch[1], 10) : null;
      res.client = confMatch[2] ? confMatch[2].trim() : "";
      res.job = confMatch[3] ? confMatch[3].trim() : "";
      res.slot = confMatch[4] ? parseInt(confMatch[4], 10) : null;
      res.amount = confMatch[5] ? `£${confMatch[5].trim()}` : null;
      res.oldRec = confMatch[6] ? confMatch[6].trim() : "";
      res.newRec = confMatch[7] ? confMatch[7].trim() : "";
      res.changes = [{
        type: "Rec",
        from: res.oldRec,
        to: res.newRec,
        label: `Receive date: ${res.oldRec} → ${res.newRec}`
      }];
    } else {
      res.rawText = clean.replace(/\[Confirmed\]\s*/i, "");
    }
    return res;
  }

  return null;
}

/**
 * Parses any informational alert detail string into a structured summary card object.
 * Returns consistent fields: tab, client, job, projectCode, contractor, rowNum,
 * confirmedRow, pipelineRow, outgoingsRow, month, amount, changes, highlight, rawText.
 */
export function parseInfoAlertDetail(flagType, detail = "") {
  if (!detail || typeof detail !== "string") return { rawText: String(detail || "") };
  const clean = detail.trim();

  // 1. Stale Invoices
  if (flagType === "invoiceStaleUnsentChanges" || clean.includes("Stale Invoice")) {
    const res = { tab: "Confirmed" };
    const confMatch = clean.match(/\[([A-Za-z]+)\]\s*(?:Stale Invoice\s*[-–:]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*([^,]+),\s*Slot\s*(\d+):\s*(?:£([0-9.,]+)\s*[-–]\s*)?Date moved\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/i);
    if (confMatch) {
      res.tab = confMatch[1] || "Confirmed";
      res.rowNum = confMatch[2] ? parseInt(confMatch[2], 10) : null;
      res.confirmedRow = res.rowNum;
      res.client = confMatch[3] ? confMatch[3].trim() : "";
      let rawJob = confMatch[4] ? confMatch[4].trim() : "";
      const jobTypeMatch = rawJob.match(/\((Project|Retainer)\)\s*$/i);
      if (jobTypeMatch) {
        res.jobType = jobTypeMatch[1].charAt(0).toUpperCase() + jobTypeMatch[1].slice(1).toLowerCase();
        rawJob = rawJob.replace(/\((Project|Retainer)\)\s*$/i, "").trim();
      }
      const pCodeMatch = rawJob.match(/\[([A-Za-z0-9_-]+)\]/);
      if (pCodeMatch) {
        res.projectCode = pCodeMatch[1];
        rawJob = rawJob.replace(/\[[A-Za-z0-9_-]+\]/, "").trim();
      }
      res.job = rawJob;
      res.slot = confMatch[5] ? parseInt(confMatch[5], 10) : null;
      if (confMatch[6]) {
        const amtNum = parseFloat(String(confMatch[6]).replace(/,/g, ""));
        res.invoiceAmount = !isNaN(amtNum) ? `£${amtNum.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `£${confMatch[6].trim()}`;
      }
      res.changes = [{
        type: "Send",
        from: confMatch[7] ? confMatch[7].trim() : "",
        to: confMatch[8] ? confMatch[8].trim() : "",
        label: `Send Date: ${confMatch[7] ? confMatch[7].trim() : ""} → ${confMatch[8] ? confMatch[8].trim() : ""}`
      }];
      res.highlight = "Stale unsent invoice send date moved forward to current month.";
      return res;
    }
  }

  // 2. Stale Expenses / Unrecon Gaps
  if (flagType === "expenseUnreconGaps" || clean.includes("Updated stale placeholder") || clean.includes("Rec Date updated")) {
    const exp = parseStaleExpenseDetail(clean);
    if (exp) {
      return {
        tab: exp.tab || (clean.includes("[Outgoings]") || clean.toLowerCase().includes("updated stale placeholder") ? "Outgoings" : "Confirmed"),
        month: exp.month,
        contractor: exp.contractor,
        rowNum: exp.rowNum,
        confirmedRow: exp.tab === "Confirmed" ? exp.rowNum : null,
        outgoingsRow: exp.tab === "Outgoings" ? exp.rowNum : null,
        client: exp.client,
        job: exp.job,
        slot: exp.slot,
        amount: exp.amount,
        recDate: exp.recDate,
        payDate: exp.payDate,
        changes: exp.changes,
        highlight: exp.tab === "Outgoings"
          ? "Stale unreceived expense dates moved forward to current month."
          : "Stale unreceived expense receive date moved forward to current month.",
        rawText: exp.rawText || clean.replace(/^\[[^\]]+\]\s*/, "")
      };
    }
  }

  // 3. Retainer Invoices Created
  if (flagType === "retainerInvoicesCreated" || (clean.includes("Added") && clean.includes("child row"))) {
    const m = clean.match(/(?:\[Retainers\s*-\s*(Confirmed|Pipeline)\]\s*)?Added\s+(\d+)\s+child\s+rows?\(s?\)\s*(?:\(Parent\s+Row:\s*(\d+)\)\s*)?(?:for\s+([^|]+)\|\s*([^[\n]+))?/i);
    if (m) {
      const tab = m[1] || "Confirmed";
      const rowNum = m[3] ? parseInt(m[3], 10) : null;
      return {
        tab,
        rowNum,
        confirmedRow: tab === "Confirmed" ? rowNum : null,
        pipelineRow: tab === "Pipeline" ? rowNum : null,
        client: m[4] ? m[4].trim() : "",
        job: m[5] ? m[5].trim() : "",
        highlight: `Added ${m[2]} future monthly billing period${parseInt(m[2], 10) > 1 ? "s" : ""} for retainer contract.`
      };
    }
    const mOld = clean.match(/(?:Row\s*(\d+),\s*)?([^,]+),\s*([^:]+):\s*Added\s+(\d+)\s+invoice rows/i);
    if (mOld) {
      const rowNum = mOld[1] ? parseInt(mOld[1], 10) : null;
      return {
        tab: "Confirmed",
        rowNum,
        confirmedRow: rowNum,
        client: mOld[2] ? mOld[2].trim() : "",
        job: mOld[3] ? mOld[3].trim() : "",
        highlight: `Added ${mOld[4]} future monthly billing period${parseInt(mOld[4], 10) > 1 ? "s" : ""} for retainer contract.`
      };
    }
  }

  // 4. Retainer Invoices Deleted / Trimmed
  if (flagType === "retainerInvoicesDeleted" || (clean.includes("Trimmed") && clean.includes("child row"))) {
    const m = clean.match(/(?:\[Retainers\s*-\s*(Confirmed|Pipeline)\]\s*)?Trimmed\s+(\d+)\s+child\s+rows?\(s?\)\s*(?:\(Parent\s+Row:\s*(\d+)\)\s*)?(?:for\s+([^|]+)\|\s*([^[\n]+))?/i);
    if (m) {
      const tab = m[1] || "Confirmed";
      const rowNum = m[3] ? parseInt(m[3], 10) : null;
      return {
        tab,
        rowNum,
        confirmedRow: tab === "Confirmed" ? rowNum : null,
        pipelineRow: tab === "Pipeline" ? rowNum : null,
        client: m[4] ? m[4].trim() : "",
        job: m[5] ? m[5].trim() : "",
        highlight: `Trimmed ${m[2]} excess billing period${parseInt(m[2], 10) > 1 ? "s" : ""} after retainer contract end date.`
      };
    }
  }

  // 5. CRM Copied to Confirmed (Checked)
  if (flagType === "crmCopiedConfChecked" || clean.includes("Copied Pipeline Project") || clean.includes("Converted Pipeline Job")) {
    const m = clean.match(/(?:Copied Pipeline Project(?:\s*\(with[^)]*\))?(?:\s+to Confirmed)?|Converted Pipeline Job to Confirmed Retainer):\s*([^|]+)\|\s*([\s\S]+?)(?:\s*\[([^\]]+)\])?(?:\s*\(Pipeline\s+row\s+(\d+)\s*->\s*Confirmed\s+row\s+(\d+)\))?\s*$/i);
    if (m) {
      const revMatch = clean.match(/Revenue:\s*([^|,;\n]+)/i);
      const dcMatch = clean.match(/Direct\s+costs:\s*([^|,;\n]+)/i);
      const startMatch = clean.match(/Start(?:\s+date)?:\s*([^|,;\n]+)/i);
      const endMatch = clean.match(/End(?:\s+date)?:\s*([^|,;\n]+)/i);
      return {
        client: m[1] ? m[1].trim() : "",
        job: m[2] ? m[2].trim() : "",
        projectCode: m[3] ? m[3].trim() : "",
        pipelineRow: m[4] ? parseInt(m[4], 10) : null,
        confirmedRow: m[5] ? parseInt(m[5], 10) : null,
        revenue: revMatch ? revMatch[1].trim() : "",
        directCosts: dcMatch ? dcMatch[1].trim() : "",
        startDate: startMatch ? startMatch[1].trim() : "",
        endDate: endMatch ? endMatch[1].trim() : "",
        highlight: clean.includes("Converted")
          ? "Converted Pipeline job to Confirmed Retainer."
          : "Pipeline project promoted to Confirmed jobs (Copied box checked)."
      };
    }
  }

  // 6. CRM Copied Unchecked
  if (flagType === "crmCopiedConfUnchecked" || clean.includes("Copied Status: 'Yes' -> 'No'")) {
    const m = clean.match(/Copied Status:\s*'Yes'\s*->\s*'No'\s*\(Reverted by Source\):\s*([^|]+)\|\s*([^[\n]+)(?:\s*\[([^\]]+)\])?(?:\s*\(Pipeline\s+row\s+(\d+)\))?/i);
    if (m) {
      return {
        tab: "Pipeline",
        client: m[1] ? m[1].trim() : "",
        job: m[2] ? m[2].trim() : "",
        projectCode: m[3] ? m[3].trim() : "",
        pipelineRow: m[4] ? parseInt(m[4], 10) : null,
        highlight: "Copied status reverted back from Yes to No by CRM source."
      };
    }
  }

  // 7. CRM Copied Delete
  if (flagType === "crmCopiedConfDelete" || clean.includes("Deleted Confirmed Job")) {
    const m = clean.match(/Deleted Confirmed Job:\s*(?:Row\s*(\d+),\s*)?([^|]+)\|\s*([^[\n]+)(?:\s*\[([^\]]+)\])?/i);
    if (m) {
      return {
        tab: "Confirmed",
        confirmedRow: m[1] ? parseInt(m[1], 10) : null,
        client: m[2] ? m[2].trim() : "",
        job: m[3] ? m[3].trim() : "",
        projectCode: m[4] ? m[4].trim() : "",
        highlight: "Confirmed job removed because CRM deal was deleted or moved."
      };
    }
  }

  // 8. Expense Added
  if (flagType === "expenseAdded" || clean.includes("Created New Row")) {
    const m = clean.match(/Created New Row:\s*(?:\[([^\]]+)\]\s*)?(?:([A-Za-z]{3}\s*\d{2})\s*[-–]\s*)?([^:]+)(?::\s*£?([0-9.,]+))?/i);
    if (m) {
      return {
        tab: m[1] || "Outgoings",
        month: m[2] ? m[2].trim() : null,
        contractor: m[3] ? m[3].trim() : "",
        amount: m[4] ? `£${m[4].trim()}` : null,
        highlight: "New expense entry created in Pulse."
      };
    }
  }

  // 9. Generic Fallback
  const res = {};
  if (flagType !== "crmCopiedConfChecked") {
    if (clean.includes("[Confirmed]")) res.tab = "Confirmed";
    else if (clean.includes("[Pipeline]")) res.tab = "Pipeline";
    else if (clean.includes("[Outgoings]")) res.tab = "Outgoings";
  }

  const pipeIdx = clean.indexOf("|");
  if (pipeIdx > 0) {
    const before = clean.substring(0, pipeIdx).replace(/\[[^\]]+\]/g, "").replace(/Row\s*\d+,?/gi, "").trim();
    const after = clean.substring(pipeIdx + 1).split(/,|\(|\[/)[0].trim();
    if (before && before.length < 50) res.client = before;
    if (after && after.length < 60) res.job = after;
  }

  const rowMatch = clean.match(/\bRow\s+(\d+)\b/i);
  if (rowMatch) res.rowNum = parseInt(rowMatch[1], 10);

  const DEFAULT_INFO_HIGHLIGHTS = {
    crmCopiedConfChecked: "Pipeline project promoted to Confirmed jobs (Copied box checked).",
    crmCopiedConfUnchecked: "Copied status reverted back from Yes to No by CRM source.",
    crmCopiedConfDelete: "Confirmed job removed because CRM deal was deleted or moved.",
    retainerInvoicesCreated: "Added future monthly billing periods for retainer contract.",
    retainerInvoicesDeleted: "Trimmed excess billing periods after retainer contract end date.",
    expenseAdded: "New expense entry created in Pulse.",
    invoiceStaleUnsentChanges: "Stale unsent invoice send date moved forward to current month.",
    expenseUnreconGaps: "Stale unreceived expense dates moved forward to current month.",
  };
  if (DEFAULT_INFO_HIGHLIGHTS[flagType]) {
    res.highlight = DEFAULT_INFO_HIGHLIGHTS[flagType];
  }

  res.rawText = clean.replace(/^\[[^\]]+\]\s*/, "");
  return res;
}

/**
 * Checks whether a "Stale unsent invoice send date changed" (invoiceStaleUnsentChanges) alert
 * should be blocked/suppressed because an active "Expected retainer invoice not found at current retainer amount"
 * (retainer_invoice) alert exists for the same job. Once the expected retainer alert is cleared,
 * this returns false so the stale unsent alert appears if still present.
 */
export function isStaleInvoiceSuppressedByRetainerAlert(na, proactiveAlerts = []) {
  if (!na || na.flagType !== "invoiceStaleUnsentChanges") return false;
  if (!Array.isArray(proactiveAlerts) || proactiveAlerts.length === 0) return false;

  const parsed = parseInfoAlertDetail(na.flagType, na.flagDetail || na.alertSummary || "");
  const naTenant = String(na.clientName || "").trim().toLowerCase();
  const naEndClient = String(parsed.client || na.analysisResult?.results?.[0]?.jobClient || na.analysisResult?.results?.[0]?.clientName || "").trim().toLowerCase();
  const naJob = String(parsed.job || na.analysisResult?.results?.[0]?.jobName || "").trim().toLowerCase();
  const naRow = parsed.confirmedRow || parsed.rowNum || na.analysisResult?.results?.[0]?.rowNum;

  return proactiveAlerts.some((pa) => {
    if (!pa || pa.alertType !== "retainer_invoice") return false;
    const m = pa.metadata || {};
    // Match expected retainer invoice not found at current retainer amount (or any active expected retainer invoice alert for this job)
    const paTenant = String(pa.clientName || "").trim().toLowerCase();
    if (naTenant && paTenant && naTenant !== paTenant) return false;

    const paEndClient = String(m.endClientName || pa.endClientName || "").trim().toLowerCase();
    const paJob = String(m.jobName || pa.jobName || "").trim().toLowerCase();
    const paRow = m.confirmedRow || pa.confirmedRow;

    if (naJob && paJob && naJob === paJob) {
      if (!naEndClient || !paEndClient || naEndClient === paEndClient) {
        return true;
      }
    }
    if (naRow && paRow && Number(naRow) === Number(paRow)) {
      return true;
    }
    return false;
  });
}

/**
 * Returns the human-readable event/action summary sentence for an informational alert card header (Option 3),
 * avoiding duplication with the blue section header above the group.
 */
export function getInfoCardTitle(na, parsed, getFlagName, isAdmin = true) {
  const rawHighlight = parsed?.highlight ? String(parsed.highlight).trim().replace(/\.$/, "") : "";
  if (rawHighlight) {
    return isAdmin ? rawHighlight : sanitizeSpreadsheetTerms(rawHighlight);
  }
  const fallback = (typeof getFlagName === "function" ? getFlagName(na?.flagType) : "") || na?.flagName || "Alert";
  return isAdmin ? fallback : sanitizeSpreadsheetTerms(fallback);
}

/**
 * Returns the human-readable problem/event summary sentence for a proactive alert card header (Option 3),
 * avoiding duplication with the blue PROACTIVE_TYPE_LABELS section header above the group.
 */
export function getProactiveCardTitle(alert, isAdmin = true) {
  if (!alert) return "Alert";
  const m = alert.metadata || {};
  const type = alert.alertType || "";
  switch (type) {
    case "retainer_invoice": {
      const effCase = m.possibleMatchCase || (
        m.possibleMatchInvoiceNo
          ? ((m.possibleMatchAmount && m.revenue && Math.abs(parseFloat(m.possibleMatchAmount || 0) - parseFloat(m.revenue || 0)) > 0.01) ? "changed" : (m.possibleMatchStatus && !["sent", "paid"].includes(String(m.possibleMatchStatus).toLowerCase()) ? "draft" : "matches"))
          : ""
      );
      if (effCase === "draft") return "Draft retainer invoice found but not yet sent";
      if (effCase === "changed") return "Expected retainer invoice not found at current retainer amount";
      return "Expected recurring retainer invoice has not been sent";
    }
    case "uninvoiced_new_job":
      return "Job started over a month ago with no invoices sent";
    case "uninvoiced_revenue":
      return "Completed job has uninvoiced revenue remaining";
    case "unreceived_expenses":
      return "Completed job has unreceived direct cost budget remaining";
    case "stale_unrecon_gap":
      return "Placeholder expense received date is overdue and has not been reconciled";
    case "retroactive_outgoings_update":
      return "Actual expenses were added to a past month in Outgoings";
    case "unmapped_pl_category": {
      const catName = getCleanPLCategoryName(alert);
      return catName && catName !== "Unknown Category"
        ? `New accounting category "${catName}" requires P&L mapping`
        : "New accounting category requires P&L mapping";
    }
    case "crm_wipe":
      return "Large drop in CRM deals detected during sync";
    case "crm_sync_blocked": {
      const tool = m.crmTool || alert.crmTool || "CRM";
      const ex = m.existingCount ?? alert.existingCount;
      const inc = m.incomingCount ?? alert.incomingCount;
      if (ex !== undefined && ex !== null && inc !== undefined && inc !== null) {
        return `${tool} sync paused — job count changed from ${ex} to ${inc}`;
      }
      return "CRM sync paused due to large change in job count";
    }
    case "revenue_mismatch":
      return "Total invoiced does not match confirmed job revenue budget";
    case "direct_costs_mismatch":
      return "Total expenses do not match job direct cost budget";
    case "pipeline_confirmed_overlap":
      return isAdmin
        ? "Job exists in both Confirmed and Pipeline tabs but Pipeline is not closed out"
        : "Job exists in both Confirmed and Pipeline jobs but Pipeline is not closed out";
    case "retainer_shrink_blocked":
      return isAdmin
        ? "Retainer contract shrunk - excess child row could not be removed automatically"
        : "Retainer contract shrunk - excess billing period could not be removed automatically";
    case "autolog_error": {
      const cleanSummary = String(m.summary || alert.heading || "")
        .replace(/^AutoLog\s+error:\s*/i, "")
        .trim();
      const title = cleanSummary || "Error recorded during automated background sync";
      return isAdmin ? title : sanitizeSpreadsheetTerms(title);
    }
    case "infinite_loop": {
      const cleanSummary = String(m.summary || alert.heading || "")
        .replace(/^Sync\s+conflict\s*(?:\(possible\s+infinite\s+loop\))?:\s*/i, "")
        .trim();
      const title = cleanSummary
        ? `Repeated field oscillation detected: ${cleanSummary}`
        : "Repeated field oscillation detected between sync runs";
      return isAdmin ? title : sanitizeSpreadsheetTerms(title);
    }
    case "deleted_invoice":
      return "Invoice reference in Pulse was not found in accounting";
    case "deleted_expense":
      return "Expense reference in Pulse was not found in accounting";
    case "job_structure_error":
      return isAdmin
        ? "Confirmed job has an invalid parent or child row structure"
        : "Confirmed job has an invalid billing structure";
    case "part_paid_balance": {
      const isExp = (m.itemType || alert.itemType) === "expense";
      return isExp
        ? "Remaining balance on part-paid expense needs an expected payment date"
        : "Remaining balance on part-paid invoice needs an expected payment date";
    }
    case "salary_forecast_in_actual_month": {
      const empName = m.employeeName || alert.employeeName;
      const monthLbl = m.monthLabel || alert.monthLabel;
      return empName && monthLbl
        ? `${empName} has no salary actuals and is still on forecast in ${monthLbl}`
        : "Employee still on salary forecast in an actuals month";
    }
    default:
      return isAdmin ? (alert.heading || "Proactive alert") : sanitizeSpreadsheetTerms(alert.heading || "Proactive alert");
  }
}

/**
 * Safely downloads a CSV file on the client with UTF-8 BOM (\uFEFF)
 * so that Excel / Windows opens the file without showing weird characters (e.g. Â£ instead of £).
 * Accepts either a pre-formatted CSV string or a 2D array of rows.
 */
export function downloadCsv(filename, content) {
  const sanitizeCsvCell = (raw) => {
    const str = String(raw);
    const trimmed = str.trimStart();
    if (!trimmed) return str;
    const first = trimmed[0];
    if (first === "=" || first === "+" || first === "@" || first === "\t" || first === "\r") {
      return `'${str}`;
    }
    if (first === "-" && !/^-[£$€]?[\d,]+(?:\.\d+)?%?$/.test(trimmed)) {
      return `'${str}`;
    }
    return str;
  };

  let csvText = "";
  if (Array.isArray(content)) {
    csvText = content
      .map((row) =>
        (row || [])
          .map((val) => {
            if (val === null || val === undefined) return '""';
            const str = sanitizeCsvCell(val);
            return `"${str.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\r\n");
  } else {
    csvText = String(content || "");
  }

  // Prepend UTF-8 BOM so Excel / Windows correctly identifies UTF-8 and displays currency symbols like £ without Â
  const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename.endsWith(".csv") ? filename : `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Extracts a clean P&L category/account name from an alert object or raw title,
 * safely unwrapping any heading prefix or quotes.
 */
export function getCleanPLCategoryName(alertOrRaw) {
  let name = "";
  if (typeof alertOrRaw === "string") {
    name = alertOrRaw;
  } else if (alertOrRaw && typeof alertOrRaw === "object") {
    name = alertOrRaw.metadata?.categoryName ||
      alertOrRaw.metadata?.cleanName ||
      alertOrRaw.categoryName ||
      alertOrRaw.cleanName ||
      alertOrRaw.heading ||
      "";
  }
  name = String(name || "").trim();
  const match = name.match(/Unmapped P&L (?:category|Account):\s*["“]?([^"”]+)["”]?/i);
  if (match) {
    name = match[1].trim();
  }
  return name.replace(/^["“]+|["”]+$/g, "").trim();
}

export const MIN_VALID_DATE_YEAR = 1900;
export const MAX_VALID_DATE_YEAR = 2099;
export const MIN_INPUT_DATE = "1900-01-01";
export const MAX_INPUT_DATE = "2099-12-31";
export const MIN_INPUT_MONTH = "1900-01";
export const MAX_INPUT_MONTH = "2099-12";

function buildValidatedDate_(yr, mIdx, day) {
  if (!Number.isInteger(yr) || yr < MIN_VALID_DATE_YEAR || yr > MAX_VALID_DATE_YEAR) return null;
  if (!Number.isInteger(mIdx) || mIdx < 0 || mIdx > 11) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const d = new Date(yr, mIdx, day);
  if (
    isNaN(d.getTime()) ||
    d.getFullYear() !== yr ||
    d.getMonth() !== mIdx ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

/**
 * Validates that a string is a strict YYYY-MM-DD calendar date within [minYear, maxYear].
 */
export function isValidCalendarIsoDate(str, { minYear = MIN_VALID_DATE_YEAR, maxYear = MAX_VALID_DATE_YEAR } = {}) {
  if (typeof str !== "string") return false;
  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const yr = parseInt(match[1], 10);
  const mo = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (yr < minYear || yr > maxYear || mo < 1 || mo > 12 || day < 1 || day > 31) return false;
  const d = new Date(yr, mo - 1, day);
  return (
    !isNaN(d.getTime()) &&
    d.getFullYear() === yr &&
    d.getMonth() === mo - 1 &&
    d.getDate() === day
  );
}

/**
 * Checks whether a date input value (ISO, d-Mmm-yy, DD/MM/YYYY, or sentinel) is valid.
 */
export function isValidDateInputValue(val, { allowEmpty = true, minYear = MIN_VALID_DATE_YEAR, maxYear = MAX_VALID_DATE_YEAR } = {}) {
  if (val === undefined || val === null || String(val).trim() === "") {
    return allowEmpty;
  }
  if (isNoEndDateSentinel(val)) return true;
  const d = parseSheetDate(val);
  return Boolean(d && d.getFullYear() >= minYear && d.getFullYear() <= maxYear);
}

/**
 * Validates start/end dates and ensures end date is not earlier than start date.
 */
export function validateDateRange(startVal, endVal, { allowNoEndDate = false, requireStart = false, requireEnd = false } = {}) {
  const startEmpty = startVal === undefined || startVal === null || String(startVal).trim() === "";
  const endIsSentinel = isNoEndDateSentinel(endVal);
  const endEmpty = endVal === undefined || endVal === null || String(endVal).trim() === "";

  if (requireStart && startEmpty) {
    return { valid: false, error: "Please enter a valid start date." };
  }
  if (!startEmpty && !isValidDateInputValue(startVal, { allowEmpty: false })) {
    return { valid: false, error: "Please enter a valid start date." };
  }

  if (!allowNoEndDate && !endIsSentinel) {
    if (requireEnd && endEmpty) {
      return { valid: false, error: "Please enter a valid end date." };
    }
    if (!endEmpty && !isValidDateInputValue(endVal, { allowEmpty: false })) {
      return { valid: false, error: "Please enter a valid end date." };
    }
  }

  if (!startEmpty && !endEmpty && !allowNoEndDate && !endIsSentinel) {
    const startDate = parseSheetDate(startVal);
    const endDate = parseSheetDate(endVal);
    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      return { valid: false, error: "End date cannot be earlier than start date." };
    }
  }

  return { valid: true };
}

/**
 * Parses any date format (ISO YYYY-MM-DD, d-Mmm-yy, DD/MM/YYYY, etc.) into a Date object.
 */
export function parseSheetDate(dStr) {
  if (dStr === null || dStr === undefined || dStr === "") return null;
  if (dStr instanceof Date) {
    if (isNaN(dStr.getTime())) return null;
    const yr = dStr.getFullYear();
    return yr >= MIN_VALID_DATE_YEAR && yr <= MAX_VALID_DATE_YEAR ? dStr : null;
  }

  // 0. Google Sheets / Excel numeric serial date (e.g. 46326 for 31-Oct-2026)
  if (typeof dStr === "number" && Number.isFinite(dStr) && dStr > 20000 && dStr < 90000) {
    const utc = new Date(Math.round((dStr - 25569) * 86400 * 1000));
    return buildValidatedDate_(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }

  const s = String(dStr).trim();
  if (!s || s === "-" || s === "(blank)") return null;

  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 20000 && num < 90000) {
      const utc = new Date(Math.round((num - 25569) * 86400 * 1000));
      return buildValidatedDate_(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
  }

  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mIdx = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return buildValidatedDate_(yr, mIdx, day);
  }

  // 2. DD-Mon-YY or DD-Mon-YYYY (e.g. 15-Oct-26 or 1-Jan-2025)
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mIdx = months[m[2].toLowerCase()];
    if (mIdx !== undefined) {
      let yr = parseInt(m[3], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      else if (m[3].length !== 4) return null;
      return buildValidatedDate_(yr, mIdx, parseInt(m[1], 10));
    }
  }

  // 3. Mon-YY or Mon-YYYY
  const myMatch = s.match(/^([A-Za-z]{3})[-/\s](\d{2,4})$/);
  if (myMatch) {
    const mIdx = months[myMatch[1].toLowerCase()];
    if (mIdx !== undefined) {
      let yr = parseInt(myMatch[2], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      else if (myMatch[2].length !== 4) return null;
      return buildValidatedDate_(yr, mIdx, 1);
    }
  }

  // 4. DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY
  const slashMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    else if (slashMatch[3].length !== 4) return null;
    return buildValidatedDate_(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  // Prevent pure integer strings from being parsed by V8 as a year (e.g. new Date("46326") -> 1-Jan-46326)
  if (/^\d+$/.test(s)) return null;

  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const yr = d.getFullYear();
  return yr >= MIN_VALID_DATE_YEAR && yr <= MAX_VALID_DATE_YEAR ? d : null;
}

/**
 * Converts any date representation to ISO "YYYY-MM-DD" for calendar inputs.
 */
export function toInputDateFormat(dStr) {
  if (!dStr) return "";
  const d = parseSheetDate(dStr);
  if (!d) return "";
  const y = d.getFullYear();
  if (y < MIN_VALID_DATE_YEAR || y > MAX_VALID_DATE_YEAR) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${m}-${day}`;
}

/**
 * Converts any date representation to "d-Mmm-yy" (e.g. "1-Jan-25", "15-Oct-26").
 */
export function toSheetDateFormat(dStr) {
  if (!dStr) return "";
  const d = parseSheetDate(dStr);
  if (!d) {
    const raw = String(dStr).trim();
    return sanitizeFormulaInput(raw);
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d.getDate();
  const mmm = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${day}-${mmm}-${yy}`;
}

/**
 * Calculates payment date given a base date string and number of days to pay.
 * Returns formatted date as "d-Mmm-yy" (e.g. "24-Nov-26") or null if invalid.
 */
export function calculatePaymentDate(baseDateStr, daysToPay) {
  if (!baseDateStr && baseDateStr !== 0) return null;
  const d = parseSheetDate(baseDateStr);
  if (!d || isNaN(d.getTime())) return null;
  const days = parseInt(daysToPay, 10);
  if (isNaN(days)) return null;
  const target = new Date(d.getTime());
  target.setDate(target.getDate() + days);
  return toSheetDateFormat(target);
}

/**
 * Generates an incremented job name for duplicated jobs.
 * E.g.:
 * - "Website Redesign" -> "Website Redesign 2"
 * - "Website Redesign 2" -> "Website Redesign 3"
 * - "Website Redesign (2)" -> "Website Redesign 3"
 */
export function generateDuplicateJobName(jobName) {
  const trimmed = (jobName || "").trim();
  if (!trimmed) return "New job 2";

  // Check if ends with a space and a number: e.g. "Acme Project 2" -> "Acme Project 3"
  const spaceNumMatch = trimmed.match(/^(.*?)\s+(\d+)$/);
  if (spaceNumMatch) {
    const prefix = spaceNumMatch[1];
    const num = parseInt(spaceNumMatch[2], 10);
    return `${prefix} ${num + 1}`;
  }

  // Check if ends with "(number)": e.g. "Acme Project (2)" -> "Acme Project 3"
  const parenNumMatch = trimmed.match(/^(.*?)\s*\((\d+)\)$/);
  if (parenNumMatch) {
    const prefix = parenNumMatch[1];
    const num = parseInt(parenNumMatch[2], 10);
    return `${prefix} ${num + 1}`;
  }

  return `${trimmed} 2`;
}

/**
 * Generates a renewal job name with "(Mmm yyyy-)" appended or replacing an existing date appendage.
 * E.g.:
 * - "SEO Retainer (Jan 2025-)" -> "SEO Retainer (Jan 2026-)"
 * - "SEO Retainer (Jan 25-)" -> "SEO Retainer (Jan 2026-)"
 * - "SEO Retainer (Jan 25-Dec 25)" -> "SEO Retainer (Jan 2026-)"
 * - "SEO Retainer" -> "SEO Retainer (Jan 2026-)"
 */
export function generateRenewalJobName(jobName, renewalStartDate) {
  const baseName = (jobName || "").trim() || "Retainer";
  const d = renewalStartDate instanceof Date ? renewalStartDate : parseSheetDate(renewalStartDate);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mmm = d && !isNaN(d.getTime()) ? months[d.getMonth()] : months[new Date().getMonth()];
  const yyyy = d && !isNaN(d.getTime()) ? d.getFullYear() : new Date().getFullYear();
  const renewalTag = `(${mmm} ${yyyy}-)`;

  // Match existing date appendages:
  // e.g. (Jan 2025-), (Jan 25-), (Jan 25 - Dec 25), (Jan 25-Dec 25), (Jan 2025 - Dec 2025), (January 2025-), (Jan 2025 to Dec 2025)
  const dateAppendageRegex = /\s*\((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s]*\d{2,4}(?:[-/\s]*(?:to|-|–)?[-/\s]*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s]*\d{2,4})?)?[-/\s]*\)\s*$/i;

  if (dateAppendageRegex.test(baseName)) {
    return baseName.replace(dateAppendageRegex, ` ${renewalTag}`);
  }
  return `${baseName} ${renewalTag}`;
}

/**
 * Calculates start and end dates for a pipeline contract renewal.
 * - Start date: The day after the origin job ends.
 * - End date: Based on the duration of the origin job.
 * Returns null if origin has no end date or is a sentinel value.
 */
export function calculateRenewalDates(startDateStr, endDateStr) {
  if (!endDateStr || isNoEndDateSentinel(endDateStr)) {
    return null;
  }
  const dEnd = parseSheetDate(endDateStr);
  if (!dEnd || isNaN(dEnd.getTime())) return null;

  // Start date of renewal is the day after the origin job ends
  const renewalStartDate = new Date(dEnd.getFullYear(), dEnd.getMonth(), dEnd.getDate() + 1);

  // Calculate duration of the origin job
  let durationMonths = 12;
  const dStart = parseSheetDate(startDateStr);
  if (dStart && !isNaN(dStart.getTime()) && dEnd >= dStart) {
    const yearDiff = dEnd.getFullYear() - dStart.getFullYear();
    const monthDiff = dEnd.getMonth() - dStart.getMonth();
    const dayDiff = dEnd.getDate() - dStart.getDate();
    const rawMonths = yearDiff * 12 + monthDiff + (dayDiff >= 20 ? 1 : 0);
    if (rawMonths > 0) {
      durationMonths = rawMonths;
    }
  }

  // End date is renewalStartDate + durationMonths - 1 day
  const targetMonth = renewalStartDate.getMonth() + durationMonths;
  const targetYear = renewalStartDate.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDays = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const nextStart = new Date(targetYear, normalizedMonth, Math.min(renewalStartDate.getDate(), maxDays));
  const renewalEndDate = new Date(nextStart.getFullYear(), nextStart.getMonth(), nextStart.getDate() - 1);

  return {
    startDateISO: toInputDateFormat(renewalStartDate),
    endDateISO: toInputDateFormat(renewalEndDate),
    startDateSheet: toSheetDateFormat(renewalStartDate),
    endDateSheet: toSheetDateFormat(renewalEndDate),
    durationMonths,
    renewalStartDate,
    renewalEndDate,
  };
}

/**
 * Extracts target job or outgoings expense information for supported alert types:
 * - expenseUnreconGaps
 * - invoiceStaleUnsentChanges
 * - uninvoiced_new_job
 * - uninvoiced_revenue
 * - unreceived_expenses
 * - revenue_mismatch
 * - direct_costs_mismatch
 * - stale_unrecon_gap
 */
function getAlertJobTargetInternal_(alertOrNa, isInfo = false, clientInfo = null) {
  if (!alertOrNa) return null;

  const m = alertOrNa.metadata || {};
  const cName = alertOrNa.clientName || clientInfo?.clientName || m.clientName || "";
  const cSheetId =
    alertOrNa.clientSheetId ||
    clientInfo?.clientSheetId ||
    clientInfo?.sheetId ||
    (alertOrNa.clientId && alertOrNa.clientId !== clientInfo?.masterSheetId ? alertOrNa.clientId : null) ||
    null;
  const effectiveClient = clientInfo
    ? { ...clientInfo, clientSheetId: cSheetId || clientInfo.clientSheetId }
    : (cName ? { clientName: cName, clientSheetId: cSheetId } : null);

  if (isInfo) {
    const flagType = alertOrNa.flagType;
    if (flagType !== "expenseUnreconGaps" && flagType !== "invoiceStaleUnsentChanges") {
      return null;
    }
    const parsed = parseInfoAlertDetail(flagType, alertOrNa.flagDetail);
    if (!parsed) return null;

    if (flagType === "expenseUnreconGaps" && (parsed.tab === "Outgoings" || (!parsed.tab && (parsed.contractor || parsed.outgoingsRow)))) {
      return {
        isOutgoings: true,
        client: effectiveClient,
        clientName: cName,
        clientSheetId: cSheetId,
        contractor: parsed.contractor,
        month: parsed.month,
        rowNum: parsed.rowNum || parsed.outgoingsRow,
        amount: parsed.amount,
        recDate: parsed.recDate,
        payDate: parsed.payDate,
        changes: parsed.changes,
        rawText: parsed.rawText,
        appId: parsed.appId || "UNRECON-GAP"
      };
    }

    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum: parsed.confirmedRow || parsed.rowNum,
      tabName: "Confirmed",
      jobName: parsed.job,
      endClientName: parsed.client,
      projectCode: parsed.projectCode
    };
  }

  // Proactive alert
  const alertType = alertOrNa.alertType;

  if (alertType === "stale_unrecon_gap") {
    const parsedFromDetail = alertOrNa.detail ? parseStaleExpenseDetail(alertOrNa.detail) : null;
    return {
      isOutgoings: true,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      contractor: m.contractor || alertOrNa.contractor || parsedFromDetail?.contractor,
      cellCoord: m.cellCoord || alertOrNa.cellCoord,
      month: m.month || alertOrNa.month || parsedFromDetail?.month,
      amount: m.amount || alertOrNa.amount || parsedFromDetail?.amount,
      recDate: m.recDate || alertOrNa.recDate || parsedFromDetail?.recDate,
      payDate: m.payDate || alertOrNa.payDate || parsedFromDetail?.payDate,
      weeksAgo: m.weeksAgo || alertOrNa.weeksAgo,
      appId: m.appId || alertOrNa.appId || "UNRECON-GAP",
      description: m.description || alertOrNa.description,
      rowNum: m.rowNum || alertOrNa.rowNum || parsedFromDetail?.rowNum
    };
  }

  if (alertType === "retainer_invoice" || alertType === "retainer_shrink_blocked") {
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/Row\s*(\d+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode
    };
  }

  if (alertType === "uninvoiced_new_job" || alertType === "uninvoiced_revenue") {
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/Row\s*(\d+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode
    };
  }

  if (alertType === "unreceived_expenses") {
    const parsed = (!m.directCosts && !alertOrNa.directCosts && alertOrNa.detail) ? parseUnreceivedExpensesDetail(alertOrNa.detail) : {};
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || parsed.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/Row\s*(\d+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName || parsed.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName || parsed.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode || parsed.projectCode
    };
  }

  if (alertType === "revenue_mismatch") {
    const parsed = (!m.revenue && !alertOrNa.revenue && alertOrNa.detail) ? parseRevenueMismatchDetail(alertOrNa.detail) : {};
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || parsed.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/Row\s*(\d+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName || parsed.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName || parsed.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode || parsed.projectCode
    };
  }

  if (alertType === "direct_costs_mismatch") {
    const parsed = (!m.directCosts && !alertOrNa.directCosts && alertOrNa.detail) ? parseDirectCostsMismatchDetail(alertOrNa.detail) : {};
    const tabName = m.tab || alertOrNa.tab || parsed.tab || (alertOrNa.detail && alertOrNa.detail.includes("Pipeline tab") ? "Pipeline" : "Confirmed");
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || alertOrNa.sheetRow || parsed.rowNum || (alertOrNa.detail && alertOrNa.detail.match(/Row\s*(\d+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum,
      tabName,
      jobName: m.jobName || alertOrNa.jobName || parsed.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName || parsed.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode || parsed.projectCode
    };
  }

  if (alertType === "deleted_invoice") {
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/row\s*(\d+)/i)?.[1]);
    const slotNum = m.slotNum || alertOrNa.slotNum || (alertOrNa.detail && alertOrNa.detail.match(/invoice slot\s*(\d+)/i)?.[1]);
    const invoiceRef = m.stableJobKey || alertOrNa.stableJobKey || m.invoiceRef || alertOrNa.invoiceRef || (alertOrNa.detail && alertOrNa.detail.match(/Invoice\s+([^\s(]+)/i)?.[1]);
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum: rowNum ? Number(rowNum) : null,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode,
      slotNum: slotNum ? Number(slotNum) : null,
      invoiceRef: invoiceRef ? String(invoiceRef).trim() : "",
      amount: m.amount || alertOrNa.amount,
      sentDate: m.sentDate || alertOrNa.sentDate,
    };
  }

  if (alertType === "deleted_expense") {
    const endClientName = String(m.endClientName || alertOrNa.endClientName || "").trim();
    const jobName = String(m.jobName || alertOrNa.jobName || "").trim();
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow || (alertOrNa.detail && alertOrNa.detail.match(/row\s*(\d+)/i)?.[1]);
    const slotNum = m.slotNum || alertOrNa.slotNum || (alertOrNa.detail && alertOrNa.detail.match(/expense slot\s*(\d+)/i)?.[1]);
    const expRef = String(m.expRef || m.stableJobKey || alertOrNa.stableJobKey || (alertOrNa.detail && alertOrNa.detail.match(/Expense\s+([^\s(]+)/i)?.[1]) || "").trim();
    const isOutgoings = Boolean(m.isOutgoings || alertOrNa.isOutgoings || (!rowNum && endClientName.toLowerCase() === "outgoings"));

    if (isOutgoings) {
      return {
        isOutgoings: true,
        client: effectiveClient,
        clientName: cName,
        clientSheetId: cSheetId,
        contractor: jobName || endClientName,
        amount: m.amount || alertOrNa.amount,
        recDate: m.recDate || alertOrNa.recDate,
        appId: expRef,
        description: m.description || alertOrNa.description,
      };
    }

    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum: rowNum ? Number(rowNum) : null,
      tabName: "Confirmed",
      jobName,
      endClientName,
      projectCode: m.projectCode || alertOrNa.projectCode,
      slotNum: slotNum ? Number(slotNum) : null,
      expRef,
      description: m.description || alertOrNa.description,
      amount: m.amount || alertOrNa.amount,
      recDate: m.recDate || alertOrNa.recDate,
    };
  }

  if (alertType === "part_paid_balance") {
    const isExp = (m.itemType || alertOrNa.itemType) === "expense";
    if (isExp) {
      return {
        isOutgoings: true,
        client: effectiveClient,
        clientName: cName,
        clientSheetId: cSheetId,
        contractor: m.contractor || alertOrNa.contractor || m.endClientName || alertOrNa.endClientName,
        rowNum: m.rowNum || alertOrNa.rowNum,
        cellCoord: m.cellCoord || alertOrNa.cellCoord,
        amount: m.balanceAmount || alertOrNa.balanceAmount,
        recDate: m.recDate || alertOrNa.recDate,
        payDate: m.targetDate || alertOrNa.targetDate,
        appId: m.appId || alertOrNa.appId
      };
    }
    const rowNum = m.confirmedRow || alertOrNa.confirmedRow;
    const slotNum = m.slot || alertOrNa.slot;
    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName: cName,
      clientSheetId: cSheetId,
      rowNum: rowNum ? Number(rowNum) : null,
      tabName: "Confirmed",
      jobName: m.jobName || alertOrNa.jobName,
      endClientName: m.endClientName || alertOrNa.endClientName,
      slotNum: slotNum ? Number(slotNum) : null,
      invoiceRef: m.ref || alertOrNa.ref,
      amount: m.balanceAmount || alertOrNa.balanceAmount,
      sentDate: m.sendDate || alertOrNa.sendDate,
    };
  }

  // CRM Alerts
  const ft = alertOrNa.flagType || alertOrNa.alertType || alertOrNa.type || "";
  if (ft.startsWith("crm") || alertOrNa.type === "crm" || alertOrNa.sheetName === "CRMComp") {
    const isPipeline = ft.includes("Pipe") || alertOrNa.mode === "Pipeline";
    const tabName = isPipeline ? "Pipeline" : "Confirmed";
    const isDash = ft.includes("Dash");
    const cd = alertOrNa.data?.crmData || [];
    const sd = alertOrNa.data?.sheetData || [];
    const crmClient = isDash ? cd[0] : cd[1];
    const crmJob = isDash ? cd[1] : cd[2];
    const crmCode = isDash ? cd[2] : cd[0];
    const shtClient = isDash ? sd[1] : sd[0];
    const shtJob = isDash ? sd[2] : sd[1];
    const shtCode = isDash ? sd[0] : sd[2];
    const clientName = shtClient || crmClient || cName;
    const jobName = shtJob || crmJob;
    const projectCode = shtCode || crmCode;
    const rowNum = (!isDash && alertOrNa.rowNumber) ? Number(alertOrNa.rowNumber) : (alertOrNa.jobRow ? Number(alertOrNa.jobRow) : undefined);

    return {
      isOutgoings: false,
      client: effectiveClient,
      clientName,
      clientSheetId: cSheetId,
      rowNum,
      tabName,
      jobName,
      endClientName: clientName,
      projectCode
    };
  }

  return null;
}

export function getAlertJobTarget(alertOrNa, isInfo = false, clientInfo = null) {
  if (!alertOrNa) return null;
  const target = getAlertJobTargetInternal_(alertOrNa, isInfo, clientInfo);
  if (!target) return null;
  target.sourceAlert = alertOrNa;
  return target;
}

const RET_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RET_MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function getRetainerRowMonthLabel(r, rIdx = 0, job = null) {
  // Defensive swap if called as (job, r, rIdx) or (job, r)
  if (r && typeof rIdx === "object" && rIdx !== null) {
    const tempJob = r;
    r = rIdx;
    rIdx = typeof job === "number" ? job : (typeof job === "string" ? parseInt(job, 10) || 0 : 0);
    job = tempJob;
  }
  const safeRIdx = typeof rIdx === "number" ? rIdx : (parseInt(rIdx, 10) || 0);

  // 1. Check if the row has an explicit date in slots or row fields
  const slotDate = r?.invoiceSlots?.[0]?.sentDate || r?.expenseSlots?.[0]?.date || r?.startDate || r?.date;
  if (slotDate) {
    const s = String(slotDate).trim();
    const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
    if (m) {
      const monStr = m[2];
      const yrStr = m[3].length === 4 ? m[3].slice(-2) : m[3];
      return `${monStr.charAt(0).toUpperCase() + monStr.slice(1).toLowerCase()}-${yrStr}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const monStr = RET_MONTH_NAMES[d.getMonth()];
      const yrStr = String(d.getFullYear()).slice(-2);
      return `${monStr}-${yrStr}`;
    }
  }

  // 2. Derive by projecting from the retainer job's startDate + safeRIdx months
  const parentStart = job?.startDate || job?.rows?.[0]?.startDate || r?.startDate;
  if (parentStart) {
    const s = String(parentStart).trim();
    const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
    if (m) {
      const mIdx = RET_MONTH_INDEX[m[2].toLowerCase()];
      if (mIdx !== undefined) {
        const fullYr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        const day = Math.min(parseInt(m[1], 10) || 1, 28);
        const projectedDate = new Date(fullYr, mIdx + safeRIdx, day);
        const monStr = RET_MONTH_NAMES[projectedDate.getMonth()];
        const yrStr = String(projectedDate.getFullYear()).slice(-2);
        return `${monStr}-${yrStr}`;
      }
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const projectedDate = new Date(d.getFullYear(), d.getMonth() + safeRIdx, Math.min(d.getDate(), 28));
      const monStr = RET_MONTH_NAMES[projectedDate.getMonth()];
      const yrStr = String(projectedDate.getFullYear()).slice(-2);
      return `${monStr}-${yrStr}`;
    }
  }

  return `Month ${safeRIdx + 1}`;
}

export function getRetainerDurationMonths(job) {
  if (!job) return 1;
  const startStr = job.startDate || job.rows?.[0]?.startDate;
  const endStr = job.endDate || job.rows?.[0]?.endDate;

  if (startStr && endStr) {
    const parse = (s) => {
      if (!s) return null;
      const str = String(s).trim();
      const m = str.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
      if (m) {
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx !== undefined) {
          const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
          return new Date(yr, mIdx, parseInt(m[1], 10));
        }
      }
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    };

    const dStart = parse(startStr);
    const dEnd = parse(endStr);
    if (dStart && dEnd && dEnd >= dStart) {
      if (dEnd.getFullYear() < 2035) {
        const totalDays = Math.round((dEnd.getTime() - dStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        const approxMonths = Math.round(totalDays / 30.4375);
        if (approxMonths > 0) return approxMonths;
      }
    }
  }

  if (job.rows && job.rows.length > 1) {
    return job.rows.length - 1;
  }
  return 1;
}

export function formatSeenTimestamp(ts) {
  if (!ts) return "";
  const str = String(ts).trim();
  if (!str) return "";
  if (str.includes("T")) {
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
      }
    } catch (e) { }
    const [datePart, timePart] = str.split("T");
    const timeClean = (timePart || "").slice(0, 5);
    return timeClean ? `${datePart} ${timeClean}` : datePart;
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(str)) {
    return str.slice(0, 16);
  }
  return str;
}

export function formatLikelihood(val) {
  if (val === null || val === undefined || String(val).trim() === "") return "";
  const s = String(val).trim();
  if (s.endsWith("%")) return s;
  const num = parseFloat(s);
  if (isNaN(num)) return s;
  const pct = num <= 1 ? num * 100 : num;
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded}%`;
}

export function normalizeLikelihoodInput(val) {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  if (!s) return "";
  if (s.startsWith("=")) return s;
  const hasPct = s.includes("%");
  const clean = s.replace(/[%,\s]/g, "");
  const num = parseFloat(clean);
  if (isNaN(num)) return s;
  const pct = !hasPct && num > 0 && num < 1 && clean.includes(".") ? num * 100 : num;
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded}%`;
}

export function isLikelihoodZero(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (!s || s === "-" || s === "(blank)") return false;
  const num = parseFloat(s.replace(/[%,\s]/g, ""));
  return !isNaN(num) && num === 0;
}

export function isLikelihoodHundred(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (!s) return false;
  if (s.includes("%")) {
    const num = parseFloat(s.replace(/[%,\s]/g, ""));
    return !isNaN(num) && Math.round(num) === 100;
  }
  const num = parseFloat(s);
  return !isNaN(num) && (num === 100 || num === 1);
}

export function isCopiedToConfYes(val) {
  return String(val || "").trim().toLowerCase() === "yes";
}

/**
 * Returns true when a Pipeline job should be suppressed from Pipeline CRM discrepancy alerts:
 * either % likelihood is 0%, or "Copied to confirmed tab?" is "Yes" (regardless of % likelihood).
 */
export function isPipelineJobSuppressed(likelihood, copiedToConf) {
  if (isLikelihoodZero(likelihood)) return true;
  if (isCopiedToConfYes(copiedToConf)) return true;
  return false;
}

/**
 * Sanitize redirect targets to prevent Open Redirect vulnerabilities (CWE-601).
 * Restricts redirects to relative internal paths (starting with / but not // or /\)
 * or explicitly trusted pulse domains.
 */
export function sanitizeRedirectUrl(url, defaultTarget = "/pma") {
  if (!url || typeof url !== "string") return defaultTarget;
  const trimmed = url.trim();
  // Valid relative internal path: starts with / and not // or /\
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return trimmed;
  }
  // Explicit trusted domains
  try {
    const parsed = new URL(trimmed);
    const isProd = process.env.NODE_ENV === "production";
    const isLocalhost = !isProd && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    const isValidScheme = parsed.protocol === "https:" || (isLocalhost && parsed.protocol === "http:");
    if (!isValidScheme) return defaultTarget;
    const trustedHosts = [
      "app.pulsedashboard.co.uk",
      "pma.pulsedashboard.co.uk",
      "pulsedashboard.co.uk",
    ];
    if (!isProd) {
      trustedHosts.push("localhost", "127.0.0.1");
    }
    if (trustedHosts.includes(parsed.hostname)) {
      return trimmed;
    }
  } catch (_) { }
  return defaultTarget;
}

/**
 * Validates that a URL is strictly a deployed Google Apps Script Web App (/exec).
 */
export function isValidGoogleScriptUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url.trim());
}

export const NO_END_DATE_SHEET_VALUE = "31-Dec-2050";
export const NO_END_DATE_DISPLAY_LABEL = "No end date";

/**
 * Checks whether an end-date value represents the canonical "No end date" sentinel (31-Dec-2050).
 * Only 31-Dec-2050 (in its various formatted representations) or "No end date" matches.
 */
export function isNoEndDateSentinel(val) {
  if (!val) return false;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.getFullYear() === 2050 && val.getMonth() === 11 && val.getDate() === 31;
  }
  const s = String(val).trim().toLowerCase();
  if (!s) return false;
  if (s === "no end date") return true;
  if (
    s === "31-dec-2050" ||
    s === "31-dec-50" ||
    s === "31 dec 2050" ||
    s === "31 dec 50" ||
    s === "31 december 2050" ||
    s === "2050-12-31" ||
    s === "2050/12/31" ||
    s === "31/12/2050" ||
    s === "31/12/50" ||
    s === "12/31/2050" ||
    s.startsWith("2050-12-31t")
  ) {
    return true;
  }
  return false;
}

/**
 * Formats a job end date for UI display, masking 31-Dec-2050 as "No end date".
 */
export function formatJobEndDateDisplay(val, fallback = "—") {
  if (isNoEndDateSentinel(val)) return NO_END_DATE_DISPLAY_LABEL;
  const s = String(val ?? "").trim();
  return s || fallback;
}

/**
 * Validates Origin / Sec-Fetch-Site headers on cookie-authenticated state-mutating requests to prevent CSRF.
 */
export function assertTrustedOrigin(req, res) {
  if (!req || !req.headers) return true;
  const origin = req.headers.origin;
  const secFetchSite = req.headers["sec-fetch-site"];
  const isProd = process.env.NODE_ENV === "production";
  const previewHostname =
    process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
      ? String(process.env.VERCEL_URL).trim().toLowerCase().split(":")[0]
      : "";

  const isTrustedHostname = (h) => {
    if (!h) return false;
    const lower = h.toLowerCase();
    return (
      lower === "app.pulsedashboard.co.uk" ||
      lower === "pma.pulsedashboard.co.uk" ||
      lower === "pulsedashboard.co.uk" ||
      (!isProd && (lower === "localhost" || lower === "127.0.0.1")) ||
      (previewHostname && lower === previewHostname)
    );
  };

  if (origin) {
    if (origin === "null") {
      if (res && typeof res.status === "function") {
        res.status(403).json({ success: false, error: "Forbidden: Untrusted request origin." });
      }
      return false;
    }
    try {
      const parsed = new URL(origin);
      if (!isTrustedHostname(parsed.hostname)) {
        if (res && typeof res.status === "function") {
          res.status(403).json({ success: false, error: "Forbidden: Untrusted request origin." });
        }
        return false;
      }
    } catch (_) {
      if (res && typeof res.status === "function") {
        res.status(403).json({ success: false, error: "Forbidden: Invalid request origin." });
      }
      return false;
    }
  } else if (req.headers.referer) {
    try {
      const refParsed = new URL(req.headers.referer);
      if (!isTrustedHostname(refParsed.hostname)) {
        if (res && typeof res.status === "function") {
          res.status(403).json({ success: false, error: "Forbidden: Untrusted request referer." });
        }
        return false;
      }
    } catch (_) {
      if (res && typeof res.status === "function") {
        res.status(403).json({ success: false, error: "Forbidden: Invalid request referer." });
      }
      return false;
    }
  } else if (secFetchSite === "cross-site") {
    if (res && typeof res.status === "function") {
      res.status(403).json({ success: false, error: "Forbidden: Cross-site request blocked." });
    }
    return false;
  }

  return true;
}

/**
 * Detects whether a Confirmed or Pipeline sheet uses the Extended JobCosting setup style.
 */
export function isJobCostingStyle({ headers, keyInfoD11 } = {}) {
  if (String(keyInfoD11 || "").trim().toLowerCase() === "jobcosting") return true;
  if (Array.isArray(headers)) {
    const h5 = String(headers[5] || "").trim().toLowerCase();
    const h8 = String(headers[8] || "").trim().toLowerCase();
    if (h5 === "date job will start" || h8 === "job revenue") return true;
  }
  return false;
}

/**
 * Returns 0-indexed column -> formula map for a JobCosting row on Confirmed or Pipeline.
 */
export function getJobCostingRowFormulasMap(sheetNameOrRowNum, maybeRowNumOrOpts) {
  let sheetName = "Confirmed";
  let rowNum = sheetNameOrRowNum;
  if (typeof sheetNameOrRowNum === "string") {
    sheetName = sheetNameOrRowNum;
    rowNum = maybeRowNumOrOpts;
  }
  if (sheetName === "Confirmed") {
    return {
      10: `=M${rowNum}*KeyInfo!$D$13`,
      12: `=I${rowNum}/KeyInfo!$D$12`,
      13: `=M${rowNum}*KeyInfo!$D$13`,
      14: `=N${rowNum}-K${rowNum}`,
      20: `=(I${rowNum}-Q${rowNum})*T${rowNum}`,
      32: `=if(I${rowNum}=0,"",I${rowNum})`,
      33: `=if(K${rowNum}+Q${rowNum}+U${rowNum}=0,"",K${rowNum}+Q${rowNum}+U${rowNum})`,
      37: `=F${rowNum}`,
      38: `=G${rowNum}`,
      40: `=if(AL${rowNum}>AM${rowNum},"Err","")`,
    };
  }
  return {
    32: `=I${rowNum}`,
    33: `=if(AG${rowNum}="","",((AG${rowNum}/KeyInfo!$D$12)*KeyInfo!$D$13)+(AG${rowNum}*0.1))`,
    37: `=F${rowNum}`,
    38: `=G${rowNum}`,
    40: `=if(AL${rowNum}>AM${rowNum},"Err","")`,
  };
}

const JOB_COSTING_COL_INDEX_TO_LETTER = {
  10: "K",
  12: "M",
  13: "N",
  14: "O",
  20: "U",
  24: "Y",
  32: "AG",
  33: "AH",
  37: "AL",
  38: "AM",
  40: "AO",
};

/**
 * Returns true if a cell holds the JobCosting Pipeline likelihood formula `=J<row>`.
 */
export function isJobCostingColJLikelihoodFormula(val) {
  return typeof val === "string" && /^=\s*\$?J\$?\d+\s*$/i.test(val.trim());
}

/**
 * Returns the job-costing formula map keyed by A1 column letters instead of 0-based indices.
 */
export function getJobCostingRowFormulasLetterMap(sheetNameOrRowNum, maybeRowNumOrOpts, maybeOpts = {}) {
  let sheetName = "Confirmed";
  let rowNum = sheetNameOrRowNum;
  let opts = (typeof maybeRowNumOrOpts === "object" && maybeRowNumOrOpts !== null) ? maybeRowNumOrOpts : maybeOpts;
  if (typeof sheetNameOrRowNum === "string") {
    sheetName = sheetNameOrRowNum;
    rowNum = maybeRowNumOrOpts;
    opts = (typeof maybeOpts === "object" && maybeOpts !== null) ? maybeOpts : {};
  }
  const indexMap = getJobCostingRowFormulasMap(sheetName, rowNum);
  const letterMap = {};
  for (const [colIdxStr, formula] of Object.entries(indexMap)) {
    const colIdx = Number(colIdxStr);
    if (opts?.hasExplicitContractorCosts && colIdx === 10) continue;
    const letter = JOB_COSTING_COL_INDEX_TO_LETTER[colIdx];
    if (letter) letterMap[letter] = formula;
  }
  return letterMap;
}

/**
 * Builds a safe clearRanges + restoreData plan for clearing/deleting job rows on Confirmed or Pipeline.
 * On JobCosting sheets, preserves formula columns (M:O, U, Y, AG:AH, AL:AM, AO) and resets row formulas cleanly.
 */
export function buildJobRowClearAndRestorePlan({
  sheetName,
  rowNums = [],
  isJobCosting = false,
  includeCopiedCol = false,
}) {
  const clearRanges = [];
  const restoreData = [];
  const shouldClearDD = includeCopiedCol || sheetName === "Pipeline";

  const isConfirmed = sheetName === "Confirmed";
  const invRangeSuffix = isConfirmed ? "BJ" : "BH";

  for (const r of rowNums) {
    if (!r || r < 2) continue;
    if (!isJobCosting) {
      clearRanges.push(
        `${sheetName}!A${r}:AM${r}`,
        `${sheetName}!AP${r}:${invRangeSuffix}${r}`,
        `${sheetName}!BX${r}:CR${r}`
      );
      if (shouldClearDD) clearRanges.push(`${sheetName}!DD${r}`);
    } else {
      if (isConfirmed) {
        clearRanges.push(
          `${sheetName}!A${r}:J${r}`,
          `${sheetName}!L${r}`,
          `${sheetName}!P${r}:T${r}`,
          `${sheetName}!V${r}:AF${r}`,
          `${sheetName}!AI${r}:AK${r}`,
          `${sheetName}!AN${r}`,
          `${sheetName}!AP${r}:BJ${r}`,
          `${sheetName}!BX${r}:CR${r}`
        );
      } else {
        clearRanges.push(
          `${sheetName}!A${r}:AF${r}`,
          `${sheetName}!AI${r}:AK${r}`,
          `${sheetName}!AN${r}`,
          `${sheetName}!AP${r}:BH${r}`,
          `${sheetName}!BX${r}:CR${r}`
        );
      }
      if (shouldClearDD) clearRanges.push(`${sheetName}!DD${r}`);

      if (isConfirmed) {
        restoreData.push(
          { range: `${sheetName}!K${r}`, values: [[`=M${r}*KeyInfo!$D$13`]] },
          {
            range: `${sheetName}!M${r}:O${r}`,
            values: [[`=I${r}/KeyInfo!$D$12`, `=M${r}*KeyInfo!$D$13`, `=N${r}-K${r}`]],
          },
          { range: `${sheetName}!U${r}`, values: [[`=(I${r}-Q${r})*T${r}`]] },
          {
            range: `${sheetName}!AG${r}:AH${r}`,
            values: [
              [
                `=if(I${r}=0,"",I${r})`,
                `=if(K${r}+Q${r}+U${r}=0,"",K${r}+Q${r}+U${r})`,
              ],
            ],
          },
          { range: `${sheetName}!AL${r}:AM${r}`, values: [[`=F${r}`, `=G${r}`]] },
          { range: `${sheetName}!AO${r}`, values: [[`=if(AL${r}>AM${r},"Err","")`]] }
        );
      } else {
        restoreData.push(
          {
            range: `${sheetName}!AG${r}:AH${r}`,
            values: [
              [
                `=I${r}`,
                `=if(AG${r}="","",((AG${r}/KeyInfo!$D$12)*KeyInfo!$D$13)+(AG${r}*0.1))`,
              ],
            ],
          },
          { range: `${sheetName}!AL${r}:AM${r}`, values: [[`=F${r}`, `=G${r}`]] },
          { range: `${sheetName}!AO${r}`, values: [[`=if(AL${r}>AM${r},"Err","")`]] }
        );
      }
    }
  }

  return { clearRanges, restoreData };
}

/**
 * Rewrites relative row references in a 0-indexed row array when moving a row from sourceRowNum to targetRowNum.
 */
export function rewriteRowFormulasToTargetRow(
  rowArr,
  sourceRowNum,
  targetRowNum,
  targetSheetName = null,
  isJobCosting = false,
  isParentRow = true
) {
  const out = Array.isArray(rowArr) ? [...rowArr] : [];
  if (sourceRowNum && targetRowNum && sourceRowNum !== targetRowNum) {
    for (let c = 0; c < out.length; c++) {
      const val = out[c];
      if (typeof val === "string" && val.startsWith("=")) {
        out[c] = val.replace(
          /(?<![A-Za-z0-9_])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![0-9(])/g,
          (match, colPart, dollarRow, rowStr) => {
            if (dollarRow === "$") return match;
            const rNum = parseInt(rowStr, 10);
            if (rNum === sourceRowNum) return `${colPart}${targetRowNum}`;
            return match;
          }
        );
      }
    }
  }
  if (isJobCosting && targetSheetName) {
    if (targetSheetName === "Pipeline") {
      // Clear Confirmed-only columns (H and J..AD) when moving to Pipeline
      out[7] = "";
      for (let c = 9; c <= 29; c++) {
        out[c] = "";
      }
    }
    const hasFGI =
      (out[5] !== "" && out[5] !== null && out[5] !== undefined) ||
      (out[6] !== "" && out[6] !== null && out[6] !== undefined) ||
      (out[8] !== "" && out[8] !== null && out[8] !== undefined);
    if (hasFGI || !isParentRow) {
      const fMap = getJobCostingRowFormulasMap(targetSheetName, targetRowNum);
      for (const [colStr, formula] of Object.entries(fMap)) {
        const c = Number(colStr);
        // Keep custom formula in K (col 10) if one was already entered on that row
        if (c === 10 && typeof out[10] === "string" && out[10].startsWith("=")) continue;
        out[c] = formula;
      }
    }
  }
  return out;
}

/**
 * Escapes PostgreSQL ILIKE wildcard characters (%, _, \) for exact case-insensitive matches.
 */
export function escapeIlikeExact(val) {
  return String(val ?? "").replace(/[\\%_]/g, "\\$&");
}

/**
 * Deterministic recursive-descent arithmetic evaluator (never uses eval or Function).
 * Evaluates simple numeric formulas like "=100+25.50*2" safely with bounded length and depth.
 */
export function evaluateSafeArithmetic(rawExpr) {
  if (typeof rawExpr !== "string") return null;
  const stripped = rawExpr.trim().replace(/^=+/, "").trim();
  if (!stripped || stripped.length > 256 || !/^[0-9+\-*/().\s]+$/.test(stripped)) {
    return null;
  }

  let pos = 0;
  const skipWs = () => {
    while (pos < stripped.length && /\s/.test(stripped[pos])) pos++;
  };

  const parseExpr = (depth) => {
    if (depth > 16) throw new Error("Depth exceeded");
    let left = parseTerm(depth + 1);
    while (true) {
      skipWs();
      const ch = stripped[pos];
      if (ch === "+" || ch === "-") {
        pos++;
        const right = parseTerm(depth + 1);
        left = ch === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (depth) => {
    if (depth > 16) throw new Error("Depth exceeded");
    let left = parseFactor(depth + 1);
    while (true) {
      skipWs();
      const ch = stripped[pos];
      if (ch === "*" || ch === "/") {
        pos++;
        const right = parseFactor(depth + 1);
        if (ch === "/") {
          if (right === 0) throw new Error("Division by zero");
          left = left / right;
        } else {
          left = left * right;
        }
      } else {
        break;
      }
    }
    return left;
  };

  const parseFactor = (depth) => {
    if (depth > 16) throw new Error("Depth exceeded");
    skipWs();
    const ch = stripped[pos];
    if (ch === "+" || ch === "-") {
      pos++;
      const inner = parseFactor(depth + 1);
      return ch === "-" ? -inner : inner;
    }
    if (ch === "(") {
      pos++;
      const inner = parseExpr(depth + 1);
      skipWs();
      if (stripped[pos] !== ")") throw new Error("Missing closing parenthesis");
      pos++;
      return inner;
    }
    const start = pos;
    let seenDot = false;
    let seenDigit = false;
    while (pos < stripped.length) {
      const c = stripped[pos];
      if (c >= "0" && c <= "9") {
        seenDigit = true;
        pos++;
      } else if (c === "." && !seenDot) {
        seenDot = true;
        pos++;
      } else {
        break;
      }
    }
    if (!seenDigit) throw new Error("Unexpected token");
    const num = Number(stripped.slice(start, pos));
    if (!Number.isFinite(num)) throw new Error("Invalid number");
    return num;
  };

  try {
    const val = parseExpr(0);
    skipWs();
    if (pos !== stripped.length || typeof val !== "number" || !Number.isFinite(val)) {
      return null;
    }
    return Math.round(val * 100) / 100;
  } catch {
    return null;
  }
}

const CANONICAL_OAUTH_HOSTS = new Set([
  "pulsedashboard.co.uk",
  "app.pulsedashboard.co.uk",
  "pma.pulsedashboard.co.uk",
]);

/**
 * Resolves the canonical Pulse host and protocol for OAuth redirect_uri generation.
 * Never trusts arbitrary x-forwarded-host values outside canonical Pulse hosts.
 */
export function resolveCanonicalOAuthHost(req) {
  const reqHostRaw = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const isPulseHost = CANONICAL_OAUTH_HOSTS.has(reqHostRaw);
  const previewHost =
    process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
      ? String(process.env.VERCEL_URL).trim().toLowerCase()
      : "";
  const isPreviewHost = Boolean(previewHost && reqHostRaw === previewHost);
  let prodHost = "";
  try {
    prodHost =
      (process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).host : "") ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL ||
      "";
  } catch { }
  const isProd = process.env.NODE_ENV === "production";
  const host =
    isPulseHost || isPreviewHost
      ? reqHostRaw
      : prodHost || (!isProd && reqHostRaw ? reqHostRaw : "app.pulsedashboard.co.uk");
  const isLocal = !isProd && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
  const proto = isLocal ? (req?.headers?.["x-forwarded-proto"] || "http") : "https";
  return { host, proto };
}

/**
 * Ensures an external anchor URL uses strictly an http:// or https:// scheme
 * (prevents javascript: / data: / vbscript: URI execution in React 18 href bindings).
 */
export function toSafeExternalHref(url) {
  if (!url || typeof url !== "string") return "#";
  const trimmed = url.trim();
  if (!trimmed) return "#";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "#";
}

/**
 * Validates that a target URL is a canonical Google Apps Script Web App (/exec)
 * and executes POST without following arbitrary external redirects with secret payloads.
 */
export async function postGasWebAppLocked(targetUrl, payload, { timeoutMs = 60000 } = {}) {
  const cleanUrl = String(targetUrl || "").trim();
  if (!isValidGoogleScriptUrl(cleanUrl)) {
    throw new Error("Blocked invalid GAS Web App URL.");
  }
  const resp = await fetch(cleanUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    redirect: "manual",
    signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (resp.status >= 300 && resp.status < 400) {
    const loc = String(resp.headers.get("location") || "").trim();
    let parsedLoc = null;
    try {
      parsedLoc = new URL(loc);
    } catch (_) { }
    if (
      parsedLoc &&
      parsedLoc.protocol === "https:" &&
      (parsedLoc.hostname === "script.googleusercontent.com" || parsedLoc.hostname === "script.google.com")
    ) {
      return await fetch(parsedLoc.toString(), {
        method: "GET",
        redirect: "manual",
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    }
    throw new Error(`Blocked unexpected Web App redirect target (HTTP ${resp.status}).`);
  }
  return resp;
}

const PORTAL_SENSITIVE_SALARY_DIV_RE =
  /salar|staff\s*cost|staff\s*ratio|staff.*%|divid|retained\s*profit|payroll|wages|director|remuneration|net\s*pay|pension|paye|\bnic\b/i;

function isRestrictedPortalSalaryUser_(user) {
  if (!user) return true;
  if (user.isAdmin || user.role === "Admin") return false;
  return Boolean(
    user.isSenior ||
    user.role === "Senior (Restricted)" ||
    String(user.role || "").toLowerCase().includes("senior")
  );
}

function redactPortalMonthBlock_(monthBlock) {
  if (!monthBlock || typeof monthBlock !== "object") return monthBlock;
  const redactRows = (arr) =>
    Array.isArray(arr)
      ? arr.map((r) =>
        r && typeof r === "object" && PORTAL_SENSITIVE_SALARY_DIV_RE.test(String(r.label || ""))
          ? { ...r, value: "—" }
          : r
      )
      : arr;
  return {
    ...monthBlock,
    ...(Array.isArray(monthBlock.rows) ? { rows: redactRows(monthBlock.rows) } : {}),
    ...(Array.isArray(monthBlock.tableRows) ? { tableRows: redactRows(monthBlock.tableRows) } : {}),
  };
}

/**
 * Redacts confidential salary, staff-cost, staff-ratio, and dividend fields from
 * the Portal Home payload for Senior (Restricted) sessions.
 */
export function redactPortalPayloadForUser(payload, user) {
  if (!payload || typeof payload !== "object" || !isRestrictedPortalSalaryUser_(user)) {
    return payload;
  }
  const cloned = { ...payload };
  if (cloned.currMonth && typeof cloned.currMonth === "object") {
    cloned.currMonth = {
      ...redactPortalMonthBlock_(cloned.currMonth),
      ...(cloned.currMonth.kpis && typeof cloned.currMonth.kpis === "object"
        ? {
          kpis: {
            ...cloned.currMonth.kpis,
            staffCostsDelivery: "—",
            staffCostsNonDelivery: "—",
            staffRatio: "—",
          },
        }
        : {}),
    };
  }
  if (cloned.months && typeof cloned.months === "object") {
    cloned.months = {
      ...(cloned.months.curr ? { curr: redactPortalMonthBlock_(cloned.months.curr) } : {}),
      ...(cloned.months.prev ? { prev: redactPortalMonthBlock_(cloned.months.prev) } : {}),
      ...(cloned.months.next ? { next: redactPortalMonthBlock_(cloned.months.next) } : {}),
    };
  }
  return cloned;
}

/**
 * Redacts confidential salary, staff-cost, staff-ratio, and dividend rows from
 * the Portal Performance payload for Senior (Restricted) sessions.
 */
export function redactPortalPerformanceForUser(perfData, user) {
  if (!perfData || typeof perfData !== "object" || !isRestrictedPortalSalaryUser_(user)) {
    return perfData;
  }
  const years = Array.isArray(perfData.years)
    ? perfData.years.map((yr) => {
      if (!yr || typeof yr !== "object" || !Array.isArray(yr.rows)) return yr;
      return {
        ...yr,
        rows: yr.rows.map((row) => {
          if (!row || typeof row !== "object") return row;
          if (!PORTAL_SENSITIVE_SALARY_DIV_RE.test(String(row.label || ""))) return row;
          return {
            ...row,
            monthlyValues: Array.isArray(row.monthlyValues) ? row.monthlyValues.map(() => "—") : row.monthlyValues,
            monthlyMath: Array.isArray(row.monthlyMath) ? row.monthlyMath.map(() => null) : row.monthlyMath,
            totalVal: "—",
            totalMath: null,
          };
        }),
      };
    })
    : perfData.years;
  return {
    ...perfData,
    years,
  };
}

export const AUTOMATION_FREQUENCY_OPTIONS = [
  "1 min",
  "2 mins",
  "5 mins",
  "10 mins",
  "15 mins",
  "30 mins",
  "1 hr",
  "2 hrs",
  "4 hrs",
  "8 hrs",
  "12 hrs",
  "24 hrs",
  "Week",
  "2 weeks",
  "4 weeks",
  "Month on 1st",
  "Month on 5th",
  "Month on 10th",
];

export const INVOICE_NUMBER_FORMATTING_OPTIONS = [
  { value: "StripPre", label: "Strip prefix (StripPre)" },
  { value: "Full", label: "Full reference (Full)" },
  { value: "Right5", label: "Right-hand 5 digits (Right5)" },
  { value: "Right4", label: "Right-hand 4 digits (Right4)" },
  { value: "Right3", label: "Right-hand 3 digits (Right3)" },
];

export function formatInvoiceNumber(raw, setting) {
  if (!raw && raw !== 0) return "";
  const str = String(raw).trim();
  if (!str) return "";
  const rule = String(setting || "Full").trim().toLowerCase();
  switch (rule) {
    case "full":
      return str;
    case "strippre":
      return str.replace(/^[^-]+-/, "");
    case "right5":
      return str.slice(-5);
    case "right4": {
      const m = str.match(/(\d+)/);
      return m ? m[1].slice(-4) : "";
    }
    case "right3": {
      const m = str.match(/(\d+)/);
      return m ? m[1].slice(-3) : "";
    }
    default:
      return str;
  }
}

/**
 * Computes UK tiered Corporation Tax for a given taxable profit using editable
 * small-profits / main rates and marginal-relief thresholds.
 */
export function calculateUkTieredCorpTax(
  profit,
  {
    smallRatePct = 19,
    mainRatePct = 25,
    lowerLimit = 50000,
    upperLimit = 250000,
  } = {}
) {
  const p = Number(profit) || 0;
  const rSmall = Math.max(0, Number(smallRatePct) || 0) / 100;
  const rMain = Math.max(0, Number(mainRatePct) || 0) / 100;
  const lower = Math.max(0, Number(lowerLimit) || 0);
  const upper = Math.max(lower, Number(upperLimit) || 0);
  const round2Val = (n) => Math.round((Number(n) || 0) * 100) / 100;

  if (p <= 0) {
    return {
      taxableProfit: round2Val(p),
      tax: 0,
      effectiveRatePct: 0,
      marginalRelief: 0,
      bandLabel: "No taxable profit (loss)",
    };
  }
  if (lower > 0 && p <= lower) {
    const tax = round2Val(p * rSmall);
    return {
      taxableProfit: round2Val(p),
      tax,
      effectiveRatePct: round2Val(rSmall * 100),
      marginalRelief: 0,
      bandLabel: `Small profits rate (${round2Val(rSmall * 100)}%)`,
    };
  }
  if (upper <= lower || p >= upper) {
    const tax = round2Val(p * rMain);
    return {
      taxableProfit: round2Val(p),
      tax,
      effectiveRatePct: round2Val(rMain * 100),
      marginalRelief: 0,
      bandLabel: `Main rate (${round2Val(rMain * 100)}%)`,
    };
  }

  // Continuous marginal relief fraction bridging small profits rate at `lower` to main rate at `upper`
  const mrf = ((rMain - rSmall) * lower) / (upper - lower);
  const mainTax = p * rMain;
  const marginalRelief = round2Val(mrf * (upper - p));
  const tax = round2Val(Math.max(0, mainTax - marginalRelief));
  const effectiveRatePct = p > 0 ? round2Val((tax / p) * 100) : 0;

  return {
    taxableProfit: round2Val(p),
    tax,
    effectiveRatePct,
    marginalRelief,
    bandLabel: `Marginal relief (${effectiveRatePct}% effective)`,
  };
}

/**
 * Formats an accounting/CRM tool identifier into a human-friendly display label.
 */
export function formatConnectionToolLabel(tool) {
  if (!tool || tool === "None") return "";
  if (tool === "Quickbooks") return "QuickBooks Online";
  if (tool === "Monday") return "Monday.com";
  return tool;
}

/**
 * Builds the default email requesting a client user to log into Pulse and connect their tools.
 */
export function buildConnectionEmailContent({ contactName, accountingTool, crmTool }) {
  const firstName = String(contactName || "").trim().split(/\s+/)[0] || "there";
  const accLabel = formatConnectionToolLabel(accountingTool);
  const crmLabel = formatConnectionToolLabel(crmTool);

  let toolSentence = "";
  if (accLabel && crmLabel) {
    toolSentence = `We're setting up Pulse for you, and need to create a link to your accounting (${accLabel}) and CRM (${crmLabel}) tools.`;
  } else if (accLabel) {
    toolSentence = `We're setting up Pulse for you, and need to create a link to your accounting tool (${accLabel}).`;
  } else if (crmLabel) {
    toolSentence = `We're setting up Pulse for you, and need to create a link to your CRM tool (${crmLabel}).`;
  } else {
    toolSentence = "We're setting up Pulse for you, and need to create a link to your tools.";
  }

  const subject = "Pulse setup: Please connect your tools";
  const body = [
    `Dear ${firstName},`,
    "",
    toolSentence,
    "",
    "To do this, please log in to Pulse by following this link:",
    "",
    "https://app.pulsedashboard.co.uk/pulse",
    "",
    "Then choose the service that drives your email account (eg Google or Microsoft), and approve the connection to Pulse.",
    "",
    "Once this is done, just follow the on-screen instructions to authorise the connections to the tools you use.",
    "",
    "Please reply to this email with any questions.",
    "",
    "Thanks,",
    "The Pulse Team",
  ].join("\n");

  return { subject, body };
}

export const VAR_RETAINER_PREFIX = "[VarRetainer]";

const VAR_RET_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const VAR_RET_MONTHS_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseVarRetSheetDate_(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  if (!s || s === "-" || s === "(blank)") return null;
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 20000 && num < 90000) {
      const utc = new Date(Math.round((num - 25569) * 86400 * 1000));
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
  }
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = VAR_RET_MONTHS_MAP[m[2].toLowerCase()];
    if (mi === undefined) return null;
    let yr = parseInt(m[3], 10);
    if (m[3].length === 2) yr += yr <= 69 ? 2000 : 1900;
    return new Date(yr, mi, parseInt(m[1], 10));
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtVarRetSheetDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  return `${d.getDate()}-${VAR_RET_MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Parses a Confirmed!AE / Pipeline!AE `[VarRetainer]` metadata tag using linear-time string splitting.
 * Format: `[VarRetainer] <SeriesName> | baseRev:<num> | baseDC:<num> | end:<DD-MMM-YYYY> | day:<1-31> | override:<rev|dc|both>`
 */
export function parseVariableRetainerTag(aeVal) {
  if (aeVal === null || aeVal === undefined) return null;
  let raw = String(aeVal).trim();
  if (!raw) return null;
  if (raw.startsWith("'")) raw = raw.slice(1).trim();
  if (!raw.toLowerCase().startsWith(VAR_RETAINER_PREFIX.toLowerCase())) return null;

  const rest = raw.slice(VAR_RETAINER_PREFIX.length).trim();
  const segments = rest.split("|").map((s) => s.trim()).filter(Boolean);
  const seriesName = segments[0] && !segments[0].includes(":") ? segments[0] : "";

  let baseRev = 0;
  let baseDC = 0;
  let endDate = "31-Dec-2050";
  let sendDay = 28;
  let overrideRev = false;
  let overrideDc = false;

  const startIdx = seriesName ? 1 : 0;
  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i];
    const colonIdx = seg.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = seg.slice(0, colonIdx).trim().toLowerCase();
    const val = seg.slice(colonIdx + 1).trim();
    if (key === "baserev") {
      const n = parseFloat(val.replace(/[£$€,\s]/g, ""));
      if (!isNaN(n) && n >= 0) baseRev = Math.round(n * 100) / 100;
    } else if (key === "basedc") {
      const n = parseFloat(val.replace(/[£$€,\s]/g, ""));
      if (!isNaN(n) && n >= 0) baseDC = Math.round(n * 100) / 100;
    } else if (key === "end") {
      if (val) {
        const parsed = parseVarRetSheetDate_(val);
        endDate = parsed ? fmtVarRetSheetDate_(parsed) : val;
      }
    } else if (key === "day") {
      const d = parseInt(val, 10);
      if (!isNaN(d) && d >= 1 && d <= 31) sendDay = d;
    } else if (key === "override") {
      const ov = val.toLowerCase();
      if (ov === "both") {
        overrideRev = true;
        overrideDc = true;
      } else if (ov === "rev") {
        overrideRev = true;
      } else if (ov === "dc") {
        overrideDc = true;
      }
    }
  }

  const parsedEnd = parseVarRetSheetDate_(endDate);
  const noEndDate = !endDate || String(endDate).includes("2050") || (parsedEnd ? parsedEnd.getFullYear() >= 2050 : false);

  return {
    seriesName,
    baseRev,
    baseDC,
    endDate: noEndDate ? "31-Dec-2050" : endDate,
    noEndDate,
    sendDay,
    overrideRev,
    overrideDc,
    raw,
  };
}

/**
 * Formats a `[VarRetainer]` tag for Confirmed!AE / Pipeline!AE and sanitizes against formula injection.
 */
export function formatVariableRetainerTag({
  seriesName = "",
  baseRev = 0,
  baseDC = 0,
  endDate = "31-Dec-2050",
  noEndDate = false,
  sendDay = 28,
  overrideRev = false,
  overrideDc = false,
} = {}) {
  const cleanName = String(seriesName || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\|/g, "-")
    .trim();
  const revNum = Math.round((parseFloat(String(baseRev ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  const dcNum = Math.round((parseFloat(String(baseDC ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  const parsedEnd = noEndDate ? null : parseVarRetSheetDate_(endDate);
  const endStr = (noEndDate || !endDate || (parsedEnd && parsedEnd.getFullYear() >= 2050))
    ? "31-Dec-2050"
    : (parsedEnd ? fmtVarRetSheetDate_(parsedEnd) : String(endDate).replace(/\|/g, "-").trim());
  const dayInt = parseInt(sendDay, 10);
  const safeDay = !isNaN(dayInt) && dayInt >= 1 && dayInt <= 31 ? dayInt : 28;

  const parts = [
    `${VAR_RETAINER_PREFIX} ${cleanName}`.trim(),
    `baseRev:${revNum}`,
    `baseDC:${dcNum}`,
    `end:${endStr}`,
    `day:${safeDay}`,
  ];
  if (overrideRev && overrideDc) parts.push("override:both");
  else if (overrideRev) parts.push("override:rev");
  else if (overrideDc) parts.push("override:dc");

  return sanitizeFormulaInput(parts.join(" | "));
}

/**
 * Returns true if a sheet row array or parsed job object represents a Variable Retainer monthly row.
 */
export function isVariableRetainerRow(rowOrJob) {
  if (!rowOrJob) return false;
  if (Array.isArray(rowOrJob)) {
    const typeStr = String(rowOrJob[35] || "").trim().toLowerCase();
    if (!typeStr.includes("retainer")) return false;
    return parseVariableRetainerTag(rowOrJob[30]) !== null;
  }
  if (rowOrJob.isVariableRetainer === true) return true;
  const typeStr = String(rowOrJob.projectRetainer || rowOrJob.type || "").trim().toLowerCase();
  if (!typeStr.includes("retainer")) return false;
  if (rowOrJob.varRetainerMeta && rowOrJob.varRetainerMeta.seriesName !== undefined) return true;
  const aeVal = rowOrJob.splitStr ?? rowOrJob.unevenSplit ?? "";
  return parseVariableRetainerTag(aeVal) !== null;
}

/**
 * Returns true ONLY for standard fixed-schedule Retainer rows (excludes Variable Retainer rows).
 */
export function isFixedScheduleRetainer(rowOrJob) {
  if (!rowOrJob) return false;
  const typeStr = Array.isArray(rowOrJob)
    ? String(rowOrJob[35] || "").trim().toLowerCase()
    : String(rowOrJob.projectRetainer || rowOrJob.type || "").trim().toLowerCase();
  if (!typeStr.includes("retainer")) return false;
  return !isVariableRetainerRow(rowOrJob);
}

/**
 * Formats a variable retainer month's Job Name: `<SeriesName> - MMM YYYY`.
 */
export function formatVarRetainerMonthJobName(seriesName, dateObj) {
  const cleanSeries = String(seriesName || "").trim();
  const d = dateObj instanceof Date ? dateObj : parseVarRetSheetDate_(dateObj);
  if (!d || isNaN(d.getTime())) return cleanSeries;
  const label = `${VAR_RET_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  return cleanSeries ? `${cleanSeries} - ${label}` : label;
}

/**
 * Groups variable retainer monthly items by `(norm(client), norm(seriesName))` chronologically.
 * Returns `{ seriesList, nonVariableItems }`.
 */
export function groupVariableRetainerSeries(items = []) {
  const map = Object.create(null);
  const nonVariableItems = [];

  for (const item of items) {
    if (!item) continue;
    const tag = item.varRetainerMeta || parseVariableRetainerTag(item.splitStr ?? item.unevenSplit ?? "");
    const isVar = Boolean(item.isVariableRetainer || (String(item.projectRetainer || "").toLowerCase().includes("retainer") && tag));
    if (!isVar || !tag) {
      nonVariableItems.push(item);
      continue;
    }
    const client = String(item.client || "").trim();
    const seriesName = tag.seriesName || String(item.jobName || "").replace(/\s*-\s*[A-Za-z]{3}\s+\d{4}$/, "").trim();
    const cKey = client.toLowerCase();
    const sKey = seriesName.toLowerCase();
    if (!cKey || !sKey || cKey === "__proto__" || sKey === "__proto__") {
      nonVariableItems.push(item);
      continue;
    }
    const mapKey = `${cKey}|||${sKey}`;
    if (!Object.prototype.hasOwnProperty.call(map, mapKey)) {
      map[mapKey] = {
        key: mapKey,
        client,
        seriesName,
        items: [],
      };
    }
    map[mapKey].items.push({ ...item, varRetainerMeta: tag });
  }

  const seriesList = Object.values(map).map((group) => {
    group.items.sort((a, b) => {
      const da = parseVarRetSheetDate_(a.startDate);
      const db = parseVarRetSheetDate_(b.startDate);
      const ta = da ? da.getTime() : 0;
      const tb = db ? db.getTime() : 0;
      if (ta !== tb) return ta - tb;
      return (a.rowNumber || a.rowNum || 0) - (b.rowNumber || b.rowNum || 0);
    });
    const latest = group.items[group.items.length - 1];
    const first = group.items[0];
    const meta = latest?.varRetainerMeta || {};
    return {
      ...group,
      baseRev: meta.baseRev ?? 0,
      baseDC: meta.baseDC ?? 0,
      endDate: meta.endDate || "31-Dec-2050",
      noEndDate: Boolean(meta.noEndDate),
      sendDay: meta.sendDay || 28,
      startDate: first?.startDate || "",
      latestItem: latest,
      firstItem: first,
    };
  });

  return { seriesList, nonVariableItems };
}

/**
 * Strict whitelist determining whether a cell is editable in the Cash tab.
 * @param {number} rowNum 1-based sheet row number (e.g. 4, 7, 36)
 * @param {number} colIdx 0-based column index (0 = A, 1 = B, 9 = J, etc.)
 */
export function isCashCellEditable(rowNum, colIdx) {
  if (isNaN(colIdx) || colIdx < 1 || colIdx > 36) return false;
  if (rowNum === 4 && colIdx === 1) return true;
  if (rowNum === 8 && colIdx === 1) return true;
  if (rowNum === 12 && colIdx === 1) return true;
  if (rowNum === 16 && colIdx === 1) return true;
  if (rowNum === 19 && colIdx === 1) return true;
  if (rowNum === 21 && colIdx === 1) return true;
  if (rowNum === 19 && colIdx === 9) return true;
  if (rowNum === 61 && colIdx === 1) return true;
  if (rowNum === 63 && colIdx === 1) return true;
  if (rowNum === 61 && colIdx === 9) return true;
  const adjustmentRows = [7, 9, 11, 13, 15, 17, 20, 22, 25, 27, 29, 30];
  if (adjustmentRows.includes(rowNum)) return true;
  if (rowNum === 36) return true;
  return false;
}

/**
 * Resolves the editable primary sheet metadata for Confirmed or Pipeline jobs,
 * strictly preferring the canonical editable tab before formula-mirror tabs.
 */
export function resolveEditableJobSheetMeta(sheetMetaList, tabType) {
  const list = Array.isArray(sheetMetaList) ? sheetMetaList : [];
  const isConf = String(tabType || "").trim().toLowerCase() === "confirmed";
  if (isConf) {
    return (
      list.find((s) => s?.properties?.title === "Confirmed") ||
      list.find((s) => s?.properties?.title === "ConfCalcs") ||
      null
    );
  }
  return (
    list.find((s) => s?.properties?.title === "Pipeline") ||
    list.find((s) => s?.properties?.title === "PipeCalcs") ||
    null
  );
}

/**
 * Checks whether a job row contains any non-empty invoice or direct expense slot cells,
 * excluding separator columns (AO=40, BW=74) and formula columns (BK:BV=62..73).
 */
export function rowHasJobSlotData(row, isConfirmedTab = true) {
  if (!Array.isArray(row)) return false;
  const invEndCol = isConfirmedTab ? 61 : 59;
  for (let c = 41; c <= invEndCol; c++) {
    if (String(row[c] ?? "").trim() !== "") return true;
  }
  for (let c = 75; c <= 95; c++) {
    if (String(row[c] ?? "").trim() !== "") return true;
  }
  return false;
}

/**
 * Determines whether a candidate row directly beneath a parent job is a contiguous
 * overflow/retainer child row (matching either parent identity or unnamed slot/anchor data)
 * with blank job-level revenue/direct-cost/start-date fields.
 */
export function isContiguousJobChildRow({
  row,
  candidateRowNum = null,
  parentClient = "",
  parentJobName = "",
  altParentClient = "",
  altParentJobName = "",
  isConfirmedTab = true,
  isJobCosting = false,
  anchorRowSet = null,
  cols = null,
}) {
  if (!Array.isArray(row)) return false;
  const clientIdx = cols?.client ?? 0;
  const jobNameIdx = cols?.jobName ?? 1;
  const revIdx = cols?.revenue ?? 32;
  const dcIdx = cols?.directCosts ?? 33;
  const startIdx = cols?.startDate ?? 37;
  const jobRevIdx = cols?.jobRevenue ?? 8;
  const jobStartIdx = cols?.jobStartDate ?? 5;
  const rechIdx = 17;

  const rClient = String(row[clientIdx] ?? "").trim();
  const rJobName = String(row[jobNameIdx] ?? "").trim();
  const isBlankIdentity = rClient === "" && rJobName === "";
  const hasSlotContent = rowHasJobSlotData(row, isConfirmedTab);
  const isAnchorChild = Boolean(
    anchorRowSet && Number.isFinite(candidateRowNum) && anchorRowSet.has(candidateRowNum)
  );
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const hasNonBlankIdentity = !isBlankIdentity;
  const matchesPrimary =
    hasNonBlankIdentity &&
    norm(rClient) === norm(parentClient) &&
    norm(rJobName) === norm(parentJobName);
  const matchesAlt =
    hasNonBlankIdentity &&
    Boolean(altParentClient || altParentJobName) &&
    norm(rClient) === norm(altParentClient || parentClient) &&
    norm(rJobName) === norm(altParentJobName || parentJobName);

  const isNamedSameJob = matchesPrimary || matchesAlt;
  const isUnnamedOverflowChild = isBlankIdentity && (hasSlotContent || isAnchorChild);
  if (!isNamedSameJob && !isUnnamedOverflowChild) return false;

  const rRev = String(row[revIdx] ?? "").trim();
  const rDc = String(row[dcIdx] ?? "").trim();
  const rStart = String(row[startIdx] ?? "").trim();
  const rRech = isConfirmedTab ? String(row[rechIdx] ?? "").trim() : "";
  const rechEmptyOrZero =
    rRech === "" || Math.abs(parseFloat(rRech.replace(/[£$€,\s]/g, "")) || 0) <= 0.001;

  if (isJobCosting && rRev.startsWith("=")) {
    return (
      String(row[jobRevIdx] ?? "").trim() === "" &&
      String(row[jobStartIdx] ?? "").trim() === "" &&
      rechEmptyOrZero
    );
  }
  return rRev === "" && rDc === "" && rStart === "" && rechEmptyOrZero;
}




