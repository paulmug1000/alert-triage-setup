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
  if (s.includes("sheet")) return "Google Sheet";
  if (s.includes("excel")) return "Excel";
  return String(crmTool).trim();
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
  } else if (alert.type === "expense" || alert.flagType === "expenseDashboardDiscr") {
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
};

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
    .replace(/\bslots\b/gi, "entries")
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
    .replace(/\bMaster\s+Sheet\s+bridge\b/gi, "Pulse data sync")
    .replace(/\b(?:Master|Client|Recon|Backup)\s+(?:spreadsheet|sheet|workbook)s?\b/gi, "Pulse")
    .replace(/\b(?:Confirmed|Pipeline|Outgoings|Salaries|Performance|Dashboard|Budget|Cash)\s+(?:tab|sheet)s?\b/gi, (m) =>
      m.replace(/\s+(?:tab|sheet)s?$/i, "")
    )
    .replace(/\bNBtoFind(?:\s+(?:tab|sheet))?\b/gi, "NB to Find")
    .replace(/\b(?:KeyInfo|PLComp|InvComp|DirComp|CRMComp|TimeComp|DataFromCRM|CRMList|DataChgAlert|AutoUpdates)\b/g, "Pulse configuration")
    .replace(/\bIMPORTRANGE\b/gi, "data link")
    .replace(/\b(?:spreadsheet|workbook)s?\b/gi, "Pulse")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const getFlagName = (flagKey) => {
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
    "expenseDashboardDiscr": "Expense discrepancy",
    "expenseAdded": "Expense added",
    "expenseUnreconGaps": "Stale unreceived expense date changed",
    "invoiceStaleUnsentChanges": "Stale unsent invoice send date changed",
  };
  return flagNames[flagKey] || flagKey;
};

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
  expense: ["expenseDashboardDiscr", "expenseAdded", "expenseUnreconGaps"],
  crm: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr"],
};

export const EXPENSE_SUPPRESSIBLE = new Set(["expenseDashboardDiscr"]);

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
  return sa === sb;
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
  // If it starts with formula trigger characters, neutralize it
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${val}`;
  }
  return val;
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

  const revMatch = detail.match(/revenue\s*=\s*£?([\d,.]+)/i);
  if (revMatch) result.revenue = revMatch[1].replace(/,/g, "");

  const invMatch = detail.match(/total invoiced[^\d]*£?([\d,.]+)/i);
  if (invMatch) result.totalInvoiced = invMatch[1].replace(/,/g, "");

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
        const arrowMatch = p.match(/(Rec|Pay):\s*([A-Za-z0-9-]+)\s*->\s*([A-Za-z0-9-]+)/i);
        if (arrowMatch) {
          const type = arrowMatch[1];
          const from = arrowMatch[2];
          const to = arrowMatch[3];
          if (type.toLowerCase() === "rec") res.recDate = to;
          if (type.toLowerCase() === "pay") res.payDate = to;
          return {
            type,
            from,
            to,
            label: `${type.toLowerCase() === "pay" ? "Pay Date" : "Receive Date"}: ${from} → ${to}`
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
    const confMatch = clean.match(/\[([A-Za-z]+)\]\s*(?:Stale Invoice\s*[-–:]\s*)?(?:Row\s*(\d+),\s*)?([^|]+)\|\s*([^,]+),\s*Slot\s*(\d+):\s*Date moved\s*([\d\-A-Za-z]+)\s*->\s*([\d\-A-Za-z]+)/i);
    if (confMatch) {
      res.tab = confMatch[1] || "Confirmed";
      res.rowNum = confMatch[2] ? parseInt(confMatch[2], 10) : null;
      res.confirmedRow = res.rowNum;
      res.client = confMatch[3] ? confMatch[3].trim() : "";
      let rawJob = confMatch[4] ? confMatch[4].trim() : "";
      const pCodeMatch = rawJob.match(/\[([A-Za-z0-9_-]+)\]/);
      if (pCodeMatch) {
        res.projectCode = pCodeMatch[1];
        rawJob = rawJob.replace(/\[[A-Za-z0-9_-]+\]/, "").trim();
      }
      res.job = rawJob;
      res.slot = confMatch[5] ? parseInt(confMatch[5], 10) : null;
      res.changes = [{
        type: "Send",
        from: confMatch[6] ? confMatch[6].trim() : "",
        to: confMatch[7] ? confMatch[7].trim() : "",
        label: `Send Date: ${confMatch[6] ? confMatch[6].trim() : ""} → ${confMatch[7] ? confMatch[7].trim() : ""}`
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
    const m = clean.match(/(?:Copied Pipeline Project (?:to Confirmed|\(with[^)]*\))|Converted Pipeline Job to Confirmed Retainer):\s*([^|]+)\|\s*([^[\n]+)(?:\s*\[([^\]]+)\])?(?:\s*\(Pipeline\s+row\s+(\d+)\s*->\s*Confirmed\s+row\s+(\d+)\))?/i);
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
    case "retainer_invoice":
      if (m.possibleMatchCase === "draft") return "Draft retainer invoice found but not yet sent";
      if (m.possibleMatchCase === "changed") return "Expected retainer invoice not found at current retainer amount";
      return "Expected recurring retainer invoice has not been sent";
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

/**
 * Parses any date format (ISO YYYY-MM-DD, d-Mmm-yy, DD/MM/YYYY, etc.) into a Date object.
 */
export function parseSheetDate(dStr) {
  if (dStr === null || dStr === undefined || dStr === "") return null;
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;

  // 0. Google Sheets / Excel numeric serial date (e.g. 46326 for 31-Oct-2026)
  if (typeof dStr === "number" && Number.isFinite(dStr) && dStr > 20000 && dStr < 90000) {
    const utc = new Date(Math.round((dStr - 25569) * 86400 * 1000));
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }

  const s = String(dStr).trim();
  if (!s || s === "-" || s === "(blank)") return null;

  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 20000 && num < 90000) {
      const utc = new Date(Math.round((num - 25569) * 86400 * 1000));
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
  }

  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mIdx = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(yr, mIdx, day);
  }

  // 2. DD-Mon-YY or DD-Mon-YYYY (e.g. 15-Oct-26 or 1-Jan-2025)
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

  // 4. DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY
  const slashMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  // Prevent pure integer strings from being parsed by V8 as a year (e.g. new Date("46326") -> 1-Jan-46326)
  if (/^\d+$/.test(s)) return null;

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Converts any date representation to ISO "YYYY-MM-DD" for calendar inputs.
 */
export function toInputDateFormat(dStr) {
  if (!dStr) return "";
  const d = parseSheetDate(dStr);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Converts any date representation to "d-Mmm-yy" (e.g. "1-Jan-25", "15-Oct-26").
 */
export function toSheetDateFormat(dStr) {
  if (!dStr) return "";
  const d = parseSheetDate(dStr);
  if (!d) {
    const raw = String(dStr).trim();
    return /^[=+\-@|\t\r]/.test(raw) ? `'${raw}` : raw;
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
export function getAlertJobTarget(alertOrNa, isInfo = false, clientInfo = null) {
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
  const pct = num <= 1 ? Math.round(num * 100) : Math.round(num);
  return `${pct}%`;
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

export function isPipelineJobSuppressed(likelihood, copiedToConf) {
  if (isLikelihoodZero(likelihood)) return true;
  if (isLikelihoodHundred(likelihood) && isCopiedToConfYes(copiedToConf)) return true;
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
    const trustedHosts = [
      "app.pulsedashboard.co.uk",
      "pma.pulsedashboard.co.uk",
      "pulsedashboard.co.uk",
      "localhost"
    ];
    if (trustedHosts.includes(parsed.hostname) || parsed.hostname.endsWith(".pulsedashboard.co.uk")) {
      return trimmed;
    }
  } catch (_) { }
  return defaultTarget;
}

