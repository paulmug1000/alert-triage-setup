import { waitUntil } from "@vercel/functions";
import { getSheetsClient, withRetry, extractSheetIdFromUrl, colIndexToLetter, sanitizeFormulaInput } from "./sheetsClient.js";
import { getToleranceValues, checkAllGASLocks } from "./sharedHelpers.js";
import { logPmaActivity } from "./pmaLogger.js";
import { resolveClientNameBySheetId, getAllClients, resolveMasterSheetIdForClient_, getSharedClientConfirmedAndKeyInfo } from "./workspaces.js";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  formatInvoiceRefForSheet,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  NO_END_DATE_SHEET_VALUE,
  isNoEndDateSentinel,
  formatJobEndDateDisplay,
  isJobCostingStyle,
  getJobCostingRowFormulasLetterMap,
  buildJobRowClearAndRestorePlan,
  parseVariableRetainerTag,
  formatVariableRetainerTag,
  formatVarRetainerMonthJobName,
  computeInclusiveRetainerMonths,
} from "../utils/helpers.js";
import { getSessionUser } from "./authService.js";
import { get2TierCache, set2TierCache, resolvePortalCache, invalidatePmaClientCache, memoryCache } from "./cacheService.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { resolveSupabaseSheetContext, flushImmediateAndScheduleBackgroundClientRecomputes } from "./masterEngineService.js";
import { preloadClientRelationalJobsBundle, buildRelationalFormattedTabRowsFromBundle } from "./relationalJobsService.js";
import { redisClient, scanRedisKeys } from "./redisClient.js";

const RET_MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

async function flushAndInvalidateRetainerCache_(
  sheets,
  clientSheetId,
  masterSheetId = null,
  scopes = ["jobs", "invoices", "retainers", "cash"],
  clientNameHint = ""
) {
  let resolvedName = String(clientNameHint || "").trim();
  let resolvedMasterId = masterSheetId || null;
  if ((!resolvedName || !resolvedMasterId) && (clientSheetId || masterSheetId)) {
    const sbCtx = await resolveSupabaseSheetContext({
      spreadsheetId: clientSheetId || masterSheetId,
      clientName: resolvedName || undefined,
    }).catch(() => null);
    if (sbCtx) {
      if (!resolvedName && sbCtx.clientName) resolvedName = sbCtx.clientName;
      if (!resolvedMasterId && sbCtx.masterSheetId) resolvedMasterId = sbCtx.masterSheetId;
    }
  }
  if (resolvedName) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, resolvedName);
  }
  await invalidatePmaClientCache(clientSheetId, resolvedMasterId, scopes).catch(() => { });
}


export function retParseSheetDate(val) {
  if (!val) return null;
  if (isNoEndDateSentinel(val)) return new Date(2050, 11, 31);
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

  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
  }

  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = RET_MONTHS_MAP[m[2].toLowerCase()];
    if (mi === undefined) return null;
    let yr;
    if (m[3].length === 2) {
      const twoDigit = parseInt(m[3], 10);
      yr = (twoDigit <= 69 ? 2000 : 1900) + twoDigit;
    } else {
      yr = parseInt(m[3], 10);
    }
    return new Date(yr, mi, parseInt(m[1]));
  }
  if (/^\d+$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function retFmtDate(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return d.getDate() + "-" + months[d.getMonth()] + "-" + d.getFullYear();
}

export function retParseMoney(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const clean = String(val).replace(/[^0-9.-]/g, "");
  return parseFloat(clean) || 0;
}

export async function retFindTrueLastRow(sheets, spreadsheetId, allRows) {
  let rows = allRows;
  if (!rows || rows.length === 0) {
    if (sheets && spreadsheetId) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      rows = resp.data.values || [];
    } else {
      return 0;
    }
  }
  let trueLastRow = 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r] || [];
    const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
    const hasRech = Math.abs(retParseMoney(row[17])) > 0.001;
    const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
    const z3 = row.slice(41, 62).some(c => c !== "" && c != null);
    const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
    if (z1 || z2 || z3 || z4 || hasRech) { trueLastRow = r + 1; break; }
  }
  return trueLastRow;
}

export function retDetectIntervalMonths(childDates, parentType) {
  if (parentType) {
    const pt = String(parentType).toLowerCase();
    if (pt.includes("quarter")) return 3;
    if (pt.includes("annual") || pt.includes("year")) return 12;
    if (pt.includes("bi-month") || pt.includes("bimonth")) return 2;
    if (pt.includes("month")) return 1;
  }
  const dates = (childDates || []).filter(Boolean);
  if (dates.length < 2) return 1;

  const diffs = [];
  for (let k = 0; k < dates.length - 1; k++) {
    const d1 = dates[k];
    const d2 = dates[k + 1];
    if (d1 && d2) {
      const t1 = d1 instanceof Date ? d1.getTime() : new Date(d1).getTime();
      const t2 = d2 instanceof Date ? d2.getTime() : new Date(d2).getTime();
      if (!isNaN(t1) && !isNaN(t2)) {
        const diffDays = Math.ceil(Math.abs(t2 - t1) / 86400000);
        const calc = Math.round(diffDays / 30);
        if (calc > 0) diffs.push(calc);
      }
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
}

export function retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths) {
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
  const addMonths = (y, m, n) => {
    const total = (y * 12 + m) + n;
    return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
  };
  let beforeVotes = 0, duringVotes = 0, afterVotes = 0;
  dates.forEach((sent, i) => {
    const { y, m } = addMonths(jobStartDate.getFullYear(), jobStartDate.getMonth(), i * interval);
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
}

export function retFindRetainerJobs(rows, options) {
  options = options || {};
  const onlyActiveOrRecentlyEnded = !!options.onlyActiveOrRecentlyEnded;
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  const jobs = [];
  let ri = 1;
  while (ri < rows.length) {
    const row = rows[ri] || [];
    const client = String(row[0] || "").trim();
    const jobName = String(row[1] || "").trim();
    const revenue = String(row[32] || "").trim();
    const type = String(row[35] || "").trim();
    if (!client && !jobName) { ri++; continue; }
    const isRetainer = type.toLowerCase().includes("retainer");
    if (!isRetainer || !revenue || parseVariableRetainerTag(row[30])) { ri++; continue; }

    const parentRowNum = ri + 1;
    const endDate = retParseSheetDate(row[38]);
    if (onlyActiveOrRecentlyEnded && endDate && endDate < twoMonthsAgo) {
      let cj2 = ri + 1;
      while (cj2 < rows.length) {
        const nx = rows[cj2] || [];
        if (String(nx[0] || "").trim() === client && String(nx[1] || "").trim() === jobName &&
          !String(nx[32] || "").trim() && !String(nx[37] || "").trim()) { cj2++; } else break;
      }
      ri = cj2;
      continue;
    }

    const childRows = [];
    let cj = ri + 1;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      const nc = String(next[0] || "").trim();
      const nj = String(next[1] || "").trim();
      const nRevenue = String(next[32] || "").trim();
      const nStart = String(next[37] || "").trim();
      if (nc === client && nj === jobName && !nRevenue && !nStart) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    jobs.push({
      client, jobName, projectCode: String(row[2] || "").trim(),
      revenue, vat: String(row[34] || "").trim(), projectRetainer: type,
      startDate: retParseSheetDate(row[37]), endDate,
      parentRow: row, parentRowNum, childRows,
    });
    ri = cj;
  }
  return jobs;
}

export function retFindVariableRetainerSeries(rows) {
  const seriesMap = Object.create(null);
  let ri = 1;
  while (ri < rows.length) {
    const row = rows[ri] || [];
    const client = String(row[0] || "").trim();
    const jobName = String(row[1] || "").trim();
    const type = String(row[35] || "").trim();
    const vrMeta = parseVariableRetainerTag(row[30]);
    if (!client || !type.toLowerCase().includes("retainer") || !vrMeta) {
      ri++;
      continue;
    }

    const monthRowNum = ri + 1;
    const overflowRows = [];
    let cj = ri + 1;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      const nc = String(next[0] || "").trim();
      const nj = String(next[1] || "").trim();
      const nRev = String(next[32] || "").trim();
      const nStart = String(next[37] || "").trim();
      const nType = String(next[35] || "").trim();
      if (nc === client && nj === jobName && !nRev && !nStart && !nType) {
        overflowRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else {
        break;
      }
    }

    const seriesName = vrMeta.seriesName || jobName.replace(/\s*-\s*[A-Za-z]{3}\s+\d{4}$/, "").trim() || jobName;
    const cKey = client.toLowerCase();
    const sKey = seriesName.toLowerCase();
    if (cKey !== "__proto__" && sKey !== "__proto__") {
      const mapKey = `${cKey}|||${sKey}`;
      if (!Object.prototype.hasOwnProperty.call(seriesMap, mapKey)) {
        seriesMap[mapKey] = {
          client,
          seriesName,
          months: [],
        };
      }
      seriesMap[mapKey].months.push({
        rowNum: monthRowNum,
        row,
        overflowRows,
        vrMeta,
        startDate: retParseSheetDate(row[37]),
        endDate: retParseSheetDate(row[38]),
      });
    }
    ri = cj;
  }

  return Object.values(seriesMap).map((group) => {
    group.months.sort((a, b) => {
      const ta = a.startDate ? a.startDate.getTime() : 0;
      const tb = b.startDate ? b.startDate.getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.rowNum - b.rowNum;
    });
    const first = group.months[0];
    const latest = group.months[group.months.length - 1];
    const meta = latest?.vrMeta || {};
    return {
      client: group.client,
      seriesName: group.seriesName,
      projectCode: String(latest?.row?.[2] || first?.row?.[2] || "").trim(),
      vat: String(latest?.row?.[34] || first?.row?.[34] || "Yes").trim(),
      baseRev: meta.baseRev ?? 0,
      baseDC: meta.baseDC ?? 0,
      endDate: meta.endDate || "31-Dec-2050",
      noEndDate: Boolean(meta.noEndDate),
      sendDay: meta.sendDay || 28,
      startDate: first?.startDate || null,
      endDateObj: retParseSheetDate(meta.endDate || "31-Dec-2050"),
      months: group.months,
    };
  });
}

export const RET_INV_SLOTS = [
  { amt: 41, ref: 42, sent: 43, days: 44, status: 45, rech: 46, costMonth: 47 },
  { amt: 48, ref: 49, sent: 50, days: 51, status: 52, rech: 53, costMonth: 54 },
  { amt: 55, ref: 56, sent: 57, days: 58, status: 59, rech: 60, costMonth: 61 },
];

export function retRowHasRealData(row) {
  if (!row) return false;
  for (const s of RET_INV_SLOTS) {
    const ref = String(row[s.ref] ?? "").trim();
    if (ref && !isPlaceholderInvoice(ref)) return true;
    const status = String(row[s.status] ?? "").trim().toLowerCase();
    if (status.includes("sent") || status.includes("paid")) return true;
  }
  const expSlots = [{ id: 81 }, { id: 88 }, { id: 95 }];
  for (const s of expSlots) {
    const id = String(row[s.id] ?? "").trim();
    if (id && !isPlaceholderExpense(id)) return true;
  }
  return false;
}

/**
 * Reconstructs the Slot 1 (AP:AT) manual retainer placeholder for a Confirmed retainer
 * child row when its last invoice is deleted or moved away and job dates do not change.
 */
export function buildRetainerChildPlaceholderSlot({
  parentRow,
  childRows = [],
  targetRowNum,
  deletedRowSnapshot = null,
  tolerance = null,
  overrideMonthlyRevenue = undefined,
} = {}) {
  const hasExplicitRev =
    overrideMonthlyRevenue !== undefined &&
    overrideMonthlyRevenue !== null &&
    overrideMonthlyRevenue !== "" &&
    !isNaN(Number(overrideMonthlyRevenue));
  const monthlyFee = hasExplicitRev ? Number(overrideMonthlyRevenue) : retParseMoney(parentRow?.[32]);
  if (!(monthlyFee > 0)) return null;

  const targetIdx = childRows.findIndex((cr) => Number(cr.rowNum) === Number(targetRowNum));
  if (targetIdx === -1) return null;

  const effectiveChildRows = childRows.map((cr) =>
    Number(cr.rowNum) === Number(targetRowNum) && Array.isArray(deletedRowSnapshot)
      ? { ...cr, row: deletedRowSnapshot }
      : cr
  );

  const childDates = effectiveChildRows.map((cr) => retParseSheetDate(cr.row?.[43])).filter(Boolean);
  const parentInvDate = retParseSheetDate(parentRow?.[43]);
  const allInvoiceDates = (parentInvDate ? [parentInvDate] : []).concat(childDates);
  const intervalMonths = retDetectIntervalMonths(allInvoiceDates, parentRow?.[35]) || 1;
  const perInvoiceAmount = Math.round(monthlyFee * intervalMonths * 100) / 100;

  const jobStartDate = retParseSheetDate(parentRow?.[37]);
  const invoiceTimingOffset = retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths);
  const sendTimingShift = invoiceTimingOffset === "before" ? -1 : (invoiceTimingOffset === "after" ? 1 : 0);

  const datedSiblings = [];
  for (let idx = 0; idx < childRows.length; idx++) {
    if (idx === targetIdx) continue;
    const rowArr = childRows[idx]?.row || [];
    const d = retParseSheetDate(rowArr[43]);
    if (!d) continue;
    const ref = String(rowArr[42] ?? "").trim();
    const status = String(rowArr[45] ?? "").trim();
    datedSiblings.push({
      idx,
      date: d,
      isPlaceholder: !ref || isPlaceholderInvoice(ref, status),
      days: rowArr[44],
    });
  }
  datedSiblings.sort((a, b) => Math.abs(a.idx - targetIdx) - Math.abs(b.idx - targetIdx));
  const placeholderSiblings = datedSiblings.filter((s) => s.isPlaceholder);

  const b51TargetDay = parseInt(tolerance?.retainerInvoiceDay, 10) > 0 ? parseInt(tolerance.retainerInvoiceDay, 10) : 28;
  let sendDay;
  if (placeholderSiblings.length > 0) {
    const allEndOfMonth = placeholderSiblings.every(
      (s) => s.date.getDate() === new Date(s.date.getFullYear(), s.date.getMonth() + 1, 0).getDate()
    );
    const has30Or31 = placeholderSiblings.some((s) => s.date.getDate() >= 30);
    sendDay = allEndOfMonth && has30Or31 ? "end" : placeholderSiblings[0].date.getDate();
  } else if (datedSiblings.length > 0) {
    sendDay = datedSiblings[0].date.getDate();
  } else {
    sendDay = b51TargetDay;
  }

  let resolvedDefaultDays = 30;
  const parsedTolDays = parseInt(String(tolerance?.defaultDaysToPay ?? "").replace(/[^\d.-]/g, ""), 10);
  if (!isNaN(parsedTolDays) && parsedTolDays >= 0 && parsedTolDays <= 365) {
    resolvedDefaultDays = parsedTolDays;
  } else if (placeholderSiblings[0]?.days !== undefined && placeholderSiblings[0]?.days !== null && String(placeholderSiblings[0].days).trim() !== "") {
    const parsedSibDays = parseInt(String(placeholderSiblings[0].days).replace(/[^\d.-]/g, ""), 10);
    if (!isNaN(parsedSibDays) && parsedSibDays >= 0 && parsedSibDays <= 365) {
      resolvedDefaultDays = parsedSibDays;
    }
  }

  let sendMonthVal;
  if (placeholderSiblings.length > 0) {
    const anchor = placeholderSiblings[0];
    sendMonthVal = anchor.date.getFullYear() * 12 + anchor.date.getMonth() + (targetIdx - anchor.idx) * intervalMonths;
  } else if (datedSiblings.length > 0) {
    const anchor = datedSiblings[0];
    sendMonthVal = anchor.date.getFullYear() * 12 + anchor.date.getMonth() + (targetIdx - anchor.idx) * intervalMonths;
  } else if (jobStartDate) {
    sendMonthVal = jobStartDate.getFullYear() * 12 + jobStartDate.getMonth() + targetIdx * intervalMonths + sendTimingShift;
  } else {
    const snapDate = retParseSheetDate(deletedRowSnapshot?.[43]);
    if (snapDate) {
      sendMonthVal = snapDate.getFullYear() * 12 + snapDate.getMonth();
    } else {
      const now = new Date();
      sendMonthVal = now.getFullYear() * 12 + now.getMonth();
    }
  }

  const slotYear = Math.floor(sendMonthVal / 12);
  const slotMonth0 = ((sendMonthVal % 12) + 12) % 12;
  const maxDaysInMonth = new Date(slotYear, slotMonth0 + 1, 0).getDate();
  const dayToUse = sendDay === "end" ? maxDaysInMonth : Math.min(sendDay, maxDaysInMonth);
  const formattedSendDate = retFmtDate(new Date(slotYear, slotMonth0, dayToUse));

  return {
    rowNum: Number(targetRowNum),
    slotNum: 1,
    values: [perInvoiceAmount, "", formattedSendDate, resolvedDefaultDays, ""],
    slot: {
      slotNum: 1,
      amount: String(perInvoiceAmount),
      ref: "",
      sentDate: formattedSendDate,
      daysToPay: String(resolvedDefaultDays),
      status: "",
    },
  };
}

function buildRetainerUiChildRow_({ rowNum, client, jobName, vat, isJobCosting = false, amount, sentDate, daysToPay }) {
  return {
    rowNum,
    isParent: false,
    tabName: "Confirmed",
    isJobCosting: Boolean(isJobCosting),
    note: "",
    client: String(client || ""),
    jobName: String(jobName || ""),
    projectCode: "",
    dateConf: "",
    leadSrc: "",
    unevenSplit: "",
    revenue: "",
    directCosts: "",
    vat: String(vat || ""),
    projectRetainer: "",
    prodLine: "",
    startDate: "",
    endDate: "",
    likelihood: "100%",
    copiedToConf: null,
    leftToInvoice: "",
    costsOutstanding: "",
    invoiceSlots: [
      {
        slotNum: 1,
        amount: amount !== undefined && amount !== null && amount !== "" ? String(amount) : "",
        ref: "",
        sentDate: String(sentDate || ""),
        daysToPay: daysToPay !== undefined && daysToPay !== null ? String(daysToPay) : "30",
        status: "",
        highlighted: false,
        note: "",
      },
      { slotNum: 2, amount: "", ref: "", sentDate: "", daysToPay: "", status: "", highlighted: false, note: "" },
      { slotNum: 3, amount: "", ref: "", sentDate: "", daysToPay: "", status: "", highlighted: false, note: "" },
    ],
    expenseSlots: [1, 2, 3].map((sNum) => ({
      slotNum: sNum,
      description: "",
      amount: "",
      vat: "",
      date: "",
      daysToPay: "",
      status: "",
      transactionId: "",
      highlighted: false,
      note: "",
    })),
  };
}

function resolveRetainerParentRow_(rows, parentRowNum, client, jobName) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const targetClient = norm(client);
  const targetJob = norm(jobName);
  const candidateNum = parseInt(parentRowNum, 10);

  if (candidateNum && candidateNum > 0 && rows[candidateNum - 1]) {
    const row = rows[candidateNum - 1];
    const rClient = norm(row[0]);
    const rJob = norm(row[1]);
    const hasParentFields = Boolean(String(row[32] ?? "").trim() || String(row[37] ?? "").trim());
    if (rJob === targetJob && (!targetClient || rClient === targetClient) && hasParentFields) {
      return {
        rowNum: candidateNum,
        row,
        resolvedClient: String(row[0] || "").trim(),
        resolvedJobName: String(row[1] || "").trim(),
      };
    }
  }

  // If candidateNum points to a child row of the retainer, walk upwards to its parent row first
  if (candidateNum && candidateNum > 1 && rows[candidateNum - 1]) {
    const startRow = rows[candidateNum - 1] || [];
    if (norm(startRow[1]) === targetJob && (!targetClient || norm(startRow[0]) === targetClient)) {
      for (let r = candidateNum - 1; r >= 1; r--) {
        const row = rows[r] || [];
        if (norm(row[1]) !== targetJob || (targetClient && norm(row[0]) !== targetClient)) break;
        const hasParentFields = Boolean(String(row[32] ?? "").trim() || String(row[37] ?? "").trim());
        if (hasParentFields) {
          return {
            rowNum: r + 1,
            row,
            resolvedClient: String(row[0] || "").trim(),
            resolvedJobName: String(row[1] || "").trim(),
          };
        }
      }
    }
  }

  // Fallback: scan all parent rows in Confirmed for matching jobName (and client if provided)
  const matches = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rClient = norm(row[0]);
    const rJob = norm(row[1]);
    const hasParentFields = Boolean(String(row[32] ?? "").trim() || String(row[37] ?? "").trim());
    if (!hasParentFields) continue;
    if (rJob === targetJob && (!targetClient || rClient === targetClient)) {
      matches.push({
        rowNum: r + 1,
        row,
        resolvedClient: String(row[0] || "").trim(),
        resolvedJobName: String(row[1] || "").trim(),
      });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    matches.sort((a, b) => Math.abs(a.rowNum - (candidateNum || 0)) - Math.abs(b.rowNum - (candidateNum || 0)));
    return matches[0];
  }

  return null;
}

export async function handleGetRetainerJobs(req, res, sheets) {
  const { clientSheetId, bypassCache, _forceJobsReadMode } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
    const sbCtx = await resolveSupabaseSheetContext({ spreadsheetId: sheetIdClean }).catch(() => null);
    const useRelationalReads =
      _forceJobsReadMode === "relational"
        ? true
        : _forceJobsReadMode === "grid"
          ? false
          : Boolean(sbCtx?.jobsMode === "relational" && sbCtx?.jobsReadMode === "relational");
    const cacheKey = _forceJobsReadMode
      ? `pulse:pma:retainer_jobs:${sheetIdClean}:probe:${_forceJobsReadMode}`
      : `pulse:pma:retainer_jobs:${sheetIdClean}`;

    const result = await resolvePortalCache({
      cacheKey,
      bypassCache: Boolean(bypassCache || _forceJobsReadMode),
      l1TtlSecs: 120,
      redisTtlSecs: _forceJobsReadMode ? 10 : 86400,
      isValidPayload: (c) => c && Array.isArray(c.jobs),
      fetchFreshFn: async () => {
        let rows = [];
        let usedRelationalReadPath = false;
        if (useRelationalReads && sbCtx?.clientId) {
          const relBundle = await preloadClientRelationalJobsBundle(sbCtx, {
            includeConfirmed: true,
            includePipeline: false,
          }).catch(() => null);
          if (relBundle?.tabHeaders?.Confirmed && Object.keys(relBundle.tabHeaders.Confirmed).length > 0) {
            rows = buildRelationalFormattedTabRowsFromBundle(relBundle, "Confirmed", { maxColLimit: 107 }).rows;
            usedRelationalReadPath = true;
          }
        }
        if (!usedRelationalReadPath) {
          const shared = await getSharedClientConfirmedAndKeyInfo(sheets, sheetIdClean, {
            includePipeline: false,
            bypassCache: Boolean(bypassCache),
          });
          rows = shared.confRows || [];
        }
        const retainerJobs = retFindRetainerJobs(rows, { onlyActiveOrRecentlyEnded: false });

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
        const buildRowData = (rowNum, row, isParent) => ({
          rowNum, isParent,
          client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
          revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
          projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
          unevenSplit: colVal(row, 30),
          invoiceSlots: [1, 2, 3].map(n => {
            const base = n === 1 ? 41 : n === 2 ? 48 : 55;
            return {
              slotNum: n, amount: colVal(row, base), ref: colVal(row, base + 1), sentDate: colVal(row, base + 2),
              daysToPay: colVal(row, base + 3), status: colVal(row, base + 4)
            };
          }),
          expenseSlots: [1, 2, 3].map(n => {
            const base = n === 1 ? 75 : n === 2 ? 82 : 89;
            return {
              slotNum: n,
              description: colVal(row, base),
              amount: colVal(row, base + 1),
              vat: colVal(row, base + 2),
              date: colVal(row, base + 3),
              daysToPay: colVal(row, base + 4),
              status: canonicalizeExpenseStatus(colVal(row, base + 5)),
              transactionId: colVal(row, base + 6),
            };
          }),
        });

        const jobs = retainerJobs.map(job => {
          const rawEnd = colVal(job.parentRow, 38);
          const isNoEnd = isNoEndDateSentinel(rawEnd);
          const isCompleted = Boolean(!isNoEnd && job.endDate && job.endDate < todayStart);
          return {
            client: job.client, jobName: job.jobName, projectCode: job.projectCode,
            revenue: job.revenue, vat: job.vat, projectRetainer: job.projectRetainer,
            parentRowNum: job.parentRowNum,
            isCompleted,
            isVariableRetainer: false,
            rows: [buildRowData(job.parentRowNum, job.parentRow, true)]
              .concat(job.childRows.map(cr => buildRowData(cr.rowNum, cr.row, false))),
          };
        });

        const varSeriesList = retFindVariableRetainerSeries(rows);
        for (const series of varSeriesList) {
          const isCompleted = Boolean(!series.noEndDate && series.endDateObj && series.endDateObj < todayStart);
          const firstMonth = series.months[0];
          const monthRows = series.months.map((m) => {
            const baseData = buildRowData(m.rowNum, m.row, true);
            const extraExpSlots = [];
            for (const ov of m.overflowRows) {
              for (let s = 1; s <= 3; s++) {
                const b = s === 1 ? 75 : s === 2 ? 82 : 89;
                const d = colVal(ov.row, b);
                const a = colVal(ov.row, b + 1);
                const tid = colVal(ov.row, b + 6);
                if (d || a || tid) {
                  extraExpSlots.push({
                    rowNum: ov.rowNum,
                    slotNum: s,
                    description: d,
                    amount: a,
                    vat: colVal(ov.row, b + 2),
                    date: colVal(ov.row, b + 3),
                    daysToPay: colVal(ov.row, b + 4),
                    status: canonicalizeExpenseStatus(colVal(ov.row, b + 5)),
                    transactionId: tid,
                  });
                }
              }
            }
            return {
              ...baseData,
              overflowRowNums: m.overflowRows.map(o => o.rowNum),
              isRevOverridden: Boolean(m.vrMeta?.overrideRev),
              isDcOverridden: Boolean(m.vrMeta?.overrideDc),
              varRetainerMeta: m.vrMeta,
              expenseSlots: [
                ...baseData.expenseSlots.map(s => ({ ...s, rowNum: m.rowNum })),
                ...extraExpSlots,
              ],
            };
          });

          jobs.push({
            client: series.client,
            jobName: series.seriesName,
            seriesName: series.seriesName,
            projectCode: series.projectCode,
            revenue: `£${Number(series.baseRev || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            directCosts: `£${Number(series.baseDC || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            baseRevenue: series.baseRev,
            baseDirectCosts: series.baseDC,
            sendDay: series.sendDay,
            startDate: firstMonth ? colVal(firstMonth.row, 37) : "",
            endDate: series.endDate,
            noEndDate: series.noEndDate,
            vat: series.vat,
            projectRetainer: "Retainer",
            parentRowNum: firstMonth ? firstMonth.rowNum : 2,
            isCompleted,
            isVariableRetainer: true,
            rows: monthRows,
          });
        }

        jobs.sort((a, b) => {
          const ca = String(a.client || "").toLowerCase();
          const cb = String(b.client || "").toLowerCase();
          if (ca !== cb) return ca.localeCompare(cb);
          return String(a.jobName || "").toLowerCase().localeCompare(String(b.jobName || "").toLowerCase());
        });

        return { success: true, jobs, jobsReadMode: usedRelationalReadPath ? "relational" : "grid" };
      },
    });

    return res.status(200).json(result.data);
  } catch (err) {
    console.error("❌ get_retainer_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleRenameRetainerJob(req, res, sheets) {
  const { clientSheetId, oldClient, oldJobName, newJobName, parentRowNum } = req.body;
  if (!clientSheetId || !oldJobName || !newJobName || !parentRowNum) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const pRow = parseInt(parentRowNum, 10) || 2;
    const winStart = Math.max(1, pRow - 20);
    const winEnd = pRow + 60;

    // Fast path: read local window (A:AM) around parentRowNum instead of 5000x96 cells
    let rows = [];
    let resolvedParent = null;
    try {
      const winResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `Confirmed!A${winStart}:AM${winEnd}`,
        valueRenderOption: "FORMATTED_VALUE",
      });
      const winVals = winResp.data.values || [];
      const sparseRows = new Array(winStart - 1).fill([]);
      for (let i = 0; i < winVals.length; i++) sparseRows.push(winVals[i]);
      const candidate = resolveRetainerParentRow_(sparseRows, pRow, oldClient, oldJobName);
      if (candidate && candidate.rowNum < winEnd - 2) {
        rows = sparseRows;
        resolvedParent = candidate;
      }
    } catch (_) { }

    if (!resolvedParent) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:AM5000",
        valueRenderOption: "FORMATTED_VALUE",
      });
      rows = resp.data.values || [];
      resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, oldClient, oldJobName);
    }

    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Row mismatch - job may have moved. Please refresh and try again." });
    }
    const effectiveParentRowNum = resolvedParent.rowNum;
    const effectiveOldClient = resolvedParent.resolvedClient;
    const effectiveOldJobName = resolvedParent.resolvedJobName;

    const vrMeta = parseVariableRetainerTag(resolvedParent.row?.[30]);
    if (vrMeta) {
      // Variable retainer series rename: fetch full Confirmed!A1:AM5000 if we only read a window
      if (winStart > 1) {
        const fullResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:AM5000",
          valueRenderOption: "FORMATTED_VALUE",
        });
        rows = fullResp.data.values || [];
      }
      const cleanNewSeries = String(newJobName || "").replace(/[\r\n\t]+/g, " ").replace(/\|/g, "-").trim();
      const targetSeriesLower = (vrMeta.seriesName || effectiveOldJobName).toLowerCase();
      const targetClientLower = effectiveOldClient.toLowerCase();
      const data = [];
      let ri = 1;
      while (ri < rows.length) {
        const row = rows[ri] || [];
        const rc = String(row[0] || "").trim();
        const rj = String(row[1] || "").trim();
        const rMeta = parseVariableRetainerTag(row[30]);
        if (rc.toLowerCase() === targetClientLower && rMeta && (rMeta.seriesName || "").toLowerCase() === targetSeriesLower) {
          const rn = ri + 1;
          const mStart = retParseSheetDate(row[37]);
          const newMonthJobName = mStart ? formatVarRetainerMonthJobName(cleanNewSeries, mStart) : cleanNewSeries;
          const newTag = formatVariableRetainerTag({ ...rMeta, seriesName: cleanNewSeries });
          data.push({ range: `Confirmed!B${rn}`, values: [[sanitizeFormulaInput(newMonthJobName)]] });
          data.push({ range: `Confirmed!AE${rn}`, values: [[newTag]] });

          let cj = ri + 1;
          while (cj < rows.length) {
            const nx = rows[cj] || [];
            if (String(nx[0] || "").trim() === rc && String(nx[1] || "").trim() === rj &&
              !String(nx[32] || "").trim() && !String(nx[37] || "").trim() && !String(nx[35] || "").trim()) {
              data.push({ range: `Confirmed!B${cj + 1}`, values: [[sanitizeFormulaInput(newMonthJobName)]] });
              cj++;
            } else break;
          }
          ri = cj;
        } else {
          ri++;
        }
      }

      if (data.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "USER_ENTERED", data },
        });
      }
      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);
      return res.status(200).json({ success: true, rowsUpdated: data.length, isVariableRetainer: true });
    }

    const targetRows = [effectiveParentRowNum];
    let cj = effectiveParentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === effectiveOldClient && String(next[1] || "").trim() === effectiveOldJobName &&
        !String(next[32] || "").trim() && !String(next[37] || "").trim()) {
        targetRows.push(cj + 1);
        cj++;
      } else break;
    }

    const data = targetRows.map(rn => ({ range: `Confirmed!B${rn}`, values: [[newJobName]] }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      _skipFormulaRecompute: true,
      requestBody: { valueInputOption: "RAW", data },
    });

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);

    (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }
      const endClient = oldClient || "";
      const jobIdentifier = endClient ? `"${endClient} - ${oldJobName}"` : `"${oldJobName}"`;
      const newJobIdentifier = endClient ? `"${endClient} - ${newJobName}"` : `"${newJobName}"`;

      await logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainer Renamed",
        summary: `Renamed retainer ${jobIdentifier} to ${newJobIdentifier}`,
        details: { oldJobName, newJobName, endClient, clientName: tenantClient, rowsUpdated: targetRows.length }
      });
    })().catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, rowsUpdated: targetRows.length });
  } catch (err) {
    console.error("❌ rename_retainer_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function executeChangeRetainerEndDate(sheets, params = {}) {
  let { clientSheetId, masterSheetId, client, jobName, parentRowNum, newEndDate: rawNewEndDate, noEndDate, clientName, automationCommanderSheetId, preloadedTolerances, previousEndDate } = params;
  const newEndDate = (noEndDate || isNoEndDateSentinel(rawNewEndDate)) ? NO_END_DATE_SHEET_VALUE : rawNewEndDate;
  if (!clientSheetId || !jobName || !parentRowNum || !newEndDate) {
    return { success: false, error: "Missing required fields" };
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    // Fetch Confirmed rows, tab metadata (including rowGroups), and tolerance settings in PARALLEL
    const [resp, metaResp, tolerance] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      }),
      preloadedTolerances ? Promise.resolve(preloadedTolerances) : getToleranceValues(sheets, masterSheetId || sheetIdClean),
    ]);

    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return { success: false, error: "Row mismatch - job may have moved." };
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const confirmedSheet = (metaResp.data.sheets || []).find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) {
      return { success: false, error: "Confirmed tab not found" };
    }
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
    const rowGroups = confirmedSheet.rowGroups || [];

    const oldEndDate = previousEndDate !== undefined ? retParseSheetDate(previousEndDate) : retParseSheetDate(parentRow[38]);
    const newEnd = retParseSheetDate(newEndDate);
    if (!newEnd) return { success: false, error: "Invalid new end date" };
    const formattedNewEndDate = retFmtDate(newEnd);
    const displayNewEndDate = formatJobEndDateDisplay(formattedNewEndDate);

    const revenue = retParseMoney(parentRow[32]);
    const vat = parentRow[34];
    const startDate = retParseSheetDate(parentRow[37]);
    if (startDate && !isNoEndDateSentinel(newEndDate) && newEnd.getTime() < startDate.getTime()) {
      return { success: false, error: "End date cannot be earlier than start date." };
    }

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] ?? "").trim() && !String(next[17] ?? "").trim() && !String(next[37] ?? "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean);

    const intervalMonthsForOffset = retDetectIntervalMonths(childDates, parentRow[35]);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(childDates, startDate, intervalMonthsForOffset);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

    const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });
    const endDateCol = isJobCosting ? "G" : "AM";
    const isGrowing = !oldEndDate || newEnd > oldEndDate;

    if (!isGrowing) {
      const newEndVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
      // Anchor to infer scheduled period month if any trailing empty child row has blank AR
      let anchorIdx = -1;
      let anchorPeriodMonthVal = null;
      for (let k = 0; k < childRows.length; k++) {
        const d = retParseSheetDate(childRows[k].row[43]);
        const ref = String(childRows[k].row[42] ?? "").trim();
        if (d && ref && !isPlaceholderInvoice(ref)) {
          anchorIdx = k;
          anchorPeriodMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
          break;
        }
      }
      if (anchorIdx === -1 && !startDate) {
        for (let k = 0; k < childRows.length; k++) {
          const d = retParseSheetDate(childRows[k].row[43]);
          if (d) {
            anchorIdx = k;
            anchorPeriodMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
            break;
          }
        }
      }

      const toTrim = [];
      for (let c = childRows.length - 1; c >= 0; c--) {
        const cr = childRows[c];
        const invDate = retParseSheetDate(cr.row[43]);
        let rowMonthVal = invDate ? (invDate.getFullYear() * 12 + invDate.getMonth() + timingMonthAdjust) : null;
        if (rowMonthVal === null && !retRowHasRealData(cr.row)) {
          if (anchorIdx !== -1 && anchorPeriodMonthVal !== null) {
            rowMonthVal = anchorPeriodMonthVal + (c - anchorIdx) * intervalMonthsForOffset;
          } else if (startDate) {
            rowMonthVal = startDate.getFullYear() * 12 + startDate.getMonth() + c * intervalMonthsForOffset;
          }
        }
        if (rowMonthVal !== null && rowMonthVal > newEndVal) {
          toTrim.push(cr);
        } else {
          break;
        }
      }

      const blockedRow = toTrim.find(cr => retRowHasRealData(cr.row));
      if (blockedRow) {
        return {
          success: false, blocked: true,
          error: `Cannot shorten this retainer - row ${blockedRow.rowNum} already has a real invoice or expense recorded.`,
        };
      }

      if (toTrim.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!${endDateCol}${parentRowNum}`,
          valueInputOption: "USER_ENTERED", _skipFormulaRecompute: true, requestBody: { values: [[sanitizeFormulaInput(formattedNewEndDate)]] },
        });
        await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);
        return { success: true, trimmed: 0, grown: 0, trimmedRowNums: [], addedChildRows: [] };
      }

      const groupTrimCounts = new Map();
      for (const cr of toTrim) {
        const rowIdx0 = cr.rowNum - 1;
        const coveringGroup = rowGroups.find(g => g.range?.startIndex <= rowIdx0 && g.range?.endIndex > rowIdx0);
        if (!coveringGroup) continue;
        const alreadyCounted = groupTrimCounts.get(coveringGroup) || 0;
        if (rowIdx0 === coveringGroup.range.endIndex - 1 - alreadyCounted) {
          groupTrimCounts.set(coveringGroup, alreadyCounted + 1);
        }
      }

      const trimRowNums = toTrim.map(cr => cr.rowNum).sort((a, b) => a - b);

      // Compute trueLastRow in memory skipping trimmed rows (eliminates redundant 5k-row download)
      const trimSet = new Set(trimRowNums);
      let trueLastRow = 0;
      for (let r = rows.length - 1; r >= 0; r--) {
        if (trimSet.has(r + 1)) continue;
        const row = rows[r] || [];
        const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
        const hasRech = Math.abs(retParseMoney(row[17])) > 0.001;
        const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
        const z3 = row.slice(41, 62).some(c => c !== "" && c != null);
        const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
        if (z1 || z2 || z3 || z4 || hasRech) { trueLastRow = r + 1; break; }
      }

      const blockStartIdx0 = trimRowNums[0] - 1;
      const blockEndIdx0 = trimRowNums[trimRowNums.length - 1];
      const trimLen = blockEndIdx0 - blockStartIdx0;

      // 1. Execute ALL structural operations (group adjustment + row move) FIRST in a single API call
      // before any cell values are modified or cleared (avoids waiting on formula recalculations).
      const requests = [];
      for (const [group, trimCount] of groupTrimCounts.entries()) {
        const groupSize = group.range.endIndex - group.range.startIndex;
        requests.push({ deleteDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: group.range.endIndex } } });
        if (trimCount < groupSize) {
          const newEnd = group.range.endIndex - trimCount;
          requests.push({
            addDimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
            },
          });
          if (group.collapsed) {
            requests.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                    depth: group.depth || 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            requests.push({
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
        } else {
          requests.push({
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: group.range.endIndex },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          });
        }
      }
      // Always unhide trimmed rows before moving them to the bottom blank pool
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
      const movedToEnd = blockStartIdx0 <= trueLastRow;
      const destIdx0 = trueLastRow + trimLen;
      if (movedToEnd) {
        requests.push({
          moveDimension: {
            source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
            destinationIndex: destIdx0,
          },
        });
      }
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests },
          _skipFormulaRecompute: true,
        });
      }

      // 2. Clear the trimmed rows (at their post-move positions) and update parent end date
      const clearRowNums = movedToEnd
        ? Array.from({ length: trimLen }, (_, i) => trueLastRow + 1 + i)
        : trimRowNums;
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName: "Confirmed",
        rowNums: clearRowNums,
        isJobCosting,
        includeCopiedCol: false,
      });
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: sheetIdClean,
        requestBody: { ranges: clearRanges },
        _skipFormulaRecompute: true,
      });
      const parentUpdateData = [
        {
          range: `Confirmed!${endDateCol}${parentRowNum}`,
          values: [[sanitizeFormulaInput(formattedNewEndDate)]],
        },
        ...restoreData,
      ];
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: parentUpdateData },
      });

      let tenantClient = clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, automationCommanderSheetId);
      }
      const endClient = client || "";
      const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

      logPmaActivity(sheets, {
        automationCommanderSheetId: automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainer End Date Changed",
        summary: `Shortened end date for ${jobIdentifier} to ${displayNewEndDate} (${trimRowNums.length} rows trimmed)`,
        details: { jobName, newEndDate: displayNewEndDate, endClient, clientName: tenantClient, trimmed: trimRowNums.length, grown: 0 }
      }).catch(e => console.error("PMA log failed:", e));

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);

      return { success: true, trimmed: trimRowNums.length, grown: 0, trimmedRowNums: trimRowNums, addedChildRows: [] };

    } else {
      const intervalMonths = retDetectIntervalMonths(childDates, parentRow[35]) || 1;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
      const pastCount = childDates.filter(d => (d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust) <= currentMonthVal).length;
      const maxFuturePeriods = Math.ceil(18 / intervalMonths);
      const targetCount = pastCount + maxFuturePeriods;

      const durationMonths = startDate ? computeInclusiveRetainerMonths(startDate, newEnd) : 1;
      const effectiveEndVal = isNoEndDateSentinel(newEndDate)
        ? (2050 * 12 + 11)
        : startDate
          ? (startDate.getFullYear() * 12 + startDate.getMonth() + durationMonths - 1)
          : (newEnd.getFullYear() * 12 + newEnd.getMonth());
      const lastChildDate = childDates.length > 0 ? childDates[childDates.length - 1] : null;
      const lastChildVal = lastChildDate
        ? (lastChildDate.getFullYear() * 12 + lastChildDate.getMonth() + timingMonthAdjust)
        : null;
      const alreadyCoversEnd = lastChildVal !== null && lastChildVal >= effectiveEndVal;

      if (childRows.length >= targetCount && alreadyCoversEnd) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!${endDateCol}${parentRowNum}`,
          valueInputOption: "USER_ENTERED", _skipFormulaRecompute: true, requestBody: { values: [[formattedNewEndDate]] },
        });
        await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);
        return { success: true, trimmed: 0, grown: 0, trimmedRowNums: [], addedChildRows: [] };
      }

      const rawDefaultDaysToPay = tolerance?.defaultDaysToPay;
      const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay || "").replace(/[^\d.-]/g, ""), 10) || 30;
      const targetSendDay = (parseInt(tolerance?.retainerInvoiceDay, 10) > 0) ? parseInt(tolerance.retainerInvoiceDay, 10) : 28;
      const sendDay = childDates.length > 0 ? childDates[childDates.length - 1].getDate() : targetSendDay;

      let lastDate;
      if (childDates.length > 0) {
        lastDate = childDates[childDates.length - 1];
      } else {
        const baseStart = startDate || newEnd;
        const prevMonth = new Date(baseStart.getFullYear(), baseStart.getMonth() - intervalMonths, 1);
        const maxDayPrev = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
        lastDate = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), Math.min(sendDay, maxDayPrev));
      }

      const rowsNeeded = Math.max(0, targetCount - childRows.length);
      const newRowDates = [];
      for (let k = 0; k < rowsNeeded; k++) {
        const monthOffset = (k + 1) * intervalMonths;
        const targetMonthFirst = new Date(lastDate.getFullYear(), lastDate.getMonth() + monthOffset, 1);
        const testVal = targetMonthFirst.getFullYear() * 12 + targetMonthFirst.getMonth();
        if ((testVal + timingMonthAdjust) > effectiveEndVal) break;
        const maxDaysInMonth = new Date(targetMonthFirst.getFullYear(), targetMonthFirst.getMonth() + 1, 0).getDate();
        const nextTestDate = new Date(targetMonthFirst.getFullYear(), targetMonthFirst.getMonth(), Math.min(sendDay, maxDaysInMonth));
        newRowDates.push(nextTestDate);
      }
      const perInvoiceAmount = Math.round(revenue * intervalMonths * 100) / 100;

      if (newRowDates.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!${endDateCol}${parentRowNum}`,
          valueInputOption: "USER_ENTERED", _skipFormulaRecompute: true, requestBody: { values: [[formattedNewEndDate]] },
        });
        await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);
        return { success: true, trimmed: 0, grown: 0, trimmedRowNums: [], addedChildRows: [] };
      }

      // Compute trueLastRow in memory from already-fetched rows (no redundant 5000-row read!)
      let trueLastRow = await retFindTrueLastRow(null, null, rows);
      const insertAfterRowNum = childRows.length > 0 ? childRows[childRows.length - 1].rowNum : parentRowNum;

      const structuralRequests = [];
      if ((currentMaxRows - (trueLastRow + 1)) < newRowDates.length) {
        const toAdd = newRowDates.length - (currentMaxRows - (trueLastRow + 1)) + 5;
        structuralRequests.push({
          insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
        });
        currentMaxRows += toAdd;
      }

      if (newRowDates.length > 0 && trueLastRow > insertAfterRowNum) {
        structuralRequests.push({
          moveDimension: {
            source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + newRowDates.length },
            destinationIndex: insertAfterRowNum,
          },
        });
        trueLastRow += newRowDates.length;
      }

      if (structuralRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: structuralRequests },
          _skipFormulaRecompute: true,
        });
      }

      // Update row grouping using rowGroups from the initial parallel fetch BEFORE writing cell data
      // (prevents blocking on Google Sheets formula recalculation)
      try {
        const anchorIdx0 = insertAfterRowNum - 1;
        const coveringGroup = rowGroups.find(g => g.range?.startIndex <= anchorIdx0 && g.range?.endIndex > anchorIdx0);
        const newRangeEnd = insertAfterRowNum + newRowDates.length;
        if (coveringGroup) {
          const groupReqs = [
            {
              deleteDimensionGroup: {
                range: {
                  sheetId: gridSheetId, dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                }
              }
            },
            {
              addDimensionGroup: {
                range: {
                  sheetId: gridSheetId, dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd,
                }
              }
            },
          ];
          if (coveringGroup.collapsed) {
            groupReqs.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                    depth: coveringGroup.depth || 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            groupReqs.push({
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: groupReqs },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [
                {
                  addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd } },
                },
                {
                  updateDimensionGroup: {
                    dimensionGroup: {
                      range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd },
                      depth: 1,
                      collapsed: true,
                    },
                    fields: "collapsed",
                  },
                },
                {
                  updateDimensionProperties: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd },
                    properties: { hiddenByUser: true },
                    fields: "hiddenByUser",
                  },
                },
              ]
            },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for grown retainer rows failed:`, groupErr.message);
      }

      // Consolidate all writes (new child rows + parent end date) into a SINGLE batchUpdate
      const allWrites = [];
      const addedChildRows = [];
      for (let m = 0; m < newRowDates.length; m++) {
        const rn = insertAfterRowNum + 1 + m;
        const formattedSent = retFmtDate(newRowDates[m]);
        allWrites.push(
          { range: `Confirmed!A${rn}`, values: [[sanitizeFormulaInput(String(client || ""))]] },
          { range: `Confirmed!B${rn}`, values: [[sanitizeFormulaInput(String(jobName || ""))]] },
          { range: `Confirmed!AI${rn}`, values: [[sanitizeFormulaInput(String(vat || ""))]] },
          { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] },
          { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
          { range: `Confirmed!AR${rn}`, values: [[formattedSent]] }
        );
        addedChildRows.push(
          buildRetainerUiChildRow_({
            rowNum: rn,
            client,
            jobName,
            vat,
            isJobCosting,
            amount: perInvoiceAmount,
            sentDate: formattedSent,
            daysToPay: defaultDaysToPay,
          })
        );
      }
      allWrites.push({
        range: `Confirmed!${endDateCol}${parentRowNum}`,
        values: [[sanitizeFormulaInput(formattedNewEndDate)]],
      });

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: allWrites },
      });

      let tenantClient = clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, automationCommanderSheetId);
      }
      const endClient = client || "";
      const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

      logPmaActivity(sheets, {
        automationCommanderSheetId: automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainer End Date Changed",
        summary: `Extended end date for ${jobIdentifier} to ${displayNewEndDate} (${newRowDates.length} rows added)`,
        details: { jobName, newEndDate: displayNewEndDate, endClient, clientName: tenantClient, trimmed: 0, grown: newRowDates.length }
      }).catch(e => console.error("PMA log failed:", e));

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);

      return { success: true, trimmed: 0, grown: newRowDates.length, trimmedRowNums: [], addedChildRows };
    }
  } catch (err) {
    console.error("❌ executeChangeRetainerEndDate error:", err);
    return { success: false, error: err.message };
  }
}

export async function handleChangeRetainerEndDate(req, res, sheets) {
  try {
    const result = await executeChangeRetainerEndDate(sheets, {
      ...req.body,
      automationCommanderSheetId: req.body.automationCommanderSheetId
    });
    if (!result.success && !result.blocked) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("❌ change_retainer_end_date error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function executeChangeRetainerStartDate(sheets, params = {}) {
  let {
    clientSheetId, masterSheetId, client, jobName, parentRowNum,
    newStartDate, newEndDate, newMonthlyAmount,
    clientName, automationCommanderSheetId, preloadedTolerances
  } = params;
  if (!clientSheetId || !jobName || !parentRowNum || !newStartDate) {
    return { success: false, error: "Missing required fields" };
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    // Fetch Confirmed rows, tab metadata (including rowGroups), and tolerance settings in PARALLEL
    const [resp, metaResp, tolerance] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      }),
      preloadedTolerances ? Promise.resolve(preloadedTolerances) : getToleranceValues(sheets, masterSheetId || sheetIdClean),
    ]);

    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return { success: false, error: "Row mismatch - job may have moved." };
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const confirmedSheet = (metaResp.data.sheets || []).find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) {
      return { success: false, error: "Confirmed tab not found" };
    }
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
    const rowGroups = confirmedSheet.rowGroups || [];

    const newStart = retParseSheetDate(newStartDate);
    if (!newStart) return { success: false, error: "Invalid new start date" };

    const currentEndDate = retParseSheetDate(parentRow[38]);
    const finalEnd = newEndDate ? retParseSheetDate(newEndDate) : (currentEndDate || new Date(2050, 11, 31));
    if (finalEnd && newStart > finalEnd) {
      return { success: false, error: "Start date cannot be after end date." };
    }
    const formattedFinalEnd = finalEnd ? retFmtDate(finalEnd) : NO_END_DATE_SHEET_VALUE;

    // Find child rows
    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] ?? "").trim() && !String(next[17] ?? "").trim() && !String(next[37] ?? "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }

    // Safety check: ensure NO real invoices or expenses exist on parent or child rows
    const allRows = [{ rowNum: parentRowNum, row: parentRow }].concat(childRows);
    const blockedRow = allRows.find(r => retRowHasRealData(r.row));
    if (blockedRow) {
      return {
        success: false,
        blocked: true,
        error: `Cannot change start date - row ${blockedRow.rowNum} already has a real invoice or expense recorded.`,
      };
    }

    const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });
    const startDateCol = isJobCosting ? "F" : "AL";
    const endDateCol = isJobCosting ? "G" : "AM";
    const revCol = isJobCosting ? "I" : "AG";
    const oldStartDate = retParseSheetDate(parentRow[37]);
    const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean);
    const intervalMonths = retDetectIntervalMonths(childDates, parentRow[35]) || 1;
    const b51TargetDay = parseInt(tolerance?.retainerInvoiceDay, 10) > 0 ? parseInt(tolerance.retainerInvoiceDay, 10) : 28;
    const parsedExplicitDay = parseInt(params?.invoiceSendDay, 10);
    const defaultSendDay = (!isNaN(parsedExplicitDay) && parsedExplicitDay >= 1 && parsedExplicitDay <= 31)
      ? parsedExplicitDay
      : (childDates.length > 0 && (!oldStartDate || childDates[0].getDate() !== oldStartDate.getDate()))
        ? childDates[0].getDate()
        : b51TargetDay;
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(childDates, oldStartDate, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? -1 : (invoiceTimingOffset === "after" ? 1 : 0);

    const revenue = (newMonthlyAmount !== undefined && newMonthlyAmount !== null && newMonthlyAmount !== "")
      ? parseFloat(newMonthlyAmount)
      : retParseMoney(parentRow[32]);
    const perInvoiceAmount = revenue * intervalMonths;
    const vat = parentRow[34];

    const rawDefaultDaysToPay = tolerance?.defaultDaysToPay;
    const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay || "").replace(/[^\d.-]/g, ""), 10) || 30;

    // Calculate target periods (open-ended retainers default to 2050-12-31 and are capped by pastCount + 18m horizon)
    const periodStarts = [];
    let cursor = new Date(newStart.getFullYear(), newStart.getMonth(), 1);
    const hasFiniteEnd = Boolean(finalEnd && !isNoEndDateSentinel(newEndDate || parentRow[38]));
    const endMonthVal = hasFiniteEnd
      ? (newStart.getFullYear() * 12 + newStart.getMonth() + computeInclusiveRetainerMonths(newStart, finalEnd) - 1)
      : (2050 * 12 + 11);
    while (true) {
      const cursorMonthVal = cursor.getFullYear() * 12 + cursor.getMonth();
      if (cursorMonthVal > endMonthVal) break;
      periodStarts.push(new Date(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + intervalMonths, 1);
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
    const pastCount = periodStarts.filter(d => (d.getFullYear() * 12 + d.getMonth()) <= currentMonthVal).length;
    const targetPeriodCount = Math.min(periodStarts.length, pastCount + Math.ceil(18 / intervalMonths));

    const newRowDates = periodStarts.slice(0, targetPeriodCount).map(p => {
      const targetYear = p.getFullYear();
      const targetMonth = p.getMonth() + timingMonthAdjust;
      const maxDays = new Date(targetYear, targetMonth + 1, 0).getDate();
      return new Date(targetYear, targetMonth, Math.min(defaultSendDay, maxDays));
    });

    const targetCount = newRowDates.length;
    const currentCount = childRows.length;
    let trimmedRowNums = [];
    const addedChildRows = [];
    const updatedChildSlots = [];

    if (targetCount < currentCount) {
      // Need to trim excess rows from the end of childRows
      const toTrim = childRows.slice(targetCount);
      const blockedRow = toTrim.find((cr) => retRowHasRealData(cr.row));
      if (blockedRow) {
        return {
          success: false,
          blocked: true,
          error: `Cannot change start date - row ${blockedRow.rowNum} already has a real invoice or expense recorded.`,
        };
      }
      const groupTrimCounts = new Map();
      for (const cr of toTrim) {
        const rowIdx0 = cr.rowNum - 1;
        const coveringGroup = rowGroups.find(g => g.range?.startIndex <= rowIdx0 && g.range?.endIndex > rowIdx0);
        if (!coveringGroup) continue;
        const alreadyCounted = groupTrimCounts.get(coveringGroup) || 0;
        if (rowIdx0 === coveringGroup.range.endIndex - 1 - alreadyCounted) {
          groupTrimCounts.set(coveringGroup, alreadyCounted + 1);
        }
      }

      const trimRowNums = toTrim.map(cr => cr.rowNum).sort((a, b) => a - b);
      trimmedRowNums = trimRowNums;
      const trimSet = new Set(trimRowNums);
      let trueLastRow = 0;
      for (let r = rows.length - 1; r >= 0; r--) {
        if (trimSet.has(r + 1)) continue;
        const row = rows[r] || [];
        const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
        const hasRech = Math.abs(retParseMoney(row[17])) > 0.001;
        const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
        const z3 = row.slice(41, 62).some(c => c !== "" && c != null);
        const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
        if (z1 || z2 || z3 || z4 || hasRech) { trueLastRow = r + 1; break; }
      }

      const blockStartIdx0 = trimRowNums[0] - 1;
      const blockEndIdx0 = trimRowNums[trimRowNums.length - 1];
      const trimLen = blockEndIdx0 - blockStartIdx0;

      // 1. Execute ALL structural operations (group adjustment + unhide + moveDimension) FIRST
      const requests = [];
      for (const [group, trimCount] of groupTrimCounts.entries()) {
        const groupSize = group.range.endIndex - group.range.startIndex;
        requests.push({ deleteDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: group.range.endIndex } } });
        if (trimCount < groupSize) {
          const newEnd = group.range.endIndex - trimCount;
          requests.push({
            addDimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
            },
          });
          if (group.collapsed) {
            requests.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                    depth: group.depth || 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            requests.push({
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: newEnd },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
        } else {
          requests.push({
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: group.range.startIndex, endIndex: group.range.endIndex },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          });
        }
      }
      // Ensure trimmed rows are unhidden before moving them to the bottom pool
      requests.push({
        updateDimensionProperties: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
      const movedToEnd = blockStartIdx0 <= trueLastRow;
      const destIdx0 = trueLastRow + trimLen;
      if (movedToEnd) {
        requests.push({
          moveDimension: {
            source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
            destinationIndex: destIdx0,
          },
        });
      }
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests },
          _skipFormulaRecompute: true,
        });
      }

      // 2. Clear the trimmed rows (at their post-move positions) and update kept child & parent rows SECOND
      const clearRowNums = movedToEnd
        ? Array.from({ length: trimLen }, (_, i) => trueLastRow + 1 + i)
        : trimRowNums;
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName: "Confirmed",
        rowNums: clearRowNums,
        isJobCosting,
        includeCopiedCol: false,
      });
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: sheetIdClean,
        requestBody: { ranges: clearRanges },
        _skipFormulaRecompute: true,
      });

      // Consolidate restoreData + child updates + parent updates into ONE batchUpdate
      const allUpdates = [];
      for (let i = 0; i < targetCount; i++) {
        const rn = childRows[i].rowNum;
        const formattedSent = retFmtDate(newRowDates[i]);
        allUpdates.push(
          { range: `Confirmed!AR${rn}`, values: [[formattedSent]] },
          { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] }
        );
        updatedChildSlots.push({ rowNum: rn, slotNum: 1, amount: String(perInvoiceAmount), sentDate: formattedSent });
      }
      allUpdates.push({ range: `Confirmed!${startDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(String(newStartDate || ""))]] });
      if (newEndDate || !currentEndDate) {
        allUpdates.push({ range: `Confirmed!${endDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(formattedFinalEnd)]] });
      }
      if (newMonthlyAmount !== undefined && newMonthlyAmount !== null && newMonthlyAmount !== "") {
        allUpdates.push({ range: `Confirmed!${revCol}${parentRowNum}`, values: [[revenue]] });
      }
      if (restoreData.length > 0) {
        allUpdates.push(...restoreData);
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: allUpdates },
      });

    } else if (targetCount > currentCount) {
      // Need to add extra child rows
      const rowsNeeded = targetCount - currentCount;
      const insertAfterRowNum = childRows.length > 0 ? childRows[childRows.length - 1].rowNum : parentRowNum;

      let trueLastRow = await retFindTrueLastRow(null, null, rows);

      const structuralRequests = [];
      if ((currentMaxRows - (trueLastRow + 1)) < rowsNeeded) {
        const toAdd = rowsNeeded - (currentMaxRows - (trueLastRow + 1)) + 5;
        structuralRequests.push({
          insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
        });
        currentMaxRows += toAdd;
      }

      if (trueLastRow > insertAfterRowNum) {
        structuralRequests.push({
          moveDimension: {
            source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + rowsNeeded },
            destinationIndex: insertAfterRowNum,
          },
        });
      }

      if (structuralRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: structuralRequests },
          _skipFormulaRecompute: true,
        });
      }

      // Update row grouping using rowGroups from the initial parallel fetch BEFORE writing cell data
      try {
        const anchorIdx0 = insertAfterRowNum - 1;
        const coveringGroup = rowGroups.find(g => g.range?.startIndex <= anchorIdx0 && g.range?.endIndex > anchorIdx0);
        const newRangeEnd = insertAfterRowNum + rowsNeeded;
        if (coveringGroup) {
          const groupReqs = [
            { deleteDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex } } },
            { addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd } } },
          ];
          if (coveringGroup.collapsed) {
            groupReqs.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                    depth: coveringGroup.depth || 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            groupReqs.push({
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: groupReqs },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [
                {
                  addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd } },
                },
                {
                  updateDimensionGroup: {
                    dimensionGroup: {
                      range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd },
                      depth: 1,
                      collapsed: true,
                    },
                    fields: "collapsed",
                  },
                },
                {
                  updateDimensionProperties: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd },
                    properties: { hiddenByUser: true },
                    fields: "hiddenByUser",
                  },
                },
              ]
            },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for grown retainer rows failed:`, groupErr.message);
      }

      // Consolidate child updates AND parent updates into ONE batchUpdate
      const allUpdates = [];
      for (let i = 0; i < currentCount; i++) {
        const rn = childRows[i].rowNum;
        const formattedSent = retFmtDate(newRowDates[i]);
        allUpdates.push(
          { range: `Confirmed!AR${rn}`, values: [[formattedSent]] },
          { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] }
        );
        updatedChildSlots.push({ rowNum: rn, slotNum: 1, amount: String(perInvoiceAmount), sentDate: formattedSent });
      }
      for (let m = 0; m < rowsNeeded; m++) {
        const rn = insertAfterRowNum + 1 + m;
        const dateIdx = currentCount + m;
        const formattedSent = retFmtDate(newRowDates[dateIdx]);
        allUpdates.push(
          { range: `Confirmed!A${rn}`, values: [[sanitizeFormulaInput(String(client || ""))]] },
          { range: `Confirmed!B${rn}`, values: [[sanitizeFormulaInput(String(jobName || ""))]] },
          { range: `Confirmed!AI${rn}`, values: [[sanitizeFormulaInput(String(vat || ""))]] },
          { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] },
          { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
          { range: `Confirmed!AR${rn}`, values: [[formattedSent]] }
        );
        addedChildRows.push(
          buildRetainerUiChildRow_({
            rowNum: rn,
            client,
            jobName,
            vat,
            isJobCosting,
            amount: perInvoiceAmount,
            sentDate: formattedSent,
            daysToPay: defaultDaysToPay,
          })
        );
      }
      allUpdates.push({ range: `Confirmed!${startDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(String(newStartDate || ""))]] });
      if (newEndDate || !currentEndDate) {
        allUpdates.push({ range: `Confirmed!${endDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(formattedFinalEnd)]] });
      }
      if (newMonthlyAmount !== undefined && newMonthlyAmount !== null && newMonthlyAmount !== "") {
        allUpdates.push({ range: `Confirmed!${revCol}${parentRowNum}`, values: [[revenue]] });
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: allUpdates },
      });

    } else {
      // Exactly same number of rows: update dates & amounts in place
      const allUpdates = [];
      for (let i = 0; i < targetCount; i++) {
        const rn = childRows[i].rowNum;
        const formattedSent = retFmtDate(newRowDates[i]);
        allUpdates.push(
          { range: `Confirmed!AR${rn}`, values: [[formattedSent]] },
          { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] }
        );
        updatedChildSlots.push({ rowNum: rn, slotNum: 1, amount: String(perInvoiceAmount), sentDate: formattedSent });
      }
      allUpdates.push({ range: `Confirmed!${startDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(String(newStartDate || ""))]] });
      if (newEndDate || !currentEndDate) {
        allUpdates.push({ range: `Confirmed!${endDateCol}${parentRowNum}`, values: [[sanitizeFormulaInput(formattedFinalEnd)]] });
      }
      if (newMonthlyAmount !== undefined && newMonthlyAmount !== null && newMonthlyAmount !== "") {
        allUpdates.push({ range: `Confirmed!${revCol}${parentRowNum}`, values: [[revenue]] });
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: allUpdates },
      });
    }

    let tenantClient = clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, automationCommanderSheetId);
    }
    const endClient = client || "";
    const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: automationCommanderSheetId,
      clientName: tenantClient,
      category: "RETAINER",
      action: "Retainer Start Date Changed",
      summary: `Changed start date for ${jobIdentifier} to ${newStartDate}`,
      details: { jobName, newStartDate, newEndDate, newMonthlyAmount, endClient, clientName: tenantClient }
    }).catch(e => console.error("PMA log failed:", e));

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);

    return {
      success: true,
      trimmed: Math.max(0, currentCount - targetCount),
      grown: Math.max(0, targetCount - currentCount),
      trimmedRowNums,
      addedChildRows,
      updatedChildSlots,
    };
  } catch (err) {
    console.error("❌ executeChangeRetainerStartDate error:", err);
    return { success: false, error: err.message };
  }
}

export async function handleChangeRetainerStartDate(req, res, sheets) {
  try {
    const result = await executeChangeRetainerStartDate(sheets, {
      ...req.body,
      automationCommanderSheetId: req.body.automationCommanderSheetId
    });
    if (!result.success && !result.blocked) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("❌ change_retainer_start_date error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Evaluates whether "Change send dates" moved the overdue retainer send date(s) strictly into the future.
 */
export function evaluateRetainerSendDatesMovedIntoFuture(updatedSlotsMeta, expectedByDate, todayDate = new Date()) {
  if (!Array.isArray(updatedSlotsMeta) || updatedSlotsMeta.length === 0) {
    return { movedIntoFuture: false, updatedExpectedDate: null };
  }
  const todayStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const todayMs = todayStart.getTime();
  const expDate = expectedByDate ? retParseSheetDate(expectedByDate) : null;

  if (expDate) {
    const expY = expDate.getFullYear();
    const expM = expDate.getMonth();
    const expD = expDate.getDate();

    const matched =
      updatedSlotsMeta.find(
        (s) =>
          s.prevDate &&
          s.prevDate.getFullYear() === expY &&
          s.prevDate.getMonth() === expM &&
          s.prevDate.getDate() === expD
      ) ||
      updatedSlotsMeta.find(
        (s) => s.prevDate && s.prevDate.getFullYear() === expY && s.prevDate.getMonth() === expM
      ) ||
      updatedSlotsMeta.find(
        (s) => s.newDate && s.newDate.getFullYear() === expY && s.newDate.getMonth() === expM
      );

    if (matched) {
      return {
        movedIntoFuture: matched.newDate.getTime() > todayMs,
        updatedExpectedDate: matched.formattedDate || null,
      };
    }
  }

  const overduePrevSlots = updatedSlotsMeta.filter((s) => {
    if (!s.prevDate) return false;
    const prevStart = new Date(s.prevDate.getFullYear(), s.prevDate.getMonth(), s.prevDate.getDate());
    return prevStart.getTime() <= todayMs;
  });
  const targetSlots = overduePrevSlots.length > 0 ? overduePrevSlots : updatedSlotsMeta;

  return {
    movedIntoFuture: targetSlots.length > 0 && targetSlots.every((s) => s.newDate.getTime() > todayMs),
    updatedExpectedDate: targetSlots[0]?.formattedDate || null,
  };
}

export async function handleChangeRetainerSendDates(req, res, sheets) {
  let { clientSheetId, masterSheetId, client, clientName, jobName, parentRowNum, newSendDay, applyTo = "placeholders", expectedByDate } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || newSendDay === undefined || newSendDay === null) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const parsedDay = newSendDay === "end" ? "end" : parseInt(newSendDay, 10);
  if (parsedDay !== "end" && (isNaN(parsedDay) || parsedDay < 1 || parsedDay > 31)) {
    return res.status(400).json({ success: false, error: "Invalid newSendDay: must be between 1 and 31 or 'end'" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:BJ5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Could not find retainer job on Confirmed tab" });
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] ?? "").trim() && !String(next[17] ?? "").trim() && !String(next[37] ?? "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }

    const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean);
    const parentInvDate = retParseSheetDate(parentRow[43]);
    const allInvoiceDates = (parentInvDate ? [parentInvDate] : []).concat(childDates);
    const intervalMonths = retDetectIntervalMonths(allInvoiceDates, parentRow[35]) || 1;

    const jobStartDateForOffset = retParseSheetDate(parentRow[37]);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDateForOffset, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

    // Anchor calculation to reconstruct true scheduled month for child rows
    let anchorChildIdx = -1;
    let anchorMonthVal = null;
    for (let k = 0; k < childRows.length; k++) {
      const d = retParseSheetDate(childRows[k].row[43]);
      const ref = String(childRows[k].row[42] ?? "").trim();
      if (d && ref && !isPlaceholderInvoice(ref)) {
        anchorChildIdx = k;
        anchorMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
        break;
      }
    }
    if (anchorChildIdx === -1 && jobStartDateForOffset && childRows.length > 0) {
      anchorChildIdx = 0;
      anchorMonthVal = jobStartDateForOffset.getFullYear() * 12 + jobStartDateForOffset.getMonth() + timingMonthAdjust;
    }

    const batchData = [];
    const slotUpdates = [];
    const updatedSlotsMeta = [];
    const rowsToProcess = childRows.length > 0 ? childRows : [{ rowNum: parentRowNum, row: parentRow }];

    for (let i = 0; i < rowsToProcess.length; i++) {
      const item = rowsToProcess[i];
      const rNum = item.rowNum;
      const rowArr = item.row;
      const ref1 = String(rowArr[42] ?? "").trim();
      const isPlaceholder = !ref1 || isPlaceholderInvoice(ref1);

      if (applyTo === "placeholders" && !isPlaceholder) {
        continue;
      }

      const prevDate = retParseSheetDate(rowArr[43]);

      // Determine month and year for this slot
      let slotYear, slotMonth0;
      if (anchorChildIdx !== -1 && anchorMonthVal !== null && childRows.length > 0) {
        const childK = i;
        const schedMonthVal = anchorMonthVal + (childK - anchorChildIdx) * intervalMonths;
        slotYear = Math.floor(schedMonthVal / 12);
        slotMonth0 = ((schedMonthVal % 12) + 12) % 12;
      } else {
        const rawDate = prevDate;
        if (rawDate) {
          slotYear = rawDate.getFullYear();
          slotMonth0 = rawDate.getMonth();
        } else if (jobStartDateForOffset) {
          const mVal = jobStartDateForOffset.getFullYear() * 12 + jobStartDateForOffset.getMonth() + i * intervalMonths;
          slotYear = Math.floor(mVal / 12);
          slotMonth0 = ((mVal % 12) + 12) % 12;
        } else {
          continue;
        }
      }

      const maxDaysInMonth = new Date(slotYear, slotMonth0 + 1, 0).getDate();
      const dayToUse = parsedDay === "end" ? maxDaysInMonth : Math.min(parsedDay, maxDaysInMonth);
      const newDate = new Date(slotYear, slotMonth0, dayToUse);
      const formattedDate = retFmtDate(newDate);

      batchData.push({
        range: `Confirmed!AR${rNum}`,
        values: [[formattedDate]]
      });
      slotUpdates.push({
        rowNum: rNum,
        slotNum: 1,
        sentDate: formattedDate,
      });
      updatedSlotsMeta.push({
        rowNum: rNum,
        prevDate,
        newDate,
        formattedDate,
        isPlaceholder,
      });
    }

    if (batchData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
      });
    }

    const { movedIntoFuture, updatedExpectedDate } = evaluateRetainerSendDatesMovedIntoFuture(
      updatedSlotsMeta,
      expectedByDate
    );

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = client || "";
    const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "RETAINER",
      action: "Retainer Send Dates Changed",
      summary: `Changed expected retainer invoice send dates for ${jobIdentifier} to day ${newSendDay} (${batchData.length} rows updated)`,
      details: { jobName, endClient, clientName: tenantClient, newSendDay, applyTo, updatedCount: batchData.length, movedIntoFuture, updatedExpectedDate }
    }).catch(e => console.error("PMA log failed:", e));

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers"]);

    return res.status(200).json({ success: true, updatedCount: batchData.length, slotUpdates, movedIntoFuture, updatedExpectedDate });
  } catch (err) {
    console.error("❌ change_retainer_send_dates error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleChangeRetainerMonthlyAmount(req, res, sheets) {
  let {
    clientSheetId, client, jobName, parentRowNum, changeMonth, changeYear, newMonthlyAmount,
    changeWholeRetainer,
    sourceInvoiceRef, sourceInvoiceSentDate, sourceInvoiceDaysToPay, sourceInvoiceStatus, sourceConfirmedRow,
  } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || !newMonthlyAmount) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  if (!changeWholeRetainer && (changeMonth === undefined || !changeYear)) {
    return res.status(400).json({ success: false, error: "Missing required fields: changeMonth and changeYear" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const [resp, metaResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "FORMATTED_VALUE",
      }),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      }),
    ]);
    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const oldEndDate = retParseSheetDate(parentRow[38]);
    const startDateObj = retParseSheetDate(parentRow[37]);
    const startMonthVal = startDateObj ? (startDateObj.getFullYear() * 12 + startDateObj.getMonth()) : null;
    const changeMonthVal = (changeYear !== undefined && changeMonth !== undefined) ? (changeYear * 12 + changeMonth) : null;

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] || "").trim() && !String(next[37] || "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }

    const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });
    const startDateCol = isJobCosting ? "F" : "AL";
    const endDateCol = isJobCosting ? "G" : "AM";
    const revCol = isJobCosting ? "I" : "AG";
    const isWholeRetainerUpdate = !!changeWholeRetainer || (changeMonthVal !== null && startMonthVal !== null && changeMonthVal <= startMonthVal);

    if (isWholeRetainerUpdate) {
      const allRows = [{ rowNum: parentRowNum, row: parentRow }].concat(childRows);
      const blockedRow = allRows.find(r => retRowHasRealData(r.row));
      if (blockedRow) {
        return res.status(400).json({
          success: false,
          error: `Cannot change the whole retainer monthly amount because row ${blockedRow.rowNum} already has a real invoice or expense recorded. Please select a future month to split.`,
        });
      }

      const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean);
      const intervalMonths = retDetectIntervalMonths(childDates, parentRow[35]) || 1;
      const parsedAmount = parseFloat(newMonthlyAmount);
      const perInvoiceAmount = parsedAmount * intervalMonths;

      const updateData = [
        { range: `Confirmed!${revCol}${parentRowNum}`, values: [[parsedAmount]] },
        ...childRows.map((cr) => {
          const rech1 = retParseMoney(cr.row[46]);
          const grossAmt = Math.round((perInvoiceAmount + rech1) * 100) / 100;
          return {
            range: `Confirmed!AP${cr.rowNum}`,
            values: [[grossAmt]],
          };
        }),
      ];

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "RAW", data: updateData },
      });

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);

      return res.status(200).json({
        success: true,
        updatedInPlace: true,
        rowsUpdated: childRows.length + 1,
      });
    }

    const allRows = [{ rowNum: parentRowNum, row: parentRow, isParent: true }].concat(childRows);
    const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean);
    const parentInvDate = retParseSheetDate(parentRow[43]);
    const allInvoiceDates = (parentInvDate ? [parentInvDate] : []).concat(childDates);
    const intervalMonths = retDetectIntervalMonths(allInvoiceDates, parentRow[35]) || 1;

    const jobStartDateForOffset = retParseSheetDate(parentRow[37]);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDateForOffset, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

    // Anchor calculation to reconstruct true scheduled month for child rows whose send dates were
    // rolled forward to subsequent months (e.g. by updateStaleUnsentInvoices)
    let anchorChildIdx = -1;
    let anchorMonthVal = null;
    for (let k = 0; k < childRows.length; k++) {
      const d = retParseSheetDate(childRows[k].row[43]);
      const ref = String(childRows[k].row[42] || "").trim();
      if (d && ref && !isPlaceholderInvoice(ref)) {
        anchorChildIdx = k;
        anchorMonthVal = d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust;
        break;
      }
    }
    if (anchorChildIdx === -1 && jobStartDateForOffset && childRows.length > 0) {
      anchorChildIdx = 0;
      anchorMonthVal = jobStartDateForOffset.getFullYear() * 12 + jobStartDateForOffset.getMonth() + timingMonthAdjust;
    }

    const datedRows = allRows.map((r, idx) => {
      const rawDate = retParseSheetDate(r.row[43]);
      let rowMonthVal = rawDate ? (rawDate.getFullYear() * 12 + rawDate.getMonth() + timingMonthAdjust) : null;
      if (idx > 0 && anchorChildIdx !== -1 && anchorMonthVal !== null) {
        const childK = idx - 1;
        rowMonthVal = anchorMonthVal + (childK - anchorChildIdx) * intervalMonths;
      }
      return { ...r, invDate: rawDate, rowMonthVal };
    }).filter(r => r.rowMonthVal !== null || r.invDate);

    let matchedRow = null;
    let matchedRowPeriodStartVal = null;
    for (let i = datedRows.length - 1; i >= 0; i--) {
      const rowMonthVal = datedRows[i].rowMonthVal !== null
        ? datedRows[i].rowMonthVal
        : (datedRows[i].invDate.getFullYear() * 12 + datedRows[i].invDate.getMonth() + timingMonthAdjust);
      if (rowMonthVal <= changeMonthVal) { matchedRow = datedRows[i]; matchedRowPeriodStartVal = rowMonthVal; break; }
    }
    if (!matchedRow) return res.status(400).json({ success: false, error: "Could not find a row covering that month" });
    if (matchedRow.isParent) return res.status(400).json({ success: false, error: "Change month falls within parent row" });

    const matchedRowPeriodEndVal = matchedRowPeriodStartVal + intervalMonths - 1;
    if (changeMonthVal > matchedRowPeriodEndVal) {
      return res.status(200).json({ success: false, blocked: true, error: "Requested month doesn't have an invoice row yet." });
    }
    if (intervalMonths > 1 && changeMonthVal !== matchedRowPeriodStartVal) {
      return res.status(200).json({ success: false, blocked: true, error: "Change falls in the middle of an invoicing period." });
    }

    const confirmedSheet = (metaResp.data.sheets || []).find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) {
      return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    }
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
    const currentRowGroups = confirmedSheet.rowGroups || [];

    let trueLastRow = await retFindTrueLastRow(null, null, rows);
    const newParentDestIdx0 = matchedRow.rowNum - 1;
    const newParentRowNum = matchedRow.rowNum;
    const relabelStartRow = matchedRow.rowNum + 1;
    const relabelRows = childRows.filter(cr => cr.rowNum >= matchedRow.rowNum).map(cr => cr.rowNum + 1);

    // 1. Perform ALL structural & grouping changes FIRST (before any cell value writes trigger formula recalculation)
    const structuralRequests = [];
    if ((currentMaxRows - (trueLastRow + 1)) < 1) {
      structuralRequests.push({
        insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
      });
      currentMaxRows += 5;
    }

    const newGroupStart = relabelRows.length > 0 ? relabelRows[0] : null;
    const newGroupEnd = relabelRows.length > 0 ? relabelRows[relabelRows.length - 1] : null;
    const addRequestsAfterMove = [];

    if (newGroupStart !== null) {
      const oldFirstChildRowNum = childRows.length > 0 ? childRows[0].rowNum : parentRowNum;
      const scanStartIdx0 = oldFirstChildRowNum - 1;
      const scanEndIdx0 = (childRows.length > 0 ? childRows[childRows.length - 1].rowNum : parentRowNum);
      const overlappingGroups = currentRowGroups.filter(g =>
        g.range && g.range.startIndex < scanEndIdx0 && g.range.endIndex > scanStartIdx0
      );
      const shouldCollapseSplitGroups = overlappingGroups.length === 0 || overlappingGroups.some(g => g.collapsed);

      for (const g of overlappingGroups) {
        const spansSplitPoint = g.range.startIndex < (newParentRowNum - 1) && g.range.endIndex >= (newParentRowNum - 1);
        if (!spansSplitPoint) continue;
        structuralRequests.push({
          deleteDimensionGroup: {
            range: {
              sheetId: gridSheetId, dimension: "ROWS",
              startIndex: g.range.startIndex, endIndex: g.range.endIndex,
            }
          }
        });
        const keepEnd = Math.min(g.range.endIndex, newParentRowNum - 1);
        if (keepEnd > g.range.startIndex) {
          addRequestsAfterMove.push({
            addDimensionGroup: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: g.range.startIndex, endIndex: keepEnd }
            }
          });
          if (shouldCollapseSplitGroups) {
            addRequestsAfterMove.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: g.range.startIndex, endIndex: keepEnd },
                    depth: g.depth || 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: g.range.startIndex, endIndex: keepEnd },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            addRequestsAfterMove.push({
              updateDimensionProperties: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: g.range.startIndex, endIndex: keepEnd },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
        }
      }
      addRequestsAfterMove.push({
        addDimensionGroup: {
          range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newGroupStart - 1, endIndex: newGroupEnd }
        }
      });
      if (shouldCollapseSplitGroups) {
        addRequestsAfterMove.push(
          {
            updateDimensionGroup: {
              dimensionGroup: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newGroupStart - 1, endIndex: newGroupEnd },
                depth: 1,
                collapsed: true,
              },
              fields: "collapsed",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newGroupStart - 1, endIndex: newGroupEnd },
              properties: { hiddenByUser: true },
              fields: "hiddenByUser",
            },
          }
        );
      } else {
        addRequestsAfterMove.push({
          updateDimensionProperties: {
            range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newGroupStart - 1, endIndex: newGroupEnd },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }
    }

    // Ensure the new parent row moved from the bottom pool is visible
    addRequestsAfterMove.push({
      updateDimensionProperties: {
        range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newParentDestIdx0, endIndex: newParentDestIdx0 + 1 },
        properties: { hiddenByUser: false },
        fields: "hiddenByUser",
      },
    });

    if (trueLastRow > newParentDestIdx0) {
      structuralRequests.push({
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + 1 },
          destinationIndex: newParentDestIdx0,
        },
      });
    }
    structuralRequests.push(...addRequestsAfterMove);

    if (structuralRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: { requests: structuralRequests },
        _skipFormulaRecompute: true,
      });
    }

    // 2. Consolidate ALL cell value updates into a SINGLE batchUpdate call
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const changeMonthLabel = `${months[changeMonth]} ${changeYear}`;
    const suffixPattern = /\s*\(\w{3} \d{4}-\)\s*$/;
    const baseJobName = jobName.replace(suffixPattern, "").trim();
    const newJobName = `${baseJobName} (${changeMonthLabel}-)`;

    const oldJobNewEndDate = new Date(changeYear, changeMonth, 0);
    const newJobStartDate = new Date(changeYear, changeMonth, 1);

    const copiedAE = parentRow.slice(0, 5);
    const copiedAGtoAM = parentRow.slice(32, 39);

    const allWriteData = [
      { range: `Confirmed!${endDateCol}${parentRowNum}`, values: [[retFmtDate(oldJobNewEndDate)]] },
    ];

    for (let i = 0; i < copiedAE.length; i++) {
      const colLetter = ["A", "B", "C", "D", "E"][i];
      const val = (colLetter === "B") ? newJobName : (copiedAE[i] !== undefined ? copiedAE[i] : "");
      allWriteData.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[sanitizeFormulaInput(String(val))]] });
    }
    const agToAmCols = ["AG", "AH", "AI", "AJ", "AK", "AL", "AM"];
    if (isJobCosting) {
      const newEndVal = oldEndDate ? retFmtDate(oldEndDate) : sanitizeFormulaInput(String(copiedAGtoAM[6] || ""));
      const dirCostVal = retParseMoney(copiedAGtoAM[1]);
      allWriteData.push(
        { range: `Confirmed!F${newParentRowNum}`, values: [[retFmtDate(newJobStartDate)]] },
        { range: `Confirmed!G${newParentRowNum}`, values: [[newEndVal]] },
        { range: `Confirmed!I${newParentRowNum}`, values: [[newMonthlyAmount]] },
        { range: `Confirmed!AI${newParentRowNum}`, values: [[sanitizeFormulaInput(String(copiedAGtoAM[2] ?? ""))]] },
        { range: `Confirmed!AJ${newParentRowNum}`, values: [[sanitizeFormulaInput(String(copiedAGtoAM[3] ?? ""))]] },
        { range: `Confirmed!AK${newParentRowNum}`, values: [[sanitizeFormulaInput(String(copiedAGtoAM[4] ?? ""))]] },
      );
      if (dirCostVal > 0) {
        allWriteData.push({ range: `Confirmed!K${newParentRowNum}`, values: [[dirCostVal]] });
      }
      const jcFormulas = getJobCostingRowFormulasLetterMap("Confirmed", newParentRowNum, { hasExplicitContractorCosts: dirCostVal > 0 });
      for (const [fCol, fStr] of Object.entries(jcFormulas)) {
        allWriteData.push({ range: `Confirmed!${fCol}${newParentRowNum}`, values: [[fStr]] });
      }
    } else {
      for (let i = 0; i < agToAmCols.length; i++) {
        const colLetter = agToAmCols[i];
        let val = copiedAGtoAM[i] !== undefined ? copiedAGtoAM[i] : "";
        if (colLetter === "AG") val = newMonthlyAmount;
        else if (colLetter === "AH") val = retParseMoney(val);
        else if (colLetter === "AL") val = retFmtDate(newJobStartDate);
        else if (colLetter === "AM") val = oldEndDate ? retFmtDate(oldEndDate) : sanitizeFormulaInput(String(copiedAGtoAM[i] || ""));
        else val = sanitizeFormulaInput(String(val));
        allWriteData.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[val]] });
      }
    }

    const newPerInvoiceAmount = newMonthlyAmount * (intervalMonths || 1);
    for (const rn of relabelRows) {
      allWriteData.push({ range: `Confirmed!B${rn}`, values: [[sanitizeFormulaInput(newJobName)]] });
      allWriteData.push({ range: `Confirmed!AP${rn}`, values: [[newPerInvoiceAmount]] });
    }

    if (sourceInvoiceRef || sourceInvoiceSentDate) {
      allWriteData.push({ range: `Confirmed!AQ${relabelStartRow}`, values: [[formatInvoiceRefForSheet(String(sourceInvoiceRef || ""))]] });
      const parsedDaysToPay = parseInt(String(sourceInvoiceDaysToPay || "").replace(/[^\d.-]/g, ""), 10);
      allWriteData.push({ range: `Confirmed!AS${relabelStartRow}`, values: [[!isNaN(parsedDaysToPay) && parsedDaysToPay > 0 ? parsedDaysToPay : 30]] });
      allWriteData.push({ range: `Confirmed!AT${relabelStartRow}`, values: [[sanitizeFormulaInput(String(sourceInvoiceStatus || ""))]] });
      if (sourceInvoiceSentDate) {
        const parsedSourceSent = retParseSheetDate(sourceInvoiceSentDate);
        if (parsedSourceSent) allWriteData.push({ range: `Confirmed!AR${relabelStartRow}`, values: [[retFmtDate(parsedSourceSent)]] });
      }
    }

    const clearRanges = [];
    const restoreAfterClear = [];
    if (sourceConfirmedRow) {
      const srcRowNumOriginal = parseInt(sourceConfirmedRow, 10);
      if (srcRowNumOriginal && srcRowNumOriginal > 0) {
        const srcParentRowOriginal = rows[srcRowNumOriginal - 1] || [];
        const srcClient = String(srcParentRowOriginal[0] || "").trim();
        const srcJobName = String(srcParentRowOriginal[1] || "").trim();
        const srcRowsToClearOriginal = [srcRowNumOriginal];
        let srcChildIdx = srcRowNumOriginal;
        while (srcChildIdx < rows.length) {
          const next = rows[srcChildIdx] || [];
          if (String(next[0] || "").trim() === srcClient && String(next[1] || "").trim() === srcJobName &&
            !String(next[32] || "").trim() && !String(next[17] || "").trim() && !String(next[37] || "").trim()) {
            srcRowsToClearOriginal.push(srcChildIdx + 1);
            srcChildIdx++;
          } else break;
        }
        const adjustedRowNums = srcRowsToClearOriginal.map(originalRowNum => {
          const idx0Original = originalRowNum - 1;
          return idx0Original >= newParentDestIdx0 ? originalRowNum + 1 : originalRowNum;
        });
        const plan = buildJobRowClearAndRestorePlan({
          sheetName: "Confirmed",
          rowNums: adjustedRowNums,
          isJobCosting,
          includeCopiedCol: false,
        });
        clearRanges.push(...plan.clearRanges);
        restoreAfterClear.push(...plan.restoreData);
      }
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { valueInputOption: "USER_ENTERED", data: allWriteData },
      _skipFormulaRecompute: true,
    });
    if (clearRanges.length > 0) {
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { ranges: clearRanges },
      });
      if (restoreAfterClear.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "USER_ENTERED", data: restoreAfterClear },
        });
      }
    }

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);

    (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }
      const endClient = client || "";
      const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

      await logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainer Monthly Amount Changed",
        summary: `Changed monthly amount for ${jobIdentifier} to £${newMonthlyAmount}`,
        details: { jobName, newMonthlyAmount, endClient, clientName: tenantClient, changeMonth, changeYear, changeWholeRetainer: !!changeWholeRetainer }
      });
    })().catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, newParentRowNum, newJobName, relabelledRows: relabelRows.length });
  } catch (err) {
    console.error("❌ change_retainer_monthly_amount error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function provisionRetainerChildRows_(sheets, params = {}) {
  const {
    clientSheetId,
    masterSheetId,
    clientName,
    parentRowNum,
    client: paramClient,
    jobName: paramJobName,
    monthlyRevenue: paramRevenue,
    vat: paramVat,
    startDate: paramStartDate,
    endDate: paramEndDate,
    invoiceFrequency = "monthly",
    invoiceIntervalMonths = null,
    invoiceSendDay,
    initialInvoices = [],
    initialExpenses = [],
  } = params;

  if (!clientSheetId) {
    return { success: false, error: "Missing clientSheetId" };
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resolvedMasterId =
      (masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null) ||
      (await resolveMasterSheetIdForClient_(sheets, sheetIdClean, clientName));

    const [resp, metaResp, tolerance] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: sheetIdClean,
          fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
        })
      ),
      getToleranceValues(sheets, resolvedMasterId || sheetIdClean),
    ]);

    const rows = resp.data?.values || [];
    const allMetaSheets = metaResp.data?.sheets || [];
    const confirmedSheet =
      allMetaSheets.find(s => s.properties?.title === "Confirmed") ||
      allMetaSheets.find(s => s.properties?.title === "ConfCalcs");
    if (!confirmedSheet) {
      return { success: false, error: "Confirmed sheet not found" };
    }
    const confirmedTabTitle = confirmedSheet.properties.title;
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
    const existingRowGroups = confirmedSheet.rowGroups || [];

    const fuzzy = str =>
      String(str || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\s+/g, "");

    let actualParentRowNum = parseInt(parentRowNum, 10);
    const targetClientFuzzy = fuzzy(paramClient);
    const targetJobFuzzy = fuzzy(paramJobName);

    const isMatchingParentRow = rowArr => {
      if (!rowArr) return false;
      const rClient = fuzzy(rowArr[0]);
      const rJob = fuzzy(rowArr[1]);
      if (targetJobFuzzy && rJob !== targetJobFuzzy) return false;
      if (targetClientFuzzy && rClient && rClient !== targetClientFuzzy) return false;
      return true;
    };

    if (
      isNaN(actualParentRowNum) ||
      actualParentRowNum < 2 ||
      !isMatchingParentRow(rows[actualParentRowNum - 1])
    ) {
      let foundRow = -1;
      for (let r = rows.length - 1; r >= 1; r--) {
        const rowArr = rows[r] || [];
        const rType = String(rowArr[35] || "").trim().toLowerCase();
        const hasParentAttrs = retParseMoney(rowArr[32]) > 0 || Boolean(rowArr[37]);
        if (rType.includes("retainer") && hasParentAttrs && isMatchingParentRow(rowArr)) {
          foundRow = r + 1;
          break;
        }
      }
      if (foundRow !== -1) {
        actualParentRowNum = foundRow;
      } else if (isNaN(actualParentRowNum) || actualParentRowNum < 2) {
        return { success: false, error: "Could not locate retainer parent row on Confirmed" };
      }
    }

    const parentRow = rows[actualParentRowNum - 1] || [];
    const client = String(paramClient ?? parentRow[0] ?? "").trim();
    const jobName = String(paramJobName ?? parentRow[1] ?? "").trim();
    const monthlyFee = retParseMoney(
      paramRevenue !== undefined && paramRevenue !== "" ? paramRevenue : parentRow[32]
    );
    const vat = String(paramVat || parentRow[34] || "No").trim();

    if (monthlyFee <= 0 || (!client && !jobName)) {
      return { success: false, error: "Invalid retainer monthly fee or missing job identity" };
    }

    let start = retParseSheetDate(paramStartDate || parentRow[37]);
    let wroteFallbackStart = false;
    if (!start) {
      start = retParseSheetDate(parentRow[3]) || new Date();
      wroteFallbackStart = true;
    }

    const rawEnd = paramEndDate !== undefined && paramEndDate !== "" ? paramEndDate : parentRow[38];
    const parsedEnd = retParseSheetDate(rawEnd);
    const wroteFallbackEnd = !parsedEnd || parsedEnd < start || !String(parentRow[38] ?? "").trim();
    const end = parsedEnd && parsedEnd >= start ? parsedEnd : new Date(2050, 11, 31);

    const parentJobFuzzy = fuzzy(jobName);
    const existingChildRows = [];
    const childDates = [];
    let totalInvoiced = 0;

    for (let j = actualParentRowNum; j < rows.length; j++) {
      const nextRow = rows[j] || [];
      if (nextRow[37] || retParseMoney(nextRow[32]) > 0 || retParseMoney(nextRow[17]) > 0) break;
      if (fuzzy(nextRow[1]) === parentJobFuzzy) {
        const cRowNum = j + 1;
        existingChildRows.push({ rowNum: cRowNum, row: nextRow });
        const amt = Math.max(0, retParseMoney(nextRow[41]) - retParseMoney(nextRow[46]));
        totalInvoiced += amt;
        const rowDate = retParseSheetDate(nextRow[43]);
        if (rowDate) {
          childDates.push(rowDate);
        }
      } else {
        break;
      }
    }

    const b51TargetDay =
      parseInt(tolerance?.retainerInvoiceDay, 10) > 0
        ? parseInt(tolerance.retainerInvoiceDay, 10)
        : 28;
    const defaultDaysToPay =
      parseInt(String(tolerance?.defaultDaysToPay || "").replace(/[^\d.-]/g, ""), 10) || 30;

    // Collect any real invoices from parent row slots 1-3 or initialInvoices,
    // and clear parent row invoice slots (AP:BH) so the parent row never holds invoices.
    const realInvoicesToPlace = [];
    const seenInvKeys = new Set();
    const addRealInvoice = inv => {
      if (!inv) return;
      const amt = retParseMoney(inv.amount);
      const ref = String(inv.ref ?? inv.invoiceNo ?? "").trim();
      const status = String(inv.status ?? "").trim();
      const sentRaw = inv.sendDate || inv.sentDate || "";
      if (isPlaceholderInvoice(ref, status)) return;
      if (amt <= 0 && !ref) return;
      const key = `${ref.toLowerCase()}|${amt}|${String(sentRaw).trim()}`;
      if (seenInvKeys.has(key)) return;
      seenInvKeys.add(key);

      let days = defaultDaysToPay;
      const rawDays = inv.days ?? inv.daysToPay;
      if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
        const sDays = String(rawDays).trim();
        if (!/^[0-9]{4}[-/]/.test(sDays) && !/[A-Za-z]{3}/.test(sDays)) {
          const p = parseInt(sDays.replace(/[^\d-]/g, ""), 10);
          if (!isNaN(p) && p >= 0 && p <= 365) days = p;
        }
      }
      const parsedSent = retParseSheetDate(sentRaw);
      const rechNum = Math.round((retParseMoney(inv.ofWhichRechgd) || 0) * 100) / 100;
      realInvoicesToPlace.push({
        amount: amt,
        ref,
        sentDate: parsedSent,
        sentDateFormatted: parsedSent ? retFmtDate(parsedSent) : sanitizeFormulaInput(String(sentRaw || "").trim()),
        daysToPay: days,
        status: canonicalizeInvoiceStatus(status || "Sent") || "Sent",
        ofWhichRechgd: rechNum > 0 ? rechNum : "",
        costMonth: rechNum > 0 ? sanitizeFormulaInput(String(inv.costMonth || "").trim()) : "",
      });
    };

    let parentHasInvoiceData = false;
    for (let c = 41; c <= 61; c++) {
      if (parentRow[c] !== undefined && parentRow[c] !== null && String(parentRow[c]).trim() !== "") {
        parentHasInvoiceData = true;
        break;
      }
    }
    for (const s of RET_INV_SLOTS) {
      const amt = retParseMoney(parentRow[s.amt]);
      const ref = String(parentRow[s.ref] || "").trim();
      const sent = parentRow[s.sent];
      const days = parentRow[s.days];
      const status = String(parentRow[s.status] || "").trim();
      const ofWhichRechgd = parentRow[s.rech];
      const costMonth = String(parentRow[s.costMonth] || "").trim();
      if (amt > 0 || ref) {
        addRealInvoice({ amount: amt, ref, sendDate: sent, days, status, ofWhichRechgd, costMonth });
      }
    }
    if (Array.isArray(initialInvoices)) {
      initialInvoices.forEach(addRealInvoice);
    }

    // Collect any direct expenses from parent row slots 1-3 (BX:CR) or initialExpenses,
    // so multi-row retainers never retain direct costs on the parent row.
    const expensesToPlace = [];
    const seenExpKeys = new Set();
    const addExpense = exp => {
      if (!exp) return;
      const desc = String(exp.desc ?? exp.description ?? "").trim();
      const amt = retParseMoney(exp.amount);
      const recRaw = exp.recDate || exp.date || "";
      const appId = String(exp.appId ?? exp.transactionId ?? "").trim();
      const status = String(exp.status ?? "").trim();
      if (!desc && amt <= 0 && !recRaw && !appId) return;
      const key = `${appId.toLowerCase()}|${desc.toLowerCase()}|${amt}|${String(recRaw).trim()}`;
      if (seenExpKeys.has(key)) return;
      seenExpKeys.add(key);

      let days = defaultDaysToPay;
      const rawDays = exp.days ?? exp.daysToPay;
      if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
        const sDays = String(rawDays).trim();
        if (!/^[0-9]{4}[-/]/.test(sDays) && !/[A-Za-z]{3}/.test(sDays)) {
          const p = parseInt(sDays.replace(/[^\d-]/g, ""), 10);
          if (!isNaN(p) && p >= 0 && p <= 365) days = p;
        }
      }
      const parsedRec = retParseSheetDate(recRaw);
      expensesToPlace.push({
        desc,
        amount: amt,
        vat: String(exp.vat || vat || "No").trim() || "No",
        recDate: parsedRec,
        recDateFormatted: parsedRec ? retFmtDate(parsedRec) : sanitizeFormulaInput(String(recRaw || "").trim()),
        daysToPay: days,
        status: sanitizeFormulaInput(status),
        appId: sanitizeFormulaInput(appId),
      });
    };

    let parentHasExpenseData = false;
    for (let c = 75; c <= 95; c++) {
      if (parentRow[c] !== undefined && parentRow[c] !== null && String(parentRow[c]).trim() !== "") {
        parentHasExpenseData = true;
        break;
      }
    }
    for (const base of [75, 82, 89]) {
      addExpense({
        desc: parentRow[base],
        amount: parentRow[base + 1],
        vat: parentRow[base + 2],
        recDate: parentRow[base + 3],
        days: parentRow[base + 4],
        status: parentRow[base + 5],
        appId: parentRow[base + 6],
      });
    }
    if (Array.isArray(initialExpenses)) {
      initialExpenses.forEach(addExpense);
    }

    const explicitInterval = Number(invoiceIntervalMonths);
    const intervalMonths =
      Number.isFinite(explicitInterval) && explicitInterval >= 1
        ? Math.round(explicitInterval)
        : String(invoiceFrequency || "").toLowerCase() === "quarterly"
          ? 3
          : childDates.length >= 2
            ? retDetectIntervalMonths(childDates)
            : 1;
    const perInvoiceAmount = monthlyFee * intervalMonths;

    const parsedExplicitDay = parseInt(invoiceSendDay, 10);
    const hasExplicitDay =
      !isNaN(parsedExplicitDay) && parsedExplicitDay >= 1 && parsedExplicitDay <= 31;
    const targetDay = hasExplicitDay ? parsedExplicitDay : b51TargetDay;
    const sendDay = hasExplicitDay
      ? parsedExplicitDay
      : childDates.length > 0
        ? childDates[childDates.length - 1].getDate()
        : targetDay;

    let lastDate;
    if (childDates.length > 0) {
      lastDate = childDates[childDates.length - 1];
    } else {
      const anchorMonth = realInvoicesToPlace.find((ri) => ri.sentDate)?.sentDate || start;
      const prevMonth = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth() - intervalMonths, 1);
      const maxDayPrev = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
      lastDate = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), Math.min(sendDay, maxDayPrev));
    }

    // True contract duration strictly governed by inclusive calendar dates
    const isOngoing = !parsedEnd || end.getFullYear() >= 2035;
    const durationMonths = computeInclusiveRetainerMonths(start, end);
    const safeDuration = Math.max(1, durationMonths);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
    const endVal = isOngoing
      ? (2050 * 12 + 11)
      : (start.getFullYear() * 12 + start.getMonth() + safeDuration - 1);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(childDates, start, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

    let pastCount = childDates.filter(
      d => (d.getFullYear() * 12 + d.getMonth() + timingMonthAdjust) <= currentMonthVal
    ).length;
    if (childDates.length === 0) {
      let probeIdx = 1;
      while (true) {
        const probeDate = new Date(
          lastDate.getFullYear(),
          lastDate.getMonth() + probeIdx * intervalMonths,
          1
        );
        const probeVal = probeDate.getFullYear() * 12 + probeDate.getMonth();
        if (probeVal > currentMonthVal || probeVal > endVal) break;
        pastCount++;
        probeIdx++;
      }
    }
    const targetCount = pastCount + Math.ceil(18 / intervalMonths);

    const newRowDates = [];
    const maxToAdd = Math.max(0, targetCount - existingChildRows.length);
    for (let k = 0; k < maxToAdd; k++) {
      const monthOffset = (k + 1) * intervalMonths;
      const targetMonthFirst = new Date(
        lastDate.getFullYear(),
        lastDate.getMonth() + monthOffset,
        1
      );
      const testVal = targetMonthFirst.getFullYear() * 12 + targetMonthFirst.getMonth();
      if ((testVal + timingMonthAdjust) > endVal) break;

      const maxDaysInMonth = new Date(
        targetMonthFirst.getFullYear(),
        targetMonthFirst.getMonth() + 1,
        0
      ).getDate();
      const invDate = new Date(
        targetMonthFirst.getFullYear(),
        targetMonthFirst.getMonth(),
        Math.min(sendDay, maxDaysInMonth)
      );
      newRowDates.push(invDate);
    }

    const rowsToCreate = newRowDates.length;
    if (rowsToCreate === 0 && !parentHasInvoiceData && !parentHasExpenseData && !wroteFallbackStart && !wroteFallbackEnd) {
      return { success: true, parentRowNum: actualParentRowNum, childRowCount: 0 };
    }

    let trueLastRow = await retFindTrueLastRow(null, null, rows);
    const insertAfterRowNum =
      existingChildRows.length > 0
        ? existingChildRows[existingChildRows.length - 1].rowNum
        : actualParentRowNum;
    const isAtBottom = insertAfterRowNum >= trueLastRow;

    if (rowsToCreate > 0) {
      const structuralRequests = [];
      if (isAtBottom) {
        // Parent row is at the bottom of existing data: place child rows directly at insertAfterRowNum + 1 onwards
        const requiredMax = insertAfterRowNum + rowsToCreate + 5;
        if (currentMaxRows < requiredMax) {
          const toAdd = requiredMax - currentMaxRows;
          structuralRequests.push({
            insertDimension: {
              range: {
                sheetId: gridSheetId,
                dimension: "ROWS",
                startIndex: currentMaxRows,
                endIndex: currentMaxRows + toAdd,
              },
              inheritFromBefore: true,
            },
          });
          currentMaxRows += toAdd;
        }
      } else {
        // Parent row is in the middle of existing data: move blank rows from trueLastRow + 2 up to insertAfterRowNum + 1 (1:1 with GAS sheet.moveRows)
        const availableEmpty = currentMaxRows - (trueLastRow + 1);
        if (availableEmpty < rowsToCreate) {
          const toAdd = rowsToCreate - availableEmpty + 5;
          structuralRequests.push({
            insertDimension: {
              range: {
                sheetId: gridSheetId,
                dimension: "ROWS",
                startIndex: currentMaxRows,
                endIndex: currentMaxRows + toAdd,
              },
              inheritFromBefore: true,
            },
          });
          currentMaxRows += toAdd;
        }
        const sourceStartIdx0 = trueLastRow + 1; // 1-based row trueLastRow + 2
        if (sourceStartIdx0 > insertAfterRowNum) {
          structuralRequests.push({
            moveDimension: {
              source: {
                sheetId: gridSheetId,
                dimension: "ROWS",
                startIndex: sourceStartIdx0,
                endIndex: sourceStartIdx0 + rowsToCreate,
              },
              destinationIndex: insertAfterRowNum, // 1-based row insertAfterRowNum + 1
            },
          });
          trueLastRow += rowsToCreate;
        }
      }

      if (structuralRequests.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: structuralRequests },
            _skipFormulaRecompute: true,
          })
        );
      }
    }

    // Match any real invoices (e.g. from create_job_from_invoice or Project->Retainer conversion) to child rows
    const matchedRealInvoicesByChildIdx = new Map();
    if (realInvoicesToPlace.length > 0 && rowsToCreate > 0) {
      for (const realInv of realInvoicesToPlace) {
        let matchedIdx = -1;
        if (realInv.sentDate) {
          const targetYm = realInv.sentDate.getFullYear() * 12 + realInv.sentDate.getMonth();
          matchedIdx = newRowDates.findIndex(
            (d, idx) =>
              !matchedRealInvoicesByChildIdx.has(idx) &&
              d.getFullYear() * 12 + d.getMonth() === targetYm
          );
        }
        if (matchedIdx === -1) {
          matchedIdx = newRowDates.findIndex((_, idx) => !matchedRealInvoicesByChildIdx.has(idx));
        }
        if (matchedIdx !== -1) {
          matchedRealInvoicesByChildIdx.set(matchedIdx, realInv);
        }
      }
    }

    const allWrites = [];
    if (wroteFallbackStart) {
      allWrites.push({
        range: `${confirmedTabTitle}!AL${actualParentRowNum}`,
        values: [[retFmtDate(start)]],
      });
    }
    if (wroteFallbackEnd) {
      allWrites.push({
        range: `${confirmedTabTitle}!AM${actualParentRowNum}`,
        values: [[retFmtDate(end)]],
      });
    }
    if (parentHasInvoiceData) {
      allWrites.push({
        range: `${confirmedTabTitle}!AP${actualParentRowNum}:BJ${actualParentRowNum}`,
        values: [new Array(21).fill("")],
      });
    }
    if (parentHasExpenseData && (rowsToCreate > 0 || existingChildRows.length > 0)) {
      allWrites.push({
        range: `${confirmedTabTitle}!BX${actualParentRowNum}:CR${actualParentRowNum}`,
        values: [new Array(21).fill("")],
      });
    }

    if (rowsToCreate > 0) {
      const startWriteRow = insertAfterRowNum + 1;
      const endWriteRow = startWriteRow + rowsToCreate - 1;
      const safeClientVal = sanitizeFormulaInput(client);
      const safeJobVal = sanitizeFormulaInput(jobName);
      const safeVatVal = sanitizeFormulaInput(vat);

      const abBlock = [];
      const aiBlock = [];
      const invBlock = [];

      for (let m = 0; m < rowsToCreate; m++) {
        abBlock.push([safeClientVal, safeJobVal]);
        aiBlock.push([safeVatVal]);
        const matchedReal = matchedRealInvoicesByChildIdx.get(m);
        if (matchedReal) {
          invBlock.push([
            matchedReal.amount || perInvoiceAmount,
            formatInvoiceRefForSheet(matchedReal.ref),
            matchedReal.sentDateFormatted || retFmtDate(newRowDates[m]),
            matchedReal.daysToPay,
            sanitizeFormulaInput(matchedReal.status),
            matchedReal.ofWhichRechgd || "",
            matchedReal.ofWhichRechgd ? sanitizeFormulaInput(matchedReal.costMonth || "") : "",
          ]);
        } else {
          invBlock.push([
            perInvoiceAmount,
            "",
            retFmtDate(newRowDates[m]),
            defaultDaysToPay,
            "",
            "",
            "",
          ]);
        }
      }

      allWrites.push(
        {
          range: `${confirmedTabTitle}!A${startWriteRow}:B${endWriteRow}`,
          values: abBlock,
        },
        {
          range: `${confirmedTabTitle}!AI${startWriteRow}:AI${endWriteRow}`,
          values: aiBlock,
        },
        {
          range: `${confirmedTabTitle}!AP${startWriteRow}:AV${endWriteRow}`,
          values: invBlock,
        }
      );

      if (expensesToPlace.length > 0) {
        const expSlotsByChild = Array.from({ length: rowsToCreate }, () => []);
        const newRowYms = newRowDates.map(d => d.getFullYear() * 12 + d.getMonth());
        for (const exp of expensesToPlace) {
          const expYm = exp.recDate ? exp.recDate.getFullYear() * 12 + exp.recDate.getMonth() : null;
          let targetIdx = -1;
          if (expYm !== null) {
            targetIdx = newRowYms.findIndex((ym, idx) => ym === expYm && expSlotsByChild[idx].length < 3);
          }
          if (targetIdx === -1 && expYm !== null) {
            let bestDist = Infinity;
            for (let idx = 0; idx < newRowYms.length; idx++) {
              if (expSlotsByChild[idx].length >= 3) continue;
              const dist = Math.abs(newRowYms[idx] - expYm);
              if (dist < bestDist) {
                bestDist = dist;
                targetIdx = idx;
              }
            }
          }
          if (targetIdx === -1) {
            targetIdx = expSlotsByChild.findIndex(arr => arr.length < 3);
          }
          if (targetIdx !== -1) {
            expSlotsByChild[targetIdx].push(exp);
          }
        }

        const hasAnyPlacedExp = expSlotsByChild.some(arr => arr.length > 0);
        if (hasAnyPlacedExp) {
          const expBlock = expSlotsByChild.map(slotList => {
            const row21 = new Array(21).fill("");
            slotList.slice(0, 3).forEach((exp, sIdx) => {
              const off = sIdx * 7;
              row21[off] = sanitizeFormulaInput(exp.desc);
              row21[off + 1] = exp.amount;
              row21[off + 2] = sanitizeFormulaInput(exp.vat);
              row21[off + 3] = exp.recDateFormatted || "";
              row21[off + 4] = exp.daysToPay;
              row21[off + 5] = exp.status;
              row21[off + 6] = exp.appId;
            });
            return row21;
          });
          allWrites.push({
            range: `${confirmedTabTitle}!BX${startWriteRow}:CR${endWriteRow}`,
            values: expBlock,
          });
        }
      }
    }

    if (rowsToCreate > 0) {
      await groupAndCollapseRetainerChildRows_(
        sheets,
        sheetIdClean,
        actualParentRowNum + 1,
        insertAfterRowNum + rowsToCreate,
        confirmedSheet
      );
    }
    if (allWrites.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _deferBackgroundRecompute: true,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: allWrites,
          },
        })
      );
    }

    // Invalidate PMA and Pulse Portal caches once provisioning finishes
    try {
      memoryCache.del(`deleted_job_rows:${sheetIdClean}:confirmed`);
      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, resolvedMasterId, [
        "retainers",
        "jobs",
        "invoices",
        "cash",
      ]);
    } catch (_) { }

    return {
      success: true,
      parentRowNum: actualParentRowNum,
      childRowCount: rowsToCreate,
    };
  } catch (err) {
    console.error("❌ provisionRetainerChildRows_ error:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Pure synchronous in-memory builder that computes the 18-month child-row schedule
 * and range writes for a newly created Confirmed Retainer job placed at the bottom of the sheet.
 * Allows callers (handleAddNewJob, handleCreateRetainerJob, handleCreateJobFromInvoice, confirm-job)
 * to include all child rows in the exact same values.batchUpdate call as the parent row.
 */
export function buildRetainerChildRowsWritePlan({
  parentRowNum,
  client = "",
  jobName = "",
  monthlyRevenue = 0,
  vat = "Yes",
  startDate,
  endDate,
  invoiceFrequency = "monthly",
  invoiceSendDay,
  b51TargetDay = 28,
  defaultDaysToPay = 30,
  initialInvoices = [],
  confirmedTabTitle = "Confirmed",
} = {}) {
  const monthlyFee = retParseMoney(monthlyRevenue);
  if (!parentRowNum || monthlyFee <= 0) {
    return {
      rowsToCreate: 0,
      startWriteRow: (parentRowNum || 0) + 1,
      endWriteRow: parentRowNum || 0,
      writeData: [],
      childRowNums: [],
      childRowsForUi: [],
    };
  }

  const start = retParseSheetDate(startDate) || new Date();
  const parsedEnd = retParseSheetDate(endDate);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : new Date(2050, 11, 31);

  const intervalMonths =
    String(invoiceFrequency || "").toLowerCase() === "quarterly" ? 3 : 1;
  const perInvoiceAmount = monthlyFee * intervalMonths;

  const parsedExplicitDay = parseInt(invoiceSendDay, 10);
  const parsedB51Day = parseInt(b51TargetDay, 10);
  const sendDay =
    !isNaN(parsedExplicitDay) && parsedExplicitDay >= 1 && parsedExplicitDay <= 31
      ? parsedExplicitDay
      : !isNaN(parsedB51Day) && parsedB51Day >= 1 && parsedB51Day <= 31
        ? parsedB51Day
        : 28;

  const parsedDefDays = parseInt(String(defaultDaysToPay ?? "").replace(/[^\d.-]/g, ""), 10);
  const resolvedDefaultDays =
    !isNaN(parsedDefDays) && parsedDefDays >= 0 && parsedDefDays <= 365 ? parsedDefDays : 30;

  const prevMonth = new Date(start.getFullYear(), start.getMonth() - intervalMonths, 1);
  const maxDayPrev = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
  const lastDate = new Date(
    prevMonth.getFullYear(),
    prevMonth.getMonth(),
    Math.min(sendDay, maxDayPrev)
  );

  // True contract duration strictly governed by inclusive calendar dates
  const isOngoing = !parsedEnd || end.getFullYear() >= 2035;
  const durationMonths = computeInclusiveRetainerMonths(start, end);
  const safeDuration = Math.max(1, durationMonths);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
  const endVal = isOngoing
    ? (2050 * 12 + 11)
    : (start.getFullYear() * 12 + start.getMonth() + safeDuration - 1);

  let pastCount = 0;
  let probeIdx = 1;
  while (true) {
    const probeDate = new Date(
      lastDate.getFullYear(),
      lastDate.getMonth() + probeIdx * intervalMonths,
      1
    );
    const probeVal = probeDate.getFullYear() * 12 + probeDate.getMonth();
    if (probeVal > currentMonthVal || probeVal > endVal) break;
    pastCount++;
    probeIdx++;
  }
  const targetCount = pastCount + Math.ceil(18 / intervalMonths);

  const newRowDates = [];
  for (let k = 0; k < targetCount; k++) {
    const monthOffset = (k + 1) * intervalMonths;
    const targetMonthFirst = new Date(
      lastDate.getFullYear(),
      lastDate.getMonth() + monthOffset,
      1
    );
    const testVal = targetMonthFirst.getFullYear() * 12 + targetMonthFirst.getMonth();
    if (testVal > endVal) break;

    const maxDaysInMonth = new Date(
      targetMonthFirst.getFullYear(),
      targetMonthFirst.getMonth() + 1,
      0
    ).getDate();
    const invDate = new Date(
      targetMonthFirst.getFullYear(),
      targetMonthFirst.getMonth(),
      Math.min(sendDay, maxDaysInMonth)
    );
    newRowDates.push(invDate);
  }

  const rowsToCreate = newRowDates.length;
  if (rowsToCreate === 0) {
    return {
      rowsToCreate: 0,
      startWriteRow: parentRowNum + 1,
      endWriteRow: parentRowNum,
      writeData: [],
      childRowNums: [],
      childRowsForUi: [],
    };
  }

  // Match any real invoices (e.g. from create_job_from_invoice or JobsNewJobModal) to child rows
  const realInvoicesToPlace = [];
  const seenInvKeys = new Set();
  if (Array.isArray(initialInvoices)) {
    for (const inv of initialInvoices) {
      if (!inv) continue;
      const amt = retParseMoney(inv.amount);
      const ref = String(inv.ref ?? inv.invoiceNo ?? "").trim();
      const status = String(inv.status ?? "").trim();
      const sentRaw = inv.sendDate || inv.sentDate || "";
      if (isPlaceholderInvoice(ref, status)) continue;
      if (amt <= 0 && !ref) continue;
      const key = `${ref.toLowerCase()}|${amt}|${String(sentRaw).trim()}`;
      if (seenInvKeys.has(key)) continue;
      seenInvKeys.add(key);

      let days = resolvedDefaultDays;
      const rawDays = inv.days ?? inv.daysToPay;
      if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
        const sDays = String(rawDays).trim();
        if (!/^[0-9]{4}[-/]/.test(sDays) && !/[A-Za-z]{3}/.test(sDays)) {
          const p = parseInt(sDays.replace(/[^\d-]/g, ""), 10);
          if (!isNaN(p) && p >= 0 && p <= 365) days = p;
        }
      }
      const parsedSent = retParseSheetDate(sentRaw);
      const rechNum = Math.round((retParseMoney(inv.ofWhichRechgd) || 0) * 100) / 100;
      realInvoicesToPlace.push({
        amount: amt,
        ref,
        sentDate: parsedSent,
        sentDateFormatted: parsedSent ? retFmtDate(parsedSent) : sanitizeFormulaInput(String(sentRaw || "").trim()),
        daysToPay: days,
        status: canonicalizeInvoiceStatus(status || "Sent") || "Sent",
        ofWhichRechgd: rechNum > 0 ? rechNum : "",
        costMonth: rechNum > 0 ? sanitizeFormulaInput(String(inv.costMonth || "").trim()) : "",
      });
    }
  }

  const matchedRealInvoicesByChildIdx = new Map();
  for (const realInv of realInvoicesToPlace) {
    let matchedIdx = -1;
    if (realInv.sentDate) {
      const targetYm = realInv.sentDate.getFullYear() * 12 + realInv.sentDate.getMonth();
      matchedIdx = newRowDates.findIndex(
        (d, idx) =>
          !matchedRealInvoicesByChildIdx.has(idx) &&
          d.getFullYear() * 12 + d.getMonth() === targetYm
      );
    }
    if (matchedIdx === -1) {
      matchedIdx = newRowDates.findIndex((_, idx) => !matchedRealInvoicesByChildIdx.has(idx));
    }
    if (matchedIdx !== -1) {
      matchedRealInvoicesByChildIdx.set(matchedIdx, realInv);
    }
  }

  const startWriteRow = parentRowNum + 1;
  const endWriteRow = startWriteRow + rowsToCreate - 1;
  const safeClientVal = sanitizeFormulaInput(client);
  const safeJobVal = sanitizeFormulaInput(jobName);
  const safeVatVal = sanitizeFormulaInput(vat || "Yes");

  const abBlock = [];
  const aiBlock = [];
  const invBlock = [];
  const childRowNums = [];
  const childRowsForUi = [];

  for (let m = 0; m < rowsToCreate; m++) {
    const rNum = startWriteRow + m;
    childRowNums.push(rNum);
    abBlock.push([safeClientVal, safeJobVal]);
    aiBlock.push([safeVatVal]);

    const matchedReal = matchedRealInvoicesByChildIdx.get(m);
    const rowAmt = matchedReal ? (matchedReal.amount || perInvoiceAmount) : perInvoiceAmount;
    const rowRef = matchedReal ? formatInvoiceRefForSheet(matchedReal.ref) : "";
    const rowSent = matchedReal
      ? (matchedReal.sentDateFormatted || retFmtDate(newRowDates[m]))
      : retFmtDate(newRowDates[m]);
    const rowDays = matchedReal ? matchedReal.daysToPay : resolvedDefaultDays;
    const rowStatus = matchedReal ? sanitizeFormulaInput(matchedReal.status) : "";
    const rowRech = matchedReal && matchedReal.ofWhichRechgd ? matchedReal.ofWhichRechgd : "";
    const rowCm = matchedReal && rowRech ? sanitizeFormulaInput(matchedReal.costMonth || "") : "";

    invBlock.push([rowAmt, rowRef, rowSent, rowDays, rowStatus, rowRech, rowCm]);

    childRowsForUi.push({
      rowNum: rNum,
      isParent: false,
      tabName: confirmedTabTitle,
      note: "",
      client: safeClientVal,
      jobName: safeJobVal,
      projectCode: "",
      dateConf: "",
      leadSrc: "",
      unevenSplit: "",
      revenue: "",
      directCosts: "",
      vat: safeVatVal,
      projectRetainer: "",
      prodLine: "",
      startDate: "",
      endDate: "",
      likelihood: "",
      copiedToConf: null,
      invoiceSlots: [
        {
          slotNum: 1,
          amount: `£${Number(rowAmt || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          invoiceNo: rowRef,
          sentDate: rowSent,
          daysToPay: String(rowDays),
          dueDate: "",
          status: rowStatus,
          ofWhichRechgd: rowRech ? `£${Number(rowRech).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
          costMonth: rowCm,
        },
        { slotNum: 2, amount: "", invoiceNo: "", sentDate: "", daysToPay: "", dueDate: "", status: "", ofWhichRechgd: "", costMonth: "" },
        { slotNum: 3, amount: "", invoiceNo: "", sentDate: "", daysToPay: "", dueDate: "", status: "", ofWhichRechgd: "", costMonth: "" },
      ],
      expenseSlots: [1, 2, 3].map(sNum => ({
        slotNum: sNum,
        description: "",
        amount: "",
        vat: "",
        date: "",
        daysToPay: "",
        status: "",
        transactionId: "",
      })),
    });
  }

  const writeData = [
    {
      range: `${confirmedTabTitle}!A${startWriteRow}:B${endWriteRow}`,
      values: abBlock,
    },
    {
      range: `${confirmedTabTitle}!AI${startWriteRow}:AI${endWriteRow}`,
      values: aiBlock,
    },
    {
      range: `${confirmedTabTitle}!AP${startWriteRow}:AV${endWriteRow}`,
      values: invBlock,
    },
  ];

  return {
    rowsToCreate,
    startWriteRow,
    endWriteRow,
    writeData,
    childRowNums,
    childRowsForUi,
  };
}

/**
 * Groups and collapses retainer child rows [startRowNum1..endRowNum1] in a single batchUpdate call.
 * MUST be called BEFORE values.batchUpdate writes the new retainer rows so the structural
 * spreadsheets.batchUpdate executes while the sheet is idle (<1s) rather than waiting behind
 * Google Sheets' 2-3 minute formula recalculation lock triggered by values.batchUpdate.
 */
export async function groupAndCollapseRetainerChildRows_(
  sheets,
  spreadsheetId,
  startRowNum1,
  endRowNum1,
  confirmedSheetMeta = null
) {
  if (!sheets || !spreadsheetId || !startRowNum1 || !endRowNum1 || endRowNum1 < startRowNum1) {
    return;
  }
  const groupStartIdx0 = startRowNum1 - 1;
  const groupEndIdx0 = endRowNum1;

  const groupTask = (async () => {
    let sheetObj = confirmedSheetMeta;
    if (!sheetObj || sheetObj.properties?.sheetId === undefined) {
      const metaResp = await sheets.spreadsheets.get(
        {
          spreadsheetId,
          fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
        },
        { timeout: 8000, retry: false }
      );
      const allMetaSheets = metaResp.data?.sheets || [];
      sheetObj =
        allMetaSheets.find(s => s.properties?.title === "Confirmed") ||
        allMetaSheets.find(s => s.properties?.title === "ConfCalcs");
    }
    if (!sheetObj || sheetObj.properties?.sheetId === undefined) return;

    const gridSheetId = sheetObj.properties.sheetId;
    const currentMaxRows = sheetObj.properties?.gridProperties?.rowCount || 5000;
    const existingRowGroups = sheetObj.rowGroups || [];
    const overlappingGroups = existingRowGroups.filter(
      g => g.range && g.range.startIndex < groupEndIdx0 && g.range.endIndex > groupStartIdx0
    );

    const groupRequests = [];
    if (currentMaxRows < endRowNum1 + 5) {
      const toAdd = endRowNum1 + 5 - currentMaxRows;
      groupRequests.push({
        insertDimension: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: currentMaxRows,
            endIndex: currentMaxRows + toAdd,
          },
          inheritFromBefore: true,
        },
      });
    }

    for (const g of overlappingGroups) {
      groupRequests.push({
        deleteDimensionGroup: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: g.range.startIndex,
            endIndex: g.range.endIndex,
          },
        },
      });
    }

    if (groupStartIdx0 >= 2) {
      groupRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: groupStartIdx0 - 1,
            endIndex: groupStartIdx0,
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
    }

    groupRequests.push(
      {
        addDimensionGroup: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: groupStartIdx0,
            endIndex: groupEndIdx0,
          },
        },
      },
      {
        updateDimensionGroup: {
          dimensionGroup: {
            range: {
              sheetId: gridSheetId,
              dimension: "ROWS",
              startIndex: groupStartIdx0,
              endIndex: groupEndIdx0,
            },
            depth: 1,
            collapsed: true,
          },
          fields: "collapsed",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: groupStartIdx0,
            endIndex: groupEndIdx0,
          },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      }
    );

    await sheets.spreadsheets.batchUpdate(
      {
        spreadsheetId,
        requestBody: { requests: groupRequests },
      },
      { timeout: 10000, retry: false }
    );
  })();

  let timeoutId = null;
  try {
    await Promise.race([
      groupTask,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Row grouping timed out after 10s")),
          10000
        );
      }),
    ]);
  } catch (groupErr) {
    console.warn("⚠ Row grouping for retainer child rows failed (non-fatal):", groupErr.message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function provisionRetainerScheduleInBackground(sheets, params = {}) {
  const bgPromise = (async () => {
    try {
      const clientInstance = sheets || (await getSheetsClient());
      const res = await provisionRetainerChildRows_(clientInstance, params);
      const flushClient =
        params?.clientName ||
        (await resolveSupabaseSheetContext({ spreadsheetId: params?.clientSheetId || params?.masterSheetId }).catch(() => null))?.clientName ||
        "";
      if (flushClient) {
        await flushImmediateAndScheduleBackgroundClientRecomputes(clientInstance, flushClient).catch(() => { });
      }
      if (params?.clientSheetId || params?.masterSheetId) {
        await invalidatePmaClientCache(
          params.clientSheetId || null,
          params.masterSheetId || null,
          ["jobs", "invoices", "retainers", "cash", "views", "dashboard"]
        ).catch(() => { });
      }
      return res;
    } catch (err) {
      console.error("❌ Retainer schedule provisioning failed:", err);
      return { success: false, error: err.message };
    }
  })();
  if (typeof waitUntil === "function") {
    try {
      waitUntil(bgPromise);
    } catch (_) { }
  }
  return bgPromise;
}

export async function createVariableRetainerSeries_(sheets, params = {}) {
  const {
    clientSheetId,
    masterSheetId,
    clientName = "",
    client = "",
    jobName = "",
    projectCode = "",
    leadSource = "",
    productLine = "",
    baseRevenue = 0,
    baseDirectCosts = 0,
    vat = "Yes",
    startDate,
    endDate,
    noEndDate = false,
    invoiceSendDay = null,
    initialInvoices = [],
    initialExpenses = [],
    setDateConf = true,
  } = params;

  const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
  const start = retParseSheetDate(startDate);
  const hasExplicitEnd = Boolean(endDate && !noEndDate && !isNoEndDateSentinel(endDate));
  const end = hasExplicitEnd ? retParseSheetDate(endDate) : new Date(2050, 11, 31);
  if (!sheetIdClean || !client || !jobName || !start || (hasExplicitEnd && !end) || end < start) {
    return { success: false, error: "Invalid variable retainer parameters or date range" };
  }
  const formattedEnd = retFmtDate(end);
  const revNum = Math.round((parseFloat(String(baseRevenue ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  const dcNum = Math.round((parseFloat(String(baseDirectCosts ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  if (revNum <= 0) {
    return { success: false, error: "Base monthly revenue must be greater than zero" };
  }

  const resolvedMasterId =
    (masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null) ||
    (await resolveMasterSheetIdForClient_(sheets, sheetIdClean, clientName));

  const [metaResp, freshResp, tolerance] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      })
    ),
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "FORMULA",
      })
    ),
    getToleranceValues(sheets, resolvedMasterId || sheetIdClean),
  ]);

  const rows = freshResp.data?.values || [];
  const confirmedSheet = (metaResp.data?.sheets || []).find(s => s.properties?.title === "Confirmed");
  if (!confirmedSheet) return { success: false, error: "Confirmed tab not found" };
  const gridSheetId = confirmedSheet.properties.sheetId;
  const currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
  const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });

  const b51Day = parseInt(tolerance?.retainerInvoiceDay, 10) > 0 ? parseInt(tolerance.retainerInvoiceDay, 10) : 28;
  const parsedDay = parseInt(invoiceSendDay, 10);
  const sendDay = !isNaN(parsedDay) && parsedDay >= 1 && parsedDay <= 31 ? parsedDay : b51Day;
  const parsedDefDays = parseInt(String(tolerance?.defaultDaysToPay ?? "").replace(/[^\d.-]/g, ""), 10);
  const defaultDaysToPay = !isNaN(parsedDefDays) && parsedDefDays >= 0 && parsedDefDays <= 365 ? parsedDefDays : 30;
  const expDay = parseInt(tolerance?.retainerExpenseDay, 10) > 0 ? parseInt(tolerance.retainerExpenseDay, 10) : 28;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
  const endMonthVal = end.getFullYear() * 12 + end.getMonth();
  const startMonthVal = start.getFullYear() * 12 + start.getMonth();

  let pastCount = 0;
  for (let mVal = startMonthVal; mVal <= Math.min(currentMonthVal, endMonthVal); mVal++) {
    pastCount++;
  }
  const targetCount = pastCount + 18;
  const monthEntries = [];
  for (let idx = 0; idx < targetCount; idx++) {
    const mVal = startMonthVal + idx;
    if (mVal > endMonthVal) break;
    const yr = Math.floor(mVal / 12);
    const mo = ((mVal % 12) + 12) % 12;
    monthEntries.push({
      mStart: new Date(yr, mo, 1),
      mEnd: new Date(yr, mo + 1, 0),
    });
  }

  if (monthEntries.length === 0) {
    return { success: false, error: "No months generated in variable retainer date range" };
  }

  const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, rows);
  if (currentMaxRows - (trueLastRow + 1) < monthEntries.length) {
    const toAdd = monthEntries.length - (currentMaxRows - (trueLastRow + 1)) + 5;
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            insertDimension: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd },
              inheritFromBefore: true,
            },
          }],
        },
        _skipFormulaRecompute: true,
      })
    );
  }

  const cleanSeries = String(jobName || "").replace(/[\r\n\t]+/g, " ").replace(/\|/g, "-").trim();
  const aeTag = formatVariableRetainerTag({
    seriesName: cleanSeries,
    baseRev: revNum,
    baseDC: dcNum,
    endDate: formattedEnd,
    noEndDate: Boolean(noEndDate || isNoEndDateSentinel(formattedEnd)),
    sendDay,
  });
  const todayStr = retFmtDate(today);
  const vatClean = sanitizeFormulaInput(vat || "Yes");
  const createdRowNums = [];
  const allWriteData = [];
  const createdRowsForUi = [];

  for (let idx = 0; idx < monthEntries.length; idx++) {
    const rowNum = trueLastRow + 1 + idx;
    createdRowNums.push(rowNum);
    const { mStart, mEnd } = monthEntries[idx];
    const mJobName = formatVarRetainerMonthJobName(cleanSeries, mStart);
    const mStartStr = retFmtDate(mStart);
    const mEndStr = retFmtDate(mEnd);
    const maxDim = mEnd.getDate();
    const invDateStr = retFmtDate(new Date(mStart.getFullYear(), mStart.getMonth(), Math.min(sendDay, maxDim)));
    const expDateStr = retFmtDate(new Date(mStart.getFullYear(), mStart.getMonth(), Math.min(expDay, maxDim)));

    let rowRev = revNum;
    let invWriteList = [];
    if (idx === 0 && Array.isArray(initialInvoices) && initialInvoices.length > 0) {
      invWriteList = initialInvoices.slice(0, 3);
      const realFee = invWriteList.reduce((acc, inv) => {
        const ref = String(inv.ref || inv.invoiceNo || "").trim();
        if (ref && !isPlaceholderInvoice(ref, inv.status)) {
          const amt = parseFloat(String(inv.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
          const rech = parseFloat(String(inv.ofWhichRechgd || "0").replace(/[£$€,\s]/g, "")) || 0;
          return acc + Math.max(0, amt - rech);
        }
        return acc;
      }, 0);
      if (realFee > 0) rowRev = Math.round(realFee * 100) / 100;
    }

    allWriteData.push(
      { range: `Confirmed!A${rowNum}`, values: [[sanitizeFormulaInput(client)]] },
      { range: `Confirmed!B${rowNum}`, values: [[sanitizeFormulaInput(mJobName)]] },
      ...(projectCode ? [{ range: `Confirmed!C${rowNum}`, values: [[sanitizeFormulaInput(projectCode)]] }] : []),
      ...(setDateConf ? [{ range: `Confirmed!D${rowNum}`, values: [[todayStr]] }] : []),
      ...(leadSource ? [{ range: `Confirmed!E${rowNum}`, values: [[sanitizeFormulaInput(leadSource)]] }] : []),
      { range: `Confirmed!AE${rowNum}`, values: [[aeTag]] },
      { range: `Confirmed!AI${rowNum}`, values: [[vatClean]] },
      { range: `Confirmed!AJ${rowNum}`, values: [["Retainer"]] },
      ...(productLine ? [{ range: `Confirmed!AK${rowNum}`, values: [[sanitizeFormulaInput(productLine)]] }] : []),
    );

    if (isJobCosting) {
      allWriteData.push(
        { range: `Confirmed!F${rowNum}`, values: [[mStartStr]] },
        { range: `Confirmed!G${rowNum}`, values: [[mEndStr]] },
        { range: `Confirmed!I${rowNum}`, values: [[rowRev]] },
        ...(dcNum > 0 ? [{ range: `Confirmed!K${rowNum}`, values: [[dcNum]] }] : []),
      );
      const jcMap = getJobCostingRowFormulasLetterMap("Confirmed", rowNum, { hasExplicitContractorCosts: dcNum > 0 });
      for (const [fCol, fStr] of Object.entries(jcMap)) {
        allWriteData.push({ range: `Confirmed!${fCol}${rowNum}`, values: [[fStr]] });
      }
    } else {
      allWriteData.push(
        { range: `Confirmed!AG${rowNum}`, values: [[rowRev]] },
        { range: `Confirmed!AH${rowNum}`, values: [[dcNum]] },
        { range: `Confirmed!AL${rowNum}`, values: [[mStartStr]] },
        { range: `Confirmed!AM${rowNum}`, values: [[mEndStr]] },
      );
    }

    const rowInvoiceSlotsUi = [];
    if (invWriteList.length > 0) {
      invWriteList.forEach((inv, sIdx) => {
        const sNum = sIdx + 1;
        const startCol = sNum === 1 ? "AP" : sNum === 2 ? "AW" : "BD";
        const endCol = sNum === 1 ? "AV" : sNum === 2 ? "BC" : "BJ";
        const amt = parseFloat(String(inv.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        const ref = formatInvoiceRefForSheet(inv.ref || inv.invoiceNo || "");
        const sDate = inv.sentDate || inv.sendDate || invDateStr;
        const dPay = inv.daysToPay ?? inv.days ?? defaultDaysToPay;
        const st = sanitizeFormulaInput(canonicalizeInvoiceStatus(inv.status || "") || "");
        const rech = parseFloat(String(inv.ofWhichRechgd || "0").replace(/[£$€,\s]/g, "")) || 0;
        const cm = rech > 0 ? sanitizeFormulaInput(String(inv.costMonth || "").trim()) : "";
        allWriteData.push({
          range: `Confirmed!${startCol}${rowNum}:${endCol}${rowNum}`,
          values: [[amt, ref, sDate, dPay, st, rech > 0 ? rech : "", cm]],
        });
        rowInvoiceSlotsUi.push({ slotNum: sNum, amount: String(amt), ref, sentDate: String(sDate), daysToPay: String(dPay), status: st, highlighted: false, note: "" });
      });
    } else {
      allWriteData.push({
        range: `Confirmed!AP${rowNum}:AT${rowNum}`,
        values: [[rowRev, "", invDateStr, defaultDaysToPay, ""]],
      });
      rowInvoiceSlotsUi.push({ slotNum: 1, amount: String(rowRev), ref: "", sentDate: invDateStr, daysToPay: String(defaultDaysToPay), status: "", highlighted: false, note: "" });
    }
    while (rowInvoiceSlotsUi.length < 3) {
      rowInvoiceSlotsUi.push({ slotNum: rowInvoiceSlotsUi.length + 1, amount: "", ref: "", sentDate: "", daysToPay: "", status: "", highlighted: false, note: "" });
    }

    const rowExpenseSlotsUi = [];
    if (idx === 0 && Array.isArray(initialExpenses) && initialExpenses.length > 0) {
      initialExpenses.slice(0, 3).forEach((exp, sIdx) => {
        const sNum = sIdx + 1;
        const sCol = sNum === 1 ? "BX" : sNum === 2 ? "CE" : "CL";
        const eCol = sNum === 1 ? "CD" : sNum === 2 ? "CK" : "CR";
        const amt = parseFloat(String(exp.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        const desc = sanitizeFormulaInput(exp.desc || exp.description || "");
        const eVat = sanitizeFormulaInput(exp.vat || vatClean);
        const eDate = exp.recDate || exp.date || expDateStr;
        const eDays = exp.days ?? exp.daysToPay ?? defaultDaysToPay;
        const eSt = sanitizeFormulaInput(canonicalizeExpenseStatus(exp.status || "") || "");
        const eId = sanitizeFormulaInput(exp.appId || exp.transactionId || "");
        allWriteData.push({
          range: `Confirmed!${sCol}${rowNum}:${eCol}${rowNum}`,
          values: [[desc, amt, eVat, eDate, eDays, eSt, eId]],
        });
        rowExpenseSlotsUi.push({ slotNum: sNum, description: desc, amount: String(amt), vat: eVat, date: String(eDate), daysToPay: String(eDays), status: eSt, transactionId: eId, highlighted: false, note: "" });
      });
    } else if (dcNum > 0) {
      const mShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mStart.getMonth()];
      const yShort = String(mStart.getFullYear()).slice(-2);
      const rand4 = Math.floor(1000 + Math.random() * 9000);
      const phId = `PLACE-EXP-${mShort}-${yShort}-${rand4}`;
      allWriteData.push({
        range: `Confirmed!BX${rowNum}:CD${rowNum}`,
        values: [["Placeholder - Direct cost", dcNum, vatClean, expDateStr, defaultDaysToPay, "", phId]],
      });
      rowExpenseSlotsUi.push({ slotNum: 1, description: "Placeholder - Direct cost", amount: String(dcNum), vat: vatClean, date: expDateStr, daysToPay: String(defaultDaysToPay), status: "", transactionId: phId, highlighted: false, note: "" });
    }
    while (rowExpenseSlotsUi.length < 3) {
      rowExpenseSlotsUi.push({ slotNum: rowExpenseSlotsUi.length + 1, description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: "", highlighted: false, note: "" });
    }

    createdRowsForUi.push({
      rowNum,
      isParent: true,
      tabName: "Confirmed",
      isJobCosting,
      note: "",
      client: String(client),
      jobName: mJobName,
      projectCode: String(projectCode || ""),
      dateConf: setDateConf ? todayStr : "",
      leadSrc: String(leadSource || ""),
      unevenSplit: aeTag,
      revenue: `£${rowRev.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      directCosts: `£${dcNum.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      vat: String(vat || "Yes"),
      projectRetainer: "Retainer",
      prodLine: String(productLine || ""),
      startDate: mStartStr,
      endDate: mEndStr,
      likelihood: "100%",
      copiedToConf: null,
      invoiceSlots: rowInvoiceSlotsUi,
      expenseSlots: rowExpenseSlotsUi,
    });
  }

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      _skipFormulaRecompute: true,
      requestBody: { valueInputOption: "USER_ENTERED", data: allWriteData },
    })
  );

  memoryCache.del(`deleted_job_rows:${sheetIdClean}:confirmed`);
  await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, resolvedMasterId, ["retainers", "jobs", "invoices", "outgoings", "cash", "views"]).catch(() => { });

  return {
    success: true,
    isVariableRetainer: true,
    seriesName: cleanSeries,
    firstRowNum: createdRowNums[0],
    lastRowNum: createdRowNums[createdRowNums.length - 1],
    createdRowNums,
    monthCount: createdRowNums.length,
    createdRowsForUi,
    formattedEnd,
  };
}

export async function handleCreateRetainerJob(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, client, jobName, monthlyRevenue, monthlyDirectCosts,
    vat, startDate, endDate, noEndDate, invoiceFrequency = "monthly", invoiceSendDay,
    retainerMode = "fixed",
  } = req.body;
  if (!clientSheetId || !client || !jobName || !monthlyRevenue || !startDate) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    if (String(retainerMode || "").toLowerCase() === "variable") {
      let sendDay = null;
      if (invoiceSendDay !== undefined && invoiceSendDay !== null && String(invoiceSendDay).trim() !== "") {
        sendDay = parseInt(invoiceSendDay, 10);
        if (isNaN(sendDay) || sendDay < 1 || sendDay > 31) {
          return res.status(400).json({ success: false, error: "Invalid invoice send day" });
        }
      }
      const varRes = await createVariableRetainerSeries_(sheets, {
        clientSheetId: sheetIdClean,
        masterSheetId,
        clientName: req.body.clientName || "",
        client,
        jobName,
        baseRevenue: monthlyRevenue,
        baseDirectCosts: monthlyDirectCosts || 0,
        vat: vat || "No",
        startDate,
        endDate,
        noEndDate: Boolean(noEndDate),
        invoiceSendDay: sendDay,
        setDateConf: true,
      });
      if (!varRes.success) {
        return res.status(400).json({ success: false, error: varRes.error || "Failed to create variable retainer" });
      }
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }
      const jobIdentifier = client ? `"${client} - ${varRes.seriesName}"` : `"${varRes.seriesName}"`;
      logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Variable Retainer Created",
        summary: `Created variable retainer ${jobIdentifier} (base £${monthlyRevenue}/month, ${varRes.monthCount} months)`,
        details: {
          jobName: varRes.seriesName,
          endClient: client,
          clientName: tenantClient,
          monthlyRevenue,
          monthlyDirectCosts,
          startDate,
          endDate: formatJobEndDateDisplay(varRes.formattedEnd),
          monthCount: varRes.monthCount,
        },
      }).catch(e => console.error("PMA log failed:", e));

      const sessionUser = getSessionUser(req);
      const isAdminUser = !sessionUser?.isReadOnly && Boolean(sessionUser?.isAdmin || sessionUser?.role === "Admin");
      return res.status(200).json({
        success: true,
        isVariableRetainer: true,
        ...(isAdminUser ? { parentRowNum: varRes.firstRowNum } : {}),
        childRowCount: varRes.monthCount,
        backgroundProvisioning: false,
      });
    }
    const start = retParseSheetDate(startDate);
    const hasExplicitEnd = Boolean(endDate && !noEndDate && !isNoEndDateSentinel(endDate));
    const end = hasExplicitEnd ? retParseSheetDate(endDate) : new Date(2050, 11, 31);
    if (!start || (hasExplicitEnd && !end)) return res.status(400).json({ success: false, error: "Invalid start or end date" });
    if (end && end < start) return res.status(400).json({ success: false, error: "End date can't be before start date" });
    const formattedEnd = retFmtDate(end);

    let sendDay = null;
    if (invoiceSendDay !== undefined && invoiceSendDay !== null && String(invoiceSendDay).trim() !== "") {
      sendDay = parseInt(invoiceSendDay, 10);
      if (isNaN(sendDay) || sendDay < 1 || sendDay > 31) {
        return res.status(400).json({ success: false, error: "Invalid invoice send day" });
      }
    }

    const revenue = parseFloat(monthlyRevenue) || 0;
    const directCosts = parseFloat(monthlyDirectCosts) || 0;
    const resolvedMasterId =
      (masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null) ||
      (await resolveMasterSheetIdForClient_(sheets, sheetIdClean, req.body.clientName || ""));

    const [metaResp, freshResp, tolerance] = await Promise.all([
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "FORMULA",
      }),
      getToleranceValues(sheets, resolvedMasterId || sheetIdClean),
    ]);
    const confirmedSheet = (metaResp.data?.sheets || []).find(s => s.properties?.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });

    const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data?.values || []);
    const newParentRowNum = trueLastRow + 1;

    const retainerPlan = buildRetainerChildRowsWritePlan({
      parentRowNum: newParentRowNum,
      client,
      jobName,
      monthlyRevenue: revenue,
      vat: vat || "No",
      startDate: retFmtDate(start),
      endDate: formattedEnd,
      invoiceFrequency,
      invoiceSendDay: sendDay,
      b51TargetDay: tolerance?.retainerInvoiceDay || 28,
      defaultDaysToPay: tolerance?.defaultDaysToPay || 30,
    });

    const allWriteData = [
      { range: `Confirmed!A${newParentRowNum}`, values: [[sanitizeFormulaInput(client)]] },
      { range: `Confirmed!B${newParentRowNum}`, values: [[sanitizeFormulaInput(jobName)]] },
      { range: `Confirmed!D${newParentRowNum}`, values: [[retFmtDate(new Date())]] },
      { range: `Confirmed!AG${newParentRowNum}`, values: [[revenue]] },
      { range: `Confirmed!AH${newParentRowNum}`, values: [[directCosts]] },
      { range: `Confirmed!AI${newParentRowNum}`, values: [[sanitizeFormulaInput(vat || "No")]] },
      { range: `Confirmed!AJ${newParentRowNum}`, values: [["Retainer"]] },
      { range: `Confirmed!AL${newParentRowNum}`, values: [[retFmtDate(start)]] },
      { range: `Confirmed!AM${newParentRowNum}`, values: [[formattedEnd]] },
      ...retainerPlan.writeData,
    ];

    if (retainerPlan.rowsToCreate > 0) {
      await groupAndCollapseRetainerChildRows_(
        sheets,
        sheetIdClean,
        retainerPlan.startWriteRow,
        retainerPlan.endWriteRow,
        confirmedSheet
      );
    }
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: allWriteData },
      })
    );

    memoryCache.del(`deleted_job_rows:${sheetIdClean}:confirmed`);
    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, resolvedMasterId, ["retainers", "jobs", "invoices", "cash"]);

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = client || "";
    const jobIdentifier = endClient ? `"${endClient} - ${jobName}"` : `"${jobName}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "RETAINER",
      action: "Retainer Created",
      summary: `Created new retainer ${jobIdentifier} at £${monthlyRevenue}/month (${retainerPlan.rowsToCreate} child rows)`,
      details: { jobName, endClient, clientName: tenantClient, monthlyRevenue, monthlyDirectCosts, startDate, endDate: formatJobEndDateDisplay(formattedEnd), invoiceFrequency, childRowCount: retainerPlan.rowsToCreate }
    }).catch(e => console.error("PMA log failed:", e));

    const sessionUser = getSessionUser(req);
    const isAdminUser = !sessionUser?.isReadOnly && Boolean(sessionUser?.isAdmin || sessionUser?.role === "Admin");
    return res.status(200).json({
      success: true,
      ...(isAdminUser ? { parentRowNum: newParentRowNum } : {}),
      childRowCount: retainerPlan.rowsToCreate,
      backgroundProvisioning: false,
    });
  } catch (err) {
    console.error("❌ create_retainer_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleTidyUpRetainers(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  const isAdmin = !sessionUser?.isReadOnly && !!(sessionUser?.isAdmin || sessionUser?.role === "Admin");
  if (!isAdmin) {
    return res.status(403).json({ success: false, error: "Forbidden: Tidy up retainers is an Admin-only function" });
  }

  const { clientSheetId, masterSheetId } = req.body;
  if (!clientSheetId || !masterSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId or masterSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const masterIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

    const allLocks = await checkAllGASLocks(sheets, masterIdClean);
    if (allLocks.invoice.locked) return res.status(400).json({ success: false, error: allLocks.invoice.message });
    if (allLocks.expense.locked) return res.status(400).json({ success: false, error: allLocks.expense.message });
    if (allLocks.crm.locked) return res.status(400).json({ success: false, error: allLocks.crm.message });

    const metaResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      ranges: ["Confirmed!A1:A5000"],
      fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,data.rowMetadata.hiddenByUser)",
    });
    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
    const rowMeta = confirmedSheet.data?.[0]?.rowMetadata || [];

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR" + currentMaxRows,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const allRows = resp.data.values || [];

    let trueLastRow = 0;
    for (let r = allRows.length - 1; r >= 0; r--) {
      const row = allRows[r] || [];
      const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
      const hasRech = Math.abs(retParseMoney(row[17])) > 0.001;
      const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
      const z3 = row.slice(41, 62).some(c => c !== "" && c != null);
      const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
      if (z1 || z2 || z3 || z4 || hasRech) { trueLastRow = r + 1; break; }
    }

    if (currentMaxRows - trueLastRow < 4) {
      const toAdd = 4 - (currentMaxRows - trueLastRow) + 5;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true }
          }]
        }
      });
      currentMaxRows += toAdd;
    }

    // Skip Row 1 (headers), Row 2 (hidden template row), and any deliberate contiguous block
    // of hidden historical rows at the very top of Confirmed (Rows 3..N) so they are never moved or disturbed.
    let startScanIdx = 2;
    while (startScanIdx < trueLastRow && rowMeta[startScanIdx]?.hiddenByUser) {
      startScanIdx++;
    }
    if (startScanIdx > 2 && startScanIdx < trueLastRow) {
      const prevRow = allRows[startScanIdx - 1] || [];
      const prevClient = String(prevRow[0] || "").trim();
      const prevJob = String(prevRow[1] || "").trim();
      while (startScanIdx < trueLastRow) {
        const curRow = allRows[startScanIdx] || [];
        const curClient = String(curRow[0] || "").trim();
        const curJob = String(curRow[1] || "").trim();
        if (prevClient && curClient === prevClient && curJob === prevJob && !curRow[32] && !curRow[37]) {
          startScanIdx++;
        } else {
          break;
        }
      }
    }

    const blocks = [];
    let r = startScanIdx;
    let blockId = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const parseDateLocal = (val) => {
      if (!val) return null;
      if (typeof val === "number") return new Date((val - 25569) * 86400 * 1000);
      const s = String(val).trim();
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (m) {
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        return new Date(yr, months[m[2].toLowerCase()], parseInt(m[1], 10));
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };

    while (r < trueLastRow) {
      const row = allRows[r] || [];
      const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
      const hasRech = Math.abs(retParseMoney(row[17])) > 0.001;
      const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
      const z3 = row.slice(41, 62).some(c => c !== "" && c != null);
      const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
      const hasData = z1 || z2 || z3 || z4 || hasRech;

      if (!hasData) {
        blocks.push({ id: `b_${blockId++}`, type: "Blank", size: 1, originalStartIdx: r });
        r++;
        continue;
      }

      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const revenue = row[32];
      const projType = String(row[35] || "").toLowerCase();
      const startVal = row[37];

      if (revenue || startVal) {
        const isRetainer = projType.includes("retainer");
        const vrMeta = isRetainer ? parseVariableRetainerTag(row[30]) : null;
        const seriesEndDt = vrMeta && !vrMeta.noEndDate ? parseDateLocal(vrMeta.endDate) : null;
        const endDate = parseDateLocal(row[38]);
        const isFinished = vrMeta
          ? Boolean(!vrMeta.noEndDate && seriesEndDt && seriesEndDt < today)
          : Boolean(endDate && endDate < today);
        const startDt = parseDateLocal(row[37]);

        let cj = r + 1;
        while (cj < trueLastRow) {
          const next = allRows[cj] || [];
          const nc = String(next[0] || "").trim();
          const nj = String(next[1] || "").trim();
          if (nc === client && nj === jobName && !next[32] && !next[37]) {
            cj++;
          } else break;
        }

        blocks.push({
          id: `b_${blockId++}`,
          type: isRetainer ? "Retainer" : "Project",
          isFinished,
          client,
          jobName,
          varSeriesKey: vrMeta ? vrMeta.seriesName.toLowerCase() : "",
          sortStartMs: startDt ? startDt.getTime() : 0,
          size: cj - r,
          originalStartIdx: r
        });
        r = cj;
      } else {
        blocks.push({ id: `b_${blockId++}`, type: "Project", size: 1, originalStartIdx: r, client, jobName });
        r++;
      }
    }

    const clusters = [];
    let currentCluster = null;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === "Project") {
        if (currentCluster) { clusters.push(currentCluster); currentCluster = null; }
      } else if (b.type === "Retainer" || b.type === "Blank") {
        if (!currentCluster) currentCluster = { startIdx: i, active: 0, finished: 0 };
        if (b.type === "Retainer") {
          if (b.isFinished) currentCluster.finished++;
          else currentCluster.active++;
        }
      }
    }
    if (currentCluster) clusters.push(currentCluster);

    let maxFin = 0, finCluster = null;
    let maxAct = 0, actCluster = null;

    for (const c of clusters) {
      if (c.finished > maxFin) { maxFin = c.finished; finCluster = c; }
      if (c.active > maxAct) { maxAct = c.active; actCluster = c; }
    }

    const baseBlocks = blocks.filter(b => b.type !== "Retainer");

    const getAnchorBlock = (cluster) => {
      if (!cluster) return null;
      for (let i = cluster.startIdx - 1; i >= 0; i--) {
        if (blocks[i].type === "Project") return blocks[i];
      }
      return null;
    };

    const getInsertIndex = (cluster) => {
      const anchor = getAnchorBlock(cluster);
      if (!anchor) return 0;
      const idx = baseBlocks.findIndex(b => b.id === anchor.id);
      return idx === -1 ? 0 : idx + 1;
    };

    const spacers = [
      { id: `b_${blockId++}`, type: "Blank", size: 1, originalStartIdx: trueLastRow },
      { id: `b_${blockId++}`, type: "Blank", size: 1, originalStartIdx: trueLastRow + 1 },
      { id: `b_${blockId++}`, type: "Blank", size: 1, originalStartIdx: trueLastRow + 2 },
      { id: `b_${blockId++}`, type: "Blank", size: 1, originalStartIdx: trueLastRow + 3 }
    ];

    const initialSheetState = [...blocks, ...spacers];

    const finishedRetainers = blocks.filter(b => b.type === "Retainer" && b.isFinished);
    const activeRetainers = blocks.filter(b => b.type === "Retainer" && !b.isFinished);

    const sortRetainers = (a, b) => {
      const cA = a.client.toLowerCase();
      const cB = b.client.toLowerCase();
      if (cA < cB) return -1;
      if (cA > cB) return 1;
      if (a.varSeriesKey && b.varSeriesKey && a.varSeriesKey === b.varSeriesKey) {
        return (a.sortStartMs || 0) - (b.sortStartMs || 0);
      }
      const keyA = (a.varSeriesKey || a.jobName).toLowerCase();
      const keyB = (b.varSeriesKey || b.jobName).toLowerCase();
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      const jA = a.jobName.toLowerCase();
      const jB = b.jobName.toLowerCase();
      if (jA < jB) return -1;
      if (jA > jB) return 1;
      return 0;
    };
    finishedRetainers.sort(sortRetainers);
    activeRetainers.sort(sortRetainers);

    const filteredBaseBlocks = [];
    const extraneousBlanks = [];
    const nonRetainers = blocks.filter(b => b.type !== "Retainer");
    let consecutiveBlanks = 0;

    for (const b of nonRetainers) {
      if (b.type === "Blank") {
        consecutiveBlanks++;
        if (consecutiveBlanks > 2) {
          extraneousBlanks.push(b);
        } else {
          filteredBaseBlocks.push(b);
        }
      } else {
        consecutiveBlanks = 0;
        filteredBaseBlocks.push(b);
      }
    }

    let currentState = [...initialSheetState];
    const blockSizes = {};
    for (const b of currentState) blockSizes[b.id] = b.size;

    const getAbsoluteIndex = (state, index) => {
      let sum = startScanIdx;
      for (let i = 0; i < index; i++) sum += blockSizes[state[i].id];
      return sum;
    };

    const moveRequests = [];

    // Phase 1: Move contiguous runs of extraneous blanks (> 2 consecutive) to the end of the sheet.
    // Moving from bottom-to-top ensures that moving lower rows does not alter row coordinates of runs above them.
    const extraneousSet = new Set(extraneousBlanks.map(b => b.id));
    const runs = [];
    let currentRun = null;
    for (let i = 0; i < currentState.length; i++) {
      if (extraneousSet.has(currentState[i].id)) {
        if (!currentRun) currentRun = { startIdx: i, count: 1 };
        else currentRun.count++;
      } else {
        if (currentRun) { runs.push(currentRun); currentRun = null; }
      }
    }
    if (currentRun) runs.push(currentRun);

    for (let r = runs.length - 1; r >= 0; r--) {
      const run = runs[r];
      let runSize = 0;
      for (let k = 0; k < run.count; k++) runSize += blockSizes[currentState[run.startIdx + k].id];
      const startIndex = getAbsoluteIndex(currentState, run.startIdx);
      const endIndex = startIndex + runSize;
      const destinationIndex = getAbsoluteIndex(currentState, currentState.length);

      moveRequests.push({
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex, endIndex },
          destinationIndex
        }
      });

      const removed = currentState.splice(run.startIdx, run.count);
      currentState.push(...removed);
    }

    // Helper: Relocates a specific block in Google Sheets and currentState to sit immediately after prevBlockId
    const placeBlockAfter = (item, prevBlockId) => {
      const currIdx = currentState.findIndex(b => b.id === item.id);
      if (currIdx === -1) return;

      if (!prevBlockId) {
        if (currIdx === 0) return;
        const startIndex = getAbsoluteIndex(currentState, currIdx);
        const endIndex = startIndex + blockSizes[item.id];
        const destinationIndex = getAbsoluteIndex(currentState, 0);

        moveRequests.push({
          moveDimension: {
            source: { sheetId: gridSheetId, dimension: "ROWS", startIndex, endIndex },
            destinationIndex
          }
        });

        const [moved] = currentState.splice(currIdx, 1);
        currentState.unshift(moved);
        return;
      }

      const prevIdx = currentState.findIndex(b => b.id === prevBlockId);
      if (prevIdx === -1 || currIdx === prevIdx + 1) return; // already in place

      const startIndex = getAbsoluteIndex(currentState, currIdx);
      const endIndex = startIndex + blockSizes[item.id];

      let destinationIndex;
      let insertAt;

      if (currIdx > prevIdx) {
        // Moving upward: target is prevIdx + 1
        const targetIdx = prevIdx + 1;
        destinationIndex = getAbsoluteIndex(currentState, targetIdx);
        insertAt = targetIdx;
      } else {
        // Moving downward: insert after prevIdx
        const targetIdx = prevIdx + 1;
        destinationIndex = targetIdx < currentState.length
          ? getAbsoluteIndex(currentState, targetIdx)
          : getAbsoluteIndex(currentState, currentState.length);
        insertAt = prevIdx; // removing item at currIdx < prevIdx shifts prevIdx left by 1
      }

      moveRequests.push({
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex, endIndex },
          destinationIndex
        }
      });

      const [moved] = currentState.splice(currIdx, 1);
      currentState.splice(insertAt, 0, moved);
    };

    // Phase 2: Relocate finished retainers cluster (bracketed by spacers[0] and spacers[1])
    if (finishedRetainers.length > 0) {
      const finAnchor = getAnchorBlock(finCluster);
      let lastFinId = finAnchor ? finAnchor.id : null;
      const finishedClusterItems = [spacers[0], ...finishedRetainers, spacers[1]];
      for (const item of finishedClusterItems) {
        placeBlockAfter(item, lastFinId);
        lastFinId = item.id;
      }
    }

    // Phase 3: Relocate active retainers cluster (bracketed by spacers[2] and spacers[3])
    if (activeRetainers.length > 0) {
      let actAnchor;
      if (actCluster && actCluster !== finCluster) {
        actAnchor = getAnchorBlock(actCluster);
      } else {
        actAnchor = finishedRetainers.length > 0 ? spacers[1] : (getAnchorBlock(finCluster) || null);
      }

      let lastActId = actAnchor ? actAnchor.id : null;
      const activeClusterItems = [spacers[2], ...activeRetainers, spacers[3]];
      for (const item of activeClusterItems) {
        placeBlockAfter(item, lastActId);
        lastActId = item.id;
      }
    }

    if (moveRequests.length > 0) {
      const CHUNK_SIZE = 10;
      console.log(`  🚀 tidy_up_retainers: executing ${moveRequests.length} targeted block moves in chunks of ${CHUNK_SIZE}...`);
      for (let i = 0; i < moveRequests.length; i += CHUNK_SIZE) {
        const chunk = moveRequests.slice(i, i + CHUNK_SIZE);
        console.log(`    📦 batchUpdate chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(moveRequests.length / CHUNK_SIZE)} (${chunk.length} moves)...`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: chunk },
          _skipFormulaRecompute: i + CHUNK_SIZE < moveRequests.length,
        });
      }
    }

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, null, ["jobs", "invoices", "retainers", "cash"]);

    (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }

      await logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainers Tidied",
        summary: `Completed retainer tidy-up routine for ${tenantClient || "Client"} (${moveRequests.length} blocks relocated)`,
        details: { clientName: tenantClient, movesCount: moveRequests.length }
      });
    })().catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, moves: moveRequests.length });

  } catch (err) {
    console.error("❌ tidy_up_retainers error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleComputeRetainerAlertResolution(req, res, sheets) {
  let { clientSheetId, masterSheetId, client, clientName, jobName, parentRowNum, resolutionType,
    lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo, possibleMatchConfirmedRow } = req.body;

  if (!clientSheetId && clientName) {
    try {
      const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
      const found = clientsArray?.find(c => c.clientName?.toLowerCase() === clientName.toLowerCase());
      if (found?.clientSheetId) clientSheetId = found.clientSheetId;
      if (found?.masterSheetId && !masterSheetId) masterSheetId = found.masterSheetId;
    } catch (lookupErr) {
      console.warn("Could not resolve clientSheetId from clientName in compute resolution:", lookupErr.message);
    }
  }

  const missing = [];
  if (!clientSheetId) missing.push("clientSheetId");
  if (!jobName) missing.push("jobName");
  if (!parentRowNum) missing.push("parentRowNum");
  if (!resolutionType) missing.push("resolutionType");
  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(", ")}` });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const jobStartDate = retParseSheetDate(parentRow[37]);

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] || "").trim() && !String(next[37] || "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    const parentInvDate = retParseSheetDate(parentRow[43]);
    const allInvoiceDates = (parentInvDate ? [parentInvDate] : []).concat(
      childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean)
    );
    const intervalMonths = retDetectIntervalMonths(allInvoiceDates);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : (invoiceTimingOffset === "after" ? -1 : 0);

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const slotDefs = [
      { amt: 41, ref: 42, sent: 43, days: 44, status: 45 },
      { amt: 48, ref: 49, sent: 50, days: 51, status: 52 },
      { amt: 55, ref: 56, sent: 57, days: 58, status: 59 },
    ];
    const realSentDates = [];
    const allRetRows = [parentRow, ...childRows.map(cr => cr.row)];
    for (const r of allRetRows) {
      for (const slot of slotDefs) {
        const status = String(r[slot.status] || "").trim().toLowerCase();
        const isSentOrPaid = status === "sent" || status === "paid" || status.includes("paid") || status.includes("sent");
        const ref = String(r[slot.ref] || "").trim();
        const sentVal = r[slot.sent];
        if (isSentOrPaid && ref && !isPlaceholderInvoice(ref) && sentVal) {
          const d = retParseSheetDate(sentVal);
          if (d) realSentDates.push(d);
        }
      }
    }
    realSentDates.sort((a, b) => a.getTime() - b.getTime());
    const sheetLastSent = realSentDates.length > 0 ? realSentDates[realSentDates.length - 1] : null;

    if (resolutionType === "end") {
      const lastSent = sheetLastSent || retParseSheetDate(lastInvoiceDate);
      if (!lastSent) {
        return res.status(400).json({ success: false, error: "Could not determine last invoice sent date." });
      }
      const coveredPeriodStartVal = lastSent.getFullYear() * 12 + lastSent.getMonth() + timingMonthAdjust;
      const coveredPeriodEndVal = coveredPeriodStartVal + intervalMonths - 1;
      const endYear = Math.floor(coveredPeriodEndVal / 12);
      const endMonth0 = coveredPeriodEndVal % 12;
      const lastDayOfMonth = new Date(endYear, endMonth0 + 1, 0).getDate();
      const computedEndDate = new Date(endYear, endMonth0, lastDayOfMonth);

      return res.status(200).json({
        success: true,
        resolutionType: "end",
        computedEndDate: retFmtDate(computedEndDate),
        computedEndDateLabel: `${lastDayOfMonth}-${months[endMonth0]}-${endYear}`,
        coveredPeriodLabel: intervalMonths > 1
          ? `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal / 12)} to ${months[coveredPeriodEndVal % 12]} ${endYear}`
          : `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal / 12)}`,
        lastInvoiceSentDate: retFmtDate(lastSent),
      });

    } else if (resolutionType === "changeAmount") {
      const altSent = retParseSheetDate(possibleMatchSentDate);
      const altAmount = parseFloat(possibleMatchAmount);
      if (!altSent || isNaN(altAmount)) {
        return res.status(400).json({ success: false, error: "Could not determine alternative invoice date/amount." });
      }
      const coveredPeriodStartVal = altSent.getFullYear() * 12 + altSent.getMonth() + timingMonthAdjust;
      const endYear = Math.floor(coveredPeriodStartVal / 12);
      const endMonth0 = coveredPeriodStartVal % 12;
      const newMonthlyAmount = altAmount / (intervalMonths || 1);

      let sourceRowInfo = null;
      if (possibleMatchConfirmedRow) {
        const srcRowNum = parseInt(possibleMatchConfirmedRow, 10);
        const srcRow = rows[srcRowNum - 1];
        if (srcRow) {
          const slotDefs = [
            { amt: 41, ref: 42, sent: 43, days: 44, status: 45 },
            { amt: 48, ref: 49, sent: 50, days: 51, status: 52 },
            { amt: 55, ref: 56, sent: 57, days: 58, status: 59 },
          ];
          const matchedSlot = slotDefs.find(s => String(srcRow[s.ref] || "").trim() === String(possibleMatchInvoiceNo || "").trim());
          if (matchedSlot) {
            let srcChildCount = 0;
            let srcChildIdx = srcRowNum;
            while (srcChildIdx < rows.length) {
              const next = rows[srcChildIdx] || [];
              if (String(next[0] || "").trim() === String(srcRow[0] || "").trim() && String(next[1] || "").trim() === String(srcRow[1] || "").trim() &&
                !String(next[32] || "").trim() && !String(next[37] || "").trim()) {
                srcChildCount++; srcChildIdx++;
              } else break;
            }
            sourceRowInfo = {
              confirmedRow: srcRowNum,
              client: String(srcRow[0] || "").trim(),
              jobName: String(srcRow[1] || "").trim(),
              ref: String(srcRow[matchedSlot.ref] || "").trim(),
              sentDate: String(srcRow[matchedSlot.sent] || "").trim(),
              daysToPay: String(srcRow[matchedSlot.days] || "").trim(),
              status: String(srcRow[matchedSlot.status] || "").trim(),
              totalRowsToClear: 1 + srcChildCount,
            };
          }
        }
      }

      return res.status(200).json({
        success: true,
        resolutionType: "changeAmount",
        changeMonth: endMonth0,
        changeYear: endYear,
        changeMonthLabel: `${months[endMonth0]} ${endYear}`,
        newMonthlyAmount: Math.round(newMonthlyAmount * 100) / 100,
        newPerInvoiceAmount: altAmount,
        intervalMonths,
        sourceInvoiceRef: possibleMatchInvoiceNo || "",
        sourceInvoiceSentDate: possibleMatchSentDate || "",
        sourceRowInfo,
      });
    }

    return res.status(400).json({ success: false, error: "Unknown resolutionType" });
  } catch (err) {
    console.error("❌ compute_retainer_alert_resolution error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleComputeRetainerSplitInvoicePreview(req, res, sheets) {
  let { clientSheetId, masterSheetId, client, clientName, jobName, parentRowNum,
    lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo,
    possibleMatchVatAmount, possibleMatchStatus, possibleMatchConfirmedRow } = req.body;

  if (!clientSheetId && clientName) {
    try {
      const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
      const found = clientsArray?.find(c => c.clientName?.toLowerCase() === clientName.toLowerCase());
      if (found?.clientSheetId) clientSheetId = found.clientSheetId;
      if (found?.masterSheetId && !masterSheetId) masterSheetId = found.masterSheetId;
    } catch (lookupErr) {
      console.warn("Could not resolve clientSheetId from clientName in split preview:", lookupErr.message);
    }
  }

  const missing = [];
  if (!clientSheetId) missing.push("clientSheetId");
  if (!jobName) missing.push("jobName");
  if (!parentRowNum) missing.push("parentRowNum");
  if (!lastInvoiceDate) missing.push("lastInvoiceDate");
  if (!possibleMatchSentDate) missing.push("possibleMatchSentDate");
  if (possibleMatchAmount === undefined || possibleMatchAmount === null || possibleMatchAmount === "") missing.push("possibleMatchAmount");
  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(", ")}` });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }
    parentRowNum = resolvedParent.rowNum;
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const standardMonthlyAmount = retParseMoney(parentRow[32]);
    const altAmount = parseFloat(possibleMatchAmount) || 0;
    const altSentDate = retParseSheetDate(possibleMatchSentDate);

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0] || "").trim() === client && String(next[1] || "").trim() === jobName &&
        !String(next[32] || "").trim() && !String(next[17] || "").trim() && !String(next[37] || "").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }

    const slotDefs = [
      { amt: 41, ref: 42, sent: 43, days: 44, status: 45, rech: 46 },
      { amt: 48, ref: 49, sent: 50, days: 51, status: 52, rech: 53 },
      { amt: 55, ref: 56, sent: 57, days: 58, status: 59, rech: 60 },
    ];
    const realSentDates = [];
    const allRetRows = [parentRow, ...childRows.map(cr => cr.row)];
    for (const r of allRetRows) {
      for (const slot of slotDefs) {
        const status = String(r[slot.status] || "").trim().toLowerCase();
        const isSentOrPaid = status === "sent" || status === "paid" || status.includes("paid") || status.includes("sent");
        const ref = String(r[slot.ref] || "").trim();
        const sentVal = r[slot.sent];
        if (isSentOrPaid && ref && !isPlaceholderInvoice(ref) && sentVal) {
          const d = retParseSheetDate(sentVal);
          if (d) realSentDates.push(d);
        }
      }
    }
    realSentDates.sort((a, b) => a.getTime() - b.getTime());
    const sheetLastSent = realSentDates.length > 0 ? realSentDates[realSentDates.length - 1] : null;

    const lastSent = sheetLastSent || retParseSheetDate(lastInvoiceDate);
    if (!altSentDate || !lastSent) return res.status(400).json({ success: false, error: "Could not parse invoice dates." });
    const missingRow = childRows
      .map(cr => ({ ...cr, invDate: retParseSheetDate(cr.row[43]) }))
      .filter(cr => cr.invDate && cr.invDate.getTime() > lastSent.getTime())
      .sort((a, b) => a.invDate.getTime() - b.invDate.getTime())[0];

    if (!missingRow) return res.status(400).json({ success: false, error: "Could not find the missing invoice's row." });

    const difference = altAmount - standardMonthlyAmount;
    const vatAmount = parseFloat(possibleMatchVatAmount) || 0;

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const extraJobName = `${months[altSentDate.getMonth()]} ${String(altSentDate.getFullYear()).slice(-2)} retainer extra revenue`;

    let existingJobInfo = null;
    if (possibleMatchConfirmedRow) {
      const srcRowNum = parseInt(possibleMatchConfirmedRow, 10);
      const srcRow = rows[srcRowNum - 1];
      if (srcRow) {
        existingJobInfo = {
          confirmedRow: srcRowNum,
          client: String(srcRow[0] || "").trim(),
          jobName: String(srcRow[1] || "").trim(),
          currentRevenue: String(srcRow[32] || "").trim(),
        };
      }
    }

    return res.status(200).json({
      success: true,
      missingRowNum: missingRow.rowNum,
      missingRowPeriodLabel: `${months[missingRow.invDate.getMonth()]} ${missingRow.invDate.getFullYear()}`,
      standardMonthlyAmount,
      altAmount,
      altSentDate: possibleMatchSentDate,
      altInvoiceNo: possibleMatchInvoiceNo || "",
      altStatus: possibleMatchStatus || "",
      vatAmount,
      difference: Math.round(difference * 100) / 100,
      extraJobName,
      extraJobMonth: altSentDate.getMonth(),
      extraJobYear: altSentDate.getFullYear(),
      existingJobInfo,
      currentParentRecharged: retParseMoney(parentRow[17]),
      defaultCostMonth: `${months[altSentDate.getMonth()]}-${String(altSentDate.getFullYear()).slice(-2)}`,
    });
  } catch (err) {
    console.error("❌ compute_retainer_split_invoice_preview error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleApplyRetainerSplitInvoice(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  const isAdminUser = !sessionUser?.isReadOnly && Boolean(sessionUser?.isAdmin || sessionUser?.role === "Admin");
  let {
    clientSheetId, masterSheetId, client, clientName, jobName, parentRowNum, missingRowNum,
    standardMonthlyAmount, altAmount, altSentDate, altInvoiceNo, altStatus, vatAmount, difference,
    extraJobName, extraJobMonth, extraJobYear, existingConfirmedRow,
    splitMode = "extra_revenue", costMonth = "",
  } = req.body;

  if (!clientSheetId && clientName) {
    try {
      const { clientsArray } = await getAllClients(sheets, { isAdmin: true }, false);
      const found = clientsArray?.find(c => c.clientName?.toLowerCase() === clientName.toLowerCase());
      if (found?.clientSheetId) clientSheetId = found.clientSheetId;
      if (found?.masterSheetId && !masterSheetId) masterSheetId = found.masterSheetId;
    } catch (lookupErr) {
      console.warn("Could not resolve clientSheetId from clientName in apply split:", lookupErr.message);
    }
  }

  const missing = [];
  if (!clientSheetId) missing.push("clientSheetId");
  if (!jobName) missing.push("jobName");
  if (!parentRowNum) missing.push("parentRowNum");
  if (!missingRowNum) missing.push("missingRowNum");
  if (difference === undefined || difference === null || difference === "") missing.push("difference");
  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(", ")}` });
  }

  missingRowNum = parseInt(missingRowNum, 10);
  if (!Number.isInteger(missingRowNum) || missingRowNum < 2 || missingRowNum > 5000) {
    return res.status(400).json({ success: false, error: "Invalid missingRowNum parameter." });
  }
  if (existingConfirmedRow !== undefined && existingConfirmedRow !== null && existingConfirmedRow !== "") {
    existingConfirmedRow = parseInt(existingConfirmedRow, 10);
    if (!Number.isInteger(existingConfirmedRow) || existingConfirmedRow < 2 || existingConfirmedRow > 5000) {
      return res.status(400).json({ success: false, error: "Invalid existingConfirmedRow parameter." });
    }
  } else {
    existingConfirmedRow = null;
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const resolvedParent = resolveRetainerParentRow_(rows, parentRowNum, client, jobName);
    if (!resolvedParent) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }
    parentRowNum = resolvedParent.rowNum;
    if (missingRowNum <= parentRowNum) {
      return res.status(400).json({ success: false, error: "Invalid missingRowNum for target retainer." });
    }
    client = resolvedParent.resolvedClient;
    jobName = resolvedParent.resolvedJobName;
    const parentRow = resolvedParent.row;

    const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
    const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;
    const parsedAltSentDate = retParseSheetDate(altSentDate);
    const diffNum = Math.round((parseFloat(String(difference ?? "").replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
    const standardMonthlyNum = Math.round((parseFloat(String(standardMonthlyAmount ?? "").replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;

    if (splitMode === "recharged_expense" && diffNum > 0) {
      const fullInvoiceAmt = Math.round((parseFloat(altAmount) || ((parseFloat(standardMonthlyAmount) || 0) + diffNum)) * 100) / 100;
      const updatedParentRech = Math.round((retParseMoney(parentRow[17]) + diffNum) * 100) / 100;
      const cleanCostMonth = sanitizeFormulaInput(String(costMonth || "").trim());

      const rechWriteData = [
        { range: `Confirmed!AP${missingRowNum}`, values: [[fullInvoiceAmt]] },
        { range: `Confirmed!AQ${missingRowNum}`, values: [[formatInvoiceRefForSheet(altInvoiceNo || "")]] },
        { range: `Confirmed!AS${missingRowNum}`, values: [[defaultDaysToPay]] },
        { range: `Confirmed!AT${missingRowNum}`, values: [[sanitizeFormulaInput(altStatus || "")]] },
        { range: `Confirmed!AU${missingRowNum}`, values: [[diffNum]] },
        { range: `Confirmed!R${parentRowNum}`, values: [[updatedParentRech]] },
      ];
      if (parsedAltSentDate) {
        rechWriteData.push({ range: `Confirmed!AR${missingRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });
      }
      if (cleanCostMonth) {
        rechWriteData.push({ range: `Confirmed!AV${missingRowNum}`, values: [[cleanCostMonth]] });
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, _skipFormulaRecompute: true, requestBody: { valueInputOption: "USER_ENTERED", data: rechWriteData },
      });

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);

      (async () => {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        const endClient = client || "";
        const jobIdentifier = endClient ? `"${endClient} - ${jobName || "Retainer"}"` : `"${jobName || "Retainer"}"`;

        await logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "RETAINER",
          action: "Retainer Recharged Expenses Recorded",
          summary: `Recorded #${altInvoiceNo || "Invoice"} on ${jobIdentifier} with £${diffNum.toFixed(2)} as recharged expenses`,
          details: { clientName: tenantClient, endClient, altInvoiceNo, difference: diffNum, fullInvoiceAmt, costMonth: cleanCostMonth }
        });
      })().catch(e => console.error("PMA log failed:", e));

      return res.status(200).json({
        success: true,
        mode: "recharged_expense",
        ...(isAdminUser ? { parentRowNum, missingRowNum } : {}),
      });
    }

    const writeData = [
      { range: `Confirmed!AP${missingRowNum}`, values: [[standardMonthlyNum]] },
      { range: `Confirmed!AQ${missingRowNum}`, values: [[formatInvoiceRefForSheet(altInvoiceNo || "")]] },
      { range: `Confirmed!AS${missingRowNum}`, values: [[defaultDaysToPay]] },
      { range: `Confirmed!AT${missingRowNum}`, values: [[sanitizeFormulaInput(altStatus || "")]] },
    ];
    if (parsedAltSentDate) writeData.push({ range: `Confirmed!AR${missingRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

    const monthStart = new Date(extraJobYear, extraJobMonth, 1);
    const monthEnd = new Date(extraJobYear, extraJobMonth + 1, 0);
    const vatYesNo = (parseFloat(vatAmount) || 0) > 0 ? "Yes" : "No";

    if (existingConfirmedRow) {
      writeData.push(
        { range: `Confirmed!B${existingConfirmedRow}`, values: [[sanitizeFormulaInput(extraJobName)]] },
        { range: `Confirmed!D${existingConfirmedRow}`, values: [[sanitizeFormulaInput(parentRow[3] || "")]] },
        { range: `Confirmed!E${existingConfirmedRow}`, values: [[sanitizeFormulaInput(parentRow[4] || "")]] },
        { range: `Confirmed!AG${existingConfirmedRow}`, values: [[diffNum]] },
        { range: `Confirmed!AJ${existingConfirmedRow}`, values: [["Retainer"]] },
        { range: `Confirmed!AK${existingConfirmedRow}`, values: [[sanitizeFormulaInput(parentRow[36] || "")]] },
        { range: `Confirmed!AP${existingConfirmedRow}`, values: [[diffNum]] },
      );
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, _skipFormulaRecompute: true, requestBody: { valueInputOption: "USER_ENTERED", data: writeData },
      });
      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);
      return res.status(200).json({
        success: true,
        mode: "converted",
        ...(isAdminUser ? { extraJobRow: existingConfirmedRow } : {}),
      });
    } else {
      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      const gridSheetId = confirmedSheet.properties.sheetId;
      let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

      const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, rows);
      const newRowNum = trueLastRow + 1;

      // 1. Structural insertDimension FIRST while sheet is idle (<1s)
      if ((currentMaxRows - (trueLastRow + 1)) < 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            requests: [{
              insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
            }]
          },
          _skipFormulaRecompute: true,
        });
      }

      // 2. Write all cell values SECOND in a single batchUpdate
      writeData.push(
        { range: `Confirmed!A${newRowNum}`, values: [[sanitizeFormulaInput(client)]] },
        { range: `Confirmed!B${newRowNum}`, values: [[sanitizeFormulaInput(extraJobName)]] },
        { range: `Confirmed!D${newRowNum}`, values: [[sanitizeFormulaInput(parentRow[3] || "")]] },
        { range: `Confirmed!E${newRowNum}`, values: [[sanitizeFormulaInput(parentRow[4] || "")]] },
        { range: `Confirmed!AG${newRowNum}`, values: [[diffNum]] },
        { range: `Confirmed!AI${newRowNum}`, values: [[vatYesNo]] },
        { range: `Confirmed!AJ${newRowNum}`, values: [["Retainer"]] },
        { range: `Confirmed!AK${newRowNum}`, values: [[sanitizeFormulaInput(parentRow[36] || "")]] },
        { range: `Confirmed!AL${newRowNum}`, values: [[retFmtDate(monthStart)]] },
        { range: `Confirmed!AM${newRowNum}`, values: [[retFmtDate(monthEnd)]] },
        { range: `Confirmed!AP${newRowNum}`, values: [[diffNum]] },
        { range: `Confirmed!AQ${newRowNum}`, values: [[formatInvoiceRefForSheet(altInvoiceNo || "")]] },
        { range: `Confirmed!AS${newRowNum}`, values: [[defaultDaysToPay]] },
        { range: `Confirmed!AT${newRowNum}`, values: [[sanitizeFormulaInput(altStatus || "")]] },
      );
      if (parsedAltSentDate) writeData.push({ range: `Confirmed!AR${newRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, _skipFormulaRecompute: true, requestBody: { valueInputOption: "USER_ENTERED", data: writeData },
      });

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["jobs", "invoices", "retainers", "cash"]);

      (async () => {
        let tenantClient = req.body.clientName || "";
        if (!tenantClient) {
          tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
        }
        const endClient = client || "";
        const jobIdentifier = endClient ? `"${endClient} - ${jobName || extraJobName || "Retainer"}"` : `"${jobName || extraJobName || "Retainer"}"`;

        await logPmaActivity(sheets, {
          automationCommanderSheetId: req.body.automationCommanderSheetId,
          clientName: tenantClient,
          category: "RETAINER",
          action: "Retainer Split Invoice Applied",
          summary: `Applied retainer invoice split for #${altInvoiceNo || "Invoice"} on ${jobIdentifier}`,
          details: { clientName: tenantClient, endClient, altInvoiceNo, difference: diffNum, extraJobName }
        });
      })().catch(e => console.error("PMA log failed:", e));

      return res.status(200).json({
        success: true,
        mode: "created",
        ...(isAdminUser ? { extraJobRow: newRowNum } : {}),
      });
    }
  } catch (err) {
    console.error("❌ apply_retainer_split_invoice error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleDeleteRetainer(req, res, sheets) {
  const { clientSheetId, masterSheetId, parentRowNum, jobName } = req.body;
  if (!clientSheetId || !masterSheetId || !parentRowNum) {
    return res.status(400).json({ success: false, error: "Missing required parameters: clientSheetId, masterSheetId, or parentRowNum" });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const masterIdClean = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

    const [allLocks, metaResp, resp] = await Promise.all([
      checkAllGASLocks(sheets, masterIdClean),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)"
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    ]);

    if (allLocks.invoice.locked) return res.status(400).json({ success: false, error: allLocks.invoice.message });
    if (allLocks.expense.locked) return res.status(400).json({ success: false, error: allLocks.expense.message });
    if (allLocks.crm.locked) return res.status(400).json({ success: false, error: allLocks.crm.message });

    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    const confirmedSheetId = confirmedSheet.properties.sheetId;

    const allRows = resp.data.values || [];

    const pIdx = parentRowNum - 1;
    if (pIdx < 0 || pIdx >= allRows.length) {
      return res.status(404).json({ success: false, error: `Parent row ${parentRowNum} not found in Confirmed sheet` });
    }

    const pRow = allRows[pIdx] || [];
    const pClient = String(pRow[0] || "").trim();
    const pJob = String(pRow[1] || "").trim();

    if (jobName && pJob && pJob.toLowerCase() !== String(jobName).trim().toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: `Job name mismatch at row ${parentRowNum}: expected "${jobName}", found "${pJob}"`
      });
    }

    // Check if this is a Variable Retainer series
    const vrMeta = parseVariableRetainerTag(pRow[30]);
    if (vrMeta) {
      const targetSeriesLower = (vrMeta.seriesName || "").toLowerCase();
      const targetClientLower = pClient.toLowerCase();
      const allSeriesRowsToClear = [];
      let ri = 1;
      while (ri < allRows.length) {
        const r = allRows[ri] || [];
        const rc = String(r[0] || "").trim();
        const rj = String(r[1] || "").trim();
        const rMeta = parseVariableRetainerTag(r[30]);
        if (rc.toLowerCase() === targetClientLower && rMeta && (rMeta.seriesName || "").toLowerCase() === targetSeriesLower) {
          allSeriesRowsToClear.push(ri + 1);
          let cj = ri + 1;
          while (cj < allRows.length) {
            const nx = allRows[cj] || [];
            if (String(nx[0] || "").trim() === rc && String(nx[1] || "").trim() === rj &&
              !String(nx[32] || "").trim() && !String(nx[37] || "").trim() && !String(nx[35] || "").trim()) {
              allSeriesRowsToClear.push(cj + 1);
              cj++;
            } else break;
          }
          ri = cj;
        } else {
          ri++;
        }
      }

      for (const rNum of allSeriesRowsToClear) {
        const rData = allRows[rNum - 1] || [];
        const invSlots = [
          { ref: rData[42], status: rData[45] },
          { ref: rData[49], status: rData[52] },
          { ref: rData[56], status: rData[59] },
        ];
        for (const s of invSlots) {
          const ref = String(s.ref || "").trim();
          const st = String(s.status || "").trim().toLowerCase();
          if ((ref && !isPlaceholderInvoice(ref)) || st.includes("sent") || st.includes("paid")) {
            return res.status(400).json({
              success: false,
              error: `Cannot delete variable retainer: Found real invoice "${ref || st}" on row ${rNum}`,
            });
          }
        }
        const expSlots = [
          { desc: rData[75], status: rData[80], id: rData[81] },
          { desc: rData[82], status: rData[87], id: rData[88] },
          { desc: rData[89], status: rData[94], id: rData[95] },
        ];
        for (const s of expSlots) {
          const id = String(s.id || "").trim();
          const desc = String(s.desc || "").trim();
          const st = String(s.status || "").trim().toLowerCase();
          if ((id && !isPlaceholderExpense(id, desc, st)) || st === "paid" || st === "received") {
            return res.status(400).json({
              success: false,
              error: `Cannot delete variable retainer: Found real expense "${desc || id}" on row ${rNum}`,
            });
          }
        }
      }

      const isJobCosting = isJobCostingStyle({ headers: allRows[0] || [] });
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName: "Confirmed",
        rowNums: allSeriesRowsToClear,
        isJobCosting,
        includeCopiedCol: false,
      });

      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { ranges: clearRanges },
        })
      );
      if (restoreData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean,
            _skipFormulaRecompute: true,
            requestBody: { valueInputOption: "USER_ENTERED", data: restoreData },
          })
        );
      }

      await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterIdClean, ["jobs", "invoices", "retainers", "cash", "views"]);
      return res.status(200).json({ success: true, clearedRows: allSeriesRowsToClear.length, isVariableRetainer: true });
    }

    // Collect parent and child rows
    const rowsToClear = [parentRowNum];
    let ci = pIdx + 1;
    while (ci < allRows.length) {
      const next = allRows[ci] || [];
      const nc = String(next[0] || "").trim();
      const nj = String(next[1] || "").trim();
      const nRevenue = String(next[32] || "").trim();
      const nStart = String(next[37] || "").trim();
      const nEnd = String(next[38] || "").trim();

      const hasParentIndicators = (nStart !== "" || nEnd !== "") || (nRevenue !== "" && parseFloat(String(nRevenue).replace(/[^0-9.-]/g, "")) > 0);
      if (hasParentIndicators) break;

      const clientMatches = !nc || nc.toLowerCase() === pClient.toLowerCase();
      const jobMatches = (nj && nj.toLowerCase() === pJob.toLowerCase()) || (!nj && (next[41] || next[42] || next[75] || next[76]));

      if (clientMatches && jobMatches) {
        rowsToClear.push(ci + 1);
        ci++;
      } else {
        break;
      }
    }

    // Verify on server that NO real invoices exist on ANY of these rows
    for (const rNum of rowsToClear) {
      const rData = allRows[rNum - 1] || [];
      // Slots: AP:AT (41..45), AW:BA (48..52), BD:BH (55..59)
      const slots = [
        { ref: rData[42], status: rData[45] },
        { ref: rData[49], status: rData[52] },
        { ref: rData[56], status: rData[59] },
      ];
      for (const s of slots) {
        const ref = String(s.ref || "").trim();
        const status = String(s.status || "").trim().toLowerCase();
        if ((ref && !isPlaceholderInvoice(ref)) || status.includes("sent") || status.includes("paid")) {
          return res.status(400).json({
            success: false,
            error: `Cannot delete retainer: Found real invoice "${ref || status}" on row ${rNum}`
          });
        }
      }
    }

    // Clear safe data ranges from Confirmed sheet (and restore JobCosting row formulas when applicable)
    const isJobCosting = isJobCostingStyle({ headers: allRows[0] || [] });
    const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
      sheetName: "Confirmed",
      rowNums: rowsToClear,
      isJobCosting,
      includeCopiedCol: false,
    });

    const cleanupRequests = [];
    if (rowsToClear.length > 1) {
      const childStart = rowsToClear[1] - 1;
      const childEnd = rowsToClear[rowsToClear.length - 1];
      const existingGroups = confirmedSheet.rowGroups || [];
      const matchGroup = existingGroups.find(
        g => g.range?.startIndex <= childStart && g.range?.endIndex >= childEnd
      );
      if (matchGroup) {
        cleanupRequests.push({
          deleteDimensionGroup: {
            range: {
              sheetId: confirmedSheetId,
              dimension: "ROWS",
              startIndex: matchGroup.range.startIndex,
              endIndex: matchGroup.range.endIndex,
            }
          }
        });
        cleanupRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId: confirmedSheetId,
              dimension: "ROWS",
              startIndex: matchGroup.range.startIndex,
              endIndex: matchGroup.range.endIndex,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }
    }
    if (rowsToClear.length > 0) {
      cleanupRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: confirmedSheetId,
            dimension: "ROWS",
            startIndex: rowsToClear[0] - 1,
            endIndex: rowsToClear[rowsToClear.length - 1],
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
    }

    // Execute structural group deletion / row unhiding FIRST while the sheet is idle (<1s),
    // then clear cell values SECOND so structural batchUpdate never blocks behind formula recalculation.
    if (cleanupRequests.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: cleanupRequests }
        })
      ).catch(groupErr => console.warn("⚠️ Delete dimension group / unhide warning (non-fatal):", groupErr.message));
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchClear({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { ranges: clearRanges },
      })
    );
    if (restoreData.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "USER_ENTERED", data: restoreData },
        })
      );
    }

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterIdClean, ["jobs", "invoices", "retainers", "cash"]);

    (async () => {
      let tenantClient = req.body.clientName || "";
      if (!tenantClient) {
        tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
      }

      await logPmaActivity(sheets, {
        automationCommanderSheetId: req.body.automationCommanderSheetId,
        clientName: tenantClient,
        category: "RETAINER",
        action: "Retainer Deleted",
        summary: `Deleted retainer "${pJob || jobName}" (${rowsToClear.length} rows cleared) for ${pClient || tenantClient}`,
        details: { clientName: tenantClient, endClient: pClient, jobName: pJob || jobName, rowsToClear }
      });
    })().catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, clearedRows: rowsToClear.length });
  } catch (err) {
    console.error("❌ delete_retainer error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateVariableRetainerBase(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, client, seriesName,
    effectiveMonth, effectiveYear, baseRevenue, baseDirectCosts,
    sendDay: rawSendDay, endDate: rawEndDate, noEndDate,
  } = req.body;
  if (!clientSheetId || !client || !seriesName || baseRevenue === undefined) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  const newBaseRev = Math.round((parseFloat(String(baseRevenue ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  const newBaseDC = Math.round((parseFloat(String(baseDirectCosts ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
  if (newBaseRev <= 0 || newBaseDC < 0) {
    return res.status(400).json({ success: false, error: "Base revenue must be greater than zero and direct costs cannot be negative." });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resolvedMasterId =
      (masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null) ||
      (await resolveMasterSheetIdForClient_(sheets, sheetIdClean, req.body.clientName || ""));

    const [valResp, formResp, metaResp, tolerance] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:BJ5000",
        valueRenderOption: "FORMULA",
      }),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
      }),
      getToleranceValues(sheets, resolvedMasterId || sheetIdClean),
    ]);

    const rows = valResp.data?.values || [];
    const formRows = formResp.data?.values || [];
    const confirmedSheet = (metaResp.data?.sheets || []).find(s => s.properties?.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });

    const allSeries = retFindVariableRetainerSeries(rows);
    const targetSeries = allSeries.find(
      s => s.client.toLowerCase() === String(client).trim().toLowerCase() &&
        s.seriesName.toLowerCase() === String(seriesName).trim().toLowerCase()
    );
    if (!targetSeries || targetSeries.months.length === 0) {
      return res.status(404).json({ success: false, error: "Variable retainer series not found." });
    }

    const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });
    const parsedEnd = (noEndDate || isNoEndDateSentinel(rawEndDate))
      ? new Date(2050, 11, 31)
      : (rawEndDate ? retParseSheetDate(rawEndDate) : targetSeries.endDateObj);
    if (!parsedEnd) return res.status(400).json({ success: false, error: "Invalid end date" });
    const formattedEnd = retFmtDate(parsedEnd);
    const isNoEnd = Boolean(noEndDate || isNoEndDateSentinel(formattedEnd) || parsedEnd.getFullYear() >= 2050);
    const firstMonthStart =
      targetSeries.startDateObj ||
      targetSeries.months[0]?.startDate ||
      retParseSheetDate(targetSeries.months[0]?.row?.[37]);
    if (!isNoEnd && firstMonthStart && parsedEnd.getTime() < firstMonthStart.getTime()) {
      return res.status(400).json({ success: false, error: "End date cannot be earlier than start date." });
    }
    const newEndMonthVal = parsedEnd.getFullYear() * 12 + parsedEnd.getMonth();

    const parsedSendDay = parseInt(rawSendDay, 10);
    const newSendDay = (!isNaN(parsedSendDay) && parsedSendDay >= 1 && parsedSendDay <= 31)
      ? parsedSendDay
      : (targetSeries.sendDay || 28);
    const parsedDefDays = parseInt(String(tolerance?.defaultDaysToPay ?? "").replace(/[^\d.-]/g, ""), 10);
    const defaultDaysToPay = !isNaN(parsedDefDays) && parsedDefDays >= 0 && parsedDefDays <= 365 ? parsedDefDays : 30;
    const expDay = parseInt(tolerance?.retainerExpenseDay, 10) > 0 ? parseInt(tolerance.retainerExpenseDay, 10) : 28;

    const effMonthVal = (effectiveYear !== undefined && effectiveMonth !== undefined && effectiveYear !== "" && effectiveMonth !== "")
      ? (parseInt(effectiveYear, 10) * 12 + parseInt(effectiveMonth, 10))
      : null;

    const rowsToTrim = [];
    const batchData = [];
    let updatedCount = 0;

    for (const m of targetSeries.months) {
      const mStart = m.startDate || retParseSheetDate(m.row[37]);
      if (!mStart) continue;
      const mMonthVal = mStart.getFullYear() * 12 + mStart.getMonth();
      if (mMonthVal > newEndMonthVal) {
        rowsToTrim.push(m);
        continue;
      }

      const isEffective = effMonthVal === null || mMonthVal >= effMonthVal;
      const fRow = formRows[m.rowNum - 1] || [];
      const newTag = formatVariableRetainerTag({
        seriesName: targetSeries.seriesName,
        baseRev: isEffective ? newBaseRev : (m.vrMeta?.baseRev ?? newBaseRev),
        baseDC: isEffective ? newBaseDC : (m.vrMeta?.baseDC ?? newBaseDC),
        endDate: formattedEnd,
        noEndDate: isNoEnd,
        sendDay: newSendDay,
        overrideRev: Boolean(m.vrMeta?.overrideRev),
        overrideDc: Boolean(m.vrMeta?.overrideDc),
      });
      batchData.push({ range: `Confirmed!AE${m.rowNum}`, values: [[newTag]] });

      if (isEffective) {
        updatedCount++;
        const hasRealInv = [42, 49, 56].some((idx, sIdx) => {
          const r = String(m.row[idx] ?? "").trim();
          const st = String(m.row[idx + 3] ?? "").trim().toLowerCase();
          return (r && !isPlaceholderInvoice(r, st)) || st.includes("sent") || st.includes("paid");
        });
        const revFormula = String(fRow[isJobCosting ? 8 : 32] ?? "").trim();
        const dcFormula = String(fRow[isJobCosting ? 10 : 33] ?? "").trim();
        const apFormula = String(fRow[41] ?? "").trim();

        if (!hasRealInv && !m.vrMeta?.overrideRev && !revFormula.startsWith("=")) {
          const revColLetter = isJobCosting ? "I" : "AG";
          batchData.push({ range: `Confirmed!${revColLetter}${m.rowNum}`, values: [[newBaseRev]] });
          const s1Ref = String(m.row[42] ?? "").trim();
          if ((!s1Ref || isPlaceholderInvoice(s1Ref)) && !apFormula.startsWith("=")) {
            const maxDim = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
            const sendDateStr = retFmtDate(new Date(mStart.getFullYear(), mStart.getMonth(), Math.min(newSendDay, maxDim)));
            batchData.push({ range: `Confirmed!AP${m.rowNum}`, values: [[newBaseRev]] });
            batchData.push({ range: `Confirmed!AR${m.rowNum}`, values: [[sendDateStr]] });
          }
        }

        // Check real bills on this month (parent + overflow) before modifying AH
        let realBillsTotal = 0;
        const monthGroupRows = [m.row, ...m.overflowRows.map(o => o.row)];
        for (const rArr of monthGroupRows) {
          for (const b of [75, 82, 89]) {
            const desc = String(rArr[b] ?? "").trim();
            const amt = retParseMoney(rArr[b + 1]);
            const st = String(rArr[b + 5] ?? "").trim().toLowerCase();
            const id = String(rArr[b + 6] ?? "").trim();
            if (amt > 0 && ((!isPlaceholderExpense(id, desc, st)) || st === "paid" || st === "received")) {
              realBillsTotal += amt;
            }
          }
        }
        if (!m.vrMeta?.overrideDc && !dcFormula.startsWith("=") && realBillsTotal <= newBaseDC + 0.01) {
          const dcColLetter = isJobCosting ? "K" : "AH";
          batchData.push({ range: `Confirmed!${dcColLetter}${m.rowNum}`, values: [[newBaseDC]] });
        }
      }
    }

    // Validate trimming
    for (const m of rowsToTrim) {
      const checkRows = [{ rowNum: m.rowNum, row: m.row }, ...m.overflowRows];
      const blocked = checkRows.find(cr => retRowHasRealData(cr.row));
      if (blocked) {
        return res.status(400).json({
          success: false,
          blocked: true,
          error: `Cannot shorten this variable retainer - row ${blocked.rowNum} already has a real invoice or expense recorded.`,
        });
      }
    }

    const clearRowNums = [];
    for (const m of rowsToTrim) {
      clearRowNums.push(m.rowNum, ...m.overflowRows.map(o => o.rowNum));
    }
    if (clearRowNums.length > 0) {
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName: "Confirmed",
        rowNums: clearRowNums,
        isJobCosting,
        includeCopiedCol: false,
      });
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { ranges: clearRanges },
        })
      );
      if (restoreData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean,
            _skipFormulaRecompute: true,
            requestBody: { valueInputOption: "USER_ENTERED", data: restoreData },
          })
        );
      }
    }

    // Grow future runway if newEndMonthVal > last kept month
    const keptMonths = targetSeries.months.filter(m => {
      const d = m.startDate || retParseSheetDate(m.row[37]);
      return d && (d.getFullYear() * 12 + d.getMonth()) <= newEndMonthVal;
    });
    const lastKept = keptMonths[keptMonths.length - 1];
    const lastKeptDate = lastKept ? (lastKept.startDate || retParseSheetDate(lastKept.row[37])) : null;
    let grownCount = 0;
    if (lastKeptDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const maxFutureMonthVal = today.getFullYear() * 12 + today.getMonth() + 18;
      const targetLastVal = Math.min(newEndMonthVal, maxFutureMonthVal);
      const lastKeptVal = lastKeptDate.getFullYear() * 12 + lastKeptDate.getMonth();

      if (targetLastVal > lastKeptVal) {
        const freshAfterClear = clearRowNums.length > 0
          ? (await sheets.spreadsheets.values.get({ spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR5000", valueRenderOption: "UNFORMATTED_VALUE" })).data?.values || rows
          : rows;
        const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshAfterClear);
        const gridSheetId = confirmedSheet.properties.sheetId;
        const currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
        const toGrow = targetLastVal - lastKeptVal;
        if (currentMaxRows - (trueLastRow + 1) < toGrow) {
          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: {
                requests: [{
                  insertDimension: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + (toGrow - (currentMaxRows - (trueLastRow + 1)) + 5) },
                    inheritFromBefore: true,
                  },
                }],
              },
              _skipFormulaRecompute: true,
            })
          );
        }

        const aeTagNew = formatVariableRetainerTag({
          seriesName: targetSeries.seriesName,
          baseRev: newBaseRev,
          baseDC: newBaseDC,
          endDate: formattedEnd,
          noEndDate: isNoEnd,
          sendDay: newSendDay,
        });
        const vatClean = sanitizeFormulaInput(targetSeries.vat || "Yes");
        for (let k = 1; k <= toGrow; k++) {
          const mVal = lastKeptVal + k;
          const yr = Math.floor(mVal / 12);
          const mo = ((mVal % 12) + 12) % 12;
          const mStart = new Date(yr, mo, 1);
          const mEnd = new Date(yr, mo + 1, 0);
          const rNum = trueLastRow + k;
          const mJobName = formatVarRetainerMonthJobName(targetSeries.seriesName, mStart);
          const maxDim = mEnd.getDate();
          const invDateStr = retFmtDate(new Date(yr, mo, Math.min(newSendDay, maxDim)));
          const expDateStr = retFmtDate(new Date(yr, mo, Math.min(expDay, maxDim)));
          grownCount++;

          batchData.push(
            { range: `Confirmed!A${rNum}`, values: [[sanitizeFormulaInput(targetSeries.client)]] },
            { range: `Confirmed!B${rNum}`, values: [[sanitizeFormulaInput(mJobName)]] },
            ...(targetSeries.projectCode ? [{ range: `Confirmed!C${rNum}`, values: [[sanitizeFormulaInput(targetSeries.projectCode)]] }] : []),
            { range: `Confirmed!AE${rNum}`, values: [[aeTagNew]] },
            { range: `Confirmed!AI${rNum}`, values: [[vatClean]] },
            { range: `Confirmed!AJ${rNum}`, values: [["Retainer"]] },
            { range: `Confirmed!AP${rNum}:AT${rNum}`, values: [[newBaseRev, "", invDateStr, defaultDaysToPay, ""]] },
          );
          if (isJobCosting) {
            batchData.push(
              { range: `Confirmed!F${rNum}`, values: [[retFmtDate(mStart)]] },
              { range: `Confirmed!G${rNum}`, values: [[retFmtDate(mEnd)]] },
              { range: `Confirmed!I${rNum}`, values: [[newBaseRev]] },
              ...(newBaseDC > 0 ? [{ range: `Confirmed!K${rNum}`, values: [[newBaseDC]] }] : []),
            );
            const jcMap = getJobCostingRowFormulasLetterMap("Confirmed", rNum, { hasExplicitContractorCosts: newBaseDC > 0 });
            for (const [fCol, fStr] of Object.entries(jcMap)) {
              batchData.push({ range: `Confirmed!${fCol}${rNum}`, values: [[fStr]] });
            }
          } else {
            batchData.push(
              { range: `Confirmed!AG${rNum}`, values: [[newBaseRev]] },
              { range: `Confirmed!AH${rNum}`, values: [[newBaseDC]] },
              { range: `Confirmed!AL${rNum}`, values: [[retFmtDate(mStart)]] },
              { range: `Confirmed!AM${rNum}`, values: [[retFmtDate(mEnd)]] },
            );
          }
          if (newBaseDC > 0) {
            const mShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo];
            const yShort = String(yr).slice(-2);
            const rand4 = Math.floor(1000 + Math.random() * 9000);
            batchData.push({
              range: `Confirmed!BX${rNum}:CD${rNum}`,
              values: [["Placeholder - Direct cost", newBaseDC, vatClean, expDateStr, defaultDaysToPay, "", `PLACE-EXP-${mShort}-${yShort}-${rand4}`]],
            });
          }
        }
      }
    }

    if (batchData.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
        })
      );
    }

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, resolvedMasterId, ["retainers", "jobs", "invoices", "outgoings", "cash", "views"]);
    return res.status(200).json({
      success: true,
      updatedCount,
      trimmedCount: clearRowNums.length,
      grownCount,
    });
  } catch (err) {
    console.error("❌ update_variable_retainer_base error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateVariableRetainerMonth(req, res, sheets) {
  const { clientSheetId, masterSheetId, rowNum, revenue, directCosts, resetToBase = false } = req.body;
  const rNum = parseInt(rowNum, 10);
  if (!clientSheetId || !rNum || rNum < 2) {
    return res.status(400).json({ success: false, error: "Missing or invalid clientSheetId / rowNum" });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const [valResp, formResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `Confirmed!A${rNum}:BJ${rNum}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: `Confirmed!A${rNum}:BJ${rNum}`,
        valueRenderOption: "FORMULA",
      }),
    ]);

    const row = valResp.data?.values?.[0] || [];
    const fRow = formResp.data?.values?.[0] || [];
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:AM1",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const isJobCosting = isJobCostingStyle({ headers: headerResp.data?.values?.[0] || [] });

    const vrMeta = parseVariableRetainerTag(row[30]);
    if (!vrMeta || !String(row[35] || "").toLowerCase().includes("retainer")) {
      return res.status(400).json({ success: false, error: "Target row is not a variable retainer month." });
    }

    const targetRev = resetToBase
      ? vrMeta.baseRev
      : Math.round((parseFloat(String(revenue ?? row[32] ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;
    const targetDC = resetToBase
      ? vrMeta.baseDC
      : Math.round((parseFloat(String(directCosts ?? row[33] ?? 0).replace(/[£$€,\s]/g, "")) || 0) * 100) / 100;

    if (targetRev < 0 || targetDC < 0) {
      return res.status(400).json({ success: false, error: "Revenue and direct costs cannot be negative." });
    }

    const newOverrideRev = resetToBase ? false : Math.abs(targetRev - vrMeta.baseRev) > 0.005;
    const newOverrideDc = resetToBase ? false : Math.abs(targetDC - vrMeta.baseDC) > 0.005;
    const newTag = formatVariableRetainerTag({
      ...vrMeta,
      overrideRev: newOverrideRev,
      overrideDc: newOverrideDc,
    });

    const batchData = [
      { range: `Confirmed!AE${rNum}`, values: [[newTag]] },
    ];

    const revFormula = String(fRow[isJobCosting ? 8 : 32] ?? "").trim();
    if (!revFormula.startsWith("=")) {
      batchData.push({ range: `Confirmed!${isJobCosting ? "I" : "AG"}${rNum}`, values: [[targetRev]] });
    }
    const dcFormula = String(fRow[isJobCosting ? 10 : 33] ?? "").trim();
    if (!dcFormula.startsWith("=")) {
      batchData.push({ range: `Confirmed!${isJobCosting ? "K" : "AH"}${rNum}`, values: [[targetDC]] });
    }

    const s1Ref = String(row[42] ?? "").trim();
    const s1Status = String(row[45] ?? "").trim().toLowerCase();
    const apFormula = String(fRow[41] ?? "").trim();
    if ((!s1Ref || isPlaceholderInvoice(s1Ref, s1Status)) && !s1Status.includes("sent") && !s1Status.includes("paid") && !apFormula.startsWith("=")) {
      batchData.push({ range: `Confirmed!AP${rNum}`, values: [[targetRev]] });
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        _skipFormulaRecompute: true,
        requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
      })
    );

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, masterSheetId, ["retainers", "jobs", "invoices", "outgoings", "cash", "views"]).catch(() => { });
    return res.status(200).json({
      success: true,
      rowNum: rNum,
      revenue: targetRev,
      directCosts: targetDC,
      overrideRev: newOverrideRev,
      overrideDc: newOverrideDc,
    });
  } catch (err) {
    console.error("❌ update_variable_retainer_month error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Unified single-job save for a Variable Retainer series from Pulse Portal / PMA:
 * saves shared job metadata (Client, Job name, Project code, VAT, Date confirmed,
 * Product line, Lead source, End date / No end date), base forecast updates from an
 * effective month onward, per-month forecast overrides, and per-month invoice &
 * direct-cost changes (inserting overflow child rows when needed and keeping formula cells intact).
 */
export async function handleSaveVariableRetainerSeries_(req, res, sheets, { verifiedClientName, sessionUser } = {}) {
  const { clientSheetId, masterSheetId, clientName, job } = req.body || {};
  if (!clientSheetId || !job) {
    return res.status(400).json({ success: false, error: "clientSheetId and job object are required" });
  }

  const newClient = String(job.client || "").trim();
  const newSeriesName = String(job.jobName || "").replace(/[\r\n\t]+/g, " ").replace(/\|/g, "-").trim();
  if (!newClient || !newSeriesName) {
    return res.status(400).json({ success: false, error: "Client name and job name are required." });
  }

  const newBaseRev = Math.round(retParseMoney(job.revenue) * 100) / 100;
  const newBaseDC = Math.round(retParseMoney(job.directCosts) * 100) / 100;
  if (!(newBaseRev > 0) || newBaseDC < 0) {
    return res.status(400).json({ success: false, error: "Base monthly revenue must be greater than zero and direct costs cannot be negative." });
  }

  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resolvedMasterId =
      (masterSheetId ? (extractSheetIdFromUrl(masterSheetId) || masterSheetId) : null) ||
      (await resolveMasterSheetIdForClient_(sheets, sheetIdClean, verifiedClientName || clientName || ""));

    const [valResp, formResp, metaResp, tolerance] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:BJ5000",
        valueRenderOption: "FORMULA",
      }),
      sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
      }),
      getToleranceValues(sheets, resolvedMasterId || sheetIdClean),
    ]);

    const rows = valResp.data?.values || [];
    let formRows = formResp.data?.values || [];
    const confirmedSheet = (metaResp.data?.sheets || []).find(s => s.properties?.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    const gridSheetId = confirmedSheet.properties.sheetId;

    const searchClient = String(job.originalClient || newClient).trim().toLowerCase();
    const searchSeries = String(job.originalSeriesName || newSeriesName).trim().toLowerCase();
    const allSeries = retFindVariableRetainerSeries(rows);
    const targetSeries = allSeries.find(
      s => s.client.toLowerCase() === searchClient && s.seriesName.toLowerCase() === searchSeries
    );
    if (!targetSeries || targetSeries.months.length === 0) {
      return res.status(404).json({ success: false, error: "Variable retainer series not found." });
    }

    const isJobCosting = isJobCostingStyle({ headers: rows[0] || [] });
    const isNoEnd = Boolean(job.noEndDate || isNoEndDateSentinel(job.endDate));
    const parsedEnd = isNoEnd ? new Date(2050, 11, 31) : retParseSheetDate(job.endDate);
    if (!parsedEnd) return res.status(400).json({ success: false, error: "Invalid end date" });
    const firstMonthStart =
      targetSeries.startDateObj ||
      targetSeries.months[0]?.startDate ||
      retParseSheetDate(targetSeries.months[0]?.row?.[37]);
    if (!isNoEnd && firstMonthStart && parsedEnd.getTime() < firstMonthStart.getTime()) {
      return res.status(400).json({ success: false, error: "End date cannot be earlier than start date." });
    }
    const formattedEnd = retFmtDate(parsedEnd);
    const newEndMonthVal = parsedEnd.getFullYear() * 12 + parsedEnd.getMonth();

    const parsedSendDay = parseInt(job.sendDay, 10);
    const newSendDay = (!isNaN(parsedSendDay) && parsedSendDay >= 1 && parsedSendDay <= 31)
      ? Math.min(28, parsedSendDay)
      : (targetSeries.sendDay || 28);
    const parsedDefDays = parseInt(String(tolerance?.defaultDaysToPay ?? "").replace(/[^\d.-]/g, ""), 10);
    const defaultDaysToPay = !isNaN(parsedDefDays) && parsedDefDays >= 0 && parsedDefDays <= 365 ? parsedDefDays : 30;
    const expDay = parseInt(tolerance?.retainerExpenseDay, 10) > 0 ? Math.min(28, parseInt(tolerance.retainerExpenseDay, 10)) : 28;

    let effMonthVal = null;
    if (job.effectiveMonth && /^\d{4}-\d{2}$/.test(String(job.effectiveMonth).trim())) {
      const [ey, em] = String(job.effectiveMonth).trim().split("-").map(Number);
      effMonthVal = ey * 12 + (em - 1);
    }

    const rowsToTrim = [];
    const keptMonthsRaw = [];
    for (const m of targetSeries.months) {
      const mStart = m.startDate || retParseSheetDate(m.row[37]);
      if (!mStart) continue;
      const mMonthVal = mStart.getFullYear() * 12 + mStart.getMonth();
      if (mMonthVal > newEndMonthVal) rowsToTrim.push(m);
      else keptMonthsRaw.push({ ...m, mStart, mMonthVal });
    }

    for (const m of rowsToTrim) {
      const checkRows = [{ rowNum: m.rowNum, row: m.row }, ...m.overflowRows];
      const blocked = checkRows.find(cr => retRowHasRealData(cr.row));
      if (blocked) {
        return res.status(400).json({
          success: false,
          blocked: true,
          error: `Cannot shorten this variable retainer - month ending ${retFmtDate(m.startDate || new Date())} already has a real invoice or expense recorded.`,
        });
      }
    }

    // Group incoming invoices & expenses onto keptMonths
    const monthByRow = new Map();
    const monthByYm = new Map();
    for (const m of keptMonthsRaw) {
      monthByRow.set(m.rowNum, m);
      monthByYm.set(m.mMonthVal, m);
    }
    const nowDt = new Date();
    const curYm = nowDt.getFullYear() * 12 + nowDt.getMonth();
    const fallbackMonth = monthByYm.get(curYm) || keptMonthsRaw[0];

    const incomingInvsByRow = new Map();
    for (const inv of (Array.isArray(job.invoices) ? job.invoices : [])) {
      const amtNum = Math.round(retParseMoney(inv.amount) * 100) / 100;
      const refStr = String(inv.ref || "").trim();
      const dtStr = String(inv.sendDate || "").trim();
      const rechNum = Math.round(retParseMoney(inv.ofWhichRechgd) * 100) / 100;
      if (!refStr && amtNum === 0 && !dtStr && rechNum === 0) continue;

      let targetM = inv.monthRowNumber ? monthByRow.get(Number(inv.monthRowNumber)) : null;
      if (!targetM && dtStr) {
        const pd = retParseSheetDate(dtStr);
        if (pd) targetM = monthByYm.get(pd.getFullYear() * 12 + pd.getMonth()) || null;
      }
      if (!targetM) targetM = fallbackMonth;
      if (!targetM) continue;
      if (!incomingInvsByRow.has(targetM.rowNum)) incomingInvsByRow.set(targetM.rowNum, []);
      incomingInvsByRow.get(targetM.rowNum).push({
        amount: amtNum,
        ref: refStr,
        sendDate: dtStr ? (retFmtDate(retParseSheetDate(dtStr)) || dtStr) : "",
        days: String(inv.days || defaultDaysToPay || "30").trim(),
        status: canonicalizeInvoiceStatus(String(inv.status || "").trim()),
        ofWhichRechgd: rechNum,
        costMonth: String(inv.costMonth || "").trim(),
      });
    }

    const incomingExpsByRow = new Map();
    for (const exp of (Array.isArray(job.directExpenses) ? job.directExpenses : [])) {
      const amtNum = Math.round(retParseMoney(exp.amount) * 100) / 100;
      const descStr = String(exp.desc || "").trim();
      const dtStr = String(exp.recDate || "").trim();
      const appIdStr = String(exp.appId || "").trim();
      if (!descStr && amtNum === 0 && !dtStr && !appIdStr) continue;

      let targetM = exp.monthRowNumber ? monthByRow.get(Number(exp.monthRowNumber)) : null;
      if (!targetM && dtStr) {
        const pd = retParseSheetDate(dtStr);
        if (pd) targetM = monthByYm.get(pd.getFullYear() * 12 + pd.getMonth()) || null;
      }
      if (!targetM) targetM = fallbackMonth;
      if (!targetM) continue;
      if (!incomingExpsByRow.has(targetM.rowNum)) incomingExpsByRow.set(targetM.rowNum, []);
      incomingExpsByRow.get(targetM.rowNum).push({
        desc: descStr,
        amount: amtNum,
        vat: String(exp.vat || "Yes").trim() || "Yes",
        recDate: dtStr ? (retFmtDate(retParseSheetDate(dtStr)) || dtStr) : "",
        days: String(exp.days || defaultDaysToPay || "30").trim(),
        status: canonicalizeExpenseStatus(String(exp.status || "").trim()),
        appId: appIdStr,
      });
    }

    const readExistingInvsForMonth_ = (m) => {
      const out = [];
      for (const rArr of [m.row, ...m.overflowRows.map(o => o.row)]) {
        for (const base of [41, 48, 55]) {
          const amt = Math.round(retParseMoney(rArr[base]) * 100) / 100;
          const ref = String(rArr[base + 1] ?? "").trim();
          const sd = rArr[base + 2] ? (retFmtDate(retParseSheetDate(rArr[base + 2])) || String(rArr[base + 2]).trim()) : "";
          const days = String(rArr[base + 3] ?? "").trim();
          const st = canonicalizeInvoiceStatus(String(rArr[base + 4] ?? "").trim());
          const rech = Math.round(retParseMoney(rArr[base + 5]) * 100) / 100;
          const cm = String(rArr[base + 6] ?? "").trim();
          if (ref || amt !== 0 || sd || rech !== 0) {
            out.push({ amount: amt, ref, sendDate: sd, days, status: st, ofWhichRechgd: rech, costMonth: cm });
          }
        }
      }
      return out;
    };

    const readExistingExpsForMonth_ = (m) => {
      const out = [];
      for (const rArr of [m.row, ...m.overflowRows.map(o => o.row)]) {
        for (const base of [75, 82, 89]) {
          const desc = String(rArr[base] ?? "").trim();
          const amt = Math.round(retParseMoney(rArr[base + 1]) * 100) / 100;
          const vatV = String(rArr[base + 2] ?? "").trim();
          const rd = rArr[base + 3] ? (retFmtDate(retParseSheetDate(rArr[base + 3])) || String(rArr[base + 3]).trim()) : "";
          const days = String(rArr[base + 4] ?? "").trim();
          const st = canonicalizeExpenseStatus(String(rArr[base + 5] ?? "").trim());
          const appId = String(rArr[base + 6] ?? "").trim();
          if (desc || amt !== 0 || rd || appId) {
            out.push({ desc, amount: amt, vat: vatV, recDate: rd, days, status: st, appId });
          }
        }
      }
      return out;
    };

    const invListChanged_ = (a, b) => {
      if (a.length !== b.length) return true;
      for (let idx = 0; idx < a.length; idx++) {
        if (
          Math.abs((a[idx].amount || 0) - (b[idx].amount || 0)) > 0.01 ||
          a[idx].ref !== b[idx].ref ||
          a[idx].sendDate !== b[idx].sendDate ||
          String(a[idx].days || "30") !== String(b[idx].days || "30") ||
          a[idx].status !== b[idx].status ||
          Math.abs((a[idx].ofWhichRechgd || 0) - (b[idx].ofWhichRechgd || 0)) > 0.01 ||
          a[idx].costMonth !== b[idx].costMonth
        ) return true;
      }
      return false;
    };

    const expListChanged_ = (a, b) => {
      if (a.length !== b.length) return true;
      for (let idx = 0; idx < a.length; idx++) {
        if (
          a[idx].desc !== b[idx].desc ||
          Math.abs((a[idx].amount || 0) - (b[idx].amount || 0)) > 0.01 ||
          String(a[idx].vat || "Yes") !== String(b[idx].vat || "Yes") ||
          a[idx].recDate !== b[idx].recDate ||
          String(a[idx].days || "30") !== String(b[idx].days || "30") ||
          a[idx].status !== b[idx].status ||
          a[idx].appId !== b[idx].appId
        ) return true;
      }
      return false;
    };

    // Determine per-month change flags & required extra overflow child rows
    const monthPlan = keptMonthsRaw.map((m) => {
      const nextInvs = incomingInvsByRow.get(m.rowNum) || [];
      const curInvs = readExistingInvsForMonth_(m);
      const nextExps = incomingExpsByRow.get(m.rowNum) || [];
      const curExps = readExistingExpsForMonth_(m);
      const invsChanged = invListChanged_(curInvs, nextInvs);
      const expsChanged = expListChanged_(curExps, nextExps);
      const rowsNeededForInvs = invsChanged ? Math.max(1, Math.ceil(nextInvs.length / 3)) : 1;
      const rowsNeededForExps = expsChanged ? Math.max(1, Math.ceil(nextExps.length / 3)) : 1;
      const totalRowsNeeded = Math.max(1 + m.overflowRows.length, rowsNeededForInvs, rowsNeededForExps);
      const extraRowsToInsert = Math.max(0, totalRowsNeeded - (1 + m.overflowRows.length));
      return {
        origRowNum: m.rowNum,
        m,
        nextInvs,
        nextExps,
        invsChanged,
        expsChanged,
        extraRowsToInsert,
      };
    });

    // If any month needs additional overflow child rows, insert bottom-up so row numbers shift cleanly
    const insertions = monthPlan.filter(p => p.extraRowsToInsert > 0).sort((a, b) => b.m.rowNum - a.m.rowNum);
    if (insertions.length > 0) {
      const dimRequests = insertions.map((p) => {
        const lastRowNum = p.m.overflowRows.length > 0
          ? p.m.overflowRows[p.m.overflowRows.length - 1].rowNum
          : p.m.rowNum;
        return {
          insertDimension: {
            range: {
              sheetId: gridSheetId,
              dimension: "ROWS",
              startIndex: lastRowNum, // 0-based index directly below lastRowNum (1-based)
              endIndex: lastRowNum + p.extraRowsToInsert,
            },
            inheritFromBefore: false,
          },
        };
      });
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: dimRequests },
          _skipFormulaRecompute: true,
        })
      );
      // Update rowNum offsets after bottom-up insertions
      for (const ins of insertions) {
        const insertAfter = ins.m.overflowRows.length > 0
          ? ins.m.overflowRows[ins.m.overflowRows.length - 1].rowNum
          : ins.m.rowNum;
        const delta = ins.extraRowsToInsert;
        for (let k = 0; k < delta; k++) {
          ins.m.overflowRows.push({ rowNum: insertAfter + 1 + k, row: [], newlyInserted: true });
        }
        for (const other of monthPlan) {
          if (other.m.rowNum > insertAfter) other.m.rowNum += delta;
          for (const ov of other.m.overflowRows) {
            if (!ov.newlyInserted && ov.rowNum > insertAfter) ov.rowNum += delta;
          }
        }
        for (const tm of rowsToTrim) {
          if (tm.rowNum > insertAfter) tm.rowNum += delta;
          for (const ov of tm.overflowRows) {
            if (ov.rowNum > insertAfter) ov.rowNum += delta;
          }
        }
      }
      const fReload = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:BJ5000",
        valueRenderOption: "FORMULA",
      });
      formRows = fReload.data?.values || formRows;
    }

    // Forecast override map keyed by original rowNumber from UI
    const forecastEditMap = new Map();
    for (const vf of (Array.isArray(job.varMonthForecasts) ? job.varMonthForecasts : [])) {
      const rn = parseInt(vf.rowNumber, 10);
      if (rn >= 2) forecastEditMap.set(rn, vf);
    }

    const cleanProjectCode = sanitizeFormulaInput(String(job.projectCode ?? "").trim());
    const cleanLeadSrc = sanitizeFormulaInput(String(job.leadSource ?? "").trim());
    const cleanVat = sanitizeFormulaInput(String(job.vat || "Yes").trim() || "Yes");
    const cleanProdLine = sanitizeFormulaInput(String(job.productLine ?? "").trim());
    const parsedDateConf = job.dateConfirmed ? retParseSheetDate(job.dateConfirmed) : null;
    const formattedDateConf = parsedDateConf ? retFmtDate(parsedDateConf) : "";
    const hasAnyExistingDateConf = keptMonthsRaw.some(km => String(km.row[3] ?? "").trim() !== "");

    const batchData = [];
    const safeClientCell = sanitizeFormulaInput(newClient);

    for (let idx = 0; idx < monthPlan.length; idx++) {
      const plan = monthPlan[idx];
      const { origRowNum, m, nextInvs, nextExps, invsChanged, expsChanged } = plan;
      const rNum = m.rowNum;
      const fRow = formRows[rNum - 1] || [];
      const mJobName = formatVarRetainerMonthJobName(newSeriesName, m.mStart);
      const safeJobCell = sanitizeFormulaInput(mJobName);
      const hadDateConf = String(m.row[3] ?? "").trim() !== "";
      const isEffectiveBase = effMonthVal === null || m.mMonthVal >= effMonthVal;

      // Update shared parent fields
      batchData.push(
        { range: `Confirmed!A${rNum}:C${rNum}`, values: [[safeClientCell, safeJobCell, cleanProjectCode]] },
        { range: `Confirmed!E${rNum}`, values: [[cleanLeadSrc]] },
        { range: `Confirmed!AI${rNum}:AJ${rNum}`, values: [[cleanVat, "Retainer"]] },
        { range: `Confirmed!AK${rNum}`, values: [[cleanProdLine]] }
      );
      if (hadDateConf || (!hasAnyExistingDateConf && idx === 0 && formattedDateConf)) {
        batchData.push({ range: `Confirmed!D${rNum}`, values: [[formattedDateConf]] });
      }
      for (const ov of m.overflowRows) {
        batchData.push(
          { range: `Confirmed!A${ov.rowNum}:B${ov.rowNum}`, values: [[safeClientCell, safeJobCell]] },
          { range: `Confirmed!AI${ov.rowNum}`, values: [[cleanVat]] }
        );
      }

      // Evaluate real invoices & real bills for this month (after any incoming changes)
      const effInvs = invsChanged ? nextInvs : readExistingInvsForMonth_(m);
      const realInvs = effInvs.filter(inv => {
        const r = String(inv.ref || "").trim();
        const st = String(inv.status || "").trim().toLowerCase();
        return (r && !isPlaceholderInvoice(r, st)) || st.includes("sent") || st.includes("paid");
      });
      const realInvFeeTotal = Math.round(realInvs.reduce((s, inv) => s + Math.max(0, (inv.amount || 0) - (inv.ofWhichRechgd || 0)), 0) * 100) / 100;

      const effExps = expsChanged ? nextExps : readExistingExpsForMonth_(m);
      const realBillsTotal = Math.round(
        effExps
          .filter(exp => {
            const st = String(exp.status || "").trim().toLowerCase();
            return (exp.amount || 0) > 0 && (!isPlaceholderExpense(exp.appId, exp.desc, st) || st === "paid" || st === "received");
          })
          .reduce((s, exp) => s + (exp.amount || 0), 0) * 100
      ) / 100;

      // Determine revenue & direct costs forecast / override for this month
      const curRev = Math.round(retParseMoney(m.row[32]) * 100) / 100;
      const curDC = Math.round(retParseMoney(m.row[33]) * 100) / 100;
      const vf = forecastEditMap.get(origRowNum);

      let targetRev = curRev;
      let targetDC = curDC;
      let nextOverrideRev = Boolean(m.vrMeta?.overrideRev);
      let nextOverrideDc = Boolean(m.vrMeta?.overrideDc);

      if (vf?.resetToBase) {
        targetRev = newBaseRev;
        targetDC = newBaseDC;
        nextOverrideRev = false;
        nextOverrideDc = false;
      } else {
        const uiRev = vf ? Math.round(retParseMoney(vf.revenue) * 100) / 100 : curRev;
        const uiOrigRev = vf ? Math.round(retParseMoney(vf.origRevenue) * 100) / 100 : curRev;
        const uiDc = vf ? Math.round(retParseMoney(vf.directCosts) * 100) / 100 : curDC;
        const uiOrigDc = vf ? Math.round(retParseMoney(vf.origDirectCosts) * 100) / 100 : curDC;

        if (vf && Math.abs(uiRev - uiOrigRev) > 0.01) {
          targetRev = uiRev;
          nextOverrideRev = Math.abs(uiRev - newBaseRev) > 0.005;
        } else if (isEffectiveBase && realInvs.length === 0 && !nextOverrideRev) {
          targetRev = newBaseRev;
        }

        if (vf && Math.abs(uiDc - uiOrigDc) > 0.01) {
          targetDC = uiDc;
          nextOverrideDc = Math.abs(uiDc - newBaseDC) > 0.005;
        } else if (isEffectiveBase && !nextOverrideDc && realBillsTotal <= newBaseDC + 0.01) {
          targetDC = newBaseDC;
        }
      }

      if (invsChanged && realInvs.length > 0 && realInvFeeTotal > 0 && !vf?.resetToBase) {
        targetRev = realInvFeeTotal;
      }
      if (realBillsTotal > targetDC + 0.01) {
        targetDC = realBillsTotal;
      }

      const revFormula = String(fRow[isJobCosting ? 8 : 32] ?? "").trim();
      const dcFormula = String(fRow[isJobCosting ? 10 : 33] ?? "").trim();
      const apFormula = String(fRow[41] ?? "").trim();

      if (!revFormula.startsWith("=") && Math.abs(targetRev - curRev) > 0.01) {
        batchData.push({ range: `Confirmed!${isJobCosting ? "I" : "AG"}${rNum}`, values: [[targetRev]] });
      }
      if (!dcFormula.startsWith("=") && Math.abs(targetDC - curDC) > 0.01) {
        batchData.push({ range: `Confirmed!${isJobCosting ? "K" : "AH"}${rNum}`, values: [[targetDC]] });
      }

      const monthBaseRevTag = isEffectiveBase ? newBaseRev : (m.vrMeta?.baseRev ?? newBaseRev);
      const monthBaseDcTag = isEffectiveBase ? newBaseDC : (m.vrMeta?.baseDC ?? newBaseDC);
      const newTag = formatVariableRetainerTag({
        seriesName: newSeriesName,
        baseRev: monthBaseRevTag,
        baseDC: monthBaseDcTag,
        endDate: formattedEnd,
        noEndDate: isNoEnd,
        sendDay: newSendDay,
        overrideRev: nextOverrideRev,
        overrideDc: nextOverrideDc,
      });
      batchData.push({ range: `Confirmed!AE${rNum}`, values: [[newTag]] });

      // Write changed invoices across parent + overflow rows (or update Slot 1 planned forecast if rev changed)
      if (invsChanged) {
        const allMonthRows = [m, ...m.overflowRows];
        const invCols = [
          { start: "AP", end: "AV" },
          { start: "AW", end: "BC" },
          { start: "BD", end: "BJ" },
        ];
        allMonthRows.forEach((mr, rOffset) => {
          const mrForm = formRows[mr.rowNum - 1] || [];
          invCols.forEach((sc, sIdx) => {
            const slotIdx = rOffset * 3 + sIdx;
            const item = nextInvs[slotIdx];
            const firstCellFormula = sIdx === 0 && rOffset === 0 ? String(mrForm[41] ?? "").trim() : "";
            if (item) {
              const refFormatted = formatInvoiceRefForSheet(item.ref);
              const amtVal = (firstCellFormula.startsWith("=") && sIdx === 0 && rOffset === 0) ? firstCellFormula : item.amount;
              batchData.push({
                range: `Confirmed!${sc.start}${mr.rowNum}:${sc.end}${mr.rowNum}`,
                values: [[
                  amtVal,
                  sanitizeFormulaInput(refFormatted),
                  sanitizeFormulaInput(item.sendDate),
                  item.days || defaultDaysToPay || "30",
                  sanitizeFormulaInput(item.status),
                  item.ofWhichRechgd > 0 ? item.ofWhichRechgd : "",
                  sanitizeFormulaInput(item.costMonth),
                ]],
              });
            } else if (!firstCellFormula.startsWith("=")) {
              batchData.push({
                range: `Confirmed!${sc.start}${mr.rowNum}:${sc.end}${mr.rowNum}`,
                values: [["", "", "", "", "", "", ""]],
              });
            }
          });
        });
      } else if (realInvs.length === 0 && !apFormula.startsWith("=")) {
        const s1Ref = String(m.row[42] ?? "").trim();
        const s1Status = String(m.row[45] ?? "").trim().toLowerCase();
        if ((!s1Ref || isPlaceholderInvoice(s1Ref, s1Status)) && !s1Status.includes("sent") && !s1Status.includes("paid")) {
          const maxDim = new Date(m.mStart.getFullYear(), m.mStart.getMonth() + 1, 0).getDate();
          const sendDateStr = retFmtDate(new Date(m.mStart.getFullYear(), m.mStart.getMonth(), Math.min(newSendDay, maxDim)));
          batchData.push(
            { range: `Confirmed!AP${rNum}`, values: [[targetRev]] },
            { range: `Confirmed!AR${rNum}`, values: [[sendDateStr]] }
          );
        }
      }

      // Write changed direct expenses across parent + overflow rows
      if (expsChanged) {
        const allMonthRows = [m, ...m.overflowRows];
        const expCols = [
          { start: "BX", end: "CD" },
          { start: "CE", end: "CK" },
          { start: "CL", end: "CR" },
        ];
        allMonthRows.forEach((mr, rOffset) => {
          expCols.forEach((sc, sIdx) => {
            const slotIdx = rOffset * 3 + sIdx;
            const item = nextExps[slotIdx];
            if (item) {
              batchData.push({
                range: `Confirmed!${sc.start}${mr.rowNum}:${sc.end}${mr.rowNum}`,
                values: [[
                  sanitizeFormulaInput(item.desc),
                  item.amount,
                  sanitizeFormulaInput(item.vat || "Yes"),
                  sanitizeFormulaInput(item.recDate),
                  item.days || defaultDaysToPay || "30",
                  sanitizeFormulaInput(item.status),
                  sanitizeFormulaInput(item.appId),
                ]],
              });
            } else {
              batchData.push({
                range: `Confirmed!${sc.start}${mr.rowNum}:${sc.end}${mr.rowNum}`,
                values: [["", "", "", "", "", "", ""]],
              });
            }
          });
        });
      }
    }

    // Clear any shortened tail months (already verified safe above)
    const clearRowNums = [];
    for (const m of rowsToTrim) {
      clearRowNums.push(m.rowNum, ...m.overflowRows.map(o => o.rowNum));
    }
    if (clearRowNums.length > 0) {
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName: "Confirmed",
        rowNums: clearRowNums,
        isJobCosting,
        includeCopiedCol: false,
      });
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { ranges: clearRanges },
        })
      );
      if (restoreData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetIdClean,
            _skipFormulaRecompute: true,
            requestBody: { valueInputOption: "USER_ENTERED", data: restoreData },
          })
        );
      }
    }

    // Grow future runway if extended up to min(endDate, currentMonth + 18)
    const lastKept = monthPlan[monthPlan.length - 1];
    if (lastKept) {
      const maxFutureMonthVal = nowDt.getFullYear() * 12 + nowDt.getMonth() + 18;
      const targetLastVal = Math.min(newEndMonthVal, maxFutureMonthVal);
      const lastKeptVal = lastKept.m.mMonthVal;
      if (targetLastVal > lastKeptVal) {
        const freshAfterOps = (await sheets.spreadsheets.values.get({
          spreadsheetId: sheetIdClean,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "UNFORMATTED_VALUE",
        })).data?.values || rows;
        const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshAfterOps);
        const currentMaxRows = confirmedSheet.properties.gridProperties?.rowCount || 5000;
        const toGrow = targetLastVal - lastKeptVal;
        if (currentMaxRows - (trueLastRow + 1) < toGrow) {
          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: sheetIdClean,
              requestBody: {
                requests: [{
                  insertDimension: {
                    range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + (toGrow - (currentMaxRows - (trueLastRow + 1)) + 5) },
                    inheritFromBefore: true,
                  },
                }],
              },
              _skipFormulaRecompute: true,
            })
          );
        }
        const aeTagNew = formatVariableRetainerTag({
          seriesName: newSeriesName,
          baseRev: newBaseRev,
          baseDC: newBaseDC,
          endDate: formattedEnd,
          noEndDate: isNoEnd,
          sendDay: newSendDay,
        });
        for (let k = 1; k <= toGrow; k++) {
          const mVal = lastKeptVal + k;
          const yr = Math.floor(mVal / 12);
          const mo = ((mVal % 12) + 12) % 12;
          const mStart = new Date(yr, mo, 1);
          const mEnd = new Date(yr, mo + 1, 0);
          const rNum = trueLastRow + k;
          const mJobName = formatVarRetainerMonthJobName(newSeriesName, mStart);
          const maxDim = mEnd.getDate();
          const invDateStr = retFmtDate(new Date(yr, mo, Math.min(newSendDay, maxDim)));
          const expDateStr = retFmtDate(new Date(yr, mo, Math.min(expDay, maxDim)));
          batchData.push(
            { range: `Confirmed!A${rNum}:C${rNum}`, values: [[safeClientCell, sanitizeFormulaInput(mJobName), cleanProjectCode]] },
            { range: `Confirmed!E${rNum}`, values: [[cleanLeadSrc]] },
            { range: `Confirmed!AE${rNum}`, values: [[aeTagNew]] },
            { range: `Confirmed!AI${rNum}:AK${rNum}`, values: [[cleanVat, "Retainer", cleanProdLine]] },
            { range: `Confirmed!AP${rNum}:AT${rNum}`, values: [[newBaseRev, "", invDateStr, defaultDaysToPay, ""]] }
          );
          if (isJobCosting) {
            batchData.push(
              { range: `Confirmed!F${rNum}:G${rNum}`, values: [[retFmtDate(mStart), retFmtDate(mEnd)]] },
              { range: `Confirmed!I${rNum}`, values: [[newBaseRev]] },
              ...(newBaseDC > 0 ? [{ range: `Confirmed!K${rNum}`, values: [[newBaseDC]] }] : [])
            );
            const jcMap = getJobCostingRowFormulasLetterMap("Confirmed", rNum, { hasExplicitContractorCosts: newBaseDC > 0 });
            for (const [fCol, fStr] of Object.entries(jcMap)) {
              batchData.push({ range: `Confirmed!${fCol}${rNum}`, values: [[fStr]] });
            }
          } else {
            batchData.push(
              { range: `Confirmed!AG${rNum}:AH${rNum}`, values: [[newBaseRev, newBaseDC]] },
              { range: `Confirmed!AL${rNum}:AM${rNum}`, values: [[retFmtDate(mStart), retFmtDate(mEnd)]] }
            );
          }
          if (newBaseDC > 0) {
            const mShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo];
            const rand4 = Math.floor(1000 + Math.random() * 9000);
            batchData.push({
              range: `Confirmed!BX${rNum}:CD${rNum}`,
              values: [["Placeholder - Direct cost", newBaseDC, cleanVat, expDateStr, defaultDaysToPay, "", `PLACE-EXP-${mShort}-${String(yr).slice(-2)}-${rand4}`]],
            });
          }
        }
      }
    }

    if (batchData.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          _skipFormulaRecompute: true,
          requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
        })
      );
    }

    await flushAndInvalidateRetainerCache_(sheets, sheetIdClean, resolvedMasterId, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]);
    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: verifiedClientName || clientName || "Client",
      category: "JOB",
      action: "JOB_MODIFIED",
      summary: `Updated variable retainer series "${newSeriesName}" for ${newClient}`,
      details: { client: newClient, jobName: newSeriesName, baseRevenue: newBaseRev, baseDirectCosts: newBaseDC },
      user: sessionUser?.name || sessionUser?.email || "",
    }).catch(() => { });

    return res.status(200).json({ success: true, sheetName: "Confirmed", childRowNumbers: [] });
  } catch (err) {
    console.error("❌ handleSaveVariableRetainerSeries_ error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}