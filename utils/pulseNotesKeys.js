/**
 * Pure client- & server-safe helpers for canonical Pulse note keys,
 * 4-tier matching of reference-less manual invoices/expenses,
 * scenario snapshot extraction, and deep-link navigation.
 */

const MONTHS_NUM = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export const RESTRICTED_NOTE_ENTITY_TYPES = new Set(["employee", "dividend"]);

export const SCREEN_ENTITY_TYPES = new Set(["performance", "cash", "budget", "scenario"]);

export const ALL_NOTE_ENTITY_TYPES = new Set([
  "job",
  "invoice",
  "job_expense",
  "contractor",
  "contractor_bill",
  "outgoing",
  "dividend",
  "employee",
  "performance",
  "cash",
  "budget",
  "scenario",
]);

export function normalizeNoteSegment(str) {
  return String(str ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

export function isRestrictedNoteEntityType(entityType) {
  return RESTRICTED_NOTE_ENTITY_TYPES.has(String(entityType || "").trim().toLowerCase());
}

/**
 * Parses common month labels ("Nov 26", "Nov-2026", "2026-11", "01/11/2026") into "YYYY-MM".
 */
export function monthLabelToYearMonth(monthLabel) {
  const s = String(monthLabel || "").trim();
  if (!s) return "unknown";

  const isoYm = s.match(/^(\d{4})[\/\-](\d{1,2})(?:[\/\-]\d{1,2})?$/);
  if (isoYm) {
    return `${isoYm[1]}-${String(isoYm[2]).padStart(2, "0")}`;
  }

  const ukDate = s.match(/^\d{1,2}[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (ukDate) {
    let yr = parseInt(ukDate[2], 10);
    if (yr < 100) yr += 2000;
    return `${yr}-${String(ukDate[1]).padStart(2, "0")}`;
  }

  const monYr = s.match(/^(?:\d{1,2}[\s\-])?([a-zA-Z]{3,})[\s\-]+(\d{2,4})$/);
  if (monYr) {
    const mNum = MONTHS_NUM[monYr[1].toLowerCase().slice(0, 3)];
    let yr = parseInt(monYr[2], 10);
    if (yr < 100) yr += 2000;
    if (mNum && Number.isFinite(yr)) {
      return `${yr}-${mNum}`;
    }
  }

  return normalizeNoteSegment(s).replace(/[^a-z0-9_-]/g, "_");
}

export function normalizeAmountFingerprint(val) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") {
    return Number.isFinite(val) ? val.toFixed(2) : "";
  }
  const cleaned = String(val).replace(/[£$€,\s]/g, "").trim();
  if (!cleaned) return "";
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num.toFixed(2) : "";
}

export function normalizeDateFingerprint(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  }
  const uk = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (uk) {
    let yr = parseInt(uk[3], 10);
    if (yr < 100) yr += 2000;
    return `${yr}-${String(uk[2]).padStart(2, "0")}-${String(uk[1]).padStart(2, "0")}`;
  }
  const dMonY = s.match(/^(\d{1,2})[\s\-]([a-zA-Z]{3,})[\s\-](\d{2,4})$/);
  if (dMonY) {
    const mNum = MONTHS_NUM[dMonY[2].toLowerCase().slice(0, 3)];
    let yr = parseInt(dMonY[3], 10);
    if (yr < 100) yr += 2000;
    if (mNum && Number.isFinite(yr)) {
      return `${yr}-${mNum}-${String(dMonY[1]).padStart(2, "0")}`;
    }
  }
  return normalizeNoteSegment(s);
}

export function buildJobNoteKey(job) {
  if (!job || typeof job !== "object") return "job:unknown";
  const projectCode = normalizeNoteSegment(job.projectCode || "");
  if (projectCode) {
    return `job:code:${projectCode}`;
  }
  const clientPart = normalizeNoteSegment(job.client || job.clientName || "general");
  const namePart = normalizeNoteSegment(job.jobName || job.name || `row-${job.rowNumber || "0"}`);
  return `job:${clientPart}::${namePart}`;
}

export function buildJobNoteLabel(job) {
  if (!job || typeof job !== "object") return "Job";
  const client = String(job.client || "").trim();
  const jobName = String(job.jobName || job.name || "").trim();
  if (client && jobName) return `${client} · ${jobName}`;
  return jobName || client || "Job";
}

export function buildInvoiceNoteKey(job, inv, slotIndex1Based = 1) {
  const ref = normalizeNoteSegment(inv?.ref || "");
  if (ref) {
    return `invoice:ref:${ref}`;
  }
  const jobKey = buildJobNoteKey(job);
  const slot = Number.isFinite(Number(slotIndex1Based)) && Number(slotIndex1Based) > 0
    ? Number(slotIndex1Based)
    : 1;
  return `invoice:job:${jobKey}:slot:${slot}`;
}

export function buildInvoiceNoteLabel(job, inv, slotIndex1Based = 1, currencySymbol = "£") {
  const jobLabel = buildJobNoteLabel(job);
  const ref = String(inv?.ref || "").trim();
  const amtNum = normalizeAmountFingerprint(inv?.amount);
  const amtDisplay = amtNum ? `${currencySymbol}${Number(amtNum).toLocaleString("en-GB", { maximumFractionDigits: 2 })}` : "";
  const dateDisplay = String(inv?.sendDate || "").trim();
  const invPart = ref ? `Invoice #${ref}` : `Invoice #${slotIndex1Based}`;
  const metaParts = [amtDisplay, dateDisplay].filter(Boolean).join(", ");
  return `${jobLabel} — ${invPart}${metaParts ? ` (${metaParts})` : ""}`;
}

export function buildJobExpenseNoteKey(job, exp, slotIndex1Based = 1) {
  const appId = normalizeNoteSegment(exp?.appId || "");
  if (appId) {
    return `job_expense:id:${appId}`;
  }
  const jobKey = buildJobNoteKey(job);
  const slot = Number.isFinite(Number(slotIndex1Based)) && Number(slotIndex1Based) > 0
    ? Number(slotIndex1Based)
    : 1;
  return `job_expense:job:${jobKey}:slot:${slot}`;
}

export function buildJobExpenseNoteLabel(job, exp, slotIndex1Based = 1, currencySymbol = "£") {
  const jobLabel = buildJobNoteLabel(job);
  const desc = String(exp?.desc || exp?.description || "").trim();
  const amtNum = normalizeAmountFingerprint(exp?.amount);
  const amtDisplay = amtNum ? `${currencySymbol}${Number(amtNum).toLocaleString("en-GB", { maximumFractionDigits: 2 })}` : "";
  const dateDisplay = String(exp?.recDate || exp?.sendDate || "").trim();
  const titlePart = desc || `Direct expense #${slotIndex1Based}`;
  const metaParts = [amtDisplay, dateDisplay].filter(Boolean).join(", ");
  return `${jobLabel} — ${titlePart}${metaParts ? ` (${metaParts})` : ""}`;
}

export function buildContractorRowNoteKey(vendorName) {
  return `contractor:row:${normalizeNoteSegment(vendorName)}`;
}

export function buildContractorCellNoteKey(vendorName, monthLabel) {
  return `contractor:cell:${normalizeNoteSegment(vendorName)}:${monthLabelToYearMonth(monthLabel)}`;
}

export function buildContractorBillNoteKey(vendorName, monthLabel, bill, idx1Based = 1) {
  const appId = normalizeNoteSegment(bill?.appId || "");
  if (appId) {
    return `contractor_bill:id:${appId}`;
  }
  return `contractor_bill:cell:${normalizeNoteSegment(vendorName)}:${monthLabelToYearMonth(monthLabel)}:idx:${idx1Based}`;
}

export function buildOutgoingRowNoteKey(categoryName) {
  return `outgoing:row:${normalizeNoteSegment(categoryName)}`;
}

export function buildOutgoingCellNoteKey(categoryName, monthLabel) {
  return `outgoing:cell:${normalizeNoteSegment(categoryName)}:${monthLabelToYearMonth(monthLabel)}`;
}

export function buildDividendRowNoteKey(name) {
  return `dividend:row:${normalizeNoteSegment(name)}`;
}

export function buildDividendCellNoteKey(name, monthLabel) {
  return `dividend:cell:${normalizeNoteSegment(name)}:${monthLabelToYearMonth(monthLabel)}`;
}

export function buildEmployeeNoteKey(name) {
  return `employee:row:${normalizeNoteSegment(name)}`;
}

export function buildScreenNoteKey(screen, fyLabel = "") {
  const s = normalizeNoteSegment(screen);
  if (s === "cash") return "screen:cash:rolling";
  const fy = normalizeNoteSegment(fyLabel || "current");
  return `screen:${s}:${fy}`;
}

/**
 * 4-tier matcher for job child items (invoices & direct expenses), handling
 * manual items without a reference even if slots are reordered/tidied in Google Sheets.
 *
 * Returns:
 * - matchedByIndex: Map<number, Array<noteSummary>> (0-based index into items)
 * - unmatchedNotes: Array<noteSummary> (orphaned/deleted items that still surface on parent job)
 */
export function matchJobChildNotes({ job, items = [], itemType = "invoice", childNotes = [] }) {
  const matchedByIndex = new Map();
  const unmatchedNotes = [];
  if (!Array.isArray(childNotes) || childNotes.length === 0) {
    return { matchedByIndex, unmatchedNotes };
  }

  const jobKey = buildJobNoteKey(job);
  const relevantNotes = childNotes.filter((n) => {
    if (!n || n.entityType !== itemType) return false;
    if (n.parentEntityKey && n.parentEntityKey === jobKey) return true;
    // Also include ref-matched notes even if parent key differed historically
    if (itemType === "invoice") {
      const noteRef = normalizeNoteSegment(n.contextMeta?.ref || "");
      return Boolean(noteRef && items.some((it) => normalizeNoteSegment(it?.ref) === noteRef));
    }
    const noteAppId = normalizeNoteSegment(n.contextMeta?.appId || "");
    return Boolean(noteAppId && items.some((it) => normalizeNoteSegment(it?.appId) === noteAppId));
  });

  if (relevantNotes.length === 0) {
    return { matchedByIndex, unmatchedNotes };
  }

  const normalizedItems = items.map((item, idx) => ({
    idx,
    slotNum: idx + 1,
    ref: normalizeNoteSegment(item?.ref || ""),
    appId: normalizeNoteSegment(item?.appId || ""),
    amount: normalizeAmountFingerprint(item?.amount),
    sendDate: normalizeDateFingerprint(item?.sendDate || ""),
    recDate: normalizeDateFingerprint(item?.recDate || item?.sendDate || ""),
    desc: normalizeNoteSegment(item?.desc || item?.description || ""),
  }));

  const claimedIndicesByFingerprint = new Set();
  const remainingNotes = [];

  const assignToIndex = (idx, note, markClaimed = true) => {
    if (!matchedByIndex.has(idx)) matchedByIndex.set(idx, []);
    matchedByIndex.get(idx).push(note);
    if (markClaimed) claimedIndicesByFingerprint.add(idx);
  };

  // Pass 1: Exact reference / appId match
  for (const note of relevantNotes) {
    const meta = note.contextMeta || {};
    let matchedIdx = -1;

    if (itemType === "invoice") {
      const refFromKey = String(note.entityKey || "").startsWith("invoice:ref:")
        ? String(note.entityKey).slice("invoice:ref:".length)
        : "";
      const targetRef = normalizeNoteSegment(meta.ref || refFromKey);
      if (targetRef) {
        const found = normalizedItems.find((it) => it.ref && it.ref === targetRef);
        if (found) matchedIdx = found.idx;
      }
    } else {
      const idFromKey = String(note.entityKey || "").startsWith("job_expense:id:")
        ? String(note.entityKey).slice("job_expense:id:".length)
        : "";
      const targetId = normalizeNoteSegment(meta.appId || idFromKey);
      if (targetId) {
        const found = normalizedItems.find((it) => it.appId && it.appId === targetId);
        if (found) matchedIdx = found.idx;
      }
    }

    if (matchedIdx !== -1) {
      assignToIndex(matchedIdx, note, true);
    } else {
      remainingNotes.push(note);
    }
  }

  // Pass 2: Content fingerprint match (handles Google Sheets slot moves & job tidying)
  const stillRemaining = [];
  for (const note of remainingNotes) {
    const meta = note.contextMeta || {};
    const nAmt = normalizeAmountFingerprint(meta.amount);
    const nDate = normalizeDateFingerprint(itemType === "invoice" ? meta.sendDate : (meta.recDate || meta.sendDate));
    const nDesc = normalizeNoteSegment(meta.desc || "");
    const nSlot = Number(meta.slotNum) || null;

    let candidates = [];
    if (itemType === "invoice") {
      if (nAmt && nDate) {
        candidates = normalizedItems.filter((it) => it.amount === nAmt && it.sendDate === nDate);
      }
    } else {
      if (nDesc && nAmt && nDate) {
        candidates = normalizedItems.filter((it) => it.desc === nDesc && it.amount === nAmt && it.recDate === nDate);
      }
      if (candidates.length === 0 && nDesc && nAmt) {
        candidates = normalizedItems.filter((it) => it.desc === nDesc && it.amount === nAmt);
      }
      if (candidates.length === 0 && nAmt && nDate) {
        candidates = normalizedItems.filter((it) => it.amount === nAmt && it.recDate === nDate);
      }
    }

    if (candidates.length > 0) {
      // Prefer exact slot tie-breaker if multiple identical manual rows exist
      const exactSlotMatch = nSlot ? candidates.find((c) => c.slotNum === nSlot) : null;
      const unclaimedMatch = candidates.find((c) => !claimedIndicesByFingerprint.has(c.idx));
      const chosen = exactSlotMatch || unclaimedMatch || candidates[0];
      assignToIndex(chosen.idx, note, true);
    } else {
      stillRemaining.push(note);
    }
  }

  // Pass 3: Unclaimed slotNum fallback
  for (const note of stillRemaining) {
    const meta = note.contextMeta || {};
    let slotNum = Number(meta.slotNum) || null;
    if (!slotNum) {
      const m = String(note.entityKey || "").match(/:slot:(\d+)$/);
      if (m) slotNum = parseInt(m[1], 10);
    }
    const target = slotNum ? normalizedItems.find((it) => it.slotNum === slotNum) : null;
    if (target && !claimedIndicesByFingerprint.has(target.idx)) {
      assignToIndex(target.idx, note, false);
    } else {
      unmatchedNotes.push(note);
    }
  }

  return { matchedByIndex, unmatchedNotes };
}

/**
 * Summarizes active Scenario adjustments into a compact JSON snapshot stored
 * inside `context_meta.scenarioSnapshot` when saving a note on the Scenarios screen.
 */
export function buildScenarioSnapshot({
  fyLabel = "",
  months = [],
  pipelineJobs = [],
  disabledJobIds = new Set(),
  confirmedJobIds = new Set(),
  adjs = {},
  currencySymbol = "£",
  isIncomeMode = false,
}) {
  const confirmedList = [];
  const excludedList = [];

  for (const j of pipelineJobs || []) {
    const label = buildJobNoteLabel(j);
    if (confirmedJobIds instanceof Set ? confirmedJobIds.has(j.id) : false) {
      confirmedList.push(label);
    } else if (disabledJobIds instanceof Set ? disabledJobIds.has(j.id) : false) {
      excludedList.push(label);
    }
  }

  const disabledNBMonths = [];
  if (Array.isArray(adjs?.nbChecked)) {
    adjs.nbChecked.forEach((checked, idx) => {
      if (checked === false) {
        disabledNBMonths.push(months[idx] || `Month ${idx + 1}`);
      }
    });
  }

  const categoryLabels = {
    rev: isIncomeMode ? "Income adjustment" : "Revenue adjustment",
    delStaff: "Delivery staff",
    delExp: "Delivery expenses",
    nonDelStaff: "Non-delivery staff",
    nonDelExp: "Non-delivery expenses",
  };

  const adjustments = [];
  for (const [catKey, catTitle] of Object.entries(categoryLabels)) {
    const arr = Array.isArray(adjs?.[catKey]) ? adjs[catKey] : [];
    arr.forEach((val, idx) => {
      const num = Number(val);
      if (Number.isFinite(num) && Math.abs(num) >= 0.01) {
        adjustments.push({
          category: catTitle,
          month: months[idx] || `Month ${idx + 1}`,
          amount: Math.round(num * 100) / 100,
          currencySymbol,
        });
      }
    });
  }

  const hasChanges =
    confirmedList.length > 0 ||
    excludedList.length > 0 ||
    disabledNBMonths.length > 0 ||
    adjustments.length > 0;

  return {
    fyLabel: String(fyLabel || "").trim(),
    hasChanges,
    confirmedPipelineJobs: confirmedList.slice(0, 25),
    excludedPipelineJobs: excludedList.slice(0, 25),
    disabledNBMonths: disabledNBMonths.slice(0, 12),
    adjustments: adjustments.slice(0, 60),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Maps a note record to its canonical Pulse Portal `?view=...` slug.
 */
export function getPortalViewForNote(note) {
  const et = String(note?.entityType || note?.entity_type || "").toLowerCase();
  const subView = String(note?.contextMeta?.subView || note?.context_meta?.subView || "").trim();

  if (subView) return subView;
  switch (et) {
    case "job":
    case "invoice":
    case "job_expense":
      return "jobs";
    case "contractor":
    case "contractor_bill":
      return "contractors";
    case "outgoing":
      return "expenses";
    case "dividend":
      return "dividends";
    case "employee":
      return "salaries";
    case "performance":
      return "dashboard";
    case "cash":
      return "cash";
    case "budget":
      return "viewBudget";
    case "scenario":
      return "scenarios";
    default:
      return "month";
  }
}

export function getEntityTypeDisplayLabel(entityType) {
  const map = {
    job: "Job",
    invoice: "Invoice",
    job_expense: "Direct expense",
    contractor: "Contractor",
    contractor_bill: "Contractor bill",
    outgoing: "Expense",
    dividend: "Dividend",
    employee: "Employee",
    performance: "Performance",
    cash: "Cashflow",
    budget: "Budget",
    scenario: "Scenarios",
  };
  return map[String(entityType || "").toLowerCase()] || "Note";
}
