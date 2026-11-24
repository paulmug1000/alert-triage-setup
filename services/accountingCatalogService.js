import { waitUntil } from "@vercel/functions";
import {
  withRetry,
  extractSheetIdFromUrl,
  colIndexToLetter,
  getSheetGid,
} from "./sheetsClient.js";
import {
  getToleranceValues,
  buildInvFromAppMetaMap,
  lookupInvFromAppMeta,
} from "./sharedHelpers.js";
import { unwrapSheetId, sanitizeFormulaInput } from "./userPermissions.js";
import { resolveSupabaseSheetContext, flushImmediateAndScheduleBackgroundClientRecomputes } from "./masterEngineService.js";
import { resolveAuthoritativeJobAnchor } from "./relationalJobsService.js";
import { runNativeMasterAmdAction } from "./masterSyncEngine.js";
import {
  probeExternalAccountingFingerprint,
  captureAccountingPreflightBaseline,
} from "./accountingPreflightService.js";
import { getSupabaseAdmin } from "./supabaseClient.js";
import { redisClient, ensureRedisConnected } from "./redisClient.js";
import { memoryCache, invalidatePmaClientCache } from "./cacheService.js";
import { resolveAssignedAlertsInMemoryAndCache } from "./alertState.js";
import { logPmaActivity } from "./pmaLogger.js";
import { logPulseActivity } from "./pulseLogger.js";
import { buildRetainerChildPlaceholderSlot } from "./retainers.js";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  formatInvoiceRefForSheet,
  toSheetDateFormat,
  parseSheetDate,
  canonicalizeInvoiceStatus,
  canonicalizeExpenseStatus,
  classifyExpenseCategory,
  isJobCostingStyle,
  sanitizeSpreadsheetTerms,
  hasActiveAccountingIntegration,
  isFixedScheduleRetainer,
  isVariableRetainerRow,
} from "../utils/helpers.js";
import {
  resetInvoiceSlotFormatting_,
  resetExpenseSlotFormatting_,
  resolveMasterSheetIdForClient_,
  isAutoInvoicePlaceholderRef_,
  isAutoExpensePlaceholderId_,
  resolveFullJobRowGroup_,
  applySlotNoteAndFormattingRelocations_,
  mergeSlotBatchWrites_,
  runAdjustAndNormalizeJobSlots_,
  resolveClientNameBySheetId,
  getSharedClientConfirmedAndKeyInfo,
  parseOutgoingsMonthHeaders_,
  parseOutgoingsNoteParts_,
  insertChildJobRow_,
  sanitizeOutgNotesVal_,
  buildUpdatedCosNote_,
  resolveMasterIdForOutgoings_,
  syncOutgNotesAndTriggerRefresh_,
  cleanNoteBlockField_,
} from "./workspaces.js";

const MAX_BATCH_OPERATIONS = 50;
const ALLOWED_LOOKBACK_MONTHS = new Set([3, 6, 12]);
const INV_SLOT_COLS = {
  1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT", rech: "AU", cm: "AV", base: 41 },
  2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA", rech: "BB", cm: "BC", base: 48 },
  3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH", rech: "BI", cm: "BJ", base: 55 },
};
const EXP_SLOT_COLS = {
  1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD", base: 75 },
  2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK", base: 82 },
  3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR", base: 89 },
};
const OUTGOINGS_MONTHLY_COL_RANGES = [
  [6, 17],  // G..R
  [21, 32], // V..AG
  [36, 47], // AK..AV
];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEGAL_SUFFIX_RE = /\b(ltd|limited|inc|incorporated|llp|llc|plc|gmbh|pty|co|company|group|uk)\b/g;

function normalizeStr_(v) {
  return String(v ?? "").trim();
}

function normalizeKey_(v) {
  return normalizeStr_(v).toLowerCase();
}

function cleanProjectCode_(v) {
  const s = normalizeKey_(v);
  return ["", "-", "n/a", "none", "—"].includes(s) ? "" : s;
}

function parseMoney_(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const n = parseFloat(String(val ?? "").replace(/[£$€,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function hasNonZeroMoney_(val) {
  return Math.abs(parseMoney_(val)) > 0.001;
}

function normalizeEntityName_(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize_(raw) {
  const norm = normalizeEntityName_(raw);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t.length >= 2);
}

function bigrams_(str) {
  const s = normalizeEntityName_(str).replace(/\s+/g, "");
  if (s.length < 2) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    out.push(s.slice(i, i + 2));
  }
  return out;
}

function diceSimilarity_(a, b) {
  const bgA = bigrams_(a);
  const bgB = bigrams_(b);
  if (bgA.length === 0 || bgB.length === 0) return 0;
  const counts = new Map();
  for (const g of bgA) counts.set(g, (counts.get(g) || 0) + 1);
  let hits = 0;
  for (const g of bgB) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      hits++;
      counts.set(g, c - 1);
    }
  }
  return (2 * hits) / (bgA.length + bgB.length);
}

function tokenJaccard_(a, b) {
  const tA = new Set(tokenize_(a));
  const tB = new Set(tokenize_(b));
  if (tA.size === 0 || tB.size === 0) return 0;
  let inter = 0;
  for (const t of tA) {
    if (tB.has(t)) inter++;
  }
  const union = tA.size + tB.size - inter;
  return union > 0 ? inter / union : 0;
}

function computeTextSimilarity_(a, b) {
  const na = normalizeEntityName_(a);
  const nb = normalizeEntityName_(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.startsWith(nb) || nb.startsWith(na) || na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return shorter >= 3 ? Math.round(75 + 20 * (shorter / longer)) : 60;
  }
  const jac = tokenJaccard_(na, nb);
  const dice = diceSimilarity_(na, nb);
  return Math.round(Math.max(jac * 75, dice * 70, (jac * 0.55 + dice * 0.45) * 78));
}

function parseAnyDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  if (typeof val === "number" && Number.isFinite(val) && val > 25000 && val < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + val * 86400000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const str = String(val).trim();
  if (!str || str === "—") return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n > 25000 && n < 90000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const viaSheet = parseSheetDate(str);
  if (viaSheet && !Number.isNaN(viaSheet.getTime())) return viaSheet;
  const iso = new Date(str);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function formatDateDisplay_(val) {
  const d = parseAnyDate_(val);
  if (!d) return normalizeStr_(val);
  return `${d.getDate()}-${MONTH_NAMES[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

function toMonthKey_(val) {
  const d = parseAnyDate_(val);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Scores how likely an accounting item belongs to a target job.
 */
export function scoreAccountingItemMatch(item, targetJob, itemType = "invoice") {
  if (!item || !targetJob) return { score: 0, isLikelyMatch: false };

  const targetClient = normalizeStr_(targetJob.client);
  const targetName = normalizeStr_(targetJob.jobName);
  const targetCode = cleanProjectCode_(targetJob.projectCode);

  if (itemType === "invoice") {
    const invClient = normalizeStr_(item.client);
    let score = computeTextSimilarity_(invClient, targetClient);
    const invJobText = `${normalizeStr_(item.job)} ${normalizeStr_(item.reference)}`.trim();
    if (targetCode && invJobText.toLowerCase().includes(targetCode)) {
      score = Math.min(100, score + 15);
    } else if (targetName && invJobText) {
      const jobSim = computeTextSimilarity_(invJobText, targetName);
      if (jobSim >= 50) score = Math.min(100, score + 10);
    }
    return { score, isLikelyMatch: score >= 45 };
  }

  // Direct costs: supplier/vendor is in contactName, while job hints live in description / reference
  const itemFields = [
    normalizeStr_(item.description),
    normalizeStr_(item.reference),
    normalizeStr_(item.contactName),
  ].filter(Boolean);
  const combinedLower = itemFields.join(" ").toLowerCase();

  let bestTextScore = 0;
  if (targetCode && combinedLower.includes(targetCode)) {
    bestTextScore = 95;
  } else {
    const queries = [targetName, targetClient].filter(Boolean);
    for (const q of queries) {
      for (const f of itemFields) {
        const sim = computeTextSimilarity_(f, q);
        if (sim > bestTextScore) bestTextScore = sim;
      }
      const nq = normalizeEntityName_(q);
      const nf = normalizeEntityName_(combinedLower);
      if (nq && nq.length >= 3 && nf.includes(nq)) {
        bestTextScore = Math.max(bestTextScore, 80);
      }
    }
  }

  // Date proximity bonus for bills near the job schedule
  let dateBonus = 0;
  const itemDate = parseAnyDate_(item.date);
  if (itemDate) {
    const startD = parseAnyDate_(targetJob.startDate);
    const endD = parseAnyDate_(targetJob.endDate);
    const ms = itemDate.getTime();
    if (startD && endD && !/no end/i.test(String(targetJob.endDate || ""))) {
      const minMs = startD.getTime() - 14 * 86400000;
      const maxMs = endD.getTime() + 30 * 86400000;
      if (ms >= minMs && ms <= maxMs) dateBonus = 15;
      else if (Math.abs(ms - startD.getTime()) <= 60 * 86400000 || Math.abs(ms - endD.getTime()) <= 60 * 86400000) {
        dateBonus = 8;
      }
    } else if (startD) {
      const diffDays = Math.abs(ms - startD.getTime()) / 86400000;
      if (diffDays <= 45) dateBonus = 15;
      else if (diffDays <= 90) dateBonus = 8;
    }
  }

  const totalScore = Math.min(100, bestTextScore + (bestTextScore >= 15 ? dateBonus : Math.min(dateBonus, 8)));
  return { score: totalScore, isLikelyMatch: totalScore >= 35 };
}

function findHeaderCol_(headers, candidates, fallbackIdx) {
  if (Array.isArray(headers) && headers.length > 0) {
    const lowerHeaders = headers.map((h) => String(h ?? "").trim().toLowerCase());
    for (const cand of candidates) {
      const exact = lowerHeaders.indexOf(cand);
      if (exact !== -1) return exact;
    }
    for (const cand of candidates) {
      const partial = lowerHeaders.findIndex((h) => h && h.includes(cand));
      if (partial !== -1) return partial;
    }
  }
  return fallbackIdx;
}

function buildExpenseDescription_(exp) {
  const rawVendor = normalizeStr_(exp?.contactName);
  const rawDesc = normalizeStr_(exp?.description);
  const rawAccount = normalizeStr_(exp?.accountName);
  const bracketRegex = /^([^(]+?)\s*[\(\[]([^)\]]+)[\)\]]$/;

  let vendor = "";
  let description = "";

  if (rawVendor) {
    const vMatch = rawVendor.match(bracketRegex);
    if (vMatch) {
      vendor = vMatch[1].trim();
      description = vMatch[2].trim();
    } else {
      vendor = rawVendor;
    }
  }

  if (rawDesc) {
    const dMatch = rawDesc.match(bracketRegex);
    if (dMatch) {
      if (!vendor) vendor = dMatch[1].trim();
      if (!description || description === rawDesc) description = dMatch[2].trim();
    } else if (!description) {
      if (!vendor || rawDesc.toLowerCase() !== vendor.toLowerCase()) {
        description = rawDesc;
      }
    }
  }

  if (!vendor) {
    vendor = rawDesc || rawAccount || "Expense";
    if (vendor === description) description = "";
  }
  if (description && vendor && description.toLowerCase() === vendor.toLowerCase()) {
    description = "";
  }
  if (vendor && description) return `${vendor} (${description})`;
  return vendor || description || rawAccount || "Expense";
}

function parseConfirmedJobsAndSlots_(confRows = []) {
  const jobs = [];
  const invoiceSlotMap = new Map(); // lowerInvoiceNo -> [{ job, rowNum, slotNum, slot }]
  const expenseSlotMap = new Map(); // lowerAppId -> [{ job, rowNum, slotNum, slot }]

  let i = 1;
  while (i < confRows.length) {
    const row = confRows[i] || [];
    const client = normalizeStr_(row[0]);
    const jobName = normalizeStr_(row[1]);
    const projectCode = normalizeStr_(row[2]);
    const revStr = normalizeStr_(row[32]);
    const dcStr = normalizeStr_(row[33]);
    const typeStr = normalizeStr_(row[35]);
    const startStr = normalizeStr_(row[37]);
    const endStr = normalizeStr_(row[38]);
    const hasRech = hasNonZeroMoney_(row[17]);

    const isParentRow = Boolean(revStr || dcStr || typeStr || startStr || hasRech);
    if (!client && !jobName && !isParentRow) {
      i++;
      continue;
    }

    const parentRowNum = i + 1;
    const rowNums = [parentRowNum];
    let j = i + 1;
    while (j < confRows.length) {
      const next = confRows[j] || [];
      const nc = normalizeStr_(next[0]);
      const nj = normalizeStr_(next[1]);
      const nRev = normalizeStr_(next[32]);
      const nDc = normalizeStr_(next[33]);
      const nType = normalizeStr_(next[35]);
      const nStart = normalizeStr_(next[37]);
      const nRech = hasNonZeroMoney_(next[17]);
      if (
        nc.toLowerCase() === client.toLowerCase() &&
        nj.toLowerCase() === jobName.toLowerCase() &&
        !nRev &&
        !nDc &&
        !nType &&
        !nStart &&
        !nRech
      ) {
        rowNums.push(j + 1);
        j++;
      } else {
        break;
      }
    }

    const jobObj = {
      client,
      jobName,
      projectCode,
      isRetainer: typeStr.toLowerCase().includes("retainer"),
      isVariableRetainer: isVariableRetainerRow(row),
      parentRowNum,
      rowNums,
    };
    jobs.push(jobObj);

    for (const rNum of rowNums) {
      const r = confRows[rNum - 1] || [];
      for (let s = 1; s <= 3; s++) {
        const ic = INV_SLOT_COLS[s];
        const invAmt = r[ic.base];
        const invRef = normalizeStr_(r[ic.base + 1]);
        const invSent = normalizeStr_(r[ic.base + 2]);
        const invDays = normalizeStr_(r[ic.base + 3]) || "30";
        const invStatus = canonicalizeInvoiceStatus(r[ic.base + 4]);
        const invRech = r[ic.base + 5] ?? "";
        const invCm = normalizeStr_(r[ic.base + 6]);
        if (invRef && !isPlaceholderInvoice(invRef, invStatus)) {
          const key = invRef.toLowerCase();
          if (!invoiceSlotMap.has(key)) invoiceSlotMap.set(key, []);
          invoiceSlotMap.get(key).push({
            job: jobObj,
            rowNum: rNum,
            slotNum: s,
            slot: {
              ref: invRef,
              amount: invAmt,
              sentDate: formatDateDisplay_(invSent),
              daysToPay: invDays,
              status: invStatus,
              ofWhichRechgd: invRech,
              costMonth: invCm,
            },
          });
        }

        const ec = EXP_SLOT_COLS[s];
        const expDesc = normalizeStr_(r[ec.base]);
        const expAmt = r[ec.base + 1];
        const expVat = normalizeStr_(r[ec.base + 2]) || "No";
        const expDate = normalizeStr_(r[ec.base + 3]);
        const expDays = normalizeStr_(r[ec.base + 4]) || "30";
        const expStatus = canonicalizeExpenseStatus(r[ec.base + 5]);
        const expId = normalizeStr_(r[ec.base + 6]);
        if (expId && !isPlaceholderExpense(expId, expDesc, expStatus)) {
          const key = expId.toLowerCase();
          if (!expenseSlotMap.has(key)) expenseSlotMap.set(key, []);
          expenseSlotMap.get(key).push({
            job: jobObj,
            rowNum: rNum,
            slotNum: s,
            slot: {
              description: expDesc,
              amount: expAmt,
              vat: expVat,
              date: formatDateDisplay_(expDate),
              daysToPay: expDays,
              status: expStatus,
              appId: expId,
            },
          });
        }
      }
    }

    i = j;
  }

  return { jobs, invoiceSlotMap, expenseSlotMap };
}

function matchJobRecord_(jobs, targetJob) {
  if (!Array.isArray(jobs) || !targetJob) return null;
  const targetCode = cleanProjectCode_(targetJob.projectCode);
  const targetClient = normalizeKey_(targetJob.client);
  const targetName = normalizeKey_(targetJob.jobName);
  const targetRowNum = Number(targetJob.rowNum || targetJob.rowNumber || 0) || null;

  if (targetCode) {
    const byCode = jobs.find((j) => cleanProjectCode_(j.projectCode) === targetCode);
    if (byCode) return byCode;
  }
  if (targetClient && targetName) {
    const matches = jobs.filter(
      (j) => normalizeKey_(j.client) === targetClient && normalizeKey_(j.jobName) === targetName
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      if (targetRowNum) {
        return matches.find((j) => j.rowNums.includes(targetRowNum)) || matches[0];
      }
      return matches[0];
    }
  }
  if (targetRowNum) {
    return jobs.find((j) => j.rowNums.includes(targetRowNum)) || null;
  }
  return null;
}

async function resolveSheetContextIds_(sheets, clientSheetId, masterSheetId, clientName) {
  const cleanClientSheetId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
  let cleanMasterSheetId = masterSheetId
    ? unwrapSheetId(extractSheetIdFromUrl(masterSheetId) || masterSheetId)
    : "";
  let resolvedName = normalizeStr_(clientName);

  const supaCtx = await resolveSupabaseSheetContext({
    clientName: resolvedName || undefined,
    clientSheetId: cleanClientSheetId || undefined,
    spreadsheetId: cleanMasterSheetId || cleanClientSheetId || undefined,
  }).catch(() => null);

  if (supaCtx) {
    if (!cleanMasterSheetId && supaCtx.masterSheetId) {
      cleanMasterSheetId = unwrapSheetId(supaCtx.masterSheetId);
    }
    if (!resolvedName && supaCtx.clientName) {
      resolvedName = supaCtx.clientName;
    }
  }

  if (!cleanMasterSheetId && cleanClientSheetId) {
    cleanMasterSheetId = await resolveMasterSheetIdForClient_(
      sheets,
      cleanClientSheetId,
      resolvedName
    ).catch(() => "");
    if (cleanMasterSheetId) {
      cleanMasterSheetId = unwrapSheetId(extractSheetIdFromUrl(cleanMasterSheetId) || cleanMasterSheetId);
    }
  }

  return {
    cleanClientSheetId,
    cleanMasterSheetId,
    resolvedClientName: resolvedName,
    supaCtx,
  };
}

async function loadAccountingInvoices_(sheets, cleanMasterSheetId) {
  let buRows = [];
  let buHeaders = [];
  let invFromAppRows = [];
  let invFormatRule = "";
  let excludeDeleted = true;
  let accountingTool = "None";

  const batchResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterSheetId,
      ranges: [
        "InvAppList!BU3:CG5004",
        "InvFromApp!A1:S5000",
        "InvAppList!F1",
        "InvAppList!CA1",
        "KeyInfo!Q4",
      ],
      valueRenderOption: "FORMATTED_VALUE",
    })
  );
  const vRanges = batchResp.data?.valueRanges || [];
  const rawBu = vRanges[0]?.values || [];
  buHeaders = rawBu[0] || [];
  buRows = rawBu.slice(1);
  invFromAppRows = vRanges[1]?.values || [];
  invFormatRule = normalizeStr_(vRanges[2]?.values?.[0]?.[0]);
  const ca1Val = normalizeStr_(vRanges[3]?.values?.[0]?.[0]).toLowerCase();
  if (ca1Val === "no") excludeDeleted = false;
  accountingTool = normalizeStr_(vRanges[4]?.values?.[0]?.[0]) || "None";

  const idxClient = findHeaderCol_(buHeaders, ["client", "contact", "contactname"], 0);
  const idxJob = findHeaderCol_(buHeaders, ["job", "reference", "ref"], 1);
  const idxGross = findHeaderCol_(buHeaders, ["invoice amount", "total", "gross"], 2);
  const idxExcl = findHeaderCol_(buHeaders, ["total excl vat", "excl vat", "subtotal", "net"], 3);
  const idxVat = findHeaderCol_(buHeaders, ["vat included", "vat", "totaltax"], 4);
  const idxInvNo = findHeaderCol_(buHeaders, ["invoice no", "invoice number", "invoiceno"], 5);
  const idxSent = findHeaderCol_(buHeaders, ["sent date", "date"], 6);
  const idxDue = findHeaderCol_(buHeaders, ["due date", "duedate"], 7);
  const idxPaid = findHeaderCol_(buHeaders, ["fully paid on", "fullypaidondate", "paid on"], 8);
  const idxStatus = findHeaderCol_(buHeaders, ["status"], 9);
  const idxCurr = findHeaderCol_(buHeaders, ["currency", "currencycode"], 10);

  const metaIndex = buildInvFromAppMetaMap(invFromAppRows, invFormatRule);
  const items = [];
  const byKey = new Map();

  for (const row of buRows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const invoiceNo = normalizeStr_(row[idxInvNo]).replace(/^'/, "");
    if (!invoiceNo) continue;

    const rawStatus = normalizeStr_(row[idxStatus]);
    const upperStatus = rawStatus.toUpperCase();
    if (excludeDeleted && (upperStatus === "VOIDED" || upperStatus === "DELETED")) continue;

    const client = normalizeStr_(row[idxClient]);
    const job = normalizeStr_(row[idxJob]);
    const grossAmt = round2_(parseMoney_(row[idxGross]));
    const exclAmt = round2_(parseMoney_(row[idxExcl]));
    const vatAmt = round2_(parseMoney_(row[idxVat]));
    const amount = exclAmt !== 0 ? exclAmt : grossAmt;

    const sentDateObj = parseAnyDate_(row[idxSent]);
    const dueDateObj = parseAnyDate_(row[idxDue]);
    const sentDate = formatDateDisplay_(row[idxSent]);
    const dueDate = formatDateDisplay_(row[idxDue]);
    const fullyPaidOn = formatDateDisplay_(row[idxPaid]);
    const currency = normalizeStr_(row[idxCurr]) || "GBP";

    let daysToPay = 30;
    if (sentDateObj && dueDateObj) {
      const diff = Math.round((dueDateObj.getTime() - sentDateObj.getTime()) / 86400000);
      if (Number.isFinite(diff) && diff >= 0 && diff <= 365) daysToPay = diff;
    }

    const status = canonicalizeInvoiceStatus(rawStatus) || "Sent";
    const meta = lookupInvFromAppMeta(metaIndex, invoiceNo);
    const key = invoiceNo.toLowerCase();

    const item = {
      key,
      itemType: "invoice",
      invoiceNo,
      client,
      job,
      reference: job,
      amount,
      grossAmount: grossAmt,
      vatAmount: vatAmt,
      sentDate,
      dueDate,
      fullyPaidOn,
      daysToPay,
      status,
      currency,
      dateTs: sentDateObj ? sentDateObj.getTime() : 0,
      monthKey: sentDateObj ? toMonthKey_(sentDateObj) : "",
      detectedRechargedAmount: round2_(meta?.rechargedAmountGbp || 0),
      lineItems: Array.isArray(meta?.lineItems) ? meta.lineItems : [],
    };
    if (!byKey.has(key)) {
      byKey.set(key, item);
      items.push(item);
    }
  }

  return { accountingTool, items, byKey };
}

async function loadAccountingDirectCosts_(sheets, cleanMasterSheetId) {
  const batchResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterSheetId,
      ranges: [
        "JnlAppList!CA3:CO1000",
        "KeyInfo!B15",
        "KeyInfo!D8",
        "KeyInfo!Q4",
        "KeyInfo!AT4:AT22",
        "KeyInfo!AT24:AT40",
      ],
      valueRenderOption: "FORMATTED_VALUE",
    })
  );
  const vRanges = batchResp.data?.valueRanges || [];
  const rawJnl = vRanges[0]?.values || [];
  const jnlHeaders = rawJnl[0] || [];
  const jnlRows = rawJnl.slice(1);
  const revFocus = normalizeStr_(vRanges[1]?.values?.[0]?.[0]) || "Revenue";
  const rawDcMode = normalizeStr_(vRanges[2]?.values?.[0]?.[0]) || "Contractors";
  const directCostsMode =
    revFocus.toLowerCase() === "income"
      ? "Pass-through"
      : rawDcMode === "Pass-through"
        ? "Pass-through"
        : "Contractors";
  const accountingTool = normalizeStr_(vRanges[3]?.values?.[0]?.[0]) || "None";
  const contractorsList = (vRanges[4]?.values || []).map((r) => normalizeStr_(r?.[0])).filter(Boolean);
  const passThroughList = (vRanges[5]?.values || []).map((r) => normalizeStr_(r?.[0])).filter(Boolean);

  const idxDate = findHeaderCol_(jnlHeaders, ["date", "rec date"], 0);
  const idxDesc = findHeaderCol_(jnlHeaders, ["description", "descr"], 1);
  const idxNet = findHeaderCol_(jnlHeaders, ["amount", "net", "excl"], 2);
  const idxRef = findHeaderCol_(jnlHeaders, ["reference", "ref"], 3);
  const idxAccount = findHeaderCol_(jnlHeaders, ["account name", "account"], 4);
  const idxStatus = findHeaderCol_(jnlHeaders, ["status"], 5);
  const idxAppId = findHeaderCol_(jnlHeaders, ["transaction id", "app id", "txid", "id"], 6);
  const idxPaid = findHeaderCol_(jnlHeaders, ["date paid", "paid date", "fully paid"], 7);
  const idxVat = findHeaderCol_(jnlHeaders, ["vat", "tax"], 8);
  const idxGross = findHeaderCol_(jnlHeaders, ["gross", "incl"], 9);
  const idxCurr = findHeaderCol_(jnlHeaders, ["currency"], 10);
  const idxContact = findHeaderCol_(jnlHeaders, ["contact", "supplier", "vendor", "payee"], -1);

  const items = [];
  const byKey = new Map();

  for (const row of jnlRows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const appId = normalizeStr_(row[idxAppId]).replace(/^'/, "");
    if (!appId) continue;

    const rawStatus = normalizeStr_(row[idxStatus]);
    const upperStatus = rawStatus.toUpperCase();
    if (upperStatus === "VOIDED" || upperStatus === "DELETED") continue;

    const dateObj = parseAnyDate_(row[idxDate]);
    const date = formatDateDisplay_(row[idxDate]);
    const datePaid = formatDateDisplay_(row[idxPaid]);
    const description = normalizeStr_(row[idxDesc]);
    const reference = normalizeStr_(row[idxRef]);
    const accountName = normalizeStr_(row[idxAccount]);
    const contactName =
      idxContact >= 0
        ? normalizeStr_(row[idxContact])
        : normalizeStr_(row[11] && !/^\d+(\.\d+)?$/.test(String(row[11]).trim()) ? row[11] : "");
    const amount = round2_(parseMoney_(row[idxNet]));
    const vatAmount = round2_(parseMoney_(row[idxVat]));
    const grossAmount = round2_(parseMoney_(row[idxGross]) || amount + vatAmount);
    const currency = normalizeStr_(row[idxCurr]) || "GBP";

    const rawLower = rawStatus.toLowerCase();
    const status =
      canonicalizeExpenseStatus(rawStatus) ||
      (rawLower === "draft" ? "Draft" : rawLower === "authorised" ? "Received" : "Received");

    const { expenseCategoryType } = classifyExpenseCategory(
      accountName,
      contractorsList,
      passThroughList,
      directCostsMode
    );
    const key = appId.toLowerCase();

    const item = {
      key,
      itemType: "directCost",
      appId,
      description,
      displayDescription: buildExpenseDescription_({ contactName, description, accountName }),
      reference,
      accountName,
      contactName,
      amount,
      vatAmount,
      grossAmount,
      vatYesNo: vatAmount > 0.005 ? "Yes" : "No",
      date,
      datePaid,
      daysToPay: 30,
      status,
      currency,
      dateTs: dateObj ? dateObj.getTime() : 0,
      monthKey: dateObj ? toMonthKey_(dateObj) : "",
      expenseCategoryType,
    };
    if (!byKey.has(key)) {
      byKey.set(key, item);
      items.push(item);
    }
  }

  return { accountingTool, directCostsMode, items, byKey };
}

async function scanOutgoingsContractorsMap_(sheets, cleanClientSheetId) {
  const outgoingsByAppId = new Map(); // lowerAppId -> [{ sheetRow, colIdx, colLetter, contractorName, monthLabel, block }]
  const resp = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId: cleanClientSheetId,
      ranges: ["Outgoings!A1:AV1", "Outgoings!A13:AV110"],
      includeGridData: true,
      fields: "sheets.data.rowData.values(formattedValue,effectiveValue,note)",
    })
  );
  const dataBlocks = resp.data?.sheets?.[0]?.data || [];
  const headerCells = dataBlocks[0]?.rowData?.[0]?.values || [];
  const monthHeaders = parseOutgoingsMonthHeaders_(headerCells);
  const monthByCol = new Map(monthHeaders.map((m) => [m.colIndex, m]));
  const rows = dataBlocks[1]?.rowData || [];

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const sheetRow = 13 + rIdx;
    const cells = rows[rIdx]?.values || [];
    const contractorName = normalizeStr_(cells[0]?.formattedValue || cells[1]?.formattedValue);
    for (const [startC, endC] of OUTGOINGS_MONTHLY_COL_RANGES) {
      for (let c = startC; c <= endC && c < cells.length; c++) {
        const note = cells[c]?.note || "";
        if (!note || !note.includes("{App ID:")) continue;
        const parsed = parseOutgoingsNoteParts_(note);
        for (const blk of parsed.blocks) {
          const idKey = normalizeKey_(blk.appId);
          if (!idKey) continue;
          const mInfo = monthByCol.get(c);
          if (!outgoingsByAppId.has(idKey)) outgoingsByAppId.set(idKey, []);
          outgoingsByAppId.get(idKey).push({
            sheetRow,
            colIdx: c,
            colLetter: colIndexToLetter(c + 1),
            contractorName: contractorName || "Contractor",
            monthLabel: mInfo?.label || "",
            block: blk,
            parsedNote: parsed,
          });
        }
      }
    }
  }

  return { outgoingsByAppId };
}

/**
 * Loads the normalized accounting catalog (unassigned, on current job, and on other jobs / contractors)
 * without triggering slow InvComp/DirComp sheet switches.
 */
export async function getAccountingCatalog({
  sheets,
  clientSheetId,
  masterSheetId = "",
  clientName = "",
  itemType = "invoice",
  lookbackMonths = 3,
  targetJob = null,
} = {}) {
  if (itemType !== "invoice" && itemType !== "directCost") {
    throw new Error("Invalid itemType. Must be 'invoice' or 'directCost'.");
  }
  const cleanLookback = ALLOWED_LOOKBACK_MONTHS.has(Number(lookbackMonths))
    ? Number(lookbackMonths)
    : 3;

  const {
    cleanClientSheetId,
    cleanMasterSheetId,
    resolvedClientName,
  } = await resolveSheetContextIds_(sheets, clientSheetId, masterSheetId, clientName);

  if (!cleanClientSheetId) {
    throw new Error("Missing clientSheetId");
  }

  const shared = await getSharedClientConfirmedAndKeyInfo(sheets, cleanClientSheetId, {
    includePipeline: false,
    bypassCache: true,
  });
  const confRows = shared.confRows || [];
  const accountingTool = shared.accountingTool || "None";

  if (!cleanMasterSheetId || !hasActiveAccountingIntegration(accountingTool)) {
    return {
      success: true,
      hasAccounting: false,
      itemType,
      accountingTool,
      lookbackMonths: cleanLookback,
      unassigned: [],
      assignedToCurrentJob: [],
      assignedToOtherJobs: [],
      directCostsMode: shared.directCostsMode || "Contractors",
    };
  }

  const { jobs, invoiceSlotMap, expenseSlotMap } = parseConfirmedJobsAndSlots_(confRows);
  let resolvedTargetJob = targetJob;
  if (targetJob?.jobUuid) {
    const anchor = await resolveAuthoritativeJobAnchor({
      spreadsheetId: cleanClientSheetId,
      clientName: resolvedClientName,
      jobUuid: targetJob.jobUuid,
      expectedTabName: "Confirmed",
      fallbackRowNum: targetJob.rowNum || targetJob.rowNumber,
    }).catch(() => null);
    if (anchor?.resolved && anchor.rowNum) {
      resolvedTargetJob = { ...targetJob, rowNum: anchor.rowNum, rowNumber: anchor.rowNum };
    }
  }
  const matchedCurrentJob = matchJobRecord_(jobs, resolvedTargetJob);

  const cutoffDate = new Date();
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setMonth(cutoffDate.getMonth() - cleanLookback);
  const cutoffMs = cutoffDate.getTime();

  const unassigned = [];
  const assignedToCurrentJob = [];
  const assignedToOtherJobs = [];

  if (itemType === "invoice") {
    const catalog = await loadAccountingInvoices_(sheets, cleanMasterSheetId);
    const seenKeys = new Set();

    for (const item of catalog.items) {
      seenKeys.add(item.key);
      const placements = invoiceSlotMap.get(item.key) || [];
      const currentPlacements = matchedCurrentJob
        ? placements.filter((p) => p.job.parentRowNum === matchedCurrentJob.parentRowNum)
        : [];
      const otherPlacements = matchedCurrentJob
        ? placements.filter((p) => p.job.parentRowNum !== matchedCurrentJob.parentRowNum)
        : placements;

      if (currentPlacements.length > 0) {
        const totalOnJob = round2_(
          currentPlacements.reduce((s, p) => s + parseMoney_(p.slot.amount), 0)
        );
        assignedToCurrentJob.push({
          ...item,
          amountOnJob: totalOnJob || item.amount,
          trancheCount: currentPlacements.length,
          isPartPaidSplit: currentPlacements.length > 1,
        });
        continue;
      }

      if (item.dateTs && item.dateTs < cutoffMs) {
        continue;
      }

      const { score, isLikelyMatch } = scoreAccountingItemMatch(item, targetJob, "invoice");
      if (otherPlacements.length > 0) {
        const primaryJob = otherPlacements[0].job;
        assignedToOtherJobs.push({
          ...item,
          matchScore: score,
          isLikelyMatch,
          sourceType: "job",
          trancheCount: otherPlacements.length,
          isPartPaidSplit: otherPlacements.length > 1,
          assignedJob: {
            client: primaryJob.client,
            jobName: primaryJob.jobName,
            projectCode: primaryJob.projectCode,
            isRetainer: primaryJob.isRetainer,
          },
        });
      } else {
        unassigned.push({
          ...item,
          matchScore: score,
          isLikelyMatch,
        });
      }
    }

    // Also include any real invoice already saved on currentJob whose date is older than InvAppList / missing from InvAppList
    if (matchedCurrentJob) {
      for (const [key, placements] of invoiceSlotMap.entries()) {
        if (seenKeys.has(key)) continue;
        const cur = placements.filter((p) => p.job.parentRowNum === matchedCurrentJob.parentRowNum);
        if (cur.length === 0) continue;
        const first = cur[0].slot;
        const totalOnJob = round2_(cur.reduce((s, p) => s + parseMoney_(p.slot.amount), 0));
        assignedToCurrentJob.push({
          key,
          itemType: "invoice",
          invoiceNo: first.ref,
          client: matchedCurrentJob.client,
          job: matchedCurrentJob.jobName,
          reference: matchedCurrentJob.projectCode,
          amount: totalOnJob,
          amountOnJob: totalOnJob,
          grossAmount: totalOnJob,
          vatAmount: 0,
          sentDate: first.sentDate,
          dueDate: "",
          fullyPaidOn: "",
          daysToPay: parseInt(first.daysToPay, 10) || 30,
          status: first.status || "Sent",
          currency: "GBP",
          dateTs: parseAnyDate_(first.sentDate)?.getTime() || 0,
          trancheCount: cur.length,
          isPartPaidSplit: cur.length > 1,
          detectedRechargedAmount: round2_(
            cur.reduce((s, p) => s + parseMoney_(p.slot.ofWhichRechgd), 0)
          ),
          lineItems: [],
        });
      }
    }
  } else {
    const [catalog, outgoingsScan] = await Promise.all([
      loadAccountingDirectCosts_(sheets, cleanMasterSheetId),
      scanOutgoingsContractorsMap_(sheets, cleanClientSheetId),
    ]);
    const seenKeys = new Set();

    for (const item of catalog.items) {
      seenKeys.add(item.key);
      const placements = expenseSlotMap.get(item.key) || [];
      const currentPlacements = matchedCurrentJob
        ? placements.filter((p) => p.job.parentRowNum === matchedCurrentJob.parentRowNum)
        : [];
      const otherJobPlacements = matchedCurrentJob
        ? placements.filter((p) => p.job.parentRowNum !== matchedCurrentJob.parentRowNum)
        : placements;
      const outgoingsMatches = outgoingsScan.outgoingsByAppId.get(item.key) || [];

      if (currentPlacements.length > 0) {
        const totalOnJob = round2_(
          currentPlacements.reduce((s, p) => s + parseMoney_(p.slot.amount), 0)
        );
        assignedToCurrentJob.push({
          ...item,
          amountOnJob: totalOnJob || item.amount,
          trancheCount: currentPlacements.length,
          isPartPaidSplit: currentPlacements.length > 1,
        });
        continue;
      }

      if (item.dateTs && item.dateTs < cutoffMs) {
        continue;
      }

      const { score, isLikelyMatch } = scoreAccountingItemMatch(item, targetJob, "directCost");
      if (otherJobPlacements.length > 0) {
        const primaryJob = otherJobPlacements[0].job;
        assignedToOtherJobs.push({
          ...item,
          matchScore: score,
          isLikelyMatch,
          sourceType: "job",
          trancheCount: otherJobPlacements.length,
          isPartPaidSplit: otherJobPlacements.length > 1,
          assignedJob: {
            client: primaryJob.client,
            jobName: primaryJob.jobName,
            projectCode: primaryJob.projectCode,
            isRetainer: primaryJob.isRetainer,
          },
        });
      } else if (outgoingsMatches.length > 0) {
        const uniqueContractors = [...new Set(outgoingsMatches.map((m) => m.contractorName).filter(Boolean))];
        const uniqueMonths = [...new Set(outgoingsMatches.map((m) => m.monthLabel).filter(Boolean))];
        assignedToOtherJobs.push({
          ...item,
          matchScore: score,
          isLikelyMatch,
          sourceType: "outgoings",
          trancheCount: outgoingsMatches.length,
          isPartPaidSplit: outgoingsMatches.length > 1,
          assignedContractor: {
            name: uniqueContractors.join(", ") || "Contractors",
            monthLabel: uniqueMonths.join(", "),
          },
        });
      } else {
        unassigned.push({
          ...item,
          matchScore: score,
          isLikelyMatch,
        });
      }
    }

    if (matchedCurrentJob) {
      for (const [key, placements] of expenseSlotMap.entries()) {
        if (seenKeys.has(key)) continue;
        const cur = placements.filter((p) => p.job.parentRowNum === matchedCurrentJob.parentRowNum);
        if (cur.length === 0) continue;
        const first = cur[0].slot;
        const totalOnJob = round2_(cur.reduce((s, p) => s + parseMoney_(p.slot.amount), 0));
        assignedToCurrentJob.push({
          key,
          itemType: "directCost",
          appId: first.appId,
          description: first.description,
          displayDescription: first.description || first.appId,
          reference: "",
          accountName: "",
          contactName: "",
          amount: totalOnJob,
          amountOnJob: totalOnJob,
          vatAmount: 0,
          grossAmount: totalOnJob,
          vatYesNo: first.vat || "No",
          date: first.date,
          datePaid: "",
          daysToPay: parseInt(first.daysToPay, 10) || 30,
          status: first.status || "Received",
          currency: "GBP",
          dateTs: parseAnyDate_(first.date)?.getTime() || 0,
          trancheCount: cur.length,
          isPartPaidSplit: cur.length > 1,
        });
      }
    }
  }

  const sortRanked = (a, b) => {
    if ((b.matchScore || 0) !== (a.matchScore || 0)) {
      return (b.matchScore || 0) - (a.matchScore || 0);
    }
    return (b.dateTs || 0) - (a.dateTs || 0);
  };
  unassigned.sort(sortRanked);
  assignedToOtherJobs.sort(sortRanked);
  assignedToCurrentJob.sort((a, b) => (b.dateTs || 0) - (a.dateTs || 0));

  return {
    success: true,
    hasAccounting: true,
    clientName: resolvedClientName,
    itemType,
    accountingTool,
    directCostsMode: shared.directCostsMode || "Contractors",
    lookbackMonths: cleanLookback,
    unassigned,
    assignedToCurrentJob,
    assignedToOtherJobs,
  };
}

/**
 * Checks whether external Xero/QuickBooks records changed since the last sync, and if so,
 * triggers a targeted live import (`pull_invoices` or `pull_expenses`) into InvFromApp/JnlsFromApp.
 */
export async function refreshAccountingCatalogSource({
  sheets,
  clientSheetId,
  masterSheetId = "",
  clientName = "",
  itemType = "invoice",
  force = false,
  userEmail = "User",
} = {}) {
  if (itemType !== "invoice" && itemType !== "directCost") {
    throw new Error("Invalid itemType. Must be 'invoice' or 'directCost'.");
  }

  const {
    cleanClientSheetId,
    cleanMasterSheetId,
    resolvedClientName,
    supaCtx,
  } = await resolveSheetContextIds_(sheets, clientSheetId, masterSheetId, clientName);

  if (!supaCtx || supaCtx.masterMode !== "supabase") {
    return {
      success: true,
      refreshed: false,
      upToDate: false,
      livePullSupported: false,
      message: "Live background refresh is unavailable for this workspace.",
    };
  }

  await ensureRedisConnected(500).catch(() => {});

  const clientKey = supaCtx.clientName || resolvedClientName || cleanClientSheetId;
  const cooldownKey = `pulse:acct_cat_cd:${clientKey}:${itemType}`;
  const lockKey = `pulse:acct_cat_lock:${clientKey}:${itemType}`;
  const cooldownSecs = force ? 10 : 45;

  const memCd = memoryCache.get(cooldownKey);
  if (memCd) {
    return {
      success: true,
      refreshed: false,
      upToDate: true,
      livePullSupported: true,
      onCooldown: true,
      checkedAt: memCd.checkedAt,
      tool: memCd.tool || null,
    };
  }
  if (redisClient?.isOpen) {
    const rawCd = await redisClient.get(cooldownKey).catch(() => null);
    if (rawCd) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawCd);
      } catch (_) {
        parsed = null;
      }
      return {
        success: true,
        refreshed: false,
        upToDate: true,
        livePullSupported: true,
        onCooldown: true,
        checkedAt: parsed?.checkedAt || new Date().toISOString(),
        tool: parsed?.tool || null,
      };
    }
  }

  // Acquire short in-flight lock so concurrent modal opens do not run duplicate pulls
  if (redisClient?.isOpen) {
    const acquired = await redisClient.set(lockKey, "1", { NX: true, EX: 90 }).catch(() => null);
    if (!acquired) {
      return {
        success: true,
        refreshed: false,
        upToDate: false,
        inProgress: true,
        livePullSupported: true,
      };
    }
  }

  try {
    const sb = getSupabaseAdmin();
    const seq = itemType === "invoice" ? "invoice" : "expense";
    const flagKey = seq === "invoice" ? "inv_preflight" : "exp_preflight";

    let prevPreflight = null;
    let baseFlags = {};
    if (sb) {
      const { data: sched } = await sb
        .from("sync_schedules")
        .select("flags")
        .eq("client_name", supaCtx.clientName)
        .maybeSingle();
      if (sched?.flags && typeof sched.flags === "object") {
        baseFlags = sched.flags;
        prevPreflight = sched.flags[flagKey] || null;
      }
    }

    let keyInfoGrid = [];
    let dcaGrid = [];
    if (sb) {
      const { data: gridRows } = await sb
        .from("master_sheet_grids")
        .select("tab_name, values_grid")
        .eq("client_name", supaCtx.clientName)
        .in("tab_name", ["KeyInfo", "DataChgAlert"]);
      for (const r of gridRows || []) {
        if (r.tab_name === "KeyInfo") keyInfoGrid = r.values_grid || [];
        else if (r.tab_name === "DataChgAlert") dcaGrid = r.values_grid || [];
      }
    }

    const sinceIso = prevPreflight?.baselineSinceIso || prevPreflight?.fullSyncedAt || null;
    const probe = !force && sinceIso
      ? await probeExternalAccountingFingerprint({
          ctx: supaCtx,
          keyInfoGrid,
          sequence: seq,
          sinceIso,
        })
      : { ok: false, reason: force ? "forced" : "no_since_baseline" };

    if (probe.ok && prevPreflight?.fingerprint && probe.fingerprint === prevPreflight.fingerprint) {
      const checkedAt = new Date().toISOString();
      const cdVal = { checkedAt, tool: probe.tool };
      memoryCache.set(cooldownKey, cdVal, cooldownSecs);
      if (redisClient?.isOpen) {
        await redisClient.set(cooldownKey, JSON.stringify(cdVal), { EX: cooldownSecs }).catch(() => {});
      }
      return {
        success: true,
        refreshed: false,
        upToDate: true,
        livePullSupported: true,
        tool: probe.tool,
        checkedAt,
      };
    }

    const runStartedIso = new Date().toISOString();
    const amdAction = itemType === "invoice" ? "pull_invoices" : "pull_expenses";
    await runNativeMasterAmdAction({
      sheets,
      clientName: supaCtx.clientName,
      amdAction,
      userEmail,
    });

    const completedAtIso = new Date().toISOString();
    if (sb) {
      try {
        const pf = await captureAccountingPreflightBaseline({
          ctx: supaCtx,
          sequence: seq,
          keyInfoGrid,
          dcaGrid,
          runStartedIso,
          completedAtIso,
          prevPreflight,
        });
        if (pf?.state) {
          await sb
            .from("sync_schedules")
            .update({ flags: { ...baseFlags, [flagKey]: pf.state } })
            .eq("client_name", supaCtx.clientName);
        }
      } catch (pfErr) {
        console.warn("[refreshAccountingCatalogSource] Baseline update note:", pfErr.message);
      }
    }

    await invalidatePmaClientCache(
      cleanClientSheetId,
      cleanMasterSheetId || null,
      itemType === "invoice" ? ["invoices"] : ["outgoings"]
    ).catch(() => {});

    const cdVal = { checkedAt: completedAtIso, tool: probe?.tool || null };
    memoryCache.set(cooldownKey, cdVal, cooldownSecs);
    if (redisClient?.isOpen) {
      await redisClient.set(cooldownKey, JSON.stringify(cdVal), { EX: cooldownSecs }).catch(() => {});
    }

    return {
      success: true,
      refreshed: true,
      upToDate: true,
      livePullSupported: true,
      tool: probe?.tool || null,
      syncedAt: completedAtIso,
    };
  } finally {
    if (redisClient?.isOpen) {
      await redisClient.del(lockKey).catch(() => {});
    }
  }
}

function buildUpdatedJobArraysFromRows_(allRows = [], rowNums = [], isRetainer = false, isSysAdmin = false) {
  const invoices = [];
  const directExpenses = [];
  let invNum = 1;
  let expNum = 1;
  const parentRowNum = rowNums[0];

  for (const rNum of rowNums) {
    const r = allRows[rNum - 1] || [];
    const isChild = rNum !== parentRowNum;
    for (let s = 1; s <= 3; s++) {
      const ic = INV_SLOT_COLS[s];
      const amt = r[ic.base];
      const ref = normalizeStr_(r[ic.base + 1]);
      const sent = normalizeStr_(r[ic.base + 2]);
      const days = normalizeStr_(r[ic.base + 3]) || "30";
      const status = canonicalizeInvoiceStatus(r[ic.base + 4]);
      const ofWhichRechgd = r[ic.base + 5] ?? "";
      const costMonth = normalizeStr_(r[ic.base + 6]);
      if (
        (amt !== undefined && String(amt).trim() !== "") ||
        ref !== "" ||
        sent !== "" ||
        hasNonZeroMoney_(ofWhichRechgd)
      ) {
        invoices.push({
          num: invNum++,
          amount: amt !== undefined && amt !== "" ? String(amt) : "",
          ref,
          sendDate: formatDateDisplay_(sent),
          days,
          status,
          ofWhichRechgd: ofWhichRechgd !== undefined && ofWhichRechgd !== "" ? String(ofWhichRechgd) : "",
          costMonth,
          isChild,
          isParent: !isChild,
          ...(isSysAdmin && isChild ? { childRowNum: rNum } : {}),
        });
      }
    }

    for (let s = 1; s <= 3; s++) {
      const ec = EXP_SLOT_COLS[s];
      const desc = normalizeStr_(r[ec.base]);
      const amt = r[ec.base + 1];
      const vat = normalizeStr_(r[ec.base + 2]) || "Yes";
      const recDate = normalizeStr_(r[ec.base + 3]);
      const days = normalizeStr_(r[ec.base + 4]) || "30";
      const status = canonicalizeExpenseStatus(r[ec.base + 5]);
      const appId = normalizeStr_(r[ec.base + 6]);
      if (
        desc !== "" ||
        (amt !== undefined && String(amt).trim() !== "") ||
        recDate !== "" ||
        appId !== ""
      ) {
        directExpenses.push({
          num: expNum++,
          desc,
          amount: amt !== undefined && amt !== "" ? String(amt) : "",
          vat,
          recDate: formatDateDisplay_(recDate),
          days,
          status,
          appId,
          isChild,
          isParent: !isChild,
          ...(isSysAdmin && isChild ? { childRowNum: rNum } : {}),
        });
      }
    }
  }

  return { invoices, directExpenses, isRetainer };
}

function findAvailableSlotInGroup_(group, kind, targetMonthKey = "") {
  const isInv = kind === "invoice";
  const slotCols = isInv ? INV_SLOT_COLS : EXP_SLOT_COLS;
  const parentRow = group.parentRow || group.allRows[group.parentRowNum - 1] || [];
  const isRetainer = isFixedScheduleRetainer(parentRow);

  const candidates = [];
  for (const rNum of group.allRowNums) {
    const rowArr = group.allRows[rNum - 1] || [];
    for (let s = 1; s <= 3; s++) {
      const sc = slotCols[s];
      if (isInv) {
        const amt = parseMoney_(rowArr[sc.base]);
        const ref = normalizeStr_(rowArr[sc.base + 1]);
        const sent = normalizeStr_(rowArr[sc.base + 2]);
        const isAuto = isAutoInvoicePlaceholderRef_(ref);
        const isManual = !ref && Math.abs(amt) >= 0.005;
        const isEmpty = !ref && Math.abs(amt) < 0.005;
        const isReal = Boolean(ref && !isAuto);
        candidates.push({
          rowNum: rNum,
          slotNum: s,
          isReal,
          isAuto,
          isManual,
          isEmpty,
          monthKey: toMonthKey_(sent),
          isParentRow: rNum === group.parentRowNum,
        });
      } else {
        const desc = normalizeStr_(rowArr[sc.base]);
        const amt = parseMoney_(rowArr[sc.base + 1]);
        const id = normalizeStr_(rowArr[sc.base + 6]);
        const isAuto = isAutoExpensePlaceholderId_(id) || (!id && /^placeholder/i.test(desc));
        const isManual = !id && !isAuto && Math.abs(amt) >= 0.005;
        const isEmpty = !desc && !id && Math.abs(amt) < 0.005;
        const isReal = Boolean(id && !isAuto);
        candidates.push({
          rowNum: rNum,
          slotNum: s,
          isReal,
          isAuto,
          isManual,
          isEmpty,
          isParentRow: rNum === group.parentRowNum,
        });
      }
    }
  }

  const free = candidates.filter((c) => !c.isReal);
  if (isInv && isRetainer && targetMonthKey) {
    // Prefer child row matching the invoice's sent month
    const monthMatch =
      free.find((c) => !c.isParentRow && c.monthKey === targetMonthKey && (c.isManual || c.isAuto)) ||
      free.find((c) => !c.isParentRow && c.monthKey === targetMonthKey && c.isEmpty);
    if (monthMatch) return monthMatch;
    // Next prefer empty slot 1 on a child row, then auto/manual placeholders on child rows
    const childEmpty = free.find((c) => !c.isParentRow && c.slotNum === 1 && c.isEmpty);
    if (childEmpty) return childEmpty;
  }

  return (
    free.find((c) => c.isAuto) ||
    free.find((c) => c.isEmpty) ||
    free.find((c) => c.isManual) ||
    null
  );
}

async function allocateSlotWithSpill_(sheets, sheetIdClean, group, kind, targetMonthKey = "") {
  const existing = findAvailableSlotInGroup_(group, kind, targetMonthKey);
  if (existing) {
    return { rowNum: existing.rowNum, slotNum: existing.slotNum, deferredWrites: [], insertedRowNum: null };
  }

  const parentRow = group.parentRow || group.allRows[group.parentRowNum - 1] || [];
  const jobClient = normalizeStr_(parentRow[0]);
  const jobName = normalizeStr_(parentRow[1]);
  const childResult = await insertChildJobRow_(
    sheets,
    sheetIdClean,
    group.lastRowNum,
    jobClient,
    jobName,
    { cachedAllRows: group.allRows, deferValueWrites: true, tabName: "Confirmed" }
  );
  const newRowNum = typeof childResult === "object" ? childResult.targetRowNum : childResult;
  const deferredWrites = Array.isArray(childResult?.valueUpdates) ? childResult.valueUpdates : [];
  if (!group.allRowNums.includes(newRowNum)) group.allRowNums.push(newRowNum);
  group.allRowNums.sort((a, b) => a - b);
  group.lastRowNum = Math.max(group.lastRowNum, newRowNum);
  if (Array.isArray(group.allRows)) {
    group.allRows.splice(newRowNum - 1, 0, [jobClient, jobName]);
  }
  return { rowNum: newRowNum, slotNum: 1, deferredWrites, insertedRowNum: newRowNum };
}

function buildInvoiceWriteValues_(inv) {
  const formattedSent = inv.sentDate ? (toSheetDateFormat(inv.sentDate) || inv.sentDate) : "";
  const formattedRef = formatInvoiceRefForSheet(inv.invoiceNo || "");
  const daysToPay = parseInt(inv.daysToPay, 10) || 30;
  const status = sanitizeFormulaInput(canonicalizeInvoiceStatus(inv.status || "Sent"));
  const rechNum = round2_(parseMoney_(inv.ofWhichRechgd));
  const rechVal = rechNum > 0 ? rechNum : "";
  const cmVal = rechNum > 0 ? sanitizeFormulaInput(normalizeStr_(inv.costMonth)) : "";
  return [round2_(inv.amount), formattedRef, formattedSent, daysToPay, status, rechVal, cmVal];
}

function buildExpenseWriteValues_(exp) {
  const desc = sanitizeFormulaInput(exp.displayDescription || buildExpenseDescription_(exp));
  const amt = round2_(exp.amount);
  const vat = exp.vatYesNo || (round2_(exp.vatAmount) > 0.005 ? "Yes" : "No");
  const dt = exp.date ? (toSheetDateFormat(exp.date) || exp.date) : "";
  const days = parseInt(exp.daysToPay, 10) || 30;
  const status = sanitizeFormulaInput(canonicalizeExpenseStatus(exp.status || "Received"));
  const id = sanitizeFormulaInput(exp.appId || "");
  return [desc, amt, vat, dt, days, status, id];
}

function applySlotWriteToGroup_(group, kind, rowNum, slotNum, values) {
  const slotCols = (kind === "invoice" ? INV_SLOT_COLS : EXP_SLOT_COLS)[slotNum];
  if (!slotCols) return null;
  if (!group.allRows[rowNum - 1]) group.allRows[rowNum - 1] = [];
  for (let k = 0; k < values.length; k++) {
    group.allRows[rowNum - 1][slotCols.base + k] = values[k];
  }
  const range =
    kind === "invoice"
      ? `Confirmed!${slotCols.a}${rowNum}:${slotCols.cm}${rowNum}`
      : `Confirmed!${slotCols.d}${rowNum}:${slotCols.id}${rowNum}`;
  return { range, values: [values] };
}

function maybeRestoreRetainerSlot_(group, clearedRowNum, clearedSlotNum, primaryWrite, allWriteData, rowSnapshot, tolerances) {
  const parentRow = group.parentRow || group.allRows[group.parentRowNum - 1] || [];
  const isRetainer = isFixedScheduleRetainer(parentRow);
  if (!isRetainer || Number(clearedRowNum) === Number(group.parentRowNum)) return;

  const rAfter = group.allRows[clearedRowNum - 1] || [];
  const stillHasInvoice = [41, 48, 55].some((col) => {
    const a = parseMoney_(rAfter[col]);
    const rf = normalizeStr_(rAfter[col + 1]);
    const snt = normalizeStr_(rAfter[col + 2]);
    const st = normalizeStr_(rAfter[col + 4]);
    return Math.abs(a) > 0.005 || rf !== "" || snt !== "" || st !== "";
  });
  if (stillHasInvoice) return;

  const retChildRows = group.allRowNums
    .filter((rn) => Number(rn) !== Number(group.parentRowNum))
    .map((rn) => ({ rowNum: rn, row: group.allRows[rn - 1] || [] }));
  const restored = buildRetainerChildPlaceholderSlot({
    parentRow,
    childRows: retChildRows,
    targetRowNum: Number(clearedRowNum),
    deletedRowSnapshot: rowSnapshot,
    tolerance: tolerances,
  });
  if (!restored) return;

  if (Number(clearedSlotNum) === 1 && primaryWrite) {
    primaryWrite.values = [[...restored.values, "", ""]];
  } else {
    allWriteData.push({
      range: `Confirmed!AP${clearedRowNum}:AT${clearedRowNum}`,
      values: [restored.values],
    });
  }
  for (let k = 0; k < 5; k++) {
    group.allRows[clearedRowNum - 1][41 + k] = restored.values[k];
  }
}

function buildRevenueOrBudgetWrites_(group, itemType, { updateJobRevenue, newJobRevenue, updateJobBudget, newJobBudget, formulaRow = null }) {
  const writes = [];
  const parentRowNum = group.parentRowNum;
  const parentRow = group.parentRow || group.allRows?.[parentRowNum - 1] || [];
  const isVarRet = isVariableRetainerRow(parentRow);
  const isJobCosting = isJobCostingStyle({ headers: group.allRows?.[0] || [] });
  const hasFormulaAt = (colIdx) => String(formulaRow?.[colIdx] || "").trim().startsWith("=");
  let updatedRevenue;
  let updatedDirectCosts;

  if (itemType === "invoice" && updateJobRevenue && newJobRevenue !== undefined) {
    const requestedBillable = Math.max(0, round2_(parseMoney_(newJobRevenue)));
    const rechargedExp = Math.max(0, round2_(parseMoney_(group.allRows?.[parentRowNum - 1]?.[17])));
    const pureFee = Math.max(0, round2_(requestedBillable - rechargedExp));
    if (isJobCosting) {
      if (!isVarRet || !hasFormulaAt(8)) {
        writes.push({ range: `Confirmed!I${parentRowNum}`, values: [[pureFee]] });
      }
      if (!isVarRet || !hasFormulaAt(32)) {
        writes.push({ range: `Confirmed!AG${parentRowNum}`, values: [[`=if(I${parentRowNum}=0,"",I${parentRowNum})`]] });
      }
    } else if (!isVarRet || !hasFormulaAt(32)) {
      writes.push({ range: `Confirmed!AG${parentRowNum}`, values: [[pureFee]] });
    }
    if (!isVarRet || (!isJobCosting && !hasFormulaAt(32)) || (isJobCosting && !hasFormulaAt(8))) {
      if (group.allRows?.[parentRowNum - 1]) {
        group.allRows[parentRowNum - 1][32] = pureFee;
      }
      updatedRevenue = pureFee;
    }
  }

  if (itemType === "directCost" && updateJobBudget && newJobBudget !== undefined && !isJobCosting) {
    const budget = Math.max(0, round2_(parseMoney_(newJobBudget)));
    if (!isVarRet || !hasFormulaAt(33)) {
      writes.push({ range: `Confirmed!AH${parentRowNum}`, values: [[budget]] });
      if (group.allRows?.[parentRowNum - 1]) {
        group.allRows[parentRowNum - 1][33] = budget;
      }
      updatedDirectCosts = budget;
    }
  }

  return { writes, updatedRevenue, updatedDirectCosts };
}

async function invalidatePortalAndPmaCaches_(cleanClientSheetId, cleanMasterSheetId, scopes) {
  await invalidatePmaClientCache(cleanClientSheetId, cleanMasterSheetId || null, scopes).catch(() => {});
  if (redisClient?.isOpen) {
    await redisClient
      .del([
        `pulse:portal:payload:${cleanClientSheetId}`,
        `pulse:portal:performance:${cleanClientSheetId}`,
        `pulse:portal:cash:${cleanClientSheetId}`,
      ])
      .catch(() => {});
  }
}

/**
 * Batch-assigns unassigned accounting items and/or unassigns currently attached items on a Confirmed job.
 */
export async function batchAssignOrUnassignJobItems({
  sheets,
  clientSheetId,
  masterSheetId = "",
  clientName = "",
  itemType = "invoice",
  targetJob,
  assignItems = [],
  unassignKeys = [],
  updateJobRevenue = false,
  newJobRevenue,
  updateJobBudget = false,
  newJobBudget,
  userEmail = "User",
  automationCommanderSheetId,
  sessionId = null,
  isSysAdmin = false,
} = {}) {
  if (itemType !== "invoice" && itemType !== "directCost") {
    throw new Error("Invalid itemType. Must be 'invoice' or 'directCost'.");
  }
  const assignList = Array.isArray(assignItems) ? assignItems : [];
  const unassignList = Array.isArray(unassignKeys) ? unassignKeys : [];
  if (assignList.length === 0 && unassignList.length === 0) {
    return { success: true, assignedCount: 0, unassignedCount: 0 };
  }
  if (assignList.length + unassignList.length > MAX_BATCH_OPERATIONS) {
    throw new Error(`Too many operations in a single batch (maximum ${MAX_BATCH_OPERATIONS}).`);
  }

  const {
    cleanClientSheetId,
    cleanMasterSheetId,
    resolvedClientName,
  } = await resolveSheetContextIds_(sheets, clientSheetId, masterSheetId, clientName);

  if (!cleanClientSheetId || !cleanMasterSheetId) {
    throw new Error("Missing workspace configuration for accounting assignment.");
  }

  if (targetJob?.jobUuid) {
    const anchor = await resolveAuthoritativeJobAnchor({
      spreadsheetId: cleanClientSheetId,
      clientName: resolvedClientName,
      jobUuid: targetJob.jobUuid,
      expectedTabName: "Confirmed",
      fallbackRowNum: targetJob.rowNum || targetJob.rowNumber,
    });
    if (anchor?.resolved && anchor.rowNum) {
      targetJob = { ...targetJob, rowNum: anchor.rowNum, rowNumber: anchor.rowNum };
    }
  }

  const [confResp, tolerances] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: cleanClientSheetId,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    getToleranceValues(sheets, cleanMasterSheetId).catch(() => null),
  ]);

  const allRows = confResp.data?.values || [];
  const { jobs, invoiceSlotMap, expenseSlotMap } = parseConfirmedJobsAndSlots_(allRows);
  const matchedJob = matchJobRecord_(jobs, targetJob);
  if (!matchedJob) {
    const err = new Error("Job could not be found in confirmed jobs. Please save the job first.");
    err.statusCode = 400;
    throw err;
  }

  const group = await resolveFullJobRowGroup_(sheets, cleanClientSheetId, "Confirmed", matchedJob.rowNums, allRows);
  if (!group) {
    const err = new Error("Unable to resolve job rows.");
    err.statusCode = 400;
    throw err;
  }

  // Load authoritative accounting catalog & Outgoings map (for direct costs)
  const [catalog, outgoingsScan] = await Promise.all([
    itemType === "invoice"
      ? loadAccountingInvoices_(sheets, cleanMasterSheetId)
      : loadAccountingDirectCosts_(sheets, cleanMasterSheetId),
    itemType === "directCost" && assignList.length > 0
      ? scanOutgoingsContractorsMap_(sheets, cleanClientSheetId)
      : Promise.resolve({ outgoingsByAppId: new Map() }),
  ]);

  const slotMap = itemType === "invoice" ? invoiceSlotMap : expenseSlotMap;
  const writeData = [];
  const touchedSlots = [];
  let unassignedCount = 0;
  let assignedCount = 0;
  const resolvedAlertKeys = [];

  // Step A: Unassign selected keys from this job (including all sibling part-paid tranches)
  for (const rawKey of unassignList) {
    const key = normalizeKey_(rawKey);
    if (!key) continue;
    const placements = (slotMap.get(key) || []).filter(
      (p) => p.job.parentRowNum === group.parentRowNum
    );
    for (const p of placements) {
      const snapshot = group.allRows[p.rowNum - 1] ? [...group.allRows[p.rowNum - 1]] : null;
      const blankVals = ["", "", "", "", "", "", ""];
      const w = applySlotWriteToGroup_(group, itemType, p.rowNum, p.slotNum, blankVals);
      if (w) {
        writeData.push(w);
        touchedSlots.push({ rowNum: p.rowNum, slotNum: p.slotNum });
      }
      if (itemType === "invoice") {
        maybeRestoreRetainerSlot_(group, p.rowNum, p.slotNum, w, writeData, snapshot, tolerances);
      }
      unassignedCount++;
    }
  }

  // Step B: Assign selected accounting items into available slots on this job
  for (const reqItem of assignList) {
    const rawKey = typeof reqItem === "string" ? reqItem : (reqItem?.key || reqItem?.invoiceNo || reqItem?.appId);
    const key = normalizeKey_(rawKey);
    if (!key) continue;

    const authItem = catalog.byKey.get(key);
    if (!authItem) {
      const err = new Error(`Item "${rawKey}" was not found in the accounting feed.`);
      err.statusCode = 404;
      throw err;
    }

    const existingPlacements = slotMap.get(key) || [];
    const onThisJob = existingPlacements.some((p) => p.job.parentRowNum === group.parentRowNum);
    if (onThisJob) continue;

    const onOtherJob = existingPlacements.some((p) => p.job.parentRowNum !== group.parentRowNum);
    const inOutgoings = itemType === "directCost" && (outgoingsScan.outgoingsByAppId.get(key) || []).length > 0;
    if (onOtherJob || inOutgoings) {
      const err = new Error(
        `"${itemType === "invoice" ? `#${authItem.invoiceNo}` : authItem.displayDescription}" is already assigned elsewhere. Use Reassign to move it.`
      );
      err.statusCode = 409;
      throw err;
    }

    const targetMonthKey = (typeof reqItem === "object" && reqItem?.monthKey) || authItem.monthKey || "";
    const allocated = await allocateSlotWithSpill_(sheets, cleanClientSheetId, group, itemType, targetMonthKey);
    if (allocated.deferredWrites.length > 0) {
      writeData.push(...allocated.deferredWrites);
    }

    const values =
      itemType === "invoice"
        ? buildInvoiceWriteValues_({
            ...authItem,
            ...(typeof reqItem === "object" && reqItem?.ofWhichRechgd !== undefined
              ? { ofWhichRechgd: reqItem.ofWhichRechgd, costMonth: reqItem.costMonth || "" }
              : {}),
          })
        : buildExpenseWriteValues_(authItem);

    const w = applySlotWriteToGroup_(group, itemType, allocated.rowNum, allocated.slotNum, values);
    if (w) {
      writeData.push(w);
      touchedSlots.push({ rowNum: allocated.rowNum, slotNum: allocated.slotNum });
    }
    assignedCount++;
    resolvedAlertKeys.push(itemType === "invoice" ? authItem.invoiceNo : authItem.appId);
  }

  // Step C: Optional job revenue / direct cost budget increase
  let formulaRowForStepC = null;
  if (
    isVariableRetainerRow(group.parentRow) &&
    ((itemType === "invoice" && updateJobRevenue && newJobRevenue !== undefined) ||
      (itemType === "directCost" && updateJobBudget && newJobBudget !== undefined))
  ) {
    try {
      const fResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: cleanClientSheetId,
          range: `Confirmed!A${group.parentRowNum}:AH${group.parentRowNum}`,
          valueRenderOption: "FORMULA",
        })
      );
      formulaRowForStepC = fResp.data?.values?.[0] || null;
    } catch (_) {
      formulaRowForStepC = null;
    }
  }
  const { writes: budgetWrites, updatedRevenue, updatedDirectCosts } = buildRevenueOrBudgetWrites_(
    group,
    itemType,
    { updateJobRevenue, newJobRevenue, updateJobBudget, newJobBudget, formulaRow: formulaRowForStepC }
  );
  if (budgetWrites.length > 0) {
    writeData.push(...budgetWrites);
  }

  // Step D: Normalize slots & placeholders, reset formatting, write in one batchUpdate
  const slotKind = itemType === "invoice" ? "invoice" : "expense";
  const normRes = await runAdjustAndNormalizeJobSlots_(
    sheets,
    cleanClientSheetId,
    "Confirmed",
    group,
    slotKind,
    {
      jobBudgetOrRevenue: itemType === "invoice" ? updatedRevenue : updatedDirectCosts,
      masterSheetId: cleanMasterSheetId,
      preloadedTolerances: tolerances,
    }
  ).catch((e) => {
    console.warn("[batchAssignOrUnassignJobItems] Slot normalization warning:", e.message);
    return { placeholderAdjustment: null, batchData: [], relocations: [], normalizedSlots: [] };
  });

  const mergedWrites = mergeSlotBatchWrites_(writeData, normRes.batchData);
  if (mergedWrites.length > 0) {
    const uniqueSlots = new Map();
    for (const ts of touchedSlots) {
      uniqueSlots.set(`${ts.rowNum}_${ts.slotNum}`, ts);
    }
    await Promise.all(
      Array.from(uniqueSlots.values()).map((ts) =>
        itemType === "invoice"
          ? resetInvoiceSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", ts.rowNum, ts.slotNum)
          : resetExpenseSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", ts.rowNum, ts.slotNum)
      )
    );
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: mergedWrites,
        },
      })
    );
  }

  const updatedArrays = buildUpdatedJobArraysFromRows_(
    group.allRows,
    group.allRowNums,
    matchedJob.isRetainer,
    isSysAdmin
  );

  const bgTasks = (async () => {
    if (normRes.relocations?.length > 0) {
      await applySlotNoteAndFormattingRelocations_(
        sheets,
        cleanClientSheetId,
        "Confirmed",
        group,
        slotKind,
        normRes.relocations
      );
    }
    await invalidatePortalAndPmaCaches_(cleanClientSheetId, cleanMasterSheetId, [
      "invoices",
      "outgoings",
      "jobs",
      "retainers",
      "cash",
    ]);

    const tenantClient =
      resolvedClientName ||
      (await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId));
    const jobLabel = matchedJob.client
      ? `"${matchedJob.client} - ${matchedJob.jobName}"`
      : `"${matchedJob.jobName}"`;
    const summaryText = `Updated ${itemType === "invoice" ? "invoices" : "direct costs"} on ${jobLabel} (${assignedCount} assigned, ${unassignedCount} unassigned)`;

    await Promise.all([
      resolvedAlertKeys.length > 0
        ? resolveAssignedAlertsInMemoryAndCache(sheets, {
            acSheetId: automationCommanderSheetId,
            clientName: tenantClient,
            ...(itemType === "invoice"
              ? { invoiceNos: resolvedAlertKeys }
              : { expenseIds: resolvedAlertKeys }),
            sessionId,
          }).catch(() => {})
        : Promise.resolve(),
      logPmaActivity(sheets, {
        automationCommanderSheetId,
        clientName: tenantClient,
        category: itemType === "invoice" ? "INVOICES" : "EXPENSES",
        action: itemType === "invoice" ? "Invoices Batch Updated" : "Direct Costs Batch Updated",
        summary: summaryText,
        details: {
          clientName: tenantClient,
          jobName: matchedJob.jobName,
          endClient: matchedJob.client,
          assignedCount,
          unassignedCount,
          keys: resolvedAlertKeys,
        },
      }).catch(() => {}),
      logPulseActivity(sheets, {
        automationCommanderSheetId,
        clientName: tenantClient,
        category: "JOBS",
        action: itemType === "invoice" ? "INVOICES_ASSIGNED" : "DIRECT_COSTS_ASSIGNED",
        summary: sanitizeSpreadsheetTerms(summaryText),
        details: { jobName: matchedJob.jobName, assignedCount, unassignedCount },
        user: userEmail,
      }).catch(() => {}),
    ]);
  })();
  try {
    waitUntil(bgTasks);
  } catch (_) {}

  return {
    success: true,
    assignedCount,
    unassignedCount,
    updatedInvoices: updatedArrays.invoices,
    updatedDirectExpenses: updatedArrays.directExpenses,
    ...(isSysAdmin ? { childRowNumbers: group.allRowNums.slice(1) } : {}),
    ...(updatedRevenue !== undefined ? { updatedRevenue } : {}),
    ...(updatedDirectCosts !== undefined ? { updatedDirectCosts } : {}),
  };
}

/**
 * Atomically moves a real invoice (all sibling tranches) or direct cost (from another Confirmed job OR Contractors/Outgoings)
 * onto the target Confirmed job.
 */
export async function moveAccountingItemToJob({
  sheets,
  clientSheetId,
  masterSheetId = "",
  clientName = "",
  itemType = "invoice",
  itemKey = "",
  sourceType = "auto",
  targetJob,
  updateJobRevenue = false,
  newJobRevenue,
  updateJobBudget = false,
  newJobBudget,
  userEmail = "User",
  automationCommanderSheetId,
  sessionId = null,
  isSysAdmin = false,
} = {}) {
  if (itemType !== "invoice" && itemType !== "directCost") {
    throw new Error("Invalid itemType. Must be 'invoice' or 'directCost'.");
  }
  const cleanKey = normalizeKey_(itemKey);
  if (!cleanKey) {
    throw new Error("Missing itemKey");
  }

  const {
    cleanClientSheetId,
    cleanMasterSheetId,
    resolvedClientName,
  } = await resolveSheetContextIds_(sheets, clientSheetId, masterSheetId, clientName);

  if (!cleanClientSheetId || !cleanMasterSheetId) {
    throw new Error("Missing workspace configuration for move.");
  }

  if (targetJob?.jobUuid) {
    const anchor = await resolveAuthoritativeJobAnchor({
      spreadsheetId: cleanClientSheetId,
      clientName: resolvedClientName,
      jobUuid: targetJob.jobUuid,
      expectedTabName: "Confirmed",
      fallbackRowNum: targetJob.rowNum || targetJob.rowNumber,
    });
    if (anchor?.resolved && anchor.rowNum) {
      targetJob = { ...targetJob, rowNum: anchor.rowNum, rowNumber: anchor.rowNum };
    }
  }

  const [confResp, tolerances] = await Promise.all([
    withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: cleanClientSheetId,
        range: "Confirmed!A1:CR5000",
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    ),
    getToleranceValues(sheets, cleanMasterSheetId).catch(() => null),
  ]);

  const allRows = confResp.data?.values || [];
  const { jobs, invoiceSlotMap, expenseSlotMap } = parseConfirmedJobsAndSlots_(allRows);
  const matchedTargetJob = matchJobRecord_(jobs, targetJob);
  if (!matchedTargetJob) {
    const err = new Error("Destination job could not be found in confirmed jobs.");
    err.statusCode = 400;
    throw err;
  }

  const targetGroup = await resolveFullJobRowGroup_(
    sheets,
    cleanClientSheetId,
    "Confirmed",
    matchedTargetJob.rowNums,
    allRows
  );
  if (!targetGroup) {
    const err = new Error("Unable to resolve destination job.");
    err.statusCode = 400;
    throw err;
  }

  const slotMap = itemType === "invoice" ? invoiceSlotMap : expenseSlotMap;
  const jobPlacements = slotMap.get(cleanKey) || [];
  const otherJobPlacements = jobPlacements.filter(
    (p) => p.job.parentRowNum !== targetGroup.parentRowNum
  );

  let outgoingsMatches = [];
  if (itemType === "directCost" && (sourceType === "outgoings" || otherJobPlacements.length === 0)) {
    const ogScan = await scanOutgoingsContractorsMap_(sheets, cleanClientSheetId);
    outgoingsMatches = ogScan.outgoingsByAppId.get(cleanKey) || [];
  }

  // Case 1: Move from another Confirmed job (moving ALL sibling tranches together)
  if (otherJobPlacements.length > 0 && sourceType !== "outgoings") {
    const primarySourceJob = otherJobPlacements[0].job;
    const sourceGroup = await resolveFullJobRowGroup_(
      sheets,
      cleanClientSheetId,
      "Confirmed",
      primarySourceJob.rowNums,
      allRows
    );
    const sameJob = sourceGroup?.parentRowNum === targetGroup.parentRowNum;
    if (sameJob) {
      throw new Error("Item is already on this job.");
    }

    const writeData = [];
    const touchedTargetSlots = [];
    const movedTranches = [];

    // Prepare placement payloads from initial allRows BEFORE any child row insertion can shift indices
    const preparedPlacements = otherJobPlacements.map((origP) => {
      const p = { ...origP };
      const rIdx0 = p.rowNum - 1;
      const baseCol = (itemType === "invoice" ? INV_SLOT_COLS : EXP_SLOT_COLS)[p.slotNum].base;
      const rawRow = allRows[rIdx0] || [];
      const trancheVals =
        itemType === "invoice"
          ? [
              rawRow[baseCol] ?? "",
              formatInvoiceRefForSheet(rawRow[baseCol + 1] ?? ""),
              rawRow[baseCol + 2] ? (toSheetDateFormat(rawRow[baseCol + 2]) || rawRow[baseCol + 2]) : "",
              rawRow[baseCol + 3] || 30,
              sanitizeFormulaInput(canonicalizeInvoiceStatus(rawRow[baseCol + 4] ?? "")),
              rawRow[baseCol + 5] ?? "",
              sanitizeFormulaInput(normalizeStr_(rawRow[baseCol + 6])),
            ]
          : [
              sanitizeFormulaInput(normalizeStr_(rawRow[baseCol])),
              round2_(parseMoney_(rawRow[baseCol + 1])),
              normalizeStr_(rawRow[baseCol + 2]) || "No",
              rawRow[baseCol + 3] ? (toSheetDateFormat(rawRow[baseCol + 3]) || rawRow[baseCol + 3]) : "",
              rawRow[baseCol + 4] || 30,
              sanitizeFormulaInput(canonicalizeExpenseStatus(rawRow[baseCol + 5] ?? "")),
              sanitizeFormulaInput(normalizeStr_(rawRow[baseCol + 6])),
            ];
      const targetMonthKey = itemType === "invoice" ? toMonthKey_(rawRow[baseCol + 2]) : "";
      return { p, trancheVals, targetMonthKey };
    });

    // Loop 1: Allocate destination slots on targetGroup first, tracking any inserted row shifts on sourceGroup
    for (const entry of preparedPlacements) {
      const allocated = await allocateSlotWithSpill_(
        sheets,
        cleanClientSheetId,
        targetGroup,
        itemType,
        entry.targetMonthKey
      );
      if (allocated.insertedRowNum) {
        const ins = allocated.insertedRowNum;
        for (const itemEntry of preparedPlacements) {
          if (itemEntry.p.rowNum >= ins) itemEntry.p.rowNum += 1;
        }
        if (sourceGroup) {
          if (sourceGroup.parentRowNum >= ins) sourceGroup.parentRowNum += 1;
          if (sourceGroup.lastRowNum >= ins) sourceGroup.lastRowNum += 1;
          sourceGroup.allRowNums = sourceGroup.allRowNums.map((rn) => (rn >= ins ? rn + 1 : rn));
          sourceGroup.parentRow = sourceGroup.allRows?.[sourceGroup.parentRowNum - 1] || sourceGroup.parentRow;
        }
      }
      if (allocated.deferredWrites.length > 0) {
        writeData.push(...allocated.deferredWrites);
      }
      const targetWrite = applySlotWriteToGroup_(
        targetGroup,
        itemType,
        allocated.rowNum,
        allocated.slotNum,
        entry.trancheVals
      );
      if (targetWrite) {
        writeData.push(targetWrite);
        touchedTargetSlots.push({ rowNum: allocated.rowNum, slotNum: allocated.slotNum });
      }
      movedTranches.push(entry.trancheVals);
    }

    // Loop 2: Clear source slots at their final (possibly shifted) row numbers
    if (sourceGroup) {
      for (const entry of preparedPlacements) {
        const p = entry.p;
        const rIdx0 = p.rowNum - 1;
        const rawSnapshot = sourceGroup.allRows?.[rIdx0] ? [...sourceGroup.allRows[rIdx0]] : null;
        const clearWrite = applySlotWriteToGroup_(
          sourceGroup,
          itemType,
          p.rowNum,
          p.slotNum,
          ["", "", "", "", "", "", ""]
        );
        if (clearWrite) writeData.push(clearWrite);
        if (itemType === "invoice") {
          maybeRestoreRetainerSlot_(
            sourceGroup,
            p.rowNum,
            p.slotNum,
            clearWrite,
            writeData,
            rawSnapshot,
            tolerances
          );
        }
      }
    }

    const { writes: budgetWrites, updatedRevenue, updatedDirectCosts } = buildRevenueOrBudgetWrites_(
      targetGroup,
      itemType,
      { updateJobRevenue, newJobRevenue, updateJobBudget, newJobBudget }
    );
    if (budgetWrites.length > 0) writeData.push(...budgetWrites);

    const slotKind = itemType === "invoice" ? "invoice" : "expense";
    const [srcNorm, tgtNorm] = await Promise.all([
      sourceGroup
        ? runAdjustAndNormalizeJobSlots_(sheets, cleanClientSheetId, "Confirmed", sourceGroup, slotKind, {
            preloadedTolerances: tolerances,
          }).catch(() => ({ batchData: [], relocations: [] }))
        : Promise.resolve({ batchData: [], relocations: [] }),
      runAdjustAndNormalizeJobSlots_(sheets, cleanClientSheetId, "Confirmed", targetGroup, slotKind, {
        jobBudgetOrRevenue: itemType === "invoice" ? updatedRevenue : updatedDirectCosts,
        masterSheetId: cleanMasterSheetId,
        preloadedTolerances: tolerances,
      }).catch(() => ({ batchData: [], relocations: [] })),
    ]);

    const mergedWrites = mergeSlotBatchWrites_(writeData, srcNorm.batchData, tgtNorm.batchData);
    await Promise.all([
      ...preparedPlacements.map(({ p }) =>
        itemType === "invoice"
          ? resetInvoiceSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", p.rowNum, p.slotNum)
          : resetExpenseSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", p.rowNum, p.slotNum)
      ),
      ...touchedTargetSlots.map((ts) =>
        itemType === "invoice"
          ? resetInvoiceSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", ts.rowNum, ts.slotNum)
          : resetExpenseSlotFormatting_(sheets, cleanClientSheetId, "Confirmed", ts.rowNum, ts.slotNum)
      ),
    ]);

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: mergedWrites,
        },
      })
    );

    const updatedArrays = buildUpdatedJobArraysFromRows_(
      targetGroup.allRows,
      targetGroup.allRowNums,
      matchedTargetJob.isRetainer,
      isSysAdmin
    );

    const bgTasks = (async () => {
      if (sourceGroup && srcNorm.relocations?.length > 0) {
        await applySlotNoteAndFormattingRelocations_(
          sheets,
          cleanClientSheetId,
          "Confirmed",
          sourceGroup,
          slotKind,
          srcNorm.relocations
        );
      }
      if (tgtNorm.relocations?.length > 0) {
        await applySlotNoteAndFormattingRelocations_(
          sheets,
          cleanClientSheetId,
          "Confirmed",
          targetGroup,
          slotKind,
          tgtNorm.relocations
        );
      }
      await invalidatePortalAndPmaCaches_(cleanClientSheetId, cleanMasterSheetId, [
        "invoices",
        "outgoings",
        "jobs",
        "retainers",
        "cash",
      ]);
      const tenantClient =
        resolvedClientName ||
        (await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId));
      const summary = `Moved ${itemType === "invoice" ? `invoice #${itemKey}` : `direct cost ${itemKey}`} from "${primarySourceJob.jobName}" to "${matchedTargetJob.jobName}"`;
      await Promise.all([
        logPmaActivity(sheets, {
          automationCommanderSheetId,
          clientName: tenantClient,
          category: itemType === "invoice" ? "INVOICES" : "EXPENSES",
          action: itemType === "invoice" ? "Invoice Moved" : "Direct Cost Moved",
          summary,
          details: {
            itemKey,
            sourceJobName: primarySourceJob.jobName,
            targetJobName: matchedTargetJob.jobName,
            trancheCount: movedTranches.length,
          },
        }).catch(() => {}),
        logPulseActivity(sheets, {
          automationCommanderSheetId,
          clientName: tenantClient,
          category: "JOBS",
          action: itemType === "invoice" ? "INVOICE_MOVED" : "DIRECT_COST_MOVED",
          summary: sanitizeSpreadsheetTerms(summary),
          details: { itemKey, sourceJobName: primarySourceJob.jobName, targetJobName: matchedTargetJob.jobName },
          user: userEmail,
        }).catch(() => {}),
      ]);
    })();
    try {
      waitUntil(bgTasks);
    } catch (_) {}

    return {
      success: true,
      movedFrom: "job",
      movedTrancheCount: movedTranches.length,
      updatedInvoices: updatedArrays.invoices,
      updatedDirectExpenses: updatedArrays.directExpenses,
      ...(updatedRevenue !== undefined ? { updatedRevenue } : {}),
      ...(updatedDirectCosts !== undefined ? { updatedDirectCosts } : {}),
    };
  }

  // Case 2: Move direct cost from Contractors (Outgoings rows 13..110) onto target Confirmed job
  if (itemType === "directCost" && outgoingsMatches.length > 0) {
    const catalog = await loadAccountingDirectCosts_(sheets, cleanMasterSheetId);
    const authItem = catalog.byKey.get(cleanKey);

    // Group matched Outgoings occurrences by cell (sheetRow + colLetter)
    const cellMap = new Map();
    for (const m of outgoingsMatches) {
      const ck = `${m.sheetRow}:${m.colLetter}`;
      if (!cellMap.has(ck)) cellMap.set(ck, m);
    }

    const outgoingsGid = await getSheetGid(sheets, cleanClientSheetId, "Outgoings");
    const outgoingsValueWrites = [];
    const outgNotesData = [];
    const noteRequests = [];

    for (const cellMatch of cellMap.values()) {
      const { sheetRow, colIdx, colLetter, parsedNote } = cellMatch;
      const remainingBlocks = parsedNote.blocks.filter((b) => normalizeKey_(b.appId) !== cleanKey);
      const blockStr = remainingBlocks
        .map((b) => {
          const safeId = cleanNoteBlockField_(b.appId);
          const safeAmt = Number.isFinite(Number(b.amount)) ? Number(b.amount) : cleanNoteBlockField_(b.amount);
          const safeStatus = cleanNoteBlockField_(b.status);
          const safeRec = cleanNoteBlockField_(b.recDate);
          const safePay = cleanNoteBlockField_(b.payDate);
          const safeDesc = cleanNoteBlockField_(b.description);
          return `{App ID: ${safeId}}{Amt: ${safeAmt}}{Status:${safeStatus ? " " + safeStatus : ""}}{Rec date:${safeRec ? " " + safeRec : ""}}{Pay date:${safePay ? " " + safePay : ""}}{Description:${safeDesc ? " " + safeDesc : ""}}`;
        })
        .join("\n");
      const noteStr = parsedNote.topNote
        ? parsedNote.topNote + (blockStr ? "\n" + blockStr : "")
        : blockStr;

      const cellTotal = round2_(
        remainingBlocks
          .filter((b) => !String(b.appId || "").startsWith("UNRECON-GAP"))
          .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0)
      );

      outgoingsValueWrites.push({
        range: `Outgoings!${colLetter}${sheetRow}`,
        values: [[cellTotal || ""]],
      });
      outgNotesData.push({
        range: `OutgNotes!${colLetter}${sheetRow}`,
        values: [[sanitizeOutgNotesVal_(noteStr)]],
      });
      if (outgoingsGid !== null && outgoingsGid !== undefined) {
        noteRequests.push({
          updateCells: {
            range: {
              sheetId: outgoingsGid,
              startRowIndex: sheetRow - 1,
              endRowIndex: sheetRow,
              startColumnIndex: colIdx,
              endColumnIndex: colIdx + 1,
            },
            rows: [{ values: [{ note: noteStr }] }],
            fields: "note",
          },
        });
      }
    }

    // Update Outgoings cell values FIRST so Google Sheets recomputes Row 111 ("Making up CoS") before we read it
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: outgoingsValueWrites,
        },
        _skipFormulaRecompute: true,
      })
    );

    const uniqueColLetters = [...new Set(Array.from(cellMap.values()).map((c) => c.colLetter))];
    try {
      const cosRanges = [];
      for (const cl of uniqueColLetters) {
        cosRanges.push(`Outgoings!${cl}1`, `Outgoings!${cl}111`);
      }
      cosRanges.push("Outgoings!C111:D111");
      const cosResp = await withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: cleanClientSheetId,
          ranges: cosRanges,
          includeGridData: true,
          fields: "sheets.data.rowData.values(effectiveValue,formattedValue,note)",
        })
      );
      const dataArr = cosResp.data?.sheets?.[0]?.data || [];
      const timingsRow = dataArr[dataArr.length - 1]?.rowData?.[0]?.values || [];
      const cosInvTiming = timingsRow[0]?.formattedValue || "Curr";
      const cosPayTiming = timingsRow[1]?.formattedValue || "Curr";

      for (let idx = 0; idx < uniqueColLetters.length; idx++) {
        const cl = uniqueColLetters[idx];
        const hCellStr = dataArr[idx * 2]?.rowData?.[0]?.values?.[0]?.formattedValue || "";
        const cosCell = dataArr[idx * 2 + 1]?.rowData?.[0]?.values?.[0] || null;
        const newCosNote = buildUpdatedCosNote_(
          cosCell,
          hCellStr,
          cosInvTiming,
          cosPayTiming,
          cl
        );
        if (newCosNote !== null) {
          const colIdx = outgoingsMatches.find((m) => m.colLetter === cl)?.colIdx;
          if (colIdx !== undefined && outgoingsGid !== null && outgoingsGid !== undefined) {
            noteRequests.push({
              updateCells: {
                range: {
                  sheetId: outgoingsGid,
                  startRowIndex: 110,
                  endRowIndex: 111,
                  startColumnIndex: colIdx,
                  endColumnIndex: colIdx + 1,
                },
                rows: [{ values: [{ note: newCosNote }] }],
                fields: "note",
              },
            });
          }
          outgNotesData.push({
            range: `OutgNotes!${cl}111`,
            values: [[sanitizeOutgNotesVal_(newCosNote)]],
          });
        }
      }
    } catch (cosErr) {
      console.warn("[moveAccountingItemToJob] Could not read Row 111 CoS cells:", cosErr.message);
    }

    if (noteRequests.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: cleanClientSheetId,
          _skipFormulaRecompute: true,
          requestBody: { requests: noteRequests },
        })
      );
    }

    // Place direct cost onto target Confirmed job
    const firstMatch = outgoingsMatches[0];
    const expPayload = authItem || {
      appId: firstMatch.block.appId,
      description: firstMatch.block.description,
      contactName: firstMatch.contractorName,
      amount: round2_(outgoingsMatches.reduce((s, m) => s + (parseFloat(m.block.amount) || 0), 0)),
      vatAmount: 0,
      vatYesNo: "No",
      date: firstMatch.block.recDate,
      daysToPay: 30,
      status: firstMatch.block.status || "Received",
    };

    const allocated = await allocateSlotWithSpill_(sheets, cleanClientSheetId, targetGroup, "directCost");
    const confWriteData = [...allocated.deferredWrites];
    const slotVals = buildExpenseWriteValues_(expPayload);
    const slotWrite = applySlotWriteToGroup_(
      targetGroup,
      "directCost",
      allocated.rowNum,
      allocated.slotNum,
      slotVals
    );
    if (slotWrite) confWriteData.push(slotWrite);

    const { writes: budgetWrites, updatedDirectCosts } = buildRevenueOrBudgetWrites_(
      targetGroup,
      "directCost",
      { updateJobBudget, newJobBudget }
    );
    if (budgetWrites.length > 0) confWriteData.push(...budgetWrites);

    const normRes = await runAdjustAndNormalizeJobSlots_(
      sheets,
      cleanClientSheetId,
      "Confirmed",
      targetGroup,
      "expense",
      {
        jobBudgetOrRevenue: updatedDirectCosts,
        masterSheetId: cleanMasterSheetId,
        preloadedTolerances: tolerances,
      }
    ).catch(() => ({ batchData: [], relocations: [] }));

    const mergedConfWrites = mergeSlotBatchWrites_(confWriteData, normRes.batchData);
    await resetExpenseSlotFormatting_(
      sheets,
      cleanClientSheetId,
      "Confirmed",
      allocated.rowNum,
      allocated.slotNum
    );
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: mergedConfWrites,
        },
      })
    );

    const updatedArrays = buildUpdatedJobArraysFromRows_(
      targetGroup.allRows,
      targetGroup.allRowNums,
      matchedTargetJob.isRetainer,
      isSysAdmin
    );

    const tenantClient =
      resolvedClientName ||
      (await resolveClientNameBySheetId(sheets, cleanClientSheetId, automationCommanderSheetId));
    const targetMasterId = await resolveMasterIdForOutgoings_(
      sheets,
      cleanClientSheetId,
      tenantClient,
      cleanMasterSheetId
    );
    await syncOutgNotesAndTriggerRefresh_(sheets, {
      sheetIdClean: cleanClientSheetId,
      targetMasterId,
      tenantClient,
      outgNotesData,
    });

    const bgTasks = (async () => {
      if (normRes.relocations?.length > 0) {
        await applySlotNoteAndFormattingRelocations_(
          sheets,
          cleanClientSheetId,
          "Confirmed",
          targetGroup,
          "expense",
          normRes.relocations
        );
      }
      await invalidatePortalAndPmaCaches_(cleanClientSheetId, cleanMasterSheetId, [
        "outgoings",
        "jobs",
        "views",
        "cash",
      ]);
      const summary = `Moved direct cost "${expPayload.displayDescription || expPayload.description || expPayload.appId}" from Contractors (${firstMatch.contractorName}) to "${matchedTargetJob.jobName}"`;
      await Promise.all([
        logPmaActivity(sheets, {
          automationCommanderSheetId,
          clientName: tenantClient,
          category: "EXPENSES",
          action: "Direct Cost Moved from Contractors",
          summary,
          details: {
            appId: expPayload.appId,
            contractorName: firstMatch.contractorName,
            targetJobName: matchedTargetJob.jobName,
          },
        }).catch(() => {}),
        logPulseActivity(sheets, {
          automationCommanderSheetId,
          clientName: tenantClient,
          category: "JOBS",
          action: "DIRECT_COST_MOVED_FROM_CONTRACTORS",
          summary: sanitizeSpreadsheetTerms(summary),
          details: { appId: expPayload.appId, targetJobName: matchedTargetJob.jobName },
          user: userEmail,
        }).catch(() => {}),
      ]);
    })();
    try {
      waitUntil(bgTasks);
    } catch (_) {}

    return {
      success: true,
      movedFrom: "outgoings",
      movedTrancheCount: outgoingsMatches.length,
      updatedDirectExpenses: updatedArrays.directExpenses,
      ...(updatedDirectCosts !== undefined ? { updatedDirectCosts } : {}),
    };
  }

  const err = new Error("Item was not found on another job or in Contractors. Please refresh and try again.");
  err.statusCode = 404;
  throw err;
}
