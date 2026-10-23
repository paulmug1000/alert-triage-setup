export function stripCurrency(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
  // Strip currency symbols (£, $, €), commas, and any non-numeric chars except dot and minus
  const clean = s.replace(/[^\d.-]/g, "").trim();
  return isNaN(Number(clean)) || clean === "" ? "" : clean;
}

export function isPlaceholderInvoice(ref, status) {
  if (!ref && !status) return false;
  const s = String(typeof ref === "object" ? (ref?.ref || "") : ref || "").trim().toUpperCase();
  const st = String(typeof ref === "object" ? (ref?.status || "") : status || "").trim().toUpperCase();
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
  if (!appId && !description && !status) return false;
  const id = String(typeof appId === "object" ? (appId?.transactionId || appId?.id || appId?.appId || "") : appId || "").trim().toUpperCase();
  const desc = String(typeof appId === "object" ? (appId?.description || "") : description || "").trim().toUpperCase();
  const st = String(typeof appId === "object" ? (appId?.status || "") : status || "").trim().toUpperCase();
  const tags = ["PLACE-EXP", "MANUAL-ENTRY", "UNRECON-GAP", "PLACE-GAP", "MANUAL-GAP", "PLACEHOLDER"];
  return (
    tags.some((t) => id.includes(t) || desc.includes(t) || st.includes(t)) ||
    id.startsWith("PLACE") ||
    desc.startsWith("PLACE") ||
    id.startsWith("MANUAL") ||
    desc.startsWith("MANUAL")
  );
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
  stale_unrecon_gap:          "Stale UNRECON-GAP expense",
  retroactive_outgoings_update: "Retroactive P&L outgoings update",
  unmapped_pl_category:       "Unmapped P&L category",
  part_paid_balance:          "Part-paid balance",
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
    // Strip parenthesized combined row/slot references: (Row 362, slot 1), (slot 1, Row 362), (Sheet Row 362, Slot 1)
    .replace(/\s*\(\s*(?:Confirmed|Pipeline)?\s*(?:sheet\s+)?rows?\s+\d+,\s*slots?\s+\d+\s*\)/gi, "")
    .replace(/\s*\(\s*slots?\s+\d+,\s*(?:Confirmed|Pipeline)?\s*(?:sheet\s+)?rows?\s+\d+\s*\)/gi, "")
    // Strip standalone parenthesized slot or row: (slot 1), (Row 362), (Confirmed row 14)
    .replace(/\s*\(\s*slots?\s+\d+\s*\)/gi, "")
    .replace(/\s*\(\s*(?:Confirmed|Pipeline)?\s*(?:sheet\s+)?rows?\s+\d+\s*\)/gi, "")
    .replace(/\(\s*(?:sheet\s+)?rows?\s+\d+,\s*/gi, "(")
    .replace(/\(\s*(?:Confirmed|Pipeline)?\s*(?:sheet\s+)?rows?\s+\d+,\s*/gi, "(")
    // Strip inline Row / Slot references: "slot 1", "slot 2", "Row 362,"
    .replace(/\b(?:Confirmed|Pipeline)?\s*(?:Sheet\s+)?Row\s+\d+,\s*/gi, "")
    .replace(/\b(Confirmed|Pipeline)\s+(?:sheet\s+)?rows?\s+\d+\b/gi, "$1")
    .replace(/\bchild\s+rows?\s+\d+\b/gi, "child entry")
    .replace(/\bchild\s+rows?\b/gi, "child entries")
    .replace(/\bparent\s+rows?\b/gi, "parent job")
    .replace(/\s*-\s*(?:sheet\s+)?rows?\s+\d+:\s*/gi, ": ")
    .replace(/\b(?:sheet\s+)?rows?\s+\d+:\s*/gi, "")
    .replace(/\b(?:in|into|on)\s+slots?\s+\d+\b/gi, "")
    .replace(/\b(?:in|into|on)\s+(?:sheet\s+)?rows?\s+\d+\b/gi, "")
    .replace(/\bslots?\s+\d+\b/gi, "")
    .replace(/\bslot\s+amount\b/gi, "expected amount")
    .replace(/\bslots\b/gi, "entries")
    .replace(/\bmulti-row\b/gi, "recurring")
    .replace(/\bnew\s+row\b/gi, "new entry")
    .replace(/\bempty\s+slots?\b/gi, "unbilled entries")
    .replace(/Mismatched rows:/gi, "Mismatched entries:")
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
    "expenseUnreconGaps":    "Stale unreceived expense date changed",
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
  expenseUnreconGaps:      "expense",
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
        label: `Receive Date: ${res.oldRec} → ${res.newRec}`
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
        highlight: `Added ${m[2]} future monthly billing row${parseInt(m[2], 10) > 1 ? "s" : ""} for retainer contract.`
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
        highlight: `Added ${mOld[4]} future monthly billing row${parseInt(mOld[4], 10) > 1 ? "s" : ""} for retainer contract.`
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
        highlight: `Trimmed ${m[2]} excess child row${parseInt(m[2], 10) > 1 ? "s" : ""} after retainer contract end date.`
      };
    }
  }

  // 5. CRM Copied to Confirmed (Checked)
  if (flagType === "crmCopiedConfChecked" || clean.includes("Copied Pipeline Project") || clean.includes("Converted Pipeline Job")) {
    const m = clean.match(/(?:Copied Pipeline Project (?:to Confirmed|\(with[^)]*\))|Converted Pipeline Job to Confirmed Retainer):\s*([^|]+)\|\s*([^[\n]+)(?:\s*\[([^\]]+)\])?(?:\s*\(Pipeline\s+row\s+(\d+)\s*->\s*Confirmed\s+row\s+(\d+)\))?/i);
    if (m) {
      return {
        tab: "Confirmed",
        client: m[1] ? m[1].trim() : "",
        job: m[2] ? m[2].trim() : "",
        projectCode: m[3] ? m[3].trim() : "",
        pipelineRow: m[4] ? parseInt(m[4], 10) : null,
        confirmedRow: m[5] ? parseInt(m[5], 10) : null,
        highlight: clean.includes("Converted")
          ? "Converted Pipeline job to Confirmed Retainer."
          : "Pipeline project copied to Confirmed tab (Copied box checked)."
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
        highlight: "New expense row created in spreadsheet."
      };
    }
  }

  // 9. Generic Fallback
  const res = {};
  if (clean.includes("[Confirmed]")) res.tab = "Confirmed";
  else if (clean.includes("[Pipeline]")) res.tab = "Pipeline";
  else if (clean.includes("[Outgoings]")) res.tab = "Outgoings";

  const pipeIdx = clean.indexOf("|");
  if (pipeIdx > 0) {
    const before = clean.substring(0, pipeIdx).replace(/\[[^\]]+\]/g, "").replace(/Row\s*\d+,?/gi, "").trim();
    const after = clean.substring(pipeIdx + 1).split(/,|\(|\[/)[0].trim();
    if (before && before.length < 50) res.client = before;
    if (after && after.length < 60) res.job = after;
  }

  const rowMatch = clean.match(/\bRow\s+(\d+)\b/i);
  if (rowMatch) res.rowNum = parseInt(rowMatch[1], 10);

  res.rawText = clean.replace(/^\[[^\]]+\]\s*/, "");
  return res;
}

/**
 * Safely downloads a CSV file on the client with UTF-8 BOM (\uFEFF)
 * so that Excel / Windows opens the file without showing weird characters (e.g. Â£ instead of £).
 * Accepts either a pre-formatted CSV string or a 2D array of rows.
 */
export function downloadCsv(filename, content) {
  let csvText = "";
  if (Array.isArray(content)) {
    csvText = content
      .map((row) =>
        (row || [])
          .map((val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val);
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
  if (!dStr) return null;
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
  const s = String(dStr).trim();
  if (!s || s === "-" || s === "(blank)") return null;

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

  // 4. DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

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
  if (!d) return String(dStr).trim();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d.getDate();
  const mmm = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${day}-${mmm}-${yy}`;
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

  // 2. Derive by projecting from the retainer job's startDate + rIdx months
  const parentStart = job?.startDate || job?.rows?.[0]?.startDate;
  if (parentStart) {
    const s = String(parentStart).trim();
    const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
    if (m) {
      const mIdx = RET_MONTH_INDEX[m[2].toLowerCase()];
      if (mIdx !== undefined) {
        const fullYr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        const day = Math.min(parseInt(m[1], 10) || 1, 28);
        const projectedDate = new Date(fullYr, mIdx + (rIdx || 0), day);
        const monStr = RET_MONTH_NAMES[projectedDate.getMonth()];
        const yrStr = String(projectedDate.getFullYear()).slice(-2);
        return `${monStr}-${yrStr}`;
      }
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const projectedDate = new Date(d.getFullYear(), d.getMonth() + (rIdx || 0), Math.min(d.getDate(), 28));
      const monStr = RET_MONTH_NAMES[projectedDate.getMonth()];
      const yrStr = String(projectedDate.getFullYear()).slice(-2);
      return `${monStr}-${yrStr}`;
    }
  }

  return `Month ${(rIdx || 0) + 1}`;
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
