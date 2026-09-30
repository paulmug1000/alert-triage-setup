export function stripCurrency(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
  // Strip currency symbols (£, $, €), commas, and any non-numeric chars except dot and minus
  const clean = s.replace(/[^\d.-]/g, "").trim();
  return isNaN(Number(clean)) || clean === "" ? "" : clean;
}

export function isPlaceholderInvoice(ref) {
  if (!ref) return false;
  const s = String(ref).trim().toUpperCase();
  return s.startsWith("PLACE-INV") || s.startsWith("MANUAL-INV");
}

export function isPlaceholderExpense(appId) {
  if (!appId) return false;
  const s = String(appId).trim().toUpperCase();
  return (
    s.startsWith("PLACE-EXP") ||
    s.startsWith("MANUAL-ENTRY") ||
    s.startsWith("PLACE-GAP") ||
    s.startsWith("MANUAL-GAP") ||
    s.startsWith("UNRECON-GAP")
  );
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

    const isAppDiscr  = flagType === "crmConfAppDiscr" || flagType === "crmPipeAppDiscr";
    const isDashDiscr = flagType === "crmPipeDashDiscr" || flagType === "crmConfDashDiscr";
    const src = isAppDiscr ? crm?.sheetData : crm?.crmData;
    const client = src?.[0] || "";
    const job    = src?.[1] || "";
    const code   = src?.[2] || "";
    const base   = `${client}${job ? " - " + job : ""}${code ? " (" + code + ")" : ""}` || "CRM alert";
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

export const ADMIN_ONLY_FLAG_KEYS = new Set([
  "crmCopiedConfChecked",
  "crmCopiedConfUnchecked",
  "crmCopiedConfDelete",
  "retainerInvoicesCreated",
  "retainerInvoicesDeleted",
  "expenseAdded",
  "expenseUnreconGaps",
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
    .replace(/\(\s*row\s+\d+,\s*/gi, "(")
    .replace(/\(\s*(?:Confirmed|Pipeline)?\s*row\s+\d+,\s*/gi, "(")
    .replace(/\s*\(\s*(?:Confirmed|Pipeline)?\s*row\s+\d+\s*\)/gi, "")
    .replace(/\b(Confirmed|Pipeline)\s+row\s+\d+\b/gi, "$1")
    .replace(/\bchild\s+row\s+\d+\b/gi, "child entry")
    .replace(/\s*-\s*row\s+\d+:\s*/gi, ": ")
    .replace(/\brow\s+\d+:\s*/gi, "")
    .replace(/Mismatched rows:/gi, "Mismatched entries:")
    .replace(/\s+/g, " ")
    .trim();
}

export const getFlagName = (flagKey) => {
  const flagNames = {
    "invoiceDashboardDiscr": "Invoice discrepancy",
    "crmPipeDashDiscr":      "Job discrepancy - Pulse-CRM (Pipeline)",
    "crmPipeAppDiscr":       "Job discrepancy - in Pulse but not in CRM (Pipeline)",
    "crmConfDashDiscr":      "Job discrepancy - Pulse-CRM (Confirmed)",
    "crmConfAppDiscr":       "Job discrepancy - in Pulse but not in CRM (Confirmed)",
    "crmCopiedConfChecked":  "CRM copied to conf box checked",
    "crmCopiedConfUnchecked":"CRM copied to conf box UNchecked",
    "crmCopiedConfDelete":   "CRM copied to conf box DELETE",
    "retainerInvoicesCreated": "Retainer invoices created",
    "retainerInvoicesDeleted": "Retainer invoices deleted",
    "expenseDashboardDiscr": "Expense discrepancy",
    "expenseAdded":          "Expense added",
    "expenseUnreconGaps":    "Expense placeholders updated",
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

/**
 * Robust client name matcher for authorization.
 * Matches:
 * - Exact equality ("Eleven" === "Eleven")
 * - Case and whitespace tolerance (" eleven " === "eleven")
 * - Alphanumeric stripped tolerance ("ayefourdesign" === "ayefour design")
 * - Prefix / Substring tolerance ("Orinoco" matches "Orinoco Communications", "Ayefour" matches "Ayefour Design")
 */
export function matchesClientName(assignedIdentifier, actualClientName) {
  if (!assignedIdentifier || !actualClientName) return false;
  const sa = String(assignedIdentifier).trim().toLowerCase();
  const sb = String(actualClientName).trim().toLowerCase();
  if (sa === sb) return true;

  const clean = n => String(n || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ca = clean(sa);
  const cb = clean(sb);
  if (ca && cb && ca === cb) return true;

  if (sa.length >= 3 && (sb.includes(sa) || sa.includes(sb))) return true;
  if (ca.length >= 3 && (cb.includes(ca) || ca.includes(cb))) return true;

  return false;
}

/**
 * Check if a user is authorized to view or edit data for a given client
 */
export function isUserAuthorizedForClient(user, clientName) {
  if (!user) return false;
  if (user.role === "Admin" || user.isAdmin || user.assignedClients === "*") return true;
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
  if (user.role === "Admin" || user.isAdmin || user.assignedClients === "*") return allClients;

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

