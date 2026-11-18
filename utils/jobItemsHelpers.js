import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  getRetainerRowMonthLabel,
} from "./helpers";

export const getJobInvoiceItems = (job, isRetainer) => {
  if (!job || !job.rows || job.rows.length === 0) return [];
  const items = [];

  if (isRetainer) {
    job.rows.forEach((r, rIdx) => {
      const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
      const slots = r.invoiceSlots || [];

      slots.forEach((s) => {
        const hasRef = Boolean(s.ref && String(s.ref).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasData = hasRef || hasAmt;
        if (hasData) {
          const isPartPaid = String(s.status || "").toLowerCase().includes("part");
          const isPlace = isPlaceholderInvoice(s.ref, s.status);
          const extraRef = hasRef
            ? `#${String(s.ref).trim()}`
            : (isPlace ? "Placeholder" : (isPartPaid ? "Part payment" : monthLabel));
          items.push({
            ...s,
            id: `ret_inv_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            ref: s.ref || "",
            amount: s.amount || "",
            status: s.status || "",
            sentDate: s.sentDate || "",
            slot: s,
            row: r,
            label: extraRef,
            subLabel: s.sentDate ? `${s.sentDate}` : "",
          });
        }
      });
    });
  } else {
    job.rows.forEach((r) => {
      const slots = r.invoiceSlots || [];
      slots.forEach((s) => {
        const hasRef = Boolean(s.ref && String(s.ref).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasData = hasRef || hasAmt;
        if (hasData) {
          const isPlace = isPlaceholderInvoice(s.ref, s.status);
          const refStr = hasRef
            ? `#${String(s.ref).trim()}`
            : (isPlace ? "Placeholder" : "Invoice");
          items.push({
            ...s,
            id: `proj_inv_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            ref: s.ref || "",
            amount: s.amount || "",
            status: s.status || "",
            sentDate: s.sentDate || "",
            slot: s,
            row: r,
            label: refStr,
            subLabel: "",
          });
        }
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
        const hasDesc = Boolean(s.description && String(s.description).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasTx = Boolean(s.transactionId && String(s.transactionId).trim() !== "");
        const hasData = hasDesc || hasAmt || hasTx;
        if (hasData) {
          const isPlace = isPlaceholderExpense(s);
          const expLabel = hasDesc
            ? String(s.description).trim()
            : (hasTx
              ? `#${String(s.transactionId).trim()}`
              : (isPlace ? "Placeholder" : `${monthLabel} direct cost`));
          items.push({
            ...s,
            id: `ret_exp_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            description: s.description || "",
            amount: s.amount || "",
            status: s.status || "",
            date: s.date || "",
            transactionId: s.transactionId || "",
            slot: s,
            row: r,
            label: expLabel,
            subLabel: "",
          });
        }
      });
    });
  } else {
    job.rows.forEach((r) => {
      const slots = r.expenseSlots || [];
      slots.forEach((s) => {
        const hasDesc = Boolean(s.description && String(s.description).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasTx = Boolean(s.transactionId && String(s.transactionId).trim() !== "");
        const hasData = hasDesc || hasAmt || hasTx;
        if (hasData) {
          const isPlace = isPlaceholderExpense(s);
          const expLabel = hasDesc
            ? String(s.description).trim()
            : (hasTx
              ? `#${String(s.transactionId).trim()}`
              : (isPlace ? "Placeholder" : "Direct cost"));
          items.push({
            ...s,
            id: `proj_exp_${r.rowNum}_${s.slotNum}`,
            rowNum: r.rowNum,
            slotNum: s.slotNum,
            description: s.description || "",
            amount: s.amount || "",
            status: s.status || "",
            date: s.date || "",
            transactionId: s.transactionId || "",
            slot: s,
            row: r,
            label: expLabel,
            subLabel: "",
          });
        }
      });
    });
  }

  return items;
};
