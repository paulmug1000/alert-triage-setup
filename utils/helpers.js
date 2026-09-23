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

    const isAppDiscr  = flagType === "crmConfAppDiscr" || flagType === "crmPipeAppDiscr";
    const isDashDiscr = flagType === "crmPipeDashDiscr" || flagType === "crmConfDashDiscr";
    const src = isAppDiscr ? crm?.sheetData : crm?.crmData;
    const client = src?.[0] || "";
    const job    = src?.[1] || "";
    const code   = src?.[2] || "";
    const base   = `${client}${job ? " — " + job : ""}${code ? " (" + code + ")" : ""}` || "CRM alert";
    if (isDashDiscr && alert.subType === "field_mismatch" && alert.mismatchFields?.length) {
      return `${base} — ⚠ ${alert.mismatchFields.join(", ")} mismatch`;
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
  retainer_invoice:           "Retainer invoice",
  crm_wipe:                   "CRM data wipe",
  revenue_mismatch:           "Revenue / invoiced mismatch",
  direct_costs_mismatch:      "Direct costs / expenses mismatch",
  pipeline_confirmed_overlap: "Pipeline / Confirmed overlap",
  retainer_shrink_blocked:    "Retainer row blocked from trimming",
  uninvoiced_new_job:         "Uninvoiced new job",
  uninvoiced_revenue:         "Uninvoiced revenue",
  deleted_invoice:            "Deleted invoice",
  job_structure_error:        "Job structure error",
  deleted_expense:            "Deleted expense",
  unreceived_expenses:        "Unreceived expenses",
  autolog_error:              "Automation error",
  infinite_loop:              "Infinite loop / automation conflict",
};

export const getFlagName = (flagKey) => {
  const flagNames = {
    "invoiceDashboardDiscr": "Invoice discrepancy",
    "crmPipeDashDiscr":      "CRM dashboard discrepancy (Pipeline)",
    "crmPipeAppDiscr":       "CRM app discrepancy (Pipeline)",
    "crmConfDashDiscr":      "CRM dashboard discrepancy (Confirmed)",
    "crmConfAppDiscr":       "CRM app discrepancy (Confirmed)",
    "crmCopiedConfChecked":  "CRM copied to conf box checked",
    "crmCopiedConfUnchecked":"CRM copied to conf box UNchecked",
    "crmCopiedConfDelete":   "CRM copied to conf box DELETE",
    "retainerInvoicesCreated": "Retainer invoices created",
    "retainerInvoicesDeleted": "Retainer invoices deleted",
    "expenseDashboardDiscr": "Expense discrepancy",
    "expenseAdded":          "Expense added",
    "expenseUnreconGaps":    "Expense reconciliation gaps",
    "invoiceStaleUnsentChanges": "Stale unsent invoice send date changed",
  };
  return flagNames[flagKey] || flagKey;
};

export const RICH_NOACTION_FLAG_GROUP = {
  crmCopiedConfChecked:    "crm",
  crmCopiedConfUnchecked:  "crm",
  crmCopiedConfDelete:     "crm",
  retainerInvoicesCreated: "invoice",
  retainerInvoicesDeleted: "invoice",
  invoiceStaleUnsentChanges: "invoice",
};

export const ALERT_CATEGORY_FLAGS = {
  invoice: ["invoiceDashboardDiscr", "invoiceStaleUnsentChanges"],
  expense: ["expenseDashboardDiscr", "expenseAdded", "expenseUnreconGaps"],
  crm: ["crmPipeDashDiscr", "crmPipeAppDiscr", "crmConfDashDiscr", "crmConfAppDiscr"],
};

export const EXPENSE_SUPPRESSIBLE = new Set(["expenseDashboardDiscr"]);