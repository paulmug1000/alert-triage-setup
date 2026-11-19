import { createHash } from "crypto";
import { isPlaceholderInvoice, isPlaceholderExpense, toSheetDateFormat, toInputDateFormat, postGasWebAppLocked } from "../utils/helpers.js";
import { serialToDate } from "./gasRuntime/sheetValueUtils.js";
import { withRetry, colIndexToLetter, applySheetFontFormat, getSheetGid, sanitizeFormulaInput } from "./sheetsClient.js";
import { getClientWebAppUrl, getAllClients } from "./workspaces.js";
import { redisClient, scanRedisKeys } from "./redisClient.js";
import { ensureAlertMemoryTab, queryAlertMemoryTargeted, updateAlertMemoryRowsBatch, appendAlertMemoryRow, updateHandledAlertHashesBatch, invalidateAlertMemoryCache } from "./alertMemory.js";
import { applyAlertRemovalToTriageData, PRECOMPUTED_KEY, scheduleWaitUntil_ } from "./alertState.js";
import { invalidatePrecomputedMemoryCache } from "./triageEngine.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { isSupabaseControlPlaneActive } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  recomputeMasterFormulasForTabs,
  flushImmediateAndScheduleBackgroundClientRecomputes,
} from "./masterEngineService.js";
import {
  findForecastOnlyEmployeesInMonth_,
  applySalaryForecastResolution_,
  parseHeaderMonthMeta_,
  colIdxToLetter,
} from "./salariesService.js";
import { pushOutgoingsAndExpenseBreakdownNative } from "./masterSyncEngine.js";

export function parseConfirmedDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

  if (typeof val === "number" && Number.isFinite(val)) {
    const utc = new Date(Math.round((val - 25569) * 86400 * 1000));
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }

  const s = String(val).trim();
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const num = parseFloat(s);
    if (num > 20000 && num < 90000) {
      const utc = new Date(Math.round((num - 25569) * 86400 * 1000));
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
  }
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(yr, months[m[2]], parseInt(m[1], 10));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function parseMoney_(val) {
  if (val === "" || val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const n = parseFloat(String(val).replace(/[£$€,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function detectPeriodMultiplier_(childRow, monthlyRevenue) {
  if (!monthlyRevenue || monthlyRevenue <= 0) return 1;
  let totalInvAmt = 0;
  const slotPairs = [[41, 46], [48, 53], [55, 60]];
  for (let s = 0; s < slotPairs.length; s++) {
    const [amtIdx, rechIdx] = slotPairs[s];
    const raw = childRow[amtIdx];
    if (raw !== "" && raw !== null && raw !== undefined) {
      const grossAmt = parseMoney_(raw);
      const rechAmt = parseMoney_(childRow[rechIdx]);
      totalInvAmt += Math.max(0, grossAmt - rechAmt);
    }
  }
  if (totalInvAmt <= 0) return 1;
  return Math.max(1, Math.round(totalInvAmt / monthlyRevenue));
}

export function sumInvSlotBreakdown_(row) {
  let total = 0;
  let rechargedTotal = 0;
  const slotPairs = [[41, 46], [48, 53], [55, 60]];
  for (let s = 0; s < slotPairs.length; s++) {
    const [amtIdx, rechIdx] = slotPairs[s];
    total += parseMoney_(row?.[amtIdx]);
    rechargedTotal += parseMoney_(row?.[rechIdx]);
  }
  total = Math.round(total * 100) / 100;
  rechargedTotal = Math.round(rechargedTotal * 100) / 100;
  const feeTotal = Math.round((total - rechargedTotal) * 100) / 100;
  return { total, rechargedTotal, feeTotal };
}

export function sumInvSlotAmounts_(row) {
  return sumInvSlotBreakdown_(row).total;
}

export function sumRealInvSlotAmounts_(row) {
  let total = 0, rechargedTotal = 0, draftCount = 0, draftTotal = 0, draftRechargedTotal = 0;
  const slots = [
    { amtIdx: 41, refIdx: 42, statusIdx: 45, rechIdx: 46 },
    { amtIdx: 48, refIdx: 49, statusIdx: 52, rechIdx: 53 },
    { amtIdx: 55, refIdx: 56, statusIdx: 59, rechIdx: 60 },
  ];
  for (let s = 0; s < slots.length; s++) {
    const ref = String(row[slots[s].refIdx] || "").trim();
    if (!ref || isPlaceholderInvoice(ref)) continue;
    const raw = row[slots[s].amtIdx];
    if (raw === "" || raw === null || raw === undefined) continue;
    const amt = parseMoney_(raw);
    const rechAmt = parseMoney_(row[slots[s].rechIdx]);
    const status = String(row[slots[s].statusIdx] || "").trim().toLowerCase();
    const isDraftOrUnsent = !status || status.includes("draft") || status.includes("unsent");
    const isRealSentOrPaid = !isDraftOrUnsent && (status === "sent" || /\bsent\b/.test(status) || status.includes("paid") || status.includes("overdue"));
    if (isRealSentOrPaid) {
      total += amt;
      rechargedTotal += rechAmt;
    } else {
      draftCount++;
      draftTotal += amt;
      draftRechargedTotal += rechAmt;
    }
  }
  total = Math.round(total * 100) / 100;
  rechargedTotal = Math.round(rechargedTotal * 100) / 100;
  const netFeeTotal = Math.max(0, Math.round((total - rechargedTotal) * 100) / 100);
  draftTotal = Math.round(draftTotal * 100) / 100;
  draftRechargedTotal = Math.round(draftRechargedTotal * 100) / 100;
  return { total, rechargedTotal, netFeeTotal, draftCount, draftTotal, draftRechargedTotal };
}

export function sumExpSlotAmounts_(row) {
  let total = 0;
  const slotAmtIdxs = [76, 83, 90];
  for (let s = 0; s < slotAmtIdxs.length; s++) {
    const raw = row[slotAmtIdxs[s]];
    if (raw === "" || raw === null || raw === undefined) continue;
    total += parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
  }
  return total;
}

export function collectJobRows_(data, parentIdx) {
  const rows = [];
  const parentClient = String(data[parentIdx][0] || "").trim().toLowerCase();
  const parentJob = String(data[parentIdx][1] || "").trim().toLowerCase();
  rows.push({ row: data[parentIdx], sheetRow: parentIdx + 1, isParent: true });
  for (let ri = parentIdx + 1; ri < data.length; ri++) {
    const r = data[ri];
    const rc = String(r[0] || "").trim().toLowerCase();
    const rj = String(r[1] || "").trim().toLowerCase();
    if (!rc || !rj) break;
    if (rc !== parentClient || rj !== parentJob) break;
    if (r[17] || r[32] || r[37] || r[38]) break;
    rows.push({ row: r, sheetRow: ri + 1, isParent: false });
  }
  return rows;
}

export function buildStableJobKey_(clientNameRow, jobName, projectCode, startVal, endVal) {
  const base = String(clientNameRow || "").trim().toLowerCase() + "|" + String(jobName || "").trim().toLowerCase();
  const code = String(projectCode || "").trim();
  if (code) return base + "|code:" + code.toLowerCase();
  const fmtPart = (v) => {
    if (!v) return "";
    const d = v instanceof Date ? v : parseConfirmedDate_(v);
    if (!d) return String(v).trim().toLowerCase();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  return base + "|dates:" + fmtPart(startVal) + ":" + fmtPart(endVal);
}

export function collectSentInvoices_(row, sentInvoices) {
  const slots = [{ statusIdx: 45, sentIdx: 43 }, { statusIdx: 52, sentIdx: 50 }, { statusIdx: 59, sentIdx: 57 }];
  for (let s = 0; s < slots.length; s++) {
    const status = String(row[slots[s].statusIdx] || "").trim().toLowerCase();
    const isReal = status === "sent" || status === "paid" || status.includes("paid") || status.includes("sent");
    if (!isReal) continue;
    const sentVal = row[slots[s].sentIdx];
    if (!sentVal) continue;
    const sentDate = parseConfirmedDate_(sentVal);
    if (sentDate) sentInvoices.push(sentDate);
  }
}

export function inferFrequency_(sortedDates) {
  if (sortedDates.length < 2) return 30;
  const gaps = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push(Math.round((sortedDates[i].getTime() - sortedDates[i - 1].getTime()) / 86400000));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const standards = [30, 60, 90, 180, 365];
  let closest = standards[0];
  let minDiff = Math.abs(median - standards[0]);
  for (let j = 1; j < standards.length; j++) {
    const diff = Math.abs(median - standards[j]);
    if (diff < minDiff) { minDiff = diff; closest = standards[j]; }
  }
  return closest;
}

export async function findPossibleRetainerInvoice_(masterSheetId, clientSheetId, endClientName, expectedDate, sharedData, sheets, currentRetainerParentIdx = -1) {
  try {
    let invData = [];
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!A6:K5000" });
      invData = resp.data.values || [];
    } catch (e) { return null; }

    let confData = sharedData?.confirmedData;
    if (!confData) {
      try {
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BJ5000" });
        confData = confResp.data.values || [];
      } catch (e) { confData = []; }
    }

    // Collect invoice refs already attached to the current retainer job so we do not propose them as unattached/changed matches
    const sameJobRefs = new Set();
    if (currentRetainerParentIdx >= 1 && confData && confData[currentRetainerParentIdx]) {
      const pRow = confData[currentRetainerParentIdx];
      const pClient = String(pRow[0] || "").trim();
      const pJob = String(pRow[1] || "").trim();
      const refCols = [42, 49, 56];
      for (let jr = currentRetainerParentIdx; jr < confData.length; jr++) {
        const jrow = confData[jr] || [];
        if (jr > currentRetainerParentIdx) {
          if (String(jrow[0] || "").trim() !== pClient || String(jrow[1] || "").trim() !== pJob) break;
          if (jrow[32] || jrow[37] || jrow[38]) break;
        }
        for (const rc of refCols) {
          const ref = String(jrow[rc] || "").trim();
          if (ref && !isPlaceholderInvoice(ref)) sameJobRefs.add(ref.toUpperCase());
        }
      }
    }

    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const expectedTime = expectedDate.getTime();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    const candidates = [];
    for (let r = 0; r < invData.length; r++) {
      const row = invData[r];
      const invClient = String(row[0] || "").trim();
      if (invClient.toLowerCase() !== endClientName.toLowerCase()) continue;

      const sentVal = row[6];
      if (!sentVal) continue;
      const sentDate = sentVal instanceof Date ? sentVal : new Date(sentVal);
      if (isNaN(sentDate.getTime())) continue;
      if (Math.abs(sentDate.getTime() - expectedTime) > windowMs) continue;

      const invoiceNo = String(row[5] || "").trim();
      if (invoiceNo && sameJobRefs.has(invoiceNo.toUpperCase())) continue;
      const invoiceAmt = parseFloat(String(row[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const vatAmount = parseFloat(String(row[4] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const status = String(row[9] || "").trim();
      candidates.push({ invoiceNo, amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt, sentDate, vatAmount, status });
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aReal = (String(a.status || "").toLowerCase() === "sent" || String(a.status || "").toLowerCase() === "paid");
      const bReal = (String(b.status || "").toLowerCase() === "sent" || String(b.status || "").toLowerCase() === "paid");
      if (aReal !== bReal) return aReal ? -1 : 1;
      return Math.abs(a.sentDate.getTime() - expectedTime) - Math.abs(b.sentDate.getTime() - expectedTime);
    });
    const best = candidates[0];

    const result = {
      invoiceNo: best.invoiceNo, amount: best.amount, sentDate: fmtDate(best.sentDate),
      vatAmount: best.vatAmount || 0, status: best.status || "", confidence: "medium", attachedToRow: null,
    };

    if (confData && confData.length > 0) {
      const refCols = [42, 49, 56];
      let attachedRow = null, attachedJobStart = null, attachedJobEnd = null, attachedJobInvCount = 0;

      for (let cr = 1; cr < confData.length; cr++) {
        const crow = confData[cr];
        for (let rc = 0; rc < refCols.length; rc++) {
          const ref = String(crow[refCols[rc]] || "").trim();
          if (ref && best.invoiceNo && ref === best.invoiceNo) {
            attachedRow = cr + 1;
            let parentIdx = cr;
            while (parentIdx > 0 && !(confData[parentIdx][32] && confData[parentIdx][37] && confData[parentIdx][38])) parentIdx--;
            const parentRow = confData[parentIdx];
            attachedJobStart = parentRow[37];
            attachedJobEnd = parentRow[38];
            attachedJobInvCount = 0;
            for (let jr = parentIdx; jr < confData.length; jr++) {
              const jrow = confData[jr];
              if (jr > parentIdx && String(jrow[0] || "").trim() !== String(parentRow[0] || "").trim()) break;
              if (jr > parentIdx && String(jrow[1] || "").trim() !== String(parentRow[1] || "").trim()) break;
              for (let jc = 0; jc < refCols.length; jc++) {
                if (String(jrow[refCols[jc]] || "").trim()) attachedJobInvCount++;
              }
            }
            break;
          }
        }
        if (attachedRow) break;
      }

      if (!attachedRow) {
        result.confidence = "high";
      } else {
        result.attachedToRow = attachedRow;
        if (attachedJobInvCount === 1 && attachedJobStart && attachedJobEnd) {
          const jStart = attachedJobStart instanceof Date ? attachedJobStart : new Date(attachedJobStart);
          const jEnd = attachedJobEnd instanceof Date ? attachedJobEnd : new Date(attachedJobEnd);
          const sendMonth = best.sentDate.getMonth(), sendYear = best.sentDate.getFullYear();
          const lastDayOfMonth = new Date(sendYear, sendMonth + 1, 0).getDate();
          if (jStart.getDate() === 1 && jStart.getMonth() === sendMonth && jStart.getFullYear() === sendYear &&
            jEnd.getDate() === lastDayOfMonth && jEnd.getMonth() === sendMonth && jEnd.getFullYear() === sendYear) {
            result.confidence = "high";
          }
        }
      }
    }
    return result;
  } catch (e) {
    return null;
  }
}

export async function checkRetainerInvoices_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const jobType = String(row[35] || "").toLowerCase();
      if (!jobType.includes("retainer")) continue;

      const revenue = row[32];
      const startVal = row[37];
      const endVal = row[38];
      if (!revenue || !startVal || !endVal) continue;

      const clientNameRow = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      if (!jobName) continue;

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate) continue;
      const startDate = parseConfirmedDate_(startVal);

      const sentInvoices = [];
      collectSentInvoices_(row, sentInvoices);

      const childRows = [];
      for (let cr = r + 1; cr < data.length; cr++) {
        const childRow = data[cr];
        const childClient = String(childRow[0] || "").trim();
        const childJob = String(childRow[1] || "").trim();
        if ((childRow[17] || childRow[32] || childRow[37] || childRow[38]) && (childClient !== clientNameRow || childJob !== jobName)) break;
        if (childClient !== clientNameRow || childJob !== jobName) break;
        if (childRow[17] || childRow[32] || childRow[37] || childRow[38]) break;
        collectSentInvoices_(childRow, sentInvoices);
        childRows.push({ crIndex: cr, sheetRow: cr + 1, row: childRow });
      }

      const contractMonths = Math.max(1, Math.round((endDate.getTime() - (startDate ? startDate.getTime() : endDate.getTime())) / (30.4375 * 24 * 60 * 60 * 1000)));
      const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalContractValue = monthlyRevenue * contractMonths;

      let totalInvoiced = sumRealInvSlotAmounts_(row).netFeeTotal;
      for (let cj = 0; cj < childRows.length; cj++) {
        totalInvoiced += sumRealInvSlotAmounts_(childRows[cj].row).netFeeTotal;
      }

      if (totalContractValue > 0 && totalInvoiced >= totalContractValue * 0.95) continue;

      // Determine schedule interval and untouched future anchor so child rows whose Send Date was rolled
      // forward to the 28th of a subsequent month by updateStaleUnsentInvoices still retain their true scheduled month
      const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
      const parsedChildDates = childRows.map(cr => parseConfirmedDate_(cr.row[43]));
      const validChildDates = parsedChildDates.filter(Boolean);
      let intervalMonths = 1;
      if (validChildDates.length >= 2) {
        const d1 = validChildDates[validChildDates.length - 2];
        const d2 = validChildDates[validChildDates.length - 1];
        const calcInt = Math.round(Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86400000) / 30);
        if (calcInt > 0) intervalMonths = calcInt;
      }

      let anchorChildIdx = -1;
      let anchorMonthVal = null;
      for (let m = childRows.length - 1; m >= 0; m--) {
        const d = parsedChildDates[m];
        if (!d) continue;
        const mVal = d.getFullYear() * 12 + d.getMonth();
        if (mVal > currentMonthVal) {
          anchorChildIdx = m;
          anchorMonthVal = mVal;
          break;
        }
      }
      if (anchorChildIdx === -1) {
        for (let m = 0; m < childRows.length; m++) {
          const d = parsedChildDates[m];
          const ref1 = String(childRows[m].row[42] || "").trim();
          if (d && ref1 && !isPlaceholderInvoice(ref1)) {
            anchorChildIdx = m;
            anchorMonthVal = d.getFullYear() * 12 + d.getMonth();
            break;
          }
        }
      }

      // Check all child rows in sequence for any overdue uninvoiced row (even if later rows already have Sent/Paid invoices)
      let hasUnsentScheduled = false;
      let unsentSendDate = null;
      for (let k = 0; k < childRows.length; k++) {
        const cr2 = childRows[k].row;
        const slots2 = [{ sentIdx: 43, refIdx: 42 }, { sentIdx: 50, refIdx: 49 }, { sentIdx: 57, refIdx: 56 }];
        let rowHasRealInv = false;
        for (let s2 = 0; s2 < slots2.length; s2++) {
          const rVal = String(cr2[slots2[s2].refIdx] || "").trim();
          if (rVal && !isPlaceholderInvoice(rVal)) {
            rowHasRealInv = true;
            break;
          }
        }
        if (rowHasRealInv) continue;

        for (let s2 = 0; s2 < slots2.length; s2++) {
          const sentVal2 = cr2[slots2[s2].sentIdx];
          const refVal2 = String(cr2[slots2[s2].refIdx] || "").trim();
          if (!sentVal2 || (refVal2 && !isPlaceholderInvoice(refVal2))) continue;
          const rawSentDate2 = parseConfirmedDate_(sentVal2);
          if (!rawSentDate2) continue;

          let effectiveSendDate2 = rawSentDate2;
          if (s2 === 0) {
            let schedMonthVal = null;
            if (anchorChildIdx !== -1 && anchorMonthVal !== null) {
              schedMonthVal = anchorMonthVal - (anchorChildIdx - k) * intervalMonths;
            } else if (startDate) {
              schedMonthVal = startDate.getFullYear() * 12 + startDate.getMonth() + k * intervalMonths;
            }
            const rawMonthVal = rawSentDate2.getFullYear() * 12 + rawSentDate2.getMonth();
            if (schedMonthVal !== null && rawMonthVal > schedMonthVal) {
              const schedYear = Math.floor(schedMonthVal / 12);
              const schedMonth0 = ((schedMonthVal % 12) + 12) % 12;
              const maxDay = new Date(schedYear, schedMonth0 + 1, 0).getDate();
              effectiveSendDate2 = new Date(schedYear, schedMonth0, Math.min(28, maxDay));
            }
          }

          if (effectiveSendDate2 < today) {
            hasUnsentScheduled = true;
            unsentSendDate = effectiveSendDate2;
            break;
          }
        }
        if (hasUnsentScheduled) break;
      }

      if (hasUnsentScheduled) {
        sentInvoices.sort((a, b) => a.getTime() - b.getTime());
        const lastRealSent = sentInvoices.length > 0 ? sentInvoices[sentInvoices.length - 1] : null;
        const possibleMatch1 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, unsentSendDate, sharedData, sheets, r);
        let detail1 = `${clientNameRow} - ${jobName}: invoice was scheduled for ${fmtDate(unsentSendDate)} but has no reference number - it may not have been sent yet.`;
        let possibleMatchCase1 = "";
        if (possibleMatch1) {
          const match1Status = String(possibleMatch1.status || "").toLowerCase();
          const match1IsReal = (match1Status === "sent" || match1Status === "paid");
          if (match1IsReal) {
            const match1Differs = Math.abs(possibleMatch1.amount - monthlyRevenue) > 0.01;
            possibleMatchCase1 = match1Differs ? "changed" : "matches";
            if (match1Differs) {
              detail1 += `\nPossible match: invoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch1.sentDate} (confidence: ${possibleMatch1.confidence})${possibleMatch1.attachedToRow ? ` - already attached to Confirmed row ${possibleMatch1.attachedToRow}` : " - not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
            } else {
              detail1 += `\nInvoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch1.sentDate}, matching the expected retainer amount${possibleMatch1.attachedToRow ? ` - already attached to Confirmed row ${possibleMatch1.attachedToRow}.` : ", but not yet attached to this job in Confirmed."}`;
            }
          } else {
            possibleMatchCase1 = "draft";
            detail1 += `\nNote: invoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)}${possibleMatch1.attachedToRow ? ` already exists on Confirmed row ${possibleMatch1.attachedToRow}` : " already exists"} but is still marked "${possibleMatch1.status || "unsent"}" - it likely just needs sending.`;
          }
        }
        const expectedDateStr1 = unsentSendDate ? fmtDate(unsentSendDate) : "";
        alerts.push({
          alertType: "retainer_invoice",
          alertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}|${expectedDateStr1}`,
          legacyAlertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}`,
          heading: "Retainer invoice not sent",
          detail: detail1, jobName, endClientName: clientNameRow, confirmedRow: r + 1,
          stableJobKey: `${clientNameRow}|${jobName}`, revenue: String(revenue || ""),
          startDate: startDate ? fmtDate(startDate) : "",
          endDate: fmtDate(endDate),
          lastInvoiceDate: lastRealSent ? fmtDate(lastRealSent) : "",
          expectedByDate: fmtDate(unsentSendDate),
          possibleMatchInvoiceNo: possibleMatch1?.invoiceNo || "", possibleMatchAmount: String(possibleMatch1?.amount || ""),
          possibleMatchSentDate: possibleMatch1?.sentDate || "", possibleMatchVatAmount: String(possibleMatch1?.vatAmount || 0),
          possibleMatchStatus: possibleMatch1?.status || "", possibleMatchConfidence: possibleMatch1?.confidence || "",
          possibleMatchConfirmedRow: possibleMatch1?.attachedToRow ? String(possibleMatch1.attachedToRow) : "",
          possibleMatchCase: possibleMatchCase1,
        });
        continue;
      }

      if (sentInvoices.length === 0) continue;

      sentInvoices.sort((a, b) => a.getTime() - b.getTime());
      const lastInvoice = sentInvoices[sentInvoices.length - 1];
      const allJobRows = [row, ...childRows.map(cr => cr.row)];

      let frequencyDays = 30;
      if (sentInvoices.length >= 2) {
        frequencyDays = inferFrequency_(sentInvoices);
      } else if (monthlyRevenue > 0) {
        let firstInvAmt = 0;
        for (let fj = 0; fj < allJobRows.length; fj++) {
          const fjReal = sumRealInvSlotAmounts_(allJobRows[fj]).netFeeTotal;
          if (fjReal > 0) { firstInvAmt = fjReal; break; }
        }
        if (firstInvAmt > 0) {
          const ratio = Math.round(firstInvAmt / monthlyRevenue);
          if (ratio >= 2) {
            const standards = [30, 60, 90, 180, 365];
            const targetDays = ratio * 30;
            let closest2 = standards[0], minDiff2 = Math.abs(targetDays - standards[0]);
            for (let si = 1; si < standards.length; si++) {
              const diff2 = Math.abs(targetDays - standards[si]);
              if (diff2 < minDiff2) { minDiff2 = diff2; closest2 = standards[si]; }
            }
            frequencyDays = closest2;
          }
        }
      }

      const expectedBy = new Date(lastInvoice.getTime() + (frequencyDays + 5) * 24 * 60 * 60 * 1000);
      expectedBy.setHours(0, 0, 0, 0);
      const nextPeriodStart = new Date(lastInvoice.getTime() + frequencyDays * 24 * 60 * 60 * 1000);

      // Account for 1-month arrears retainers where the final invoice is expected up to 1 interval after endDate
      const isArrearsSchedule = Boolean(
        startDate &&
        validChildDates.length > 0 &&
        validChildDates[0].getTime() > new Date(startDate.getFullYear(), startDate.getMonth() + intervalMonths, 0, 23, 59, 59).getTime()
      );
      const effectiveEndForSchedule = isArrearsSchedule
        ? new Date(endDate.getFullYear(), endDate.getMonth() + intervalMonths + 1, 0, 23, 59, 59)
        : endDate;

      if (today > expectedBy && effectiveEndForSchedule > nextPeriodStart) {
        const possibleMatch2 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, expectedBy, sharedData, sheets, r);
        let detail2 = `${clientNameRow} - ${jobName}, last invoice sent ${fmtDate(lastInvoice)}, next one had been expected by ${fmtDate(expectedBy)}. Check whether retainer has ended.`;
        let possibleMatchCase = "";
        if (possibleMatch2) {
          const match2Status = String(possibleMatch2.status || "").toLowerCase();
          const match2IsReal = (match2Status === "sent" || match2Status === "paid");
          if (match2IsReal) {
            const match2Differs = Math.abs(possibleMatch2.amount - monthlyRevenue) > 0.01;
            possibleMatchCase = match2Differs ? "changed" : "matches";
            if (match2Differs) {
              detail2 += `\nPossible match: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate} (confidence: ${possibleMatch2.confidence})${possibleMatch2.attachedToRow ? ` - already attached to Confirmed row ${possibleMatch2.attachedToRow}` : " - not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
            } else {
              detail2 += `\nInvoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate}, matching the expected retainer amount${possibleMatch2.attachedToRow ? ` - already attached to Confirmed row ${possibleMatch2.attachedToRow}.` : ", but not yet attached to this job in Confirmed."}`;
            }
          } else {
            possibleMatchCase = "draft";
            detail2 += `\nNote: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)}${possibleMatch2.attachedToRow ? ` already exists on Confirmed row ${possibleMatch2.attachedToRow}` : " already exists"} but is still marked "${possibleMatch2.status || "unsent"}" - it likely just needs sending.`;
          }
        }
        const expectedDateStr2 = expectedBy ? fmtDate(expectedBy) : "";
        alerts.push({
          alertType: "retainer_invoice",
          alertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}|${expectedDateStr2}`,
          legacyAlertKey: `retainer_invoice|${clientName}|${clientNameRow}|${jobName}`,
          heading: "Retainer job expected invoice not sent",
          detail: detail2, jobName, endClientName: clientNameRow, confirmedRow: r + 1,
          stableJobKey: `${clientNameRow}|${jobName}`, revenue: String(revenue || ""),
          startDate: startDate ? fmtDate(startDate) : "",
          endDate: fmtDate(endDate), frequencyDays, lastInvoiceDate: fmtDate(lastInvoice), expectedByDate: fmtDate(expectedBy),
          possibleMatchInvoiceNo: possibleMatch2?.invoiceNo || "", possibleMatchAmount: String(possibleMatch2?.amount || ""),
          possibleMatchSentDate: possibleMatch2?.sentDate || "", possibleMatchVatAmount: String(possibleMatch2?.vatAmount || 0),
          possibleMatchStatus: possibleMatch2?.status || "", possibleMatchConfidence: possibleMatch2?.confidence || "",
          possibleMatchConfirmedRow: possibleMatch2?.attachedToRow ? String(possibleMatch2.attachedToRow) : "",
          possibleMatchCase,
        });
      }
    }
  } catch (e) { }
  return alerts;
}

export async function checkCRMWipe_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.autoLogData || [];
    const WARNING_TEXT = "WARNING: CRM wiped data blank!";
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const details = String(row[3] || "");
      if (!details.includes(WARNING_TEXT)) continue;

      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");
      const sequenceType = String(row[1] || "");
      const summary = String(row[2] || "");
      const jobMatch = details.match(/Job[:\s]+([^\n,]+)/i);
      const jobInfo = jobMatch ? jobMatch[1].trim() : "";

      alerts.push({
        alertType: "crm_wipe", alertKey: `crm_wipe|${clientName}|${tsStr}`,
        heading: "CRM data wipe warning",
        detail: `AutoLog entry at ${tsStr} contains: "${WARNING_TEXT}". Review CRM data for ${clientName}.`,
        timestamp: tsStr, sequenceType, summary, jobInfo, detailsSnippet: details.slice(0, 300),
      });
    }
  } catch (e) { }
  return alerts;
}

export async function checkRevenueMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TOLERANCE = 1.00;
    const hasVal = (v) => v !== "" && v !== null && v !== undefined && String(v).trim() !== "";

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32];
      const rechargedRaw = row[17];
      const jobType = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal = row[38];

      if ((!hasVal(revenue) && !hasVal(rechargedRaw)) || !startVal || !endVal) { r++; continue; }

      const feeBudget = Math.round(parseMoney_(revenue) * 100) / 100;
      const rechargedBudget = Math.round(parseMoney_(rechargedRaw) * 100) / 100;
      const billableBudget = Math.round((feeBudget + rechargedBudget) * 100) / 100;

      if (billableBudget <= 0) {
        const jobRows0 = collectJobRows_(data, r);
        let totalInvoiced0 = 0;
        let rechargedInvoiced0 = 0;
        for (let jr0 = 0; jr0 < jobRows0.length; jr0++) {
          const bd0 = sumInvSlotBreakdown_(jobRows0[jr0].row);
          totalInvoiced0 += bd0.total;
          rechargedInvoiced0 += bd0.rechargedTotal;
        }
        totalInvoiced0 = Math.round(totalInvoiced0 * 100) / 100;
        rechargedInvoiced0 = Math.round(rechargedInvoiced0 * 100) / 100;
        const feeInvoiced0 = Math.round((totalInvoiced0 - rechargedInvoiced0) * 100) / 100;
        if (totalInvoiced0 > 0) {
          const jobClient0 = String(row[0] || "").trim();
          const jobName0 = String(row[1] || "").trim();
          const projectCode0 = String(row[2] || "").trim();
          alerts.push({
            alertType: "revenue_mismatch",
            alertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}|rev:0.00|inv:${totalInvoiced0.toFixed(2)}`,
            legacyAlertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}`,
            heading: "Revenue / total invoiced mismatch",
            detail: `${jobClient0} | ${jobName0} (Row ${r + 1})${projectCode0 ? ` [${projectCode0}]` : ""}: revenue = £0.00 but total invoiced (incl. placeholders) = £${totalInvoiced0.toFixed(2)} - job revenue appears to be missing or not yet set.`,
            jobName: jobName0, endClientName: jobClient0, projectCode: projectCode0, confirmedRow: r + 1, isRetainer: jobType.includes("retainer"),
            endDate: endVal ? toSheetDateFormat(endVal) : "",
            revenue: "0.00", feeRevenue: "0.00", rechargedExpenses: "0.00", billableBudget: "0.00",
            totalInvoiced: totalInvoiced0.toFixed(2), feeInvoiced: feeInvoiced0.toFixed(2), rechargedInvoiced: rechargedInvoiced0.toFixed(2),
            diff: totalInvoiced0.toFixed(2), rechargedDiff: rechargedInvoiced0.toFixed(2),
          });
        }
        r += jobRows0.length;
        continue;
      }

      const startDate = parseConfirmedDate_(startVal);
      if (startDate && startDate > today) { r += collectJobRows_(data, r).length; continue; }

      const jobClient = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows = collectJobRows_(data, r);

      let mismatch = false, detail = "", mismatchTotalInvoiced = 0, mismatchFeeInvoiced = 0, mismatchRechargedInvoiced = 0;
      let billableDiff = 0, rechargedDiff = 0;

      if (!isRetainer) {
        let totalInvoiced = 0;
        let rechargedInvoiced = 0;
        for (let jr = 0; jr < jobRows.length; jr++) {
          const bd = sumInvSlotBreakdown_(jobRows[jr].row);
          totalInvoiced += bd.total;
          rechargedInvoiced += bd.rechargedTotal;
        }
        totalInvoiced = Math.round(totalInvoiced * 100) / 100;
        rechargedInvoiced = Math.round(rechargedInvoiced * 100) / 100;
        const feeInvoiced = Math.round((totalInvoiced - rechargedInvoiced) * 100) / 100;
        if (totalInvoiced === 0) { r += jobRows.length; continue; }

        billableDiff = Math.round((totalInvoiced - billableBudget) * 100) / 100;
        rechargedDiff = Math.round((rechargedInvoiced - rechargedBudget) * 100) / 100;
        if (Math.abs(billableDiff) > TOLERANCE || Math.abs(rechargedDiff) > TOLERANCE) {
          mismatch = true;
          mismatchTotalInvoiced = totalInvoiced;
          mismatchFeeInvoiced = feeInvoiced;
          mismatchRechargedInvoiced = rechargedInvoiced;
          if (Math.abs(billableDiff) > TOLERANCE) {
            const budgetDesc = rechargedBudget > 0
              ? `billable budget = £${billableBudget.toFixed(2)} (£${feeBudget.toFixed(2)} fee + £${rechargedBudget.toFixed(2)} recharged)`
              : `revenue = £${billableBudget.toFixed(2)}`;
            const invDesc = (rechargedInvoiced > 0 || rechargedBudget > 0)
              ? `total invoiced (incl. placeholders) = £${totalInvoiced.toFixed(2)} (£${feeInvoiced.toFixed(2)} fee + £${rechargedInvoiced.toFixed(2)} recharged)`
              : `total invoiced (incl. placeholders) = £${totalInvoiced.toFixed(2)}`;
            detail = `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: ${budgetDesc}, ${invDesc} - difference of £${Math.abs(billableDiff).toFixed(2)}`;
          } else {
            detail = `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: total invoiced (£${totalInvoiced.toFixed(2)}) matches billable budget (£${billableBudget.toFixed(2)}), but invoiced recharged expenses (£${rechargedInvoiced.toFixed(2)}) do not match job recharged expenses (£${rechargedBudget.toFixed(2)}) - difference of £${Math.abs(rechargedDiff).toFixed(2)}`;
          }
        }
      }
      // Note: Retainers recognise revenue according to their monthly job revenue amount (Col AG),
      // even if actual monthly invoices vary due to FX / currency conversions or billing adjustments.
      // Therefore, differences between monthly invoice amounts and the monthly revenue rate
      // are normal and do not raise revenue_mismatch alerts.

      if (mismatch) {
        const baseAlertKey = `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}|rev:${billableBudget.toFixed(2)}|inv:${mismatchTotalInvoiced.toFixed(2)}`;
        const alertKey = (Math.abs(billableDiff) <= TOLERANCE && Math.abs(rechargedDiff) > TOLERANCE)
          ? `${baseAlertKey}|rech:${rechargedBudget.toFixed(2)}|rechInv:${mismatchRechargedInvoiced.toFixed(2)}`
          : baseAlertKey;
        const reportedDiff = Math.abs(billableDiff) > TOLERANCE ? Math.abs(billableDiff) : Math.abs(rechargedDiff);
        alerts.push({
          alertType: "revenue_mismatch",
          alertKey,
          legacyAlertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}`,
          heading: "Revenue / total invoiced mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
          endDate: endVal ? toSheetDateFormat(endVal) : "",
          revenue: billableBudget.toFixed(2),
          feeRevenue: feeBudget.toFixed(2),
          rechargedExpenses: rechargedBudget.toFixed(2),
          billableBudget: billableBudget.toFixed(2),
          totalInvoiced: mismatchTotalInvoiced.toFixed(2),
          feeInvoiced: mismatchFeeInvoiced.toFixed(2),
          rechargedInvoiced: mismatchRechargedInvoiced.toFixed(2),
          diff: reportedDiff.toFixed(2),
          rechargedDiff: Math.abs(rechargedDiff).toFixed(2),
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

export async function checkDirectCostsMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  const tabName = "Confirmed";
  const startRow = 2;
  try {
    const data = sharedData?.confirmedData ? sharedData.confirmedData.slice(startRow - 1) : [];
    if (data.length === 0) return alerts;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TOLERANCE = 1.00;
    let r = 0;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32];
      const directCosts = row[33];
      const jobType = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }

      const directCostsAmt = parseFloat(String(directCosts || "0").replace(/[£$€,\s]/g, "")) || 0;
      if (directCostsAmt <= 0) {
        const skipRows = collectJobRows_(data, r);
        r += skipRows.length;
        continue;
      }

      const startDate = parseConfirmedDate_(startVal);
      if (startDate && startDate > today) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
      const jobClient = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows = collectJobRows_(data, r);
      const sheetRow = startRow + r;

      let mismatch = false, detail = "", mismatchExpTotal = 0;

      if (!isRetainer) {
        let totalExpenses = 0;
        for (let jr = 0; jr < jobRows.length; jr++) totalExpenses += sumExpSlotAmounts_(jobRows[jr].row);
        if (totalExpenses === 0) { r += jobRows.length; continue; }

        const diff = Math.abs(totalExpenses - directCostsAmt);
        if (diff > TOLERANCE) {
          mismatch = true;
          mismatchExpTotal = totalExpenses;
          detail = `${jobClient} | ${jobName} (Row ${sheetRow})${projectCode ? ` [${projectCode}]` : ""} [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses (incl. placeholders) = £${totalExpenses.toFixed(2)} - difference of £${diff.toFixed(2)}`;
        }
      } else {
        const childRows = jobRows.filter(jr => !jr.isParent);
        if (childRows.length === 0) {
          const parentExp = sumExpSlotAmounts_(row);
          if (parentExp === 0) { r += jobRows.length; continue; }
          const diffA = Math.abs(parentExp - directCostsAmt);
          if (diffA > TOLERANCE) {
            mismatch = true;
            mismatchExpTotal = parentExp;
            detail = `${jobClient} | ${jobName} (Row ${sheetRow}) [retainer, single-row] [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses on parent = £${parentExp.toFixed(2)} - difference of £${diffA.toFixed(2)}`;
          }
        } else {
          for (let ci = 0; ci < childRows.length; ci++) {
            const cr = childRows[ci];
            const childExp = sumExpSlotAmounts_(cr.row);
            if (childExp === 0) continue;
            const mult = detectPeriodMultiplier_(cr.row, revenueAmt);
            const expectedForRow = directCostsAmt * mult;
            const diffC = Math.abs(childExp - expectedForRow);
            if (diffC > TOLERANCE) {
              const txId = String(cr.row[81] || "").trim();
              const expDate = String(cr.row[78] || "").trim();
              const suffix = txId || expDate || `child-${ci}`;
              const childSheetRow = cr.sheetRow + startRow - 1;

              alerts.push({
                alertType: "direct_costs_mismatch",
                alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}|${suffix}${projectCode ? `|${projectCode}` : ""}|exp:${childExp.toFixed(2)}|expected:${expectedForRow.toFixed(2)}`,
                legacyAlertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}|${suffix}${projectCode ? `|${projectCode}` : ""}`,
                heading: "Direct costs / total expenses mismatch",
                detail: `${jobClient} | ${jobName} (Row ${childSheetRow}) [retainer, multi-row] [${tabName} tab]: £${childExp.toFixed(2)} expenses, expected £${expectedForRow.toFixed(2)} (${mult}× monthly budget of £${directCostsAmt.toFixed(2)}) - diff £${diffC.toFixed(2)}`,
                jobName, endClientName: jobClient, projectCode, confirmedRow: childSheetRow, isRetainer, tab: tabName,
                endDate: endVal ? toSheetDateFormat(endVal) : "",
                childExp: childExp.toFixed(2), expectedForRow: expectedForRow.toFixed(2), directCosts: directCostsAmt.toFixed(2),
              });
            }
          }
        }
      }

      if (mismatch) {
        alerts.push({
          alertType: "direct_costs_mismatch",
          alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}${projectCode ? `|${projectCode}` : ""}|budget:${directCostsAmt.toFixed(2)}|exp:${mismatchExpTotal.toFixed(2)}`,
          legacyAlertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}${projectCode ? `|${projectCode}` : ""}`,
          heading: "Direct costs / total expenses mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: sheetRow, isRetainer, tab: tabName,
          endDate: endVal ? toSheetDateFormat(endVal) : "",
          directCosts: directCostsAmt.toFixed(2), totalExpenses: mismatchExpTotal.toFixed(2), diff: Math.abs(mismatchExpTotal - directCostsAmt).toFixed(2),
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

export async function checkPipelineConfirmedOverlap_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const confData = sharedData?.confirmedData || [];
    const pipeData = sharedData?.pipelineData || [];
    if (confData.length < 2 || pipeData.length < 2) return alerts;

    const pipeByCode = {}, pipeByJob = {};
    for (let p = 1; p < pipeData.length; p++) {
      const pr = pipeData[p];
      const pClient = String(pr[0] || "").trim();
      const pJob = String(pr[1] || "").trim();
      const pCode = String(pr[2] || "").trim();
      const pLikelihood = String(pr[39] || "").trim();
      const pCopied = String(pr[107] || "").trim();
      if (!pClient && !pJob && !pCode) continue;

      const pipeInfo = { sheetRow: p + 1, likelihood: pLikelihood, copiedToConf: pCopied, jobName: pJob, clientName: pClient, projectCode: pCode };
      if (pCode) pipeByCode[pCode.toLowerCase()] = pipeInfo;
      if (pClient && pJob) pipeByJob[`${pClient.toLowerCase()}|||${pJob.toLowerCase()}`] = pipeInfo;
    }

    for (let r = 1; r < confData.length; r++) {
      const row = confData[r];
      const confClient = String(row[0] || "").trim();
      const confJob = String(row[1] || "").trim();
      const confCode = String(row[2] || "").trim();
      const confRevenue = row[32];
      const confStart = row[37];
      const confJobType = String(row[35] || "").trim();

      if (!confRevenue || !confStart || !confJob) continue;

      let pipeMatch = null;
      if (confCode) pipeMatch = pipeByCode[confCode.toLowerCase()] || null;
      if (!pipeMatch && confClient && confJob) pipeMatch = pipeByJob[`${confClient.toLowerCase()}|||${confJob.toLowerCase()}`] || null;

      if (!pipeMatch) continue;

      const likelihoodIs0 = (pipeMatch.likelihood === "0%" || pipeMatch.likelihood === "0");
      const copiedIsYes = (pipeMatch.copiedToConf.toLowerCase() === "yes");
      if (likelihoodIs0 || copiedIsYes) continue;

      const confRevenueAmt = parseFloat(String(confRevenue).replace(/[£$€,\s]/g, "")) || 0;
      const detail = `Job found in both Confirmed and Pipeline tabs but Pipeline row is not closed out.\nConfirmed: row ${r + 1}, client: ${confClient}, job: ${confJob}${confCode ? `, project code: ${confCode}` : ""}${confJobType ? `, type: ${confJobType}` : ""}${confRevenueAmt > 0 ? `, revenue: £${confRevenueAmt.toFixed(2)}` : ""}.\nPipeline: row ${pipeMatch.sheetRow}, likelihood: ${pipeMatch.likelihood || "(blank)"}, "Copied to confirmed?": ${pipeMatch.copiedToConf || "(blank)"}.\nExpected fix: set Pipeline likelihood to 0% OR mark "Copied to confirmed?" as Yes.`;

      alerts.push({
        alertType: "pipeline_confirmed_overlap",
        alertKey: `pipeline_confirmed_overlap|${clientName}|${confClient}|${confCode || confJob}|cRow:${r + 1}|pRow:${pipeMatch.sheetRow}|pLike:${pipeMatch.likelihood || ""}|pCopied:${pipeMatch.copiedToConf || ""}`,
        legacyAlertKey: `pipeline_confirmed_overlap|${clientName}|${confClient}|${confCode || confJob}`,
        heading: "Job in both Pipeline and Confirmed - Pipeline not closed out", detail, jobName: confJob, endClientName: confClient,
        projectCode: confCode, confirmedRow: r + 1, pipelineRow: pipeMatch.sheetRow, likelihood: pipeMatch.likelihood, copiedToConf: pipeMatch.copiedToConf, jobType: confJobType,
      });
    }
  } catch (e) { }
  return alerts;
}

export async function checkRetainerShrinkBlocked_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.autoLogData || [];
    const WARNING_FRAGMENT = "unable to trim excess child row";
    const seenRowNums = {};

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const details = String(row[3] || "");
      if (!details.includes(WARNING_FRAGMENT)) continue;

      const rowMatch = details.match(/excess child row\s+(\d+)\s+for/i);
      const childRowNum = rowMatch ? parseInt(rowMatch[1], 10) : null;
      if (!childRowNum || seenRowNums[childRowNum]) continue;
      seenRowNums[childRowNum] = true;

      const jobMatch = details.match(/excess child row\s+\d+\s+for\s+([^.]+?)\s+due to actuals/i);
      const clientJobStr = jobMatch ? jobMatch[1].trim() : "";
      let endClientStr = "", jobName = "";
      if (clientJobStr.includes(" | ")) {
        endClientStr = clientJobStr.slice(0, clientJobStr.indexOf(" | ")).trim();
        jobName = clientJobStr.slice(clientJobStr.indexOf(" | ") + 3).trim();
      } else { jobName = clientJobStr; }

      const timestamp = row[0];
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      alerts.push({
        alertType: "retainer_shrink_blocked",
        alertKey: `retainer_shrink_blocked|${clientName}|${endClientStr || "unknown"}|${jobName || clientJobStr}|row${childRowNum}${tsStr ? `|${tsStr}` : ""}`,
        legacyAlertKey: `retainer_shrink_blocked|${clientName}|${endClientStr || "unknown"}|${jobName || clientJobStr}|row${childRowNum}`,
        heading: "Retainer child row blocked from trimming - manual review needed",
        detail: `Retainer contract shrunk but the system was unable to automatically trim child row ${childRowNum} because the row contains actuals (expenses or invoices already recorded).\nJob: ${clientJobStr || clientName}.\nChild row ${childRowNum} is now an excess row that falls outside the new contract period but cannot be removed automatically.\nAction required: manually review row ${childRowNum} in the Confirmed tab and decide whether to keep, adjust, or remove it.\nFirst detected: ${tsStr ? tsStr.slice(0, 10) : "(unknown date)"}.`,
        jobName, endClientName: endClientStr, childRowNum, clientJobStr, timestamp: tsStr, confirmedRow: childRowNum,
      });
    }
  } catch (e) { }
  return alerts;
}

export async function checkUninvoicedNewJobs_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const oneMonthAgo = new Date(today);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32], rechargedRaw = row[17], startVal = row[37], endVal = row[38];

      if ((!revenue && !rechargedRaw) || !startVal) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue || "").replace(/[£$€,\s]/g, "")) || 0;
      const rechargedAmt = parseFloat(String(rechargedRaw || "").replace(/[£$€,\s]/g, "")) || 0;
      const billableAmt = Math.round((revenueAmt + rechargedAmt) * 100) / 100;
      if (billableAmt <= 0) { r += collectJobRows_(data, r).length; continue; }

      const startDate = parseConfirmedDate_(startVal);
      if (!startDate || startDate > oneMonthAgo) { r += collectJobRows_(data, r).length; continue; }

      // Completed jobs with uninvoiced revenue are handled with higher precedence by checkUninvoicedRevenue_
      const jobType = String(row[35] || "").toLowerCase();
      const isRetainer = jobType.includes("retainer");
      const endDate = endVal ? parseConfirmedDate_(endVal) : null;
      const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
      const isCompletedPastGrace = !isRetainer && endDate && (today.getTime() - endDate.getTime()) > TWO_WEEKS_MS;
      if (isCompletedPastGrace) {
        r += collectJobRows_(data, r).length;
        continue;
      }

      const jobClient = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const jobRows = collectJobRows_(data, r);
      let hasRealInvoice = false;

      for (let jr = 0; jr < jobRows.length; jr++) {
        const jRow = jobRows[jr].row;
        const slots = [{ ref: 42, amt: 41, rech: 46 }, { ref: 49, amt: 48, rech: 53 }, { ref: 56, amt: 55, rech: 60 }];
        for (const s of slots) {
          const ref = String(jRow[s.ref] || "").trim();
          const amtNum = parseMoney_(jRow[s.amt]);
          const rechNum = parseMoney_(jRow[s.rech]);
          if (ref && !isPlaceholderInvoice(ref) && (amtNum > 0 || rechNum > 0)) {
            hasRealInvoice = true;
            break;
          }
        }
        if (hasRealInvoice) break;
      }

      if (!hasRealInvoice) {
        const isRetainerJob = isRetainer || jobRows.length > 1;
        // If this is a retainer whose first child row is scheduled in arrears (e.g. 1 month after startDate)
        // and that first scheduled invoice date (+ 5 days grace) has not yet passed, do not prematurely flag uninvoiced_new_job
        if (isRetainerJob && jobRows.length > 1) {
          const firstChildDate = parseConfirmedDate_(jobRows[1].row?.[43]);
          if (firstChildDate && today.getTime() <= (firstChildDate.getTime() + 5 * 86400000)) {
            const secondChildDate = jobRows.length > 2 ? parseConfirmedDate_(jobRows[2].row?.[43]) : null;
            const notRolledPastSecond = !secondChildDate || firstChildDate.getTime() < secondChildDate.getTime();
            if (notRolledPastSecond) {
              r += jobRows.length;
              continue;
            }
          }
        }
        const resolvedJobType = isRetainerJob ? "Retainer" : "Project";
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        const formattedEndDate = endDate ? fmtDate(endDate) : (endVal ? String(endVal).trim() : "");
        alerts.push({
          alertType: "uninvoiced_new_job",
          alertKey: `uninvoiced_new_job|${clientName}|${jobClient || ""}|${stableKey}|rev:${billableAmt.toFixed(2)}`,
          legacyAlertKey: `uninvoiced_new_job|${clientName}|${jobClient || ""}|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Job started over a month ago with no invoices sent",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job started ${fmtDate(startDate)}${formattedEndDate ? `, ends ${formattedEndDate}` : ""} (over a month ago)${rechargedAmt > 0 ? ` with £${billableAmt.toFixed(2)} billable (£${revenueAmt.toFixed(2)} fee + £${rechargedAmt.toFixed(2)} recharged)` : ""} but no real invoices have been recorded yet. All invoice slots are empty or contain manual placeholders.`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(billableAmt), feeRevenue: String(revenueAmt), rechargedExpenses: String(rechargedAmt), billableBudget: String(billableAmt), startDate: fmtDate(startDate), endDate: formattedEndDate,
          jobType: resolvedJobType, isRetainer: isRetainerJob,
          metadata: { jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(billableAmt), feeRevenue: String(revenueAmt), rechargedExpenses: String(rechargedAmt), billableBudget: String(billableAmt), startDate: fmtDate(startDate), endDate: formattedEndDate, stableJobKey: stableKey, jobType: resolvedJobType, isRetainer: isRetainerJob },
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

export async function checkUninvoicedRevenue_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const TOLERANCE = 1.00;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32];
      const rechargedRaw = row[17];
      const jobType = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal = row[38];

      if ((!revenue && !rechargedRaw) || !startVal || !endVal) { r++; continue; }
      if (jobType.includes("retainer")) { r += collectJobRows_(data, r).length; continue; }

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate || (today.getTime() - endDate.getTime()) <= TWO_WEEKS_MS) { r += collectJobRows_(data, r).length; continue; }

      const jobClient = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue || "").replace(/[£$€,\s]/g, "")) || 0;
      const rechargedAmt = parseFloat(String(rechargedRaw || "").replace(/[£$€,\s]/g, "")) || 0;
      const billableAmt = Math.round((revenueAmt + rechargedAmt) * 100) / 100;
      const jobRows = collectJobRows_(data, r);

      let totalRealInvoiced = 0, totalRealRecharged = 0, draftCount = 0, draftTotal = 0;
      for (let jr = 0; jr < jobRows.length; jr++) {
        const slotResult = sumRealInvSlotAmounts_(jobRows[jr].row);
        totalRealInvoiced += slotResult.total;
        totalRealRecharged += slotResult.rechargedTotal;
        draftCount += slotResult.draftCount;
        draftTotal += slotResult.draftTotal;
      }
      totalRealInvoiced = Math.round(totalRealInvoiced * 100) / 100;
      totalRealRecharged = Math.round(totalRealRecharged * 100) / 100;
      const totalRealFee = Math.max(0, Math.round((totalRealInvoiced - totalRealRecharged) * 100) / 100);

      const uninvoiced = Math.round((billableAmt - totalRealInvoiced) * 100) / 100;
      const uninvoicedFee = Math.max(0, Math.round((revenueAmt - totalRealFee) * 100) / 100);
      const uninvoicedRecharged = Math.max(0, Math.round((rechargedAmt - totalRealRecharged) * 100) / 100);
      if (uninvoiced > TOLERANCE) {
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        const draftNote = draftCount > 0 ? ` Note: ${draftCount} invoice(s) totalling £${draftTotal.toFixed(2)} have a reference but are still Draft (not yet sent) - these are not counted as invoiced.` : "";
        const billableBreakdown = rechargedAmt > 0 ? `billable = £${billableAmt.toFixed(2)} (£${revenueAmt.toFixed(2)} fee + £${rechargedAmt.toFixed(2)} recharged)` : `revenue = £${revenueAmt.toFixed(2)}`;
        alerts.push({
          alertType: "uninvoiced_revenue",
          alertKey: `uninvoiced_revenue|${clientName}|${jobClient || ""}|${stableKey}|uninv:${uninvoiced.toFixed(2)}|rev:${billableAmt.toFixed(2)}|drafts:${draftCount}`,
          legacyAlertKey: `uninvoiced_revenue|${clientName}|${jobClient || ""}|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Completed job has uninvoiced revenue",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, ${billableBreakdown}, real sent/paid invoiced (excl. placeholders and drafts) = £${totalRealInvoiced.toFixed(2)} - £${uninvoiced.toFixed(2)} uninvoiced.${draftNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1,
          revenue: String(billableAmt), feeRevenue: String(revenueAmt), rechargedExpenses: String(rechargedAmt), billableBudget: String(billableAmt),
          totalInvoiced: String(totalRealInvoiced.toFixed(2)), feeInvoiced: String(totalRealFee.toFixed(2)), rechargedInvoiced: String(totalRealRecharged.toFixed(2)),
          uninvoicedFee: String(uninvoicedFee.toFixed(2)), uninvoicedRecharged: String(uninvoicedRecharged.toFixed(2)),
          endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)),
          metadata: {
            jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1,
            revenue: String(billableAmt), feeRevenue: String(revenueAmt), rechargedExpenses: String(rechargedAmt), billableBudget: String(billableAmt),
            totalInvoiced: String(totalRealInvoiced.toFixed(2)), feeInvoiced: String(totalRealFee.toFixed(2)), rechargedInvoiced: String(totalRealRecharged.toFixed(2)),
            uninvoicedFee: String(uninvoicedFee.toFixed(2)), uninvoicedRecharged: String(uninvoicedRecharged.toFixed(2)),
            endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)), stableJobKey: stableKey
          },
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

export async function checkDeletedInvoices_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let rightData = [];
    try {
      const invCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!AT6:BS5000" });
      rightData = invCompResp.data.values || [];
    } catch (e) { return alerts; }

    const candidateRefs = [];
    for (let r = 0; r < rightData.length; r++) {
      const ref = String(rightData[r][5] || "").trim();
      const missingFlag = String(rightData[r][21] || "").trim();
      if (!ref || isPlaceholderInvoice(ref) || missingFlag !== "1") continue;
      candidateRefs.push(ref);
    }
    if (candidateRefs.length === 0) return alerts;

    let confData = sharedData?.confirmedData;
    if (!confData) {
      try {
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BJ5000" });
        confData = confResp.data.values || [];
      } catch (e) { return alerts; }
    }

    const slotDefs = [{ ref: 42, amt: 41, sent: 43 }, { ref: 49, amt: 48, sent: 50 }, { ref: 56, amt: 55, sent: 57 }];
    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    for (let c = 0; c < candidateRefs.length; c++) {
      const candidateRef = candidateRefs[c];
      let found = null;
      for (let cr = 1; cr < confData.length && !found; cr++) {
        const crow = confData[cr];
        for (let s = 0; s < slotDefs.length; s++) {
          if (String(crow[slotDefs[s].ref] || "").trim() === candidateRef) {
            found = { rowNum: cr + 1, foundClientName: String(crow[0] || "").trim(), jobName: String(crow[1] || "").trim(), projectCode: String(crow[2] || "").trim(), amount: crow[slotDefs[s].amt], sentDate: crow[slotDefs[s].sent], slotNum: s + 1 };
            break;
          }
        }
      }
      if (!found) continue;

      const sentDateObj = parseConfirmedDate_(found.sentDate);
      const sentDateValid = sentDateObj !== null;
      if (sentDateValid && (now.getTime() - sentDateObj.getTime() < bufferMs)) continue;

      const amountNum = parseFloat(String(found.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
      const sentDateStr = sentDateValid ? `${String(sentDateObj.getDate()).padStart(2, '0')}-${months[sentDateObj.getMonth()]}-${String(sentDateObj.getFullYear()).slice(-2)}` : String(found.sentDate || "(unknown)");

      alerts.push({
        alertType: "deleted_invoice", alertKey: `deleted_invoice|${clientName}|${candidateRef}`,
        heading: "Invoice reference no longer found in accounting system",
        detail: `Invoice ${candidateRef} (${found.foundClientName}${found.jobName ? ` - ${found.jobName}` : ""}), sent ${sentDateStr}${amountNum > 0 ? `, £${amountNum.toFixed(2)}` : ""}, has a real reference on the Confirmed tab (row ${found.rowNum}, invoice slot ${found.slotNum}) but no longer appears in the accounting system. It may have been deleted or voided - check Xero directly.`,
        jobName: found.jobName, endClientName: found.foundClientName, projectCode: found.projectCode, confirmedRow: found.rowNum, stableJobKey: candidateRef,
        slotNum: found.slotNum, invoiceRef: candidateRef, amount: amountNum > 0 ? String(amountNum.toFixed(2)) : "", sentDate: sentDateStr,
        metadata: {
          jobName: found.jobName, endClientName: found.foundClientName, projectCode: found.projectCode, confirmedRow: found.rowNum,
          stableJobKey: candidateRef, slotNum: found.slotNum, invoiceRef: candidateRef, amount: amountNum > 0 ? String(amountNum.toFixed(2)) : "", sentDate: sentDateStr,
          clientName
        }
      });
    }
  } catch (e) { }
  return alerts;
}

export async function checkJobStructureErrors_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;

    const invAmtIdx = [41, 48, 55], expAmtIdx = [76, 83, 90];
    const hasVal = (v) => v !== "" && v !== null && v !== undefined && String(v).trim() !== "";
    const hasInvSlotData = (row, sIdx) => {
      const base = sIdx === 0 ? 41 : sIdx === 1 ? 48 : 55;
      return hasVal(row[base]) || hasVal(row[base + 1]) || hasVal(row[base + 5]);
    };
    const hasExpSlotData = (row, sIdx) => {
      const base = sIdx === 0 ? 75 : sIdx === 1 ? 82 : 89;
      return hasVal(row[base]) || hasVal(row[base + 1]) || hasVal(row[base + 6]);
    };
    const fmtDate = (d) => {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    };

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const jobClient = String(row[0] || "").trim();
      const jobNameV = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      const revenue = row[32], rechargedRaw = row[17], jobType = String(row[35] || "").toLowerCase(), startVal = row[37], endVal = row[38];

      if (!jobClient || !jobNameV || (!hasVal(revenue) && !hasVal(rechargedRaw)) || !hasVal(startVal) || !hasVal(endVal)) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows = collectJobRows_(data, r);
      const hasChildren = jobRows.length > 1;
      const problems = [];

      const parsedStart = parseConfirmedDate_(startVal);
      const parsedEnd = parseConfirmedDate_(endVal);

      let isSingleMonth = false;

      if (parsedStart && parsedEnd) {
        if (parsedEnd.getTime() < parsedStart.getTime()) {
          console.log(`\n🚨 FOUND DATE ERROR: ${jobClient} | ${jobNameV}`);
          console.log(`  - startVal: ${startVal} -> parsed: ${parsedStart}`);
          console.log(`  - endVal:   ${endVal} -> parsed: ${parsedEnd}`);
          problems.push(`Row ${r + 1} (parent): end date (${fmtDate(parsedEnd)}) is before start date (${fmtDate(parsedStart)})`);
        } else {
          const diffTime = parsedEnd.getTime() - parsedStart.getTime();
          const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
          const monthsDiff = Math.max(1, Math.round(diffDays / 30.4375));
          isSingleMonth = (monthsDiff === 1);
        }
      } else {
        console.log(`\n⚠️ FAILED TO PARSE DATES: ${jobClient} | ${jobNameV}`);
        console.log(`  - startVal: "${startVal}" -> parsed: ${parsedStart}`);
        console.log(`  - endVal:   "${endVal}" -> parsed: ${parsedEnd}`);
      }

      if (isRetainer && !hasChildren && !isSingleMonth) {
        problems.push(`Row ${r + 1} (parent): retainer job has no child rows (single-row retainers are not allowed)`);
      }

      for (let jr = 0; jr < jobRows.length; jr++) {
        const jRow = jobRows[jr].row, jSheetRow = jobRows[jr].sheetRow;
        const rowLabel = `Row ${jSheetRow} (${jobRows[jr].isParent ? "parent" : "child"})`;

        if (isRetainer && (hasVal(jRow[invAmtIdx[1]]) || hasVal(jRow[invAmtIdx[2]]))) {
          const s1Ref = String(jRow[42] || "").trim();
          const s2Ref = String(jRow[49] || "").trim();
          const s3Ref = String(jRow[56] || "").trim();
          const s1Stat = String(jRow[45] || "").toLowerCase();
          const s2Stat = String(jRow[52] || "").toLowerCase();
          const s3Stat = String(jRow[59] || "").toLowerCase();

          const isPartPayment = s1Stat.includes("part") || s2Stat.includes("part") || s3Stat.includes("part") ||
            (s2Ref && s1Ref && (s2Ref === s1Ref || s2Ref.startsWith(s1Ref) || s1Ref.startsWith(s2Ref))) ||
            (s3Ref && s1Ref && (s3Ref === s1Ref || s3Ref.startsWith(s1Ref) || s1Ref.startsWith(s3Ref)));

          if (!isPartPayment) {
            problems.push(`${rowLabel}: retainer has data in invoice slot 2 or 3 - retainers should only ever use slot 1 per row (unless tracking part-payment installments)`);
          }
        }
        if (isRetainer && hasChildren && jobRows[jr].isParent) {
          if (hasInvSlotData(jRow, 0) || hasInvSlotData(jRow, 1) || hasInvSlotData(jRow, 2)) {
            problems.push(`${rowLabel}: retainer has child rows but the parent row also holds an invoice - once child rows exist, the parent should stay empty`);
          }
          if (hasExpSlotData(jRow, 0) || hasExpSlotData(jRow, 1) || hasExpSlotData(jRow, 2)) {
            problems.push(`${rowLabel}: retainer has child rows but the parent row also holds a direct cost / expense - once child rows exist, the parent should stay empty`);
          }
        }
        if (hasInvSlotData(jRow, 1) && !hasInvSlotData(jRow, 0)) problems.push(`${rowLabel}: invoice slot 2 has data but slot 1 is empty`);
        if (hasInvSlotData(jRow, 2) && (!hasInvSlotData(jRow, 0) || !hasInvSlotData(jRow, 1))) problems.push(`${rowLabel}: invoice slot 3 has data but slot 1 or 2 is empty`);
        if (hasExpSlotData(jRow, 1) && !hasExpSlotData(jRow, 0)) problems.push(`${rowLabel}: expense slot 2 has data but slot 1 is empty`);
        if (hasExpSlotData(jRow, 2) && (!hasExpSlotData(jRow, 0) || !hasExpSlotData(jRow, 1))) problems.push(`${rowLabel}: expense slot 3 has data but slot 1 or 2 is empty`);
      }

      if (problems.length > 0) {
        const problemFootprint = Buffer.from(problems.join("; ")).toString("base64");

        alerts.push({
          alertType: "job_structure_error",
          alertKey: `job_structure_error|${clientName}|${jobClient}|${jobNameV}${projectCode ? `|${projectCode}` : ""}|${problemFootprint}`,
          heading: "Job structure doesn't match expected invoice/expense layout",
          detail: `${jobClient} | ${jobNameV}${projectCode ? ` [${projectCode}]` : ""} (${isRetainer ? "Retainer" : "Project"}): ${problems.join("; ")}`,
          jobName: jobNameV, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
          metadata: {
            jobName: jobNameV, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer, clientName
          }
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

export async function checkDeletedExpenses_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let wideData = [];
    try {
      const dirCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "DirComp!DG6:FQ5000" });
      wideData = dirCompResp.data.values || [];
    } catch (e) { return alerts; }

    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let confData = sharedData?.confirmedDataWide || sharedData?.confirmedData || null;

    const expSlotDefs = [{ ref: 81, amt: 76 }, { ref: 88, amt: 83 }, { ref: 95, amt: 90 }];

    for (let r = 0; r < wideData.length; r++) {
      const row = wideData[r];
      const appId = String(row[9] || "").trim();
      const missingFlag = String(row[55] || "").trim();
      if (!appId || isPlaceholderExpense(appId) || missingFlag !== "1") continue;

      const recDateRaw = row[6];
      const recDateObj = recDateRaw instanceof Date ? recDateRaw : new Date(recDateRaw);
      const recDateValid = !isNaN(recDateObj.getTime());
      if (recDateValid && (now.getTime() - recDateObj.getTime() < bufferMs)) continue;

      const jobClientD = String(row[0] || "").trim(), jobNameD = String(row[1] || "").trim(), description = String(row[2] || "").trim();
      const grossAmount = parseFloat(String(row[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const recDateStr = recDateValid ? `${String(recDateObj.getDate()).padStart(2, '0')}-${months[recDateObj.getMonth()]}-${String(recDateObj.getFullYear()).slice(-2)}` : String(recDateRaw || "(unknown)");

      let foundRow = null, foundSlot = null;
      if (confData === null) {
        try {
          const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:CR5000" });
          confData = confResp.data.values || [];
        } catch (e) { confData = []; }
      }
      for (let cr = 1; cr < confData.length && !foundRow; cr++) {
        const crow = confData[cr];
        for (let s = 0; s < expSlotDefs.length; s++) {
          if (String(crow[expSlotDefs[s].ref] || "").trim() === appId) {
            foundRow = cr + 1; foundSlot = s + 1; break;
          }
        }
      }

      const isOutgoings = !foundRow && jobClientD.toLowerCase() === "outgoings";
      alerts.push({
        alertType: "deleted_expense", alertKey: `deleted_expense|${clientName}|${appId}`,
        heading: "Expense reference no longer found in accounting system",
        detail: `Expense ${appId} (${jobClientD}${jobNameD ? ` - ${jobNameD}` : ""})${description ? `, ${description}` : ""}, received ${recDateStr}${grossAmount > 0 ? `, £${grossAmount.toFixed(2)}` : ""}${foundRow ? ` (Confirmed row ${foundRow}, expense slot${foundSlot})` : ""} but no longer appears in the accounting system. It may have been deleted or voided - check Xero directly.`,
        jobName: jobNameD, endClientName: jobClientD, confirmedRow: foundRow || "", slotNum: foundSlot || null,
        stableJobKey: appId, description, amount: grossAmount || "", recDate: recDateStr, isOutgoings,
        metadata: {
          expRef: appId,
          confirmedRow: foundRow || null,
          slotNum: foundSlot || null,
          endClientName: jobClientD,
          jobName: jobNameD,
          description,
          amount: grossAmount || "",
          recDate: recDateStr,
          isOutgoings,
        },
      });
    }
  } catch (e) { }
  return alerts;
}

export async function checkUnreceivedExpenses_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const TOLERANCE = 1.00;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    const expSlots = [{ amt: 76, ref: 81 }, { amt: 83, ref: 88 }, { amt: 90, ref: 95 }];

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32], directCosts = row[33], jobType = String(row[35] || "").toLowerCase(), startVal = row[37], endVal = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }
      if (jobType.indexOf("retainer") !== -1) { r += collectJobRows_(data, r).length; continue; }

      const directCostsAmt = parseFloat(String(directCosts || "0").replace(/[£$€,\s]/g, "")) || 0;
      if (directCostsAmt <= 0) { r += collectJobRows_(data, r).length; continue; }

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate || (today.getTime() - endDate.getTime()) <= TWO_WEEKS_MS) { r += collectJobRows_(data, r).length; continue; }

      const jobClient = String(row[0] || "").trim(), jobName = String(row[1] || "").trim(), projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const jobRows = collectJobRows_(data, r);
      let totalRealReceived = 0, placeholderCount = 0, placeholderTotal = 0;

      for (let jr = 0; jr < jobRows.length; jr++) {
        const jRow = jobRows[jr].row;
        for (let s = 0; s < expSlots.length; s++) {
          const amtRaw = jRow[expSlots[s].amt];
          if (amtRaw === "" || amtRaw === null || amtRaw === undefined) continue;
          const amtNum = parseFloat(String(amtRaw).replace(/[£$€,\s]/g, "")) || 0;
          if (amtNum === 0) continue;
          const refVal = String(jRow[expSlots[s].ref] || "").trim();
          if (isPlaceholderExpense(refVal)) {
            placeholderCount++; placeholderTotal += amtNum;
          } else { totalRealReceived += amtNum; }
        }
      }

      const unreceived = directCostsAmt - totalRealReceived;
      if (unreceived > TOLERANCE) {
        const placeholderNote = placeholderCount > 0 ? ` Note: ${placeholderCount} expense(s) totalling £${placeholderTotal.toFixed(2)} are placeholders - these are not counted as received.` : "";
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        alerts.push({
          alertType: "unreceived_expenses",
          alertKey: `unreceived_expenses|${clientName}|${jobClient || ""}|${stableKey}|unrec:${unreceived.toFixed(2)}|budget:${directCostsAmt.toFixed(2)}|ph:${placeholderCount}`,
          legacyAlertKey: `unreceived_expenses|${clientName}|${jobClient || ""}|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Completed job has unreceived expenses",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, direct cost budget = £${directCostsAmt.toFixed(2)}, real received expenses (excl. estimates/gaps) = £${totalRealReceived.toFixed(2)} - £${unreceived.toFixed(2)} unreceived.${placeholderNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, directCosts: String(directCostsAmt), endDate: fmtDate(endDate), unreceivedAmount: String(unreceived.toFixed(2)), placeholderCount: String(placeholderCount), placeholderTotal: String(placeholderTotal.toFixed(2)),
          metadata: { jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, directCosts: String(directCostsAmt), endDate: fmtDate(endDate), unreceivedAmount: String(unreceived.toFixed(2)), placeholderCount: String(placeholderCount), placeholderTotal: String(placeholderTotal.toFixed(2)), stableJobKey: stableKey },
        });
      }
      r += jobRows.length;
    }
  } catch (e) { }
  return alerts;
}

function cleanAutoLogVal_(v) {
  if (!v) return "";
  let s = String(v).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function normalizeAutoLogFieldName_(rawField) {
  const f = rawField.toLowerCase().trim();
  if (f.includes("day") || f.includes("extend")) return "invoice_days_to_pay";
  if (f.includes("paid date") || f.includes("fully paid")) return "invoice_paid_date";
  if (f.includes("client") || f.includes("customer")) return "client_name";
  if (f.includes("copied status") || f.includes("copied to conf")) return "copied_status";
  if (f.includes("revenue") || f.includes("amount")) return "amount";
  if (f.includes("status")) return "status";
  if (f.includes("date moved") || f.includes("sent date") || f.includes("invoice date")) return "invoice_date";
  return f.replace(/[^a-z0-9_]/g, "_");
}

function extractEntityFromAutoLogLine_(line) {
  const invMatch = line.match(/(?:Inv(?:oice)?\s*(?:#|no\.?)?\s*[:#]?\s*([A-Za-z0-9\-_]+))/i);
  let invNo = "";
  if (invMatch) {
    const candidate = invMatch[1].replace(/^#/, "").trim();
    if (candidate.toLowerCase() !== "s" && candidate.toLowerCase() !== "summary" && /\d/.test(candidate)) {
      invNo = candidate;
    }
  }

  const rowMatch = line.match(/Row\s*(\d+)/i);
  const rowNo = rowMatch ? rowMatch[1].trim() : "";

  let jobName = "";
  let endClientName = "";
  const clientJobMatch = line.match(/(?:Row\s*\d+,\s*|\(\s*)([^|\n]+)\s*\|\s*((?:[^,\n\-:\(\)]+|\([^,\n\-:\(\)]*\))+)/);
  if (clientJobMatch) {
    endClientName = clientJobMatch[1].trim();
    jobName = clientJobMatch[2].trim();
  }

  const slotMatch = line.match(/Slot\s*(\d+)/i);
  const slotNo = slotMatch ? slotMatch[1].trim() : "";

  return { invNo, rowNo, endClientName, jobName, slotNo };
}

function parseAutoLogLineTransitions_(line) {
  if (!line || !line.includes("->")) return [];
  const results = [];
  const matchedSpans = [];
  const seen = new Set();

  const recordMatch = (rawField, rawFrom, rawTo, span) => {
    const field = rawField.trim();
    const fromVal = cleanAutoLogVal_(rawFrom);
    const toVal = cleanAutoLogVal_(rawTo);
    if (field.length > 35 || !fromVal || !toVal || fromVal.toLowerCase() === toVal.toLowerCase()) {
      return;
    }
    const dedupKey = `${normalizeAutoLogFieldName_(field)}|${fromVal.toLowerCase()}|${toVal.toLowerCase()}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    results.push({ rawField: field, fromVal, toVal });
    if (span) matchedSpans.push(span);
  };

  // Pass 1: colon-separated field with single-quoted values (supports colons/apostrophes inside quotes and parens/symbols in field names)
  const pQuoted = /(?:[-–•,\n:]|^)\s*([A-Za-z0-9\s()%#&/_]+?)\s*:\s*'((?:[^'\r\n]|'(?!\s*(?:->|[,;\r\n]|$)))+)'\s*->\s*'((?:[^'\r\n]|'(?!\s*(?:->|[,;\r\n]|$)))+)'(?=\s*(?:[\r\n,;]|$))/g;
  let m;
  while ((m = pQuoted.exec(line)) !== null) {
    recordMatch(m[1], m[2], m[3], [m.index, m.index + m[0].length]);
  }

  // Pass 2: colon-separated field with unquoted fallback values
  const pUnquoted = /(?:[-–•,\n:]|^)\s*([A-Za-z0-9\s()%#&/_]+?)\s*:\s*([^':\r\n]+?)\s*->\s*([^':\r\n;]+?)(?=\s*(?:[\r\n,;]|$))/g;
  while ((m = pUnquoted.exec(line)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (matchedSpans.some(([qs, qe]) => start < qe && end > qs)) continue;
    recordMatch(m[1], m[2], m[3], [start, end]);
  }

  // Pass 3: colonless legacy patterns ("Extended days", "Date moved")
  const p2 = /(?:[-–•,:\n]|^)\s*(Extended days|Date moved)\s+('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?=\s*(?:[\r\n,;]|$))/gi;
  while ((m = p2.exec(line)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (matchedSpans.some(([qs, qe]) => start < qe && end > qs)) continue;
    recordMatch(m[1], m[2], m[3], [start, end]);
  }

  return results;
}

export async function checkAutoLogErrors_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    const gasLocks = sharedData?.gasLocks || null;
    if (!data.length && !gasLocks) return alerts;

    const errorRegex = /error:\s*([^\n\r]+)/i;
    const errorsBySignature = new Map();

    const normalizeSignature = (text) =>
      String(text || "")
        .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*/g, "")
        .replace(/;\s*started at\s+\d{1,2}:\d{2}/gi, "")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .slice(0, 80);

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const summary = String(row[2] || "").trim();
      const details = String(row[3] || "").trim();

      // Extract error text, prioritizing the richer/more descriptive message
      const detailsMatch = details.match(errorRegex);
      const summaryMatch = summary.match(errorRegex);

      let rawErrorText = "";
      if (detailsMatch && detailsMatch[1]?.trim()) {
        const detailsErr = detailsMatch[1].trim();
        const summaryErr = summaryMatch ? summaryMatch[1]?.trim() : "";
        if (!summaryErr || detailsErr.length >= summaryErr.length) {
          rawErrorText = detailsErr;
        } else {
          rawErrorText = summaryErr;
        }
      } else if (summaryMatch && summaryMatch[1]?.trim()) {
        const summaryErr = summaryMatch[1].trim();
        if (details && !details.toLowerCase().includes(summaryErr.toLowerCase())) {
          rawErrorText = `${summaryErr} - ${details}`;
        } else if (details && details.length > summaryErr.length) {
          rawErrorText = details;
        } else {
          rawErrorText = summaryErr;
        }
      } else {
        const combinedText = `${summary}\n${details}`;
        const match = combinedText.match(errorRegex);
        if (match && match[1]?.trim()) {
          rawErrorText = match[1].trim();
        }
      }

      rawErrorText = rawErrorText.replace(/[\r\n]+/g, " ").trim();
      if (!rawErrorText) continue;

      const cleanSignature = normalizeSignature(rawErrorText);
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");
      const detailsText = (details || rawErrorText).slice(0, 500);

      if (!errorsBySignature.has(cleanSignature)) {
        errorsBySignature.set(cleanSignature, {
          latestTs: tsStr,
          count: 1,
          category,
          summary,
          errorText: rawErrorText,
          detailsSnippet: detailsText,
        });
      } else {
        const item = errorsBySignature.get(cleanSignature);
        item.count += 1;
      }
    }

    // Also include any stale/timed-out GAS lock detected in DataChgAlert!B4:I4 before AutoLog self-heal completes
    if (gasLocks && typeof gasLocks === "object") {
      for (const lockKey of ["invoice", "expense", "crm"]) {
        const staleTimeout = gasLocks[lockKey]?.staleTimeout;
        if (!staleTimeout || !staleTimeout.errorText) continue;
        const cleanSig = normalizeSignature(staleTimeout.errorText);
        if (!errorsBySignature.has(cleanSig)) {
          errorsBySignature.set(cleanSig, {
            latestTs: staleTimeout.startedAt || new Date().toISOString(),
            count: 1,
            category: staleTimeout.category || lockKey.toUpperCase(),
            summary: staleTimeout.summary || "Error: Sequence Timeout",
            errorText: staleTimeout.errorText,
            detailsSnippet: `Error: ${staleTimeout.errorText}`,
          });
        }
      }
    }

    for (const [signature, info] of errorsBySignature.entries()) {
      const countNote = info.count > 1 ? ` (occurred ${info.count} times in last 100 logs)` : "";
      alerts.push({
        alertType: "autolog_error",
        alertKey: `autolog_error|${clientName}|${signature}`,
        legacyAlertKey: `autolog_error|${clientName}|${signature}`,
        heading: `Automation error${info.category ? ` in ${info.category}` : ""}`,
        detail: `Error in AutoLog: "${info.errorText}"${countNote}. Latest: ${info.latestTs || "recently"}.`,
        clientName,
        timestamp: info.latestTs,
        category: info.category,
        summary: info.summary,
        errorSnippet: info.errorText,
        occurrenceCount: String(info.count),
        detailsSnippet: info.detailsSnippet,
        rawSnippet: info.detailsSnippet,
      });
    }
  } catch (e) {
    console.error(`Error in checkAutoLogErrors_ for ${clientName}:`, e.message);
  }
  return alerts;
}

export async function checkRetroactiveOutgoingsChanges_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    if (!data.length) return alerts;

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const summary = String(row[2] || "").trim();
      const details = String(row[3] || "").trim();

      // Detect P&L Outgoings updates from automated sequence or bank transaction fallbacks
      const isOutgoingsUpdate = summary.toLowerCase().startsWith("p&l outgoings updated:");
      const isBankTxnFallback = summary.toLowerCase().includes("bank transaction added from unreconciled") ||
        summary.toLowerCase().includes("bank transaction added from unrecon");

      if (isOutgoingsUpdate || isBankTxnFallback) {
        const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");
        const alertKey = `retroactive_outgoings_update|${clientName}|${summary}|${tsStr}`;

        alerts.push({
          alertType: "retroactive_outgoings_update",
          alertKey,
          legacyAlertKey: `retroactive_outgoings_update|${clientName}|${summary}`,
          severity: "info",
          category: "Expenses",
          heading: summary,
          title: summary,
          detail: details,
          clientName,
          timestamp: tsStr,
          metadata: {
            summary,
            details,
            timestamp: tsStr
          }
        });
      }
    }
  } catch (e) {
    console.error(`Error in checkRetroactiveOutgoingsChanges_ for ${clientName}:`, e.message);
  }
  return alerts;
}

export function parseAutoLogTimestampMs_(ts) {
  if (!ts) return null;
  if (ts instanceof Date) {
    const t = ts.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 20000 && ts < 90000) {
    const dt = serialToDate(ts);
    return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : null;
  }
  const str = String(ts).trim();
  if (!str) return null;
  if (/^\d{5}(?:\.\d+)?$/.test(str)) {
    const num = parseFloat(str);
    if (Number.isFinite(num) && num > 20000 && num < 90000) {
      const dt = serialToDate(num);
      return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : null;
    }
  }
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mSheet = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (mSheet) {
    const mon = months[mSheet[2].toLowerCase()];
    if (mon !== undefined) {
      const yr = mSheet[3].length === 2 ? 2000 + parseInt(mSheet[3], 10) : parseInt(mSheet[3], 10);
      const dd = parseInt(mSheet[1], 10);
      const hh = mSheet[4] ? parseInt(mSheet[4], 10) : 0;
      const mm = mSheet[5] ? parseInt(mSheet[5], 10) : 0;
      const ss = mSheet[6] ? parseInt(mSheet[6], 10) : 0;
      return Date.UTC(yr, mon, dd, hh, mm, ss);
    }
  }
  const mUk = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (mUk) {
    const yr = mUk[3].length === 2 ? 2000 + parseInt(mUk[3], 10) : parseInt(mUk[3], 10);
    const mon = parseInt(mUk[2], 10) - 1;
    const dd = parseInt(mUk[1], 10);
    const hh = mUk[4] ? parseInt(mUk[4], 10) : 0;
    const mm = mUk[5] ? parseInt(mUk[5], 10) : 0;
    const ss = mUk[6] ? parseInt(mUk[6], 10) : 0;
    return Date.UTC(yr, mon, dd, hh, mm, ss);
  }
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isAutoLogTimestampNewer_(newTs, oldTs) {
  if (!newTs || !oldTs) return false;
  const newStr = String(newTs).trim();
  const oldStr = String(oldTs).trim();
  if (!newStr || !oldStr || newStr === oldStr) return false;
  const newMs = parseAutoLogTimestampMs_(newTs);
  const oldMs = parseAutoLogTimestampMs_(oldTs);
  if (newMs !== null && oldMs !== null) {
    return newMs > oldMs;
  }
  return newStr !== oldStr;
}

function formatAutoLogTimestamp_(ts) {
  if (!ts) return "";
  if (ts instanceof Date && !Number.isNaN(ts.getTime())) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dd = String(ts.getDate()).padStart(2, "0");
    const mmm = months[ts.getMonth()];
    const yy = String(ts.getFullYear()).slice(-2);
    const hh = String(ts.getHours()).padStart(2, "0");
    const mm = String(ts.getMinutes()).padStart(2, "0");
    return `${dd}-${mmm}-${yy} ${hh}:${mm}`;
  }
  const str = String(ts).trim();
  const num = typeof ts === "number" ? ts : (/^\d{5}(?:\.\d+)?$/.test(str) ? parseFloat(str) : NaN);
  if (Number.isFinite(num) && num > 20000 && num < 90000) {
    const dt = serialToDate(num);
    if (dt && !Number.isNaN(dt.getTime())) {
      return formatAutoLogTimestamp_(dt);
    }
  }
  return str;
}

export async function checkAutoLogInfiniteLoops_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    if (!data.length) return alerts;

    const chronologicalRows = [...data].reverse();
    const transitionHistory = new Map();

    for (let r = 0; r < chronologicalRows.length; r++) {
      const row = chronologicalRows[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const details = String(row[3] || "");
      const lines = details.split(/\r?\n/);
      const tsStr = formatAutoLogTimestamp_(timestamp);

      let currentContext = { invNo: "", rowNo: "", endClientName: "", jobName: "", slotNo: "" };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const lineEntity = extractEntityFromAutoLogLine_(line);
        const isNewRow = Boolean(lineEntity.rowNo && lineEntity.rowNo !== currentContext.rowNo);
        const hasOwnEntityWithoutInv = Boolean(
          !lineEntity.invNo && (lineEntity.rowNo || lineEntity.endClientName || lineEntity.jobName)
        );
        if (isNewRow) {
          currentContext = { invNo: "", rowNo: "", endClientName: "", jobName: "", slotNo: "" };
        } else if (hasOwnEntityWithoutInv) {
          currentContext.invNo = "";
          currentContext.slotNo = "";
        }

        if (lineEntity.invNo) currentContext.invNo = lineEntity.invNo;
        if (lineEntity.rowNo) currentContext.rowNo = lineEntity.rowNo;
        if (lineEntity.endClientName) currentContext.endClientName = lineEntity.endClientName;
        if (lineEntity.jobName) currentContext.jobName = lineEntity.jobName;
        if (lineEntity.slotNo) currentContext.slotNo = lineEntity.slotNo;

        const transitions = parseAutoLogLineTransitions_(line);
        if (!transitions.length) continue;

        for (const t of transitions) {
          const invNo = lineEntity.invNo || currentContext.invNo;
          const rowNo = lineEntity.rowNo || currentContext.rowNo;
          const endClientName = lineEntity.endClientName || currentContext.endClientName;
          const jobName = lineEntity.jobName || currentContext.jobName;

          const entityKey = rowNo ? `row_${rowNo}`
            : (invNo ? `inv_${invNo}`
              : (jobName ? `job_${jobName.toLowerCase()}` : "unknown"));

          if (entityKey === "unknown") continue;

          const displayEntity = invNo
            ? `Invoice #${invNo}${rowNo ? ` (Row ${rowNo})` : ""}`
            : (rowNo
              ? `Row ${rowNo}${jobName ? ` (${jobName})` : ""}`
              : (jobName || "Job"));

          const normalizedField = normalizeAutoLogFieldName_(t.rawField);
          const key = `${entityKey}|${normalizedField}`;

          if (!transitionHistory.has(key)) transitionHistory.set(key, []);
          transitionHistory.get(key).push({
            runIndex: r,
            tsStr,
            category,
            line,
            rawField: t.rawField,
            fromVal: t.fromVal,
            toVal: t.toVal,
            displayEntity,
            endClientName: endClientName || "",
            jobName: jobName || "",
            rowNo: rowNo || "",
            invNo: invNo || "",
          });
        }
      }
    }

    // Evaluate full oscillations / flip-flops for each entity & field
    for (const [key, history] of transitionHistory.entries()) {
      if (history.length < 2) continue;

      // Pair from newest to oldest so the latest oscillation is anchored to the most recent
      // reversal and does not flip-flop when older transitions age out of the 100-row slice.
      const completedOscillations = [];
      let i = history.length - 1;
      while (i >= 0) {
        const tEnd = history[i];
        let revIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          const tPrev = history[j];
          if (
            tPrev.fromVal.toLowerCase() === tEnd.toVal.toLowerCase() &&
            tPrev.toVal.toLowerCase() === tEnd.fromVal.toLowerCase()
          ) {
            revIdx = j;
            break;
          }
        }

        if (revIdx !== -1) {
          const tStart = history[revIdx];
          completedOscillations.push({
            tStart,
            tEnd,
            intraRun: tStart.runIndex === tEnd.runIndex,
          });
          // Advance past the opening transition to ensure distinct cycles
          i = revIdx - 1;
        } else {
          i--;
        }
      }
      completedOscillations.reverse();

      // Require at least TWO full oscillations / flip-flops
      if (completedOscillations.length < 2) continue;

      const [entityKey, normalizedField] = key.split("|");
      const latestOsc = completedOscillations[completedOscillations.length - 1];
      const t1 = latestOsc.tStart;
      const t2 = latestOsc.tEnd;
      const allIntraRun = completedOscillations.every(o => o.intraRun);
      const conflictType = allIntraRun ? "intra_run" : "inter_run";

      let suggestion = "";
      if (normalizedField === "invoice_days_to_pay" || normalizedField === "invoice_paid_date") {
        suggestion = "Likely caused by invoice having a pay date recorded without a 'Paid' status, causing payment terms to fight with the overdue date extender.";
      } else if (normalizedField === "client_name") {
        const isMultiInvoiceSlotConflict = completedOscillations.some(
          (o) =>
            o.tStart.category === "INVOICES" &&
            o.tEnd.category === "INVOICES" &&
            o.tStart.invNo &&
            o.tEnd.invNo &&
            o.tStart.invNo !== o.tEnd.invNo
        );
        suggestion = isMultiInvoiceSlotConflict
          ? "Likely caused by multiple linked invoices on the same job referencing different customer names in accounting software (Xero)."
          : "Likely caused by a naming mismatch between accounting software (Xero) and CRM.";
      } else if (normalizedField === "copied_status") {
        suggestion = "Likely caused by Pipeline source data reverting copied status.";
      }

      const transition1 = allIntraRun
        ? `${t1.rawField}: ${t1.fromVal} -> ${t1.toVal}`
        : `At ${t1.tsStr}: ${t1.rawField} '${t1.fromVal}' -> '${t1.toVal}'`;
      const transition2 = allIntraRun
        ? `${t2.rawField}: ${t2.fromVal} -> ${t2.toVal}`
        : `At ${t2.tsStr}: ${t2.rawField} '${t2.fromVal}' -> '${t2.toVal}'`;

      const hint = suggestion ? ` Possible cause: ${suggestion}` : "";
      const countNote = `${completedOscillations.length} full oscillations detected across recent runs`;

      alerts.push({
        alertType: "infinite_loop",
        alertKey: `infinite_loop|${clientName}|${key}`,
        legacyAlertKey: `infinite_loop|${clientName}|${key}`,
        heading: `Automation conflict: ${t2.displayEntity}`,
        detail: `The automation is fighting itself on ${t2.displayEntity} (${t2.rawField}). ${transition1} was reversed by ${transition2} (${countNote}).${hint}`,
        clientName,
        timestamp: t2.tsStr,
        jobName: t2.jobName || t1.jobName,
        endClientName: t2.endClientName || t1.endClientName,
        confirmedRow: t2.rowNo || t1.rowNo,
        invoiceNo: t2.invNo || t1.invNo,
        fieldName: t2.rawField,
        conflictType,
        transition1,
        transition2,
        suggestion,
        occurrenceCount: String(completedOscillations.length),
      });
    }
  } catch (e) {
    console.error(`Error in checkAutoLogInfiniteLoops_ for ${clientName}:`, e.message);
  }
  return alerts;
}

export async function checkStaleUnreconGapExpenses_(clientName, clientSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    // 1. Check Outgoings tab
    let outgoingsData = sharedData?.outgoingsData || null;
    if (!outgoingsData && clientSheetId && sheets) {
      try {
        const resp = await withRetry(() => sheets.spreadsheets.get({
          spreadsheetId: clientSheetId,
          ranges: ["Outgoings!A1:AZ350"],
          fields: "sheets(data(rowData(values(formattedValue,note))))"
        }));
        outgoingsData = resp.data?.sheets?.[0]?.data?.[0]?.rowData || [];
        if (sharedData) sharedData.outgoingsData = outgoingsData;
      } catch (e) {
        // Outgoings tab may not exist or error reading
      }
    }

    if (outgoingsData && outgoingsData.length >= 2) {
      const headerRow = outgoingsData[0]?.values || [];
      const colHeaders = headerRow.map(c => String(c?.formattedValue || "").trim());

      for (let rIdx = 1; rIdx < outgoingsData.length; rIdx++) {
        const rowCells = outgoingsData[rIdx]?.values || [];
        const contractor = String(rowCells[0]?.formattedValue || "").trim();
        if (!contractor) continue;
        const contrLower = contractor.toLowerCase();
        if (contrLower === "contractors" || contrLower.startsWith("total") || contrLower.startsWith("=")) continue;

        for (let cIdx = 1; cIdx < rowCells.length; cIdx++) {
          const cell = rowCells[cIdx];
          const note = String(cell?.note || "");
          if (!note.toUpperCase().includes("UNRECON-GAP")) continue;

          const blocks = note.split(/(?=\{App ID:)/i).map(b => b.trim()).filter(Boolean);
          for (const block of blocks) {
            if (!block.toUpperCase().includes("UNRECON-GAP")) continue;

            const appId = block.match(/\{App ID:\s*([^}]+)\}/i)?.[1]?.trim() || "";
            const amtStr = block.match(/\{Amt:\s*([^}]+)\}/i)?.[1] || "";
            const amount = parseFloat(amtStr.replace(/[£$€,\s]/g, "")) || 0;
            const status = block.match(/\{Status:\s*([^}]*)\}/i)?.[1]?.trim().toLowerCase() || "";
            const recDateRaw = block.match(/\{Rec date:\s*([^}]*)\}/i)?.[1]?.trim() || "";
            const payDateRaw = block.match(/\{Pay date:\s*([^}]*)\}/i)?.[1]?.trim() || "";
            const desc = block.match(/\{Description:\s*([^}]*)\}/i)?.[1]?.trim() || "";

            if (status === "paid" || status === "complete" || status === "received") continue;
            if (amount <= 0 && Math.abs(amount) < 0.01) continue;

            const monthHeader = colHeaders[cIdx] || "";
            const recDate = parseConfirmedDate_(recDateRaw) || parseConfirmedDate_(monthHeader);
            if (!recDate) continue;

            const diffMs = today.getTime() - recDate.getTime();
            if (diffMs > SIX_WEEKS_MS) {
              const weeksAgo = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
              const recDateFormatted = fmtDate(recDate);
              const colLetter = colIndexToLetter(cIdx + 1);
              const cellCoord = `${colLetter}${rIdx + 1}`;
              const safeAppId = (appId && appId !== "UNRECON-GAP") ? appId : `UNRECON-GAP-${monthHeader}-${contractor.replace(/[^a-zA-Z0-9]/g, "")}-${cellCoord}`;

              alerts.push({
                alertType: "stale_unrecon_gap",
                alertKey: `stale_unrecon_gap|${clientName}|${safeAppId}|${recDateFormatted}`,
                legacyAlertKey: `stale_unrecon_gap|${clientName}|${safeAppId}`,
                heading: "Stale UNRECON-GAP expense entry",
                detail: `${contractor} (Outgoings ${monthHeader ? `${monthHeader}, ` : ""}Cell ${cellCoord}): UNRECON-GAP expense [${appId || "Gap"}] of £${amount.toFixed(2)} has received date ${recDateFormatted} (${weeksAgo} weeks ago - more than 6 weeks overdue).`,
                contractor,
                jobName: contractor,
                endClientName: contractor,
                month: monthHeader,
                cellCoord,
                appId,
                amount: amount.toFixed(2),
                recDate: recDateFormatted,
                weeksAgo: String(weeksAgo),
                sourceTab: "Outgoings",
                rowNum: rIdx + 1,
                stableJobKey: safeAppId,
                metadata: {
                  sourceTab: "Outgoings",
                  contractor,
                  jobName: contractor,
                  endClientName: contractor,
                  month: monthHeader,
                  cellCoord,
                  appId,
                  amount: amount.toFixed(2),
                  recDate: recDateFormatted,
                  payDate: payDateRaw,
                  weeksAgo: String(weeksAgo),
                  description: desc || "Manual/Unaccounted balance (Gap)",
                  rowNum: rIdx + 1,
                  stableJobKey: safeAppId,
                }
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`Error in checkStaleUnreconGapExpenses_ for ${clientName}:`, e.message);
  }
  return alerts;
}

/**
 * Detects the enclosing section for an account name in PLFromApp!A:A
 * (e.g. Cost of sales / Operating expenses / Revenue / Other income / Other expenses)
 */
export function detectPLSectionForAccount(plRows, targetName) {
  if (!Array.isArray(plRows) || !targetName) return null;
  const cleanTarget = String(targetName)
    .replace(/^\d+\s*[-–]\s*/, "")
    .toLowerCase()
    .trim();
  const rawTarget = String(targetName).toLowerCase().trim();
  const isTargetOtherExpenses = /^other\s+expenses?$/i.test(cleanTarget);

  let currentRawSection = "";
  let currentSectionType = "";
  let currentSuggestedChoice = "delivery_expense";

  for (let i = 0; i < plRows.length; i++) {
    const rawVal = String(plRows[i]?.[0] || "").trim();
    if (!rawVal) continue;
    const lower = rawVal.toLowerCase();

    // Check if this row is a section header
    if (/^(?:less\s+)?(?:cost\s+of\s+sales|cost\s+of\s+goods\s+sold|direct\s+costs?)/i.test(lower)) {
      currentRawSection = rawVal;
      currentSectionType = "Cost of sales (Direct costs)";
      currentSuggestedChoice = "delivery_expense";
      continue;
    }
    if (/^(?:less\s+)?(?:operating\s+expenses?|overheads?|expenses?|administrative\s+expenses?|admin\s+expenses?|indirect\s+expenses?)/i.test(lower)) {
      currentRawSection = rawVal;
      currentSectionType = "Operating expenses (Overheads)";
      currentSuggestedChoice = "non_delivery_expense";
      continue;
    }
    if (/^(?:income|revenue|turnover|trading\s+income)/i.test(lower) && !lower.startsWith("total ") && !lower.startsWith("net ")) {
      currentRawSection = rawVal;
      currentSectionType = "Revenue / Income";
      currentSuggestedChoice = "revenue";
      continue;
    }
    if (/^other\s+income|^non-operating\s+income/i.test(lower)) {
      currentRawSection = rawVal;
      currentSectionType = "Other income";
      currentSuggestedChoice = "non_operating_income";
      continue;
    }
    if (/^(?:less\s+)?(?:other\s+expenses?|non-operating\s+expenses?|finance\s+costs?)/i.test(lower)) {
      currentRawSection = rawVal;
      currentSectionType = "Other expenses";
      currentSuggestedChoice = "non_operating_expense";
      continue;
    }

    // Check if this row matches the target account
    const normRow = rawVal.replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
    if (lower === rawTarget || normRow === cleanTarget || (cleanTarget.length >= 4 && normRow.includes(cleanTarget)) || (normRow.length >= 4 && cleanTarget.includes(normRow))) {
      if (currentRawSection) {
        return {
          rawSection: currentRawSection,
          sectionType: currentSectionType,
          suggestedClassification: isTargetOtherExpenses ? "non_delivery_expense" : currentSuggestedChoice
        };
      }
    }
  }

  if (isTargetOtherExpenses) {
    return {
      rawSection: currentRawSection || "Operating expenses",
      sectionType: currentSectionType || "Operating expenses (Overheads)",
      suggestedClassification: "non_delivery_expense"
    };
  }

  return currentRawSection ? {
    rawSection: currentRawSection,
    sectionType: currentSectionType,
    suggestedClassification: currentSuggestedChoice
  } : null;
}

export async function checkQuarantinedPLCategories_(clientName, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    if (!masterSheetId || !sheets) return alerts;

    let compResp = null;
    let plFromAppRows = [];
    try {
      compResp = await withRetry(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: masterSheetId,
          ranges: [
            "PLComp!B180:B229",
            "PLFromApp!A1:A350"
          ]
        })
      );
      plFromAppRows = compResp.data.valueRanges?.[1]?.values || [];
    } catch (_) {
      // Fallback to PLComp alone if PLFromApp is not found on master sheet
      compResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "PLComp!B180:B229"
        })
      );
    }

    const rows = compResp.data.valueRanges ? (compResp.data.valueRanges[0]?.values || []) : (compResp.data.values || []);
    const quarantinedCats = [];
    rows.forEach((r, idx) => {
      const val = String(r[0] || "").trim();
      const lower = val.toLowerCase();
      const isInvalid = !val || val.startsWith("#") || lower.includes("#n/a") ||
        lower.includes("#ref!") || lower.includes("#value!") ||
        lower.includes("#name?") || lower.includes("#error!") ||
        lower === "extra ignore";
      if (!isInvalid) {
        quarantinedCats.push({ name: val, rowNum: 180 + idx });
      }
    });

    if (quarantinedCats.length === 0) return alerts;

    // Check AutoLog for recent quarantine timestamp/details if available
    const autoLogData = sharedData?.autoLogData || [];
    const logDetailsMap = new Map();
    for (let i = 0; i < Math.min(autoLogData.length, 100); i++) {
      const logSummary = String(autoLogData[i]?.[2] || "").trim();
      const match = logSummary.match(/New P&L Category Quarantined:\s*"([^"]+)"/i);
      if (match) {
        const catName = match[1].trim();
        const ts = autoLogData[i]?.[0];
        const tsStr = ts instanceof Date ? ts.toISOString() : String(ts || "");
        if (!logDetailsMap.has(catName.toLowerCase())) {
          logDetailsMap.set(catName.toLowerCase(), {
            timestamp: tsStr,
            details: String(autoLogData[i]?.[3] || "").trim()
          });
        }
      }
    }

    for (const q of quarantinedCats) {
      const catName = q.name;
      const cleanCat = String(catName || "").replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
      const isOtherExpenses = /^other\s+expenses?$/i.test(cleanCat);
      const logInfo = logDetailsMap.get(catName.toLowerCase());
      const tsStr = logInfo?.timestamp || new Date().toISOString();
      const alertKey = `unmapped_pl_category|${clientName}|${catName}`;
      const sectionInfo = detectPLSectionForAccount(plFromAppRows, catName);
      const suggestedChoice = isOtherExpenses
        ? "non_delivery_expense"
        : (sectionInfo?.suggestedClassification || "delivery_expense");

      alerts.push({
        alertType: "unmapped_pl_category",
        alertKey,
        legacyAlertKey: `unmapped_pl_category|${clientName}|${catName}`,
        severity: "actionable",
        category: "Expenses",
        heading: `Unmapped P&L category: "${catName}"`,
        title: `Unmapped P&L category: "${catName}"`,
        categoryName: catName,
        cleanName: catName,
        quarantineRow: q.rowNum,
        plSection: sectionInfo?.rawSection || null,
        plSectionType: sectionInfo?.sectionType || null,
        suggestedClassification: suggestedChoice,
        detail: `The nominal account "${catName}" was detected in the P&L report${sectionInfo?.sectionType ? ` under ${sectionInfo.sectionType}` : ""} but has not yet been classified. It has been temporarily quarantined in PLComp!B${q.rowNum} to protect Outgoings from unverified expenses. Please choose how this account should be classified.`,
        clientName,
        timestamp: tsStr,
        metadata: {
          clientName,
          categoryName: catName,
          cleanName: catName,
          quarantineRow: q.rowNum,
          masterSheetId,
          timestamp: tsStr,
          logDetails: logInfo?.details || "",
          plSection: sectionInfo?.rawSection || null,
          plSectionType: sectionInfo?.sectionType || null,
          suggestedClassification: suggestedChoice
        }
      });
    }
  } catch (e) {
    console.error(`Error in checkQuarantinedPLCategories_ for ${clientName}:`, e.message);
  }
  return alerts;
}

/**
 * Pushes historical and forecast P&L amounts for a category directly from Master Sheet (PLFromApp / PLComp)
 * to the newly created row on Outgoings (Columns G onwards).
 */
/**
 * Parses P&L / Outgoings header strings like "Jul 26", "July 2026", or ISO dates into "YYYY-MM".
 */
function parsePLHeaderToMonthKey_(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(/^([A-Za-z]{3})[\s\-_]*(\d{2})$/);
  if (m) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mIdx = monthNames.indexOf(m[1].toLowerCase());
    if (mIdx !== -1) {
      const yr = 2000 + parseInt(m[2], 10);
      return `${yr}-${String(mIdx + 1).padStart(2, '0')}`;
    }
  }
  const mLong = s.match(/^([A-Za-z]+)[\s\-_]*(\d{2,4})$/);
  if (mLong) {
    const monthNamesLong = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const mIdx = monthNamesLong.indexOf(mLong[1].toLowerCase());
    if (mIdx !== -1) {
      let yr = parseInt(mLong[2], 10);
      if (yr < 100) yr += 2000;
      return `${yr}-${String(mIdx + 1).padStart(2, '0')}`;
    }
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2010) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Converts a 1-indexed column number to an A1 notation column letter.
 */
function colIndexToA1_(colIdx) {
  let temp = colIdx;
  let letter = "";
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

/**
 * Computes monthly P&L columns (G onwards) and currency formatting targets for an Outgoings row.
 */
function computeOutgoingsPLRowValues_(categoryName, targetSheetRow, plAppRows, plCompRows, outHeaders, templateRow) {
  const normClean = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
  if (!outHeaders || outHeaders.length <= 6) return null;

  const monthlyAmounts = new Map(); // 'YYYY-MM' -> number

  if (Array.isArray(plAppRows) && plAppRows.length > 0) {
    const plAppHeaders = plAppRows[0] || [];
    const plAppCatRow = plAppRows.find(r => {
      const name = String(r[0] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return name === normClean || name.includes(normClean) || normClean.includes(name);
    });

    if (plAppCatRow) {
      for (let c = 1; c < plAppHeaders.length; c++) {
        const mKey = parsePLHeaderToMonthKey_(plAppHeaders[c]);
        if (mKey) {
          const val = parseFloat(String(plAppCatRow[c] || "0").replace(/[£$€,\s]/g, "")) || 0;
          monthlyAmounts.set(mKey, val);
        }
      }
    }
  }

  if (Array.isArray(plCompRows) && plCompRows.length > 0) {
    const plCompHeaders = plCompRows[0] || [];
    const plCompCatRow = plCompRows.find(r => {
      const bVal = String(r[1] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      const eVal = String(r[4] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return bVal === normClean || eVal === normClean || bVal.includes(normClean) || eVal.includes(normClean);
    });

    if (plCompCatRow) {
      // Pass 1: Standard PLFromApp columns (F..K => indices 5..10)
      for (let c = 5; c <= Math.min(10, plCompHeaders.length - 1); c++) {
        const hStr = plCompHeaders[c];
        if (!hStr) continue;
        const mKey = parsePLHeaderToMonthKey_(hStr);
        if (mKey) {
          const val = parseFloat(String(plCompCatRow[c] || "0").replace(/[£$€,\s]/g, "")) || 0;
          if (val !== 0 || !monthlyAmounts.has(mKey)) {
            monthlyAmounts.set(mKey, val);
          }
        }
      }
      // Pass 2: Combined PLComp columns with PLAdds (T..Y => indices 19..24),
      // skipping M..R (12..17) which only contain PLAdds adjustments.
      for (let c = 19; c <= Math.min(24, plCompHeaders.length - 1); c++) {
        const hStr = plCompHeaders[c];
        if (!hStr) continue;
        const rawCell = plCompCatRow[c];
        if (rawCell === "" || rawCell === null || rawCell === undefined) continue;
        const mKey = parsePLHeaderToMonthKey_(hStr);
        if (mKey) {
          const val = parseFloat(String(rawCell).replace(/[£$€,\s]/g, "")) || 0;
          if (val !== 0 || !monthlyAmounts.has(mKey)) {
            monthlyAmounts.set(mKey, val);
          }
        }
      }
    }
  }

  const maxCols = Math.max(outHeaders.length, templateRow.length, 50);
  const rowValues = [];
  const decimalColIndices = [];

  for (let c = 6; c < maxCols; c++) {
    const tmplVal = templateRow[c] !== undefined ? String(templateRow[c]).trim() : "";
    const headerStr = outHeaders[c] !== undefined ? String(outHeaders[c]).trim() : "";

    // A. If template row has a formula (e.g. "=SUM(G126:S126)"), adapt and preserve it
    if (tmplVal.startsWith("=")) {
      const adaptedFormula = tmplVal.replace(/(?<=[A-Za-z])126(?!\d)/g, String(targetSheetRow));
      rowValues.push(adaptedFormula);
      continue;
    }

    // B. If column header is empty/spacer or not a month, keep it completely blank ("")
    const mKey = parsePLHeaderToMonthKey_(headerStr);
    if (!mKey) {
      rowValues.push("");
      continue;
    }

    // C. Valid month column: if an amount exists from P&L, write it; otherwise keep blank ("")
    const amount = monthlyAmounts.get(mKey);
    if (amount !== undefined && amount !== 0) {
      rowValues.push(amount);
      if (Math.abs(amount % 1) > 0.001) {
        decimalColIndices.push(c);
      }
    } else {
      rowValues.push("");
    }
  }

  return {
    rowValues,
    decimalColIndices,
    endColLetter: colIndexToA1_(6 + rowValues.length),
  };
}

/**
 * Applies Arial 9pt font and optional currency decimal formatting to an Outgoings row.
 */
async function applyOutgoingsRowFormatting_(sheets, clientSheetId, targetSheetRow, decimalColIndices = []) {
  try {
    const outSheetId = await getSheetGid(sheets, clientSheetId, "Outgoings");
    const requests = [
      {
        repeatCell: {
          range: {
            sheetId: outSheetId,
            startRowIndex: targetSheetRow - 1,
            endRowIndex: targetSheetRow,
            startColumnIndex: 0,
            endColumnIndex: 50
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                fontFamily: "Arial",
                fontSize: 9
              }
            }
          },
          fields: "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize"
        }
      },
      ...decimalColIndices.map(colIdx => ({
        repeatCell: {
          range: {
            sheetId: outSheetId,
            startRowIndex: targetSheetRow - 1,
            endRowIndex: targetSheetRow,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1
          },
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: "CURRENCY",
                pattern: "\"£\"#,##0.00"
              }
            }
          },
          fields: "userEnteredFormat.numberFormat"
        }
      }))
    ];

    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: { requests }
    }));
  } catch (fmtErr) {
    console.warn("[P&L Amount Push] Could not apply row formatting:", fmtErr.message);
  }
}

export async function pushCategoryPLAmountsToOutgoings_(sheets, masterSheetId, clientSheetId, categoryName, targetSheetRow, options = {}) {
  if (!masterSheetId || !clientSheetId || !categoryName || !targetSheetRow) return false;
  if (Number(targetSheetRow) === 225 || Number(targetSheetRow) === 226) return false;
  const normClean = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
  if (normClean === "recharged expenses (forecast)" || normClean === "recharged expenses recovery") return false;

  const [plAppRes, plCompRes, outHRes, tmplRes] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "PLFromApp!A1:AZ100"
    })).catch((e) => {
      console.warn("[P&L Amount Push] Could not read PLFromApp:", e.message);
      return null;
    }),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "PLComp!A1:AZ200"
    })).catch((e) => {
      console.warn("[P&L Amount Push] Could not read PLComp:", e.message);
      return null;
    }),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "Outgoings!1:1"
    })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "Outgoings!126:126",
      valueRenderOption: "FORMULA"
    }))
  ]);

  const computed = computeOutgoingsPLRowValues_(
    categoryName,
    targetSheetRow,
    plAppRes?.data?.values || [],
    plCompRes?.data?.values || [],
    outHRes.data.values?.[0] || [],
    tmplRes.data.values?.[0] || []
  );
  if (!computed) return false;

  const { rowValues, decimalColIndices, endColLetter } = computed;
  const startColLetter = "G";

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: clientSheetId,
    range: `Outgoings!${startColLetter}${targetSheetRow}:${endColLetter}${targetSheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] },
    _deferBackgroundRecompute: true,
  }));

  if (Array.isArray(options?.deferredFormattingTasks)) {
    options.deferredFormattingTasks.push(() =>
      applyOutgoingsRowFormatting_(sheets, clientSheetId, targetSheetRow, decimalColIndices)
    );
  } else {
    await applyOutgoingsRowFormatting_(sheets, clientSheetId, targetSheetRow, decimalColIndices);
  }

  const nonZeroCount = rowValues.filter(v => typeof v === "number" && v !== 0).length;
  console.log(`[P&L Amount Push] Successfully populated row ${targetSheetRow} (${nonZeroCount} actual months, formulas preserved, spacers blank) into Outgoings!${startColLetter}${targetSheetRow}:${endColLetter}${targetSheetRow} for "${categoryName}".`);
  return true;
}

export async function ensureCategoryInOutgoings_(sheets, clientSheetId, categoryName, isDeliveryExpense = false, masterSheetId = null, options = {}) {
  if (!clientSheetId || !categoryName) return null;
  const cleanName = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim();
  const normClean = cleanName.toLowerCase();
  if (normClean === "recharged expenses (forecast)" || normClean === "recharged expenses recovery") return null;

  const MIN_CATEGORY_ROW = 126;
  const MAX_CATEGORY_ROW = 223; // Fixed: Last usable row of the Other expenses section is Row 223
  const prefetched = options?.prefetched || null;
  const deferredFormattingTasks = Array.isArray(options?.deferredFormattingTasks) ? options.deferredFormattingTasks : null;

  let rows = prefetched?.outRows || null;
  let outHeaders = prefetched?.outHeaders || null;
  let templateRow = prefetched?.templateRow || null;
  let jnlsRows = prefetched?.jnlsRows ?? null;
  let plAppRows = prefetched?.plAppRows ?? null;
  let plCompRows = prefetched?.plCompRows ?? null;

  // Read Client Outgoings and Master inputs in one parallel wave when not already prefetched
  if (!rows || (masterSheetId && (!outHeaders || !templateRow || jnlsRows === null || plAppRows === null || plCompRows === null))) {
    const [clientBatchRes, clientTmplRes, masterBatchRes] = await Promise.all([
      (!rows || (masterSheetId && !outHeaders))
        ? withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: clientSheetId,
          ranges: masterSheetId
            ? [`Outgoings!A124:A${MAX_CATEGORY_ROW + 2}`, "Outgoings!1:1"]
            : [`Outgoings!A124:A${MAX_CATEGORY_ROW + 2}`],
        }))
        : Promise.resolve(null),
      masterSheetId && !templateRow
        ? withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "Outgoings!126:126",
          valueRenderOption: "FORMULA",
        })).catch(() => null)
        : Promise.resolve(null),
      masterSheetId && (jnlsRows === null || plAppRows === null || plCompRows === null)
        ? withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: masterSheetId,
          ranges: ["JnlsFromApp!A2:G500", "PLFromApp!A1:AZ100", "PLComp!A1:AZ200"],
        })).catch((err) => {
          console.warn(`[Outgoings Provision] Batch master read warning: ${err.message}`);
          return null;
        })
        : Promise.resolve(null),
    ]);

    if (clientBatchRes?.data?.valueRanges) {
      if (!rows) rows = clientBatchRes.data.valueRanges[0]?.values || [];
      if (masterSheetId && !outHeaders) outHeaders = clientBatchRes.data.valueRanges[1]?.values?.[0] || [];
    }
    if (clientTmplRes && !templateRow) {
      templateRow = clientTmplRes.data?.values?.[0] || [];
    }
    if (masterBatchRes?.data?.valueRanges) {
      if (jnlsRows === null) jnlsRows = masterBatchRes.data.valueRanges[0]?.values || [];
      if (plAppRows === null) plAppRows = masterBatchRes.data.valueRanges[1]?.values || [];
      if (plCompRows === null) plCompRows = masterBatchRes.data.valueRanges[2]?.values || [];
    }
  }

  rows = rows || [];
  const existingCats = new Set();
  const populatedCategoryRows = [];

  // Gather existing populated categories strictly within rows 126 up to 223
  for (let r = MIN_CATEGORY_ROW; r <= MAX_CATEGORY_ROW; r++) {
    const raw = String(rows[r - 124]?.[0] || "").trim();
    const lower = raw.toLowerCase();

    if (
      raw &&
      !raw.startsWith("#") &&
      !lower.includes("#n/a") &&
      !lower.startsWith("total") &&
      !lower.startsWith("---") &&
      !lower.startsWith("===") &&
      lower !== "other expenses" &&
      lower !== "recharged expenses (forecast)" &&
      lower !== "recharged expenses recovery"
    ) {
      const norm = raw.replace(/^\d+\s*[-–]\s*/, "").toLowerCase().trim();
      existingCats.add(norm);
      populatedCategoryRows.push(r);
    }
  }

  // If already exists on Outgoings, nothing to do
  if (existingCats.has(normClean)) {
    console.log(`[Outgoings Provision] Category "${cleanName}" already exists on Outgoings tab.`);
    return { alreadyExisted: true };
  }

  // Target row: strictly the first blank row UNDERNEATH ALL EXISTING CATEGORIES.
  // We take Math.max of all populated category rows across the entire expense section (both overheads and direct expenses).
  // This guarantees we never place it into row 125 or any intermediate gap within "Other expenses".
  const maxUsedCategoryRow = populatedCategoryRows.length > 0 ? Math.max(...populatedCategoryRows) : (MIN_CATEGORY_ROW - 1);
  const targetSheetRow = maxUsedCategoryRow + 1;

  if (targetSheetRow > MAX_CATEGORY_ROW) {
    console.warn(`[Outgoings Provision] Cannot insert "${cleanName}": row ${targetSheetRow} exceeds maximum usable category row ${MAX_CATEGORY_ROW}.`);
    return null;
  }

  // Determine VAT setting:
  // Default to "Yes". If actual transactions exist in JnlsFromApp for this category, base on them:
  // - If any matching transaction has VAT > 0, set "Yes".
  // - If matching transactions exist and all have VAT == 0, set "No".
  // - If no matching transactions exist, default to "Yes".
  let vatSetting = "Yes";
  if (masterSheetId && Array.isArray(jnlsRows)) {
    try {
      const matchingTxns = jnlsRows.filter(r => {
        const acc = String(r[6] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
        const desc = String(r[1] || "").toLowerCase();
        return acc === normClean || acc.includes(normClean) || desc.includes(normClean);
      });

      if (matchingTxns.length > 0) {
        const hasVat = matchingTxns.some(r => {
          const v = parseFloat(String(r[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
          return Math.abs(v) > 0.001;
        });
        vatSetting = hasVat ? "Yes" : "No";
        console.log(`[Outgoings Provision] Determined VAT setting "${vatSetting}" from ${matchingTxns.length} matching transaction(s) in JnlsFromApp for "${cleanName}".`);
      } else {
        console.log(`[Outgoings Provision] No transactions in JnlsFromApp for "${cleanName}". Defaulting VAT to "Yes".`);
      }
    } catch (jnlErr) {
      console.warn(`[Outgoings Provision] Error checking JnlsFromApp for VAT: ${jnlErr.message}. Defaulting VAT to "Yes".`);
    }
  }

  const defaults = [
    vatSetting,
    "Curr",
    "Curr",
    isDeliveryExpense ? "100%" : "0%",
    "100%"
  ];
  const metaCells = [sanitizeFormulaInput(String(cleanName || "")), ...defaults];

  let computedPL = null;
  if (masterSheetId && Array.isArray(outHeaders) && Array.isArray(templateRow)) {
    try {
      computedPL = computeOutgoingsPLRowValues_(
        cleanName,
        targetSheetRow,
        plAppRows || [],
        plCompRows || [],
        outHeaders,
        templateRow
      );
    } catch (plErr) {
      console.warn(`[Outgoings Provision] Could not compute P&L amounts for "${cleanName}":`, plErr.message);
      computedPL = null;
    }
  }

  // Write Columns A:F + G onwards in ONE atomic values.update so Client Sheet / Supabase only persists and recomputes once
  if (computedPL) {
    const combinedRow = [...metaCells, ...computedPL.rowValues];
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: `Outgoings!A${targetSheetRow}:${computedPL.endColLetter}${targetSheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [combinedRow] },
      _deferBackgroundRecompute: true,
    }));

    const nonZeroCount = computedPL.rowValues.filter(v => typeof v === "number" && v !== 0).length;
    console.log(`[P&L Amount Push] Successfully populated row ${targetSheetRow} (${nonZeroCount} actual months, formulas preserved, spacers blank) into Outgoings!A${targetSheetRow}:${computedPL.endColLetter}${targetSheetRow} for "${cleanName}".`);

    const fmtTask = () => applyOutgoingsRowFormatting_(sheets, clientSheetId, targetSheetRow, computedPL.decimalColIndices);
    if (deferredFormattingTasks) {
      deferredFormattingTasks.push(fmtTask);
    } else {
      await fmtTask();
    }
  } else {
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: `Outgoings!A${targetSheetRow}:F${targetSheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [metaCells] },
      _deferBackgroundRecompute: true,
    }));

    const fmtTask = () => applySheetFontFormat(sheets, clientSheetId, "Outgoings", targetSheetRow - 1, targetSheetRow, 0, 50, "Arial", 9);
    if (deferredFormattingTasks) {
      deferredFormattingTasks.push(fmtTask);
    } else {
      await fmtTask();
    }
  }

  console.log(`[Outgoings Provision] Successfully inserted "${cleanName}" into Outgoings!Row ${targetSheetRow} (${isDeliveryExpense ? "CoS" : "Overhead"}, VAT: ${vatSetting}).`);
  return { targetSheetRow, cleanName, vatSetting };
}

export async function handleClassifyPLCategory(sheets, {
  clientName,
  categoryName,
  classification,
  automationCommanderSheetId,
  masterSheetId,
  clientSheetId,
  userEmail,
  isAdmin = false,
  sessionId,
  alertKey: providedAlertKey,
  fingerprintHash: providedFp
}) {
  if (!clientName || !categoryName || !classification) {
    throw new Error("Missing clientName, categoryName, or classification");
  }
  const tStart = Date.now();
  const timings = {};

  // Sanitize category name if a formatted heading was passed
  let cleanCategory = String(categoryName || "").trim();
  const headingMatch = cleanCategory.match(/Unmapped P&L (?:category|Account):\s*["“]?([^"”]+)["”]?/i);
  if (headingMatch) {
    cleanCategory = headingMatch[1].trim();
  }
  cleanCategory = cleanCategory.replace(/^["“]+|["”]+$/g, "").trim();
  categoryName = cleanCategory;

  if (categoryName.startsWith("#") || categoryName.toLowerCase().includes("#n/a")) {
    throw new Error(`Cannot classify invalid error value as category: "${categoryName}"`);
  }

  // 1. Resolve masterSheetId and clientSheetId
  let targetMasterSheetId = masterSheetId;
  let targetClientSheetId = clientSheetId;
  if (!targetMasterSheetId || !targetClientSheetId) {
    const clientsData = await getAllClients(sheets, { isAdmin: true }, false, automationCommanderSheetId);
    const clientObj = clientsData?.clientsObj?.[clientName];
    if (!targetMasterSheetId) targetMasterSheetId = clientObj?.masterSheetId;
    if (!targetClientSheetId) targetClientSheetId = clientObj?.clientSheetId;
  }
  if (!targetMasterSheetId) {
    throw new Error(`Could not find Master Sheet ID for client "${clientName}"`);
  }
  masterSheetId = targetMasterSheetId;

  if (!targetClientSheetId) {
    try {
      const x28Res = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "KeyInfo!X28"
      }));
      targetClientSheetId = String(x28Res.data.values?.[0]?.[0] || "").trim();
    } catch (e) { }
  }

  const cleanName = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim();

  const CLASSIFICATION_LABELS = {
    delivery_expense: "Delivery expense",
    non_delivery_expense: "Non-delivery expense",
    revenue: "Revenue",
    cos_staff: "CoS staff cost",
    non_cos_staff: "Non-CoS staff cost",
    contractor: "Track as a Contractor",
    corporation_tax: "Corporation tax",
    depreciation: "Depreciation",
    non_operating_income: "Non-operating income",
    non_operating_expense: "Non-operating expense",
    ignore: "Ignore entirely"
  };

  const classificationLabel = CLASSIFICATION_LABELS[classification] || classification;

  const throwProtectedKeyInfoError_ = (err) => {
    const isProtected = err && typeof err.message === "string" && (
      err.message.includes("protected cell or object") ||
      err.message.includes("protected range") ||
      err.message.includes("PERMISSION_DENIED")
    );
    if (!isProtected) throw err;
    if (!isAdmin) {
      throw new Error("Unable to apply category mapping because configuration permissions are restricted for this workspace. Please contact your system administrator.");
    }
    const primarySa = process.env.SERVICE_ACCOUNT_EMAIL || "alert-triage-backend@automation-commander.iam.gserviceaccount.com";
    throw new Error(`Master sheet configuration is protected: KeyInfo restricts editing. Please ensure '${primarySa}' has editor access to the KeyInfo sheet protection on the Master Sheet for '${clientName}' (or run 'Sync Protection Editors' in Bulk Updater).`);
  };

  const SECTION_MAPPING = {
    revenue: { label: "Revenue", fallbackStart: 2, fallbackEnd: 17 },
    cos_staff: { label: "CoS staff costs", fallbackStart: 19, fallbackEnd: 28 },
    non_cos_staff: { label: "Non-CoS staff costs", fallbackStart: 35, fallbackEnd: 43 },
    corporation_tax: { label: "Corporation tax", fallbackStart: 50, fallbackEnd: 52 },
    depreciation: { label: "Depreciation", fallbackStart: 54, fallbackEnd: 56 },
    delivery_expense: { label: "Other costs of sale", fallbackStart: 59, fallbackEnd: 78 },
    non_operating_income: { label: "Non-operating income", fallbackStart: 81, fallbackEnd: 93 },
    non_operating_expense: { label: "Non-operating expenses", fallbackStart: 101, fallbackEnd: 110 },
    ignore: { label: "Ignore", fallbackStart: 128, fallbackEnd: 180 }
  };

  const needsOutgoingsProvision = Boolean(
    targetClientSheetId && (classification === "non_delivery_expense" || classification === "delivery_expense")
  );
  const needsContractorKeyInfo = classification === "contractor";
  const needsSectionKeyInfo = !needsContractorKeyInfo && classification !== "non_delivery_expense";

  if (needsSectionKeyInfo && !SECTION_MAPPING[classification]) {
    throw new Error(`Unknown classification: "${classification}"`);
  }

  const alertKey = providedAlertKey || `unmapped_pl_category|${clientName}|${categoryName}`;
  const legacyAlertKey = `unmapped_pl_category|${clientName}|${cleanName}`;
  const fp = providedFp || createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
  const legacyFp = createHash("sha256").update(legacyAlertKey).digest("hex").substring(0, 16);

  const acId = (!automationCommanderSheetId || automationCommanderSheetId === "default")
    ? (process.env.AUTOMATION_COMMANDER_SHEET_ID || "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M")
    : automationCommanderSheetId;

  // Stage 1: Single parallel prefetch across Master Sheet, Client Sheet, AlertMemory, Supabase context, and caller Redis session
  const tPrefetchStart = Date.now();
  const masterRanges = ["PLComp!B180:B229"];
  if (needsContractorKeyInfo) {
    masterRanges.push("KeyInfo!AW2:AW161", "KeyInfo!AT4:AT22");
  } else if (needsSectionKeyInfo) {
    masterRanges.push("KeyInfo!AZ1:BA185");
  }
  if (needsOutgoingsProvision) {
    masterRanges.push("JnlsFromApp!A2:G500", "PLFromApp!A1:AZ100", "PLComp!A1:AZ200");
  }

  const [
    masterBatchRes,
    clientBatchRes,
    clientTmplRes,
    supaCtx,
    supabaseActive,
    prefetchedMemoryRows,
    callerSessionRaw,
  ] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: masterRanges,
    })),
    needsOutgoingsProvision
      ? withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: targetClientSheetId,
        ranges: ["Outgoings!A124:A225", "Outgoings!1:1"],
      }))
      : Promise.resolve(null),
    needsOutgoingsProvision
      ? withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: targetClientSheetId,
        range: "Outgoings!126:126",
        valueRenderOption: "FORMULA",
      })).catch(() => null)
      : Promise.resolve(null),
    resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId }),
    acId && sheets ? isSupabaseControlPlaneActive() : Promise.resolve(false),
    acId && sheets
      ? queryAlertMemoryTargeted(sheets, acId, {
        hashes: [fp, legacyFp],
        clientName,
        alertType: "unmapped_pl_category",
      }).catch((amErr) => {
        console.warn("Could not query AlertMemory row for classified category:", amErr.message);
        return [];
      })
      : Promise.resolve([]),
    sessionId && redisClient?.isOpen
      ? redisClient.get(`triage_alerts:${sessionId}`).catch(() => null)
      : Promise.resolve(null),
  ]);
  timings.prefetchMs = Date.now() - tPrefetchStart;

  const masterValueRanges = masterBatchRes?.data?.valueRanges || [];
  let mrIdx = 0;
  const plCompQuarantineRows = masterValueRanges[mrIdx++]?.values || [];
  const awRawRows = needsContractorKeyInfo ? (masterValueRanges[mrIdx++]?.values || []) : [];
  const atRows = needsContractorKeyInfo ? (masterValueRanges[mrIdx++]?.values || []) : [];
  const azBaRows = needsSectionKeyInfo ? (masterValueRanges[mrIdx++]?.values || []) : [];
  const jnlsRows = needsOutgoingsProvision ? (masterValueRanges[mrIdx++]?.values || []) : null;
  const plAppRows = needsOutgoingsProvision ? (masterValueRanges[mrIdx++]?.values || []) : null;
  const plCompRows = needsOutgoingsProvision ? (masterValueRanges[mrIdx++]?.values || []) : null;

  const clientValueRanges = clientBatchRes?.data?.valueRanges || [];
  const outgoingsPrefetched = needsOutgoingsProvision
    ? {
      outRows: clientValueRanges[0]?.values || [],
      outHeaders: clientValueRanges[1]?.values?.[0] || [],
      templateRow: clientTmplRes?.data?.values?.[0] || [],
      jnlsRows,
      plAppRows,
      plCompRows,
    }
    : null;

  const mutatedMasterTabs = new Set();
  const deferredFormattingTasks = [];

  // Validate slots synchronously before firing any parallel writes
  let keyInfoUpdatePromise = null;
  if (needsContractorKeyInfo) {
    const awRows = awRawRows.map(r => String(r[0] || "").trim()).filter(Boolean);
    let contractorEntry = awRows.find(item => {
      const itemClean = item.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return itemClean === cleanName.toLowerCase() || item.toLowerCase() === categoryName.toLowerCase();
    });
    if (!contractorEntry) {
      contractorEntry = awRows.find(item => item.toLowerCase().includes(cleanName.toLowerCase())) || categoryName;
    }

    let targetAtRow = -1;
    for (let i = 0; i < 19; i++) {
      const val = String(atRows[i]?.[0] || "").trim();
      if (!val) {
        targetAtRow = 4 + i;
        break;
      }
    }
    if (targetAtRow === -1) {
      throw new Error("No empty slots available in KeyInfo!AT4:AT22 for Contractors.");
    }

    mutatedMasterTabs.add("KeyInfo");
    keyInfoUpdatePromise = withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: `KeyInfo!AT${targetAtRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[sanitizeFormulaInput(String(contractorEntry || ""))]] },
      _skipMasterFormulaRecompute: true,
    })).catch((writeErr) => throwProtectedKeyInfoError_(writeErr));
  } else if (needsSectionKeyInfo) {
    const targetConfig = SECTION_MAPPING[classification];
    let sectionStartRow = -1;
    let sectionEndRow = 185;

    for (let i = 0; i < azBaRows.length; i++) {
      const azVal = String(azBaRows[i]?.[0] || "").trim().toLowerCase();
      if (azVal === targetConfig.label.toLowerCase()) {
        sectionStartRow = i + 1; // 1-indexed
        for (let j = i + 1; j < azBaRows.length; j++) {
          const nextAz = String(azBaRows[j]?.[0] || "").trim();
          if (nextAz) {
            sectionEndRow = j; // 1-indexed
            break;
          }
        }
        break;
      }
    }

    if (sectionStartRow === -1) {
      sectionStartRow = targetConfig.fallbackStart;
      sectionEndRow = targetConfig.fallbackEnd;
    }

    let targetBaRow = -1;
    for (let r = sectionStartRow; r <= sectionEndRow; r++) {
      const baVal = String(azBaRows[r - 1]?.[1] || "").trim();
      if (!baVal) {
        targetBaRow = r;
        break;
      }
    }

    if (targetBaRow === -1) {
      throw new Error(`No available slots in KeyInfo section "${targetConfig.label}".`);
    }

    mutatedMasterTabs.add("KeyInfo");
    keyInfoUpdatePromise = withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: `KeyInfo!BA${targetBaRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[sanitizeFormulaInput(String(cleanName || ""))]] },
      _skipMasterFormulaRecompute: true,
    })).catch((writeErr) => throwProtectedKeyInfoError_(writeErr));
  }

  // Prepare PLComp quarantine clear
  const plCompClearData = [];
  for (let i = 0; i < plCompQuarantineRows.length; i++) {
    const val = String(plCompQuarantineRows[i]?.[0] || "").trim();
    const valClean = val.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
    if (valClean === cleanName.toLowerCase() || val.toLowerCase() === categoryName.toLowerCase()) {
      const clearRow = 180 + i;
      plCompClearData.push({
        range: `PLComp!B${clearRow}`,
        values: [[""]],
      });
    }
  }
  if (plCompClearData.length > 0) {
    mutatedMasterTabs.add("PLComp");
  }
  const plCompClearPromise = plCompClearData.length > 0
    ? withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: plCompClearData,
      },
      _skipMasterFormulaRecompute: true,
    }))
    : Promise.resolve();

  // Prepare Outgoings provisioning write
  const outgoingsPromise = needsOutgoingsProvision
    ? ensureCategoryInOutgoings_(
      sheets,
      targetClientSheetId,
      cleanName,
      classification === "delivery_expense",
      masterSheetId,
      { prefetched: outgoingsPrefetched, deferredFormattingTasks }
    )
    : Promise.resolve();

  // Prepare AlertMemory + handled hashes update
  const memoryRows = Array.isArray(prefetchedMemoryRows) ? prefetchedMemoryRows : [];
  const matchingRows = memoryRows.filter(r =>
    r.alertType === "unmapped_pl_category" &&
    r.clientName === clientName &&
    (r.fingerprintHash === fp ||
      r.fingerprintHash === legacyFp ||
      r.alertSummary.toLowerCase().includes(cleanName.toLowerCase()) ||
      r.alertSummary.toLowerCase().includes(categoryName.toLowerCase()))
  );

  const targetIds = [alertKey, legacyAlertKey, fp, legacyFp].filter(Boolean);
  for (const mr of matchingRows) {
    if (mr.fingerprintHash) targetIds.push(mr.fingerprintHash);
    if (mr.rowIndex != null) targetIds.push(String(mr.rowIndex));
  }

  const alertMemoryWritePromise = (acId && sheets)
    ? (async () => {
      try {
        await ensureAlertMemoryTab(sheets, acId);
        const alreadyCoveredHashes = new Set();
        if (matchingRows.length > 0) {
          const nowIso = new Date().toISOString();
          for (const mr of matchingRows) {
            if (mr.fingerprintHash) alreadyCoveredHashes.add(mr.fingerprintHash);
          }
          await updateAlertMemoryRowsBatch(
            sheets,
            acId,
            matchingRows.map(row => ({
              rowIndex: row.rowIndex,
              updates: {
                ...row,
                status: "accepted",
                lastRechecked: nowIso,
              },
            }))
          );
        } else {
          alreadyCoveredHashes.add(fp);
          await appendAlertMemoryRow(sheets, acId, {
            fingerprintHash: fp,
            alertType: "unmapped_pl_category",
            clientName,
            alertSummary: `Unmapped P&L category: "${cleanName}"`,
            cachedOptionsJSON: "",
            status: "accepted",
            category: "proactive",
            dataSnapshot: JSON.stringify({
              alertType: "unmapped_pl_category",
              alertKey,
              legacyAlertKey,
              clientName,
              categoryName: cleanName,
              cleanName,
              status: "accepted"
            })
          });
        }

        // Only make a separate handled-hashes call for hashes not already updated above
        const missingHandledByHash = {};
        if (fp && !alreadyCoveredHashes.has(fp)) missingHandledByHash[fp] = "accepted";
        if (legacyFp && legacyFp !== fp && !alreadyCoveredHashes.has(legacyFp)) missingHandledByHash[legacyFp] = "accepted";
        if (Object.keys(missingHandledByHash).length > 0) {
          await updateHandledAlertHashesBatch(acId, missingHandledByHash);
        }

        if (!supabaseActive) {
          invalidateAlertMemoryCache(acId);
        }
      } catch (amErr) {
        console.warn("Could not update AlertMemory row for classified category:", amErr.message);
      }
    })()
    : Promise.resolve();

  // Prepare caller's Redis session prune
  const sessionWritePromise = (sessionId && redisClient?.isOpen && callerSessionRaw)
    ? (async () => {
      try {
        const parsed = JSON.parse(callerSessionRaw);
        const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds);
        if (removedCount > 0) {
          await redisClient.set(`triage_alerts:${sessionId}`, JSON.stringify(parsed), { EX: 86400 * 7 });
        }
      } catch (sErr) {
        console.warn("Could not prune classified category from session:", sErr.message);
      }
    })()
    : Promise.resolve();

  // Stage 2: Execute all critical Master, Outgoings, AlertMemory, and caller session writes in parallel
  const tWriteStart = Date.now();
  await Promise.all([
    keyInfoUpdatePromise || Promise.resolve(),
    outgoingsPromise,
    plCompClearPromise,
    alertMemoryWritePromise,
    sessionWritePromise,
  ]);
  timings.writeMs = Date.now() - tWriteStart;
  invalidatePrecomputedMemoryCache();

  // Stage 3: Non-critical formatting, PRECOMPUTED_KEY pruning, AutoLog, other Redis sessions, Master formula recompute,
  //          and full Outgoings/Expense Breakdown sync run cleanly in background via waitUntil
  const nowStr = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });

  const runBackgroundWork = async (yieldBeforeStart = false) => {
    if (yieldBeforeStart) {
      await new Promise((r) => setTimeout(r, 75));
    }

    // 0. Cosmetic row font/currency formatting on Client Outgoings
    for (const fmtTask of deferredFormattingTasks) {
      await fmtTask().catch(() => { });
    }

    // A. Log to AutoLog on Master Sheet
    try {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: masterSheetId,
        range: "AutoLog!A:D",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            nowStr,
            "EXPENSES",
            sanitizeFormulaInput(`P&L Category Classified: "${cleanName}" -> ${classificationLabel}`),
            sanitizeFormulaInput(`User ${userEmail || "admin"} classified quarantined category "${categoryName}" as ${classificationLabel}. Added to KeyInfo and cleared from PLComp quarantine. Full expense & Outgoings sync triggered.`)
          ]]
        }
      }));
    } catch (logErr) {
      console.warn("⚠️ Could not write classification to AutoLog:", logErr.message);
    }

    // B. Prune PRECOMPUTED_KEY and sweep other active Redis sessions with non-blocking SCAN + parallel chunks
    if (redisClient?.isOpen) {
      try {
        const preRaw = await redisClient.get(PRECOMPUTED_KEY);
        if (preRaw) {
          const pre = JSON.parse(preRaw);
          const { removedCount } = applyAlertRemovalToTriageData(pre, targetIds);
          if (removedCount > 0) {
            await redisClient.set(PRECOMPUTED_KEY, JSON.stringify(pre), { EX: 86400 * 7 });
          }
        }
      } catch (pErr) {
        console.warn("Could not prune classified category from precomputed cache:", pErr.message);
      }

      try {
        const allSessionKeys = await scanRedisKeys("triage_alerts:*");
        const otherKeys = allSessionKeys.filter((sk) => sk && sk !== `triage_alerts:${sessionId}`);
        for (let i = 0; i < otherKeys.length; i += 10) {
          const chunk = otherKeys.slice(i, i + 10);
          await Promise.all(
            chunk.map(async (sk) => {
              try {
                const sData = await redisClient.get(sk);
                if (sData) {
                  const parsed = JSON.parse(sData);
                  const { removedCount } = applyAlertRemovalToTriageData(parsed, targetIds);
                  if (removedCount > 0) {
                    await redisClient.set(sk, JSON.stringify(parsed), { EX: 86400 * 7 });
                  }
                }
              } catch (_) { }
            })
          );
        }
      } catch (keysErr) {
        console.warn("Could not sweep active sessions for classified category:", keysErr.message);
      }
    }

    // C. Master Sheet full sync (shared single gasEnvironment in Supabase mode, or WebApp trigger in Sheet mode)
    if (supaCtx && supaCtx.masterMode === "supabase") {
      const targetClient = supaCtx.clientName || clientName;
      try {
        await pushOutgoingsAndExpenseBreakdownNative(sheets, targetClient);
      } catch (err) {
        console.warn("⚠️ Native combined Outgoings & ExpenseBreakdown sync error:", err.message);
      }
      try {
        await flushImmediateAndScheduleBackgroundClientRecomputes();
      } catch (_) { }
    } else {
      const webAppUrl = await getClientWebAppUrl(sheets, clientName, automationCommanderSheetId);
      if (webAppUrl) {
        const secret = (process.env.AGENT_TRIGGER_SECRET || "").trim();
        if (secret) {
          postGasWebAppLocked(webAppUrl, { secret, action: "push_outgoings", clientName }).catch(err => {
            console.warn("⚠️ Master WebApp push_outgoings error:", err.message);
          });

          postGasWebAppLocked(webAppUrl, { secret, action: "sync_expense_breakdown", clientName }).catch(syncErr => {
            console.warn("⚠️ Master WebApp sync_expense_breakdown error:", syncErr.message);
          });
        }
      }
    }
  };

  timings.beforeBgMs = Date.now() - tStart;
  try {
    const { waitUntil } = await import("@vercel/functions");
    if (typeof waitUntil === "function") {
      waitUntil(runBackgroundWork(true));
    } else {
      await runBackgroundWork(false);
    }
  } catch (_) {
    await runBackgroundWork(false);
  }

  const tInvStart = Date.now();
  await invalidatePmaClientCache(
    supaCtx?.clientSheetId || null,
    supaCtx?.masterSheetId || masterSheetId || null,
    ["outgoings", "expenses", "cash", "views"]
  ).catch(() => { });
  timings.invMs = Date.now() - tInvStart;

  console.log(
    `[classify_pl_category timing] client="${clientName}" cat="${cleanName}" preMs=${timings.prefetchMs} writeMs=${timings.writeMs} invMs=${timings.invMs} beforeBgMs=${timings.beforeBgMs} totalMs=${Date.now() - tStart}`
  );

  return {
    success: true,
    message: `Successfully classified "${cleanName}" as ${classificationLabel} and triggered Outgoings sync.`
  };
}

/**
 * PART-PAID BALANCES CHECK
 * Scans Confirmed and Outgoings for part-paid balance items ("Part-paid (balance)")
 * and raises proactive alerts explaining the projected payment date, with an interactive
 * date adjustment option directly on the alert card.
 */
export async function checkPartPaidBalances_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  if (!clientSheetId || !sheets) return alerts;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (d) => {
    if (!d || isNaN(d.getTime())) return "";
    return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  };

  try {
    // 1. INVOICE PART-PAID BALANCES (in Confirmed tab)
    let confirmedData = sharedData?.confirmedData || null;
    if (!confirmedData) {
      try {
        const resp = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "Confirmed!A1:CR5000",
          valueRenderOption: "UNFORMATTED_VALUE"
        }));
        confirmedData = resp.data?.values || [];
        if (sharedData) sharedData.confirmedData = confirmedData;
      } catch (e) {
        // Confirmed tab read failed
      }
    }

    if (confirmedData && confirmedData.length >= 2) {
      const headerRow = (confirmedData[0] || []).map(h => String(h || "").trim().toLowerCase());
      const clientCol = headerRow.indexOf("client");
      const jobCol = headerRow.indexOf("job name");

      const slotCols = {
        1: { amt: 41, ref: 42, sendDate: 43, days: 44, status: 45 },
        2: { amt: 48, ref: 49, sendDate: 50, days: 51, status: 52 },
        3: { amt: 55, ref: 56, sendDate: 57, days: 58, status: 59 },
      };

      for (let r = 1; r < confirmedData.length; r++) {
        const row = confirmedData[r];
        if (!row || row.length === 0) continue;

        const rowClient = String((clientCol !== -1 ? row[clientCol] : row[0]) || "").trim();
        const rowJob = String((jobCol !== -1 ? row[jobCol] : row[1]) || "").trim();
        if (!rowClient && !rowJob) continue;

        for (let s = 1; s <= 3; s++) {
          const cfg = slotCols[s];
          const rawStatus = String(row[cfg.status] || "").trim().toLowerCase();
          if (!rawStatus.includes("balance") || !rawStatus.includes("part")) continue;

          const rawAmt = row[cfg.amt];
          const balanceAmt = parseFloat(String(rawAmt || "0").replace(/[£$€,\s]/g, "")) || 0;
          if (balanceAmt <= 0.005) continue;

          const refVal = String(row[cfg.ref] || "").trim();
          const sendDateRaw = row[cfg.sendDate];
          const sendDateObj = parseConfirmedDate_(sendDateRaw) || new Date();
          const daysToPay = parseInt(row[cfg.days], 10) || 0;

          const projectedDateObj = new Date(sendDateObj.getTime() + daysToPay * 86400000);
          const sendDateStr = fmtDate(sendDateObj);
          const projectedDateStr = fmtDate(projectedDateObj);
          const isoTargetDate = toInputDateFormat(projectedDateObj);

          const endClient = rowClient || clientName;
          const displayRef = refVal ? (refVal.toUpperCase().startsWith("INV") ? refVal : `INV-${refVal}`) : "Unreferenced";

          const explanation = `Pulse has projected the remaining balance of £${balanceAmt.toFixed(2)} to be collected on ${projectedDateStr} based on the overdue mid-month collection rule (${daysToPay} days from send date). You can adjust this expected collection date below if agreed otherwise.`;

          alerts.push({
            alertType: "part_paid_balance",
            alertKey: `part_paid_balance|${clientName}|invoice|${r + 1}|${s}|${refVal || "noref"}`,
            legacyAlertKey: `part_paid_balance|${clientName}|${refVal || (r + 1)}`,
            heading: "Part-paid invoice balance",
            detail: `${endClient} | ${rowJob}: invoice ${displayRef} has an unpaid balance of £${balanceAmt.toFixed(2)}. Projected payment date: ${projectedDateStr}.`,
            itemType: "invoice",
            clientName,
            endClientName: endClient,
            jobName: rowJob,
            confirmedRow: r + 1,
            slot: s,
            ref: displayRef,
            rawRef: refVal,
            balanceAmount: balanceAmt.toFixed(2),
            sendDate: sendDateStr,
            daysToPay: String(daysToPay),
            targetDate: projectedDateStr,
            isoTargetDate,
            explanation,
            stableJobKey: `${endClient}|${rowJob}`,
            metadata: {
              itemType: "invoice",
              clientName,
              endClientName: endClient,
              jobName: rowJob,
              confirmedRow: r + 1,
              slot: s,
              ref: displayRef,
              rawRef: refVal,
              balanceAmount: balanceAmt.toFixed(2),
              sendDate: sendDateStr,
              daysToPay: String(daysToPay),
              targetDate: projectedDateStr,
              isoTargetDate,
              explanation,
              clientSheetId,
              masterSheetId
            }
          });
        }
      }
    }

    // 2. EXPENSE PART-PAID BALANCES (in Outgoings tab)
    let outgoingsData = sharedData?.outgoingsData || null;
    if (!outgoingsData && clientSheetId) {
      try {
        const resp = await withRetry(() => sheets.spreadsheets.get({
          spreadsheetId: clientSheetId,
          ranges: ["Outgoings!A1:AZ350"],
          fields: "sheets(data(rowData(values(formattedValue,note))))"
        }));
        outgoingsData = resp.data?.sheets?.[0]?.data?.[0]?.rowData || [];
        if (sharedData) sharedData.outgoingsData = outgoingsData;
      } catch (e) {
        // Outgoings tab read error
      }
    }

    if (outgoingsData && outgoingsData.length >= 2) {
      for (let rIdx = 1; rIdx < outgoingsData.length; rIdx++) {
        const rowCells = outgoingsData[rIdx]?.values || [];
        const contractor = String(rowCells[0]?.formattedValue || "").trim();
        if (!contractor || contractor.toLowerCase() === "contractors" || contractor.toLowerCase().startsWith("total")) continue;

        for (let cIdx = 1; cIdx < rowCells.length; cIdx++) {
          const cell = rowCells[cIdx];
          const note = String(cell?.note || "");
          if (!note.toLowerCase().includes("balance") || !note.toLowerCase().includes("part")) continue;

          const blocks = note.split(/(?=\{App ID:)/i).map(b => b.trim()).filter(Boolean);
          for (const block of blocks) {
            const statusMatch = block.match(/\{Status:\s*([^}]*)\}/i);
            const status = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
            if (!status.includes("balance") || !status.includes("part")) continue;

            const appId = block.match(/\{App ID:\s*([^}]+)\}/i)?.[1]?.trim() || "";
            const amtStr = block.match(/\{Amt:\s*([^}]+)\}/i)?.[1] || "";
            const amount = parseFloat(amtStr.replace(/[£$€,\s]/g, "")) || 0;
            if (amount <= 0.005) continue;

            const recDateRaw = block.match(/\{Rec date:\s*([^}]*)\}/i)?.[1]?.trim() || "";
            const payDateRaw = block.match(/\{Pay date:\s*([^}]*)\}/i)?.[1]?.trim() || "";
            const colLetter = colIndexToLetter(cIdx + 1);
            const cellCoord = `${colLetter}${rIdx + 1}`;

            const explanation = `Pulse has projected this remaining expense balance of £${amount.toFixed(2)} to be paid on ${payDateRaw || "the estimated date"} based on the contractor monthly pay run rule (28th of the month, cutoff 20th). You can adjust this expected payment date below if agreed otherwise.`;

            alerts.push({
              alertType: "part_paid_balance",
              alertKey: `part_paid_balance|${clientName}|expense|${cellCoord}|${appId || "part"}`,
              legacyAlertKey: `part_paid_balance|${clientName}|expense|${cellCoord}`,
              heading: "Part-paid expense balance",
              detail: `${contractor} (Outgoings Cell ${cellCoord}): expense ${appId || ""} has an unpaid balance of £${amount.toFixed(2)}. Projected payment date: ${payDateRaw || "estimated"}.`,
              itemType: "expense",
              clientName,
              endClientName: contractor,
              jobName: contractor,
              contractor,
              cellCoord,
              rowNum: rIdx + 1,
              appId,
              balanceAmount: amount.toFixed(2),
              recDate: recDateRaw,
              targetDate: payDateRaw,
              isoTargetDate: toInputDateFormat(payDateRaw),
              explanation,
              stableJobKey: `${contractor}|${cellCoord}`,
              metadata: {
                itemType: "expense",
                clientName,
                endClientName: contractor,
                jobName: contractor,
                contractor,
                cellCoord,
                rowNum: rIdx + 1,
                appId,
                balanceAmount: amount.toFixed(2),
                recDate: recDateRaw,
                targetDate: payDateRaw,
                isoTargetDate: toInputDateFormat(payDateRaw),
                explanation,
                clientSheetId,
                masterSheetId
              }
            });
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error in checkPartPaidBalances_ for ${clientName}:`, err.message);
  }

  return alerts;
}

export async function handleUpdatePartPaidDate(sheets, {
  clientName,
  clientSheetId,
  masterSheetId,
  itemType,
  rowNumber,
  slot,
  sendDate,
  cellCoord,
  appId,
  newDate,
  userEmail,
  isAdmin = false,
  sessionId,
  alertKey: providedAlertKey,
  fingerprintHash: providedFp
}) {
  if (!clientSheetId || !newDate) {
    throw new Error("Missing clientSheetId or newDate");
  }

  const parsedNewDate = parseConfirmedDate_(newDate);
  if (!parsedNewDate) {
    throw new Error("Invalid target date format selected");
  }
  const formattedNewDate = toSheetDateFormat(parsedNewDate);
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const timestamp = `${now.getDate()}-${months[now.getMonth()]} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  if (itemType === "invoice") {
    const parsedRowNum = parseInt(rowNumber, 10);
    if (!rowNumber || isNaN(parsedRowNum) || parsedRowNum < 2 || parsedRowNum > 5000 || !slot) {
      throw new Error("Missing or invalid rowNumber or slot for invoice date update");
    }
    rowNumber = parsedRowNum;
    const slotDaysCols = { 1: "AS", 2: "AZ", 3: "BG" };
    const colLetter = slotDaysCols[slot];
    if (!colLetter) throw new Error(`Invalid slot index: ${slot}`);

    const parsedSendDate = parseConfirmedDate_(sendDate) || now;
    const newDaysToPay = Math.max(0, Math.round((parsedNewDate.getTime() - parsedSendDate.getTime()) / 86400000));

    // 1. Update Days to Pay in Confirmed sheet (defer downstream Client tab recompute)
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: `Confirmed!${colLetter}${rowNumber}`,
      valueInputOption: "RAW",
      _deferBackgroundRecompute: true,
      requestBody: { values: [[newDaysToPay]] }
    }));

    // 2. Append cell note and log activity cleanly in background via waitUntil
    scheduleWaitUntil_(async () => {
      try {
        const metaResp = await sheets.spreadsheets.get({
          spreadsheetId: clientSheetId,
          fields: "sheets(properties.sheetId,properties.title)"
        });
        const confSheet = metaResp.data?.sheets?.find(s => s.properties.title === "Confirmed");
        if (confSheet) {
          const gridSheetId = confSheet.properties.sheetId;
          const colIdx = (slot === 1 ? 44 : (slot === 2 ? 51 : 58)); // 0-indexed column
          const auditNote = `${timestamp}: Expected payment date adjusted to ${formattedNewDate} (${newDaysToPay} days to pay) by ${userEmail || "user"}.`;
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: {
              requests: [{
                updateCells: {
                  range: {
                    sheetId: gridSheetId,
                    startRowIndex: rowNumber - 1,
                    endRowIndex: rowNumber,
                    startColumnIndex: colIdx,
                    endColumnIndex: colIdx + 1
                  },
                  rows: [{
                    values: [{
                      note: auditNote
                    }]
                  }],
                  fields: "note"
                }
              }]
            }
          });
        }
      } catch (noteErr) {
        console.warn("Could not append audit note on Confirmed cell:", noteErr.message);
      }

      await logPmaActivity({
        userEmail: userEmail || "system",
        sessionId,
        alertKey: providedAlertKey,
        fingerprintHash: providedFp,
        action: "UPDATE_PART_PAID_INVOICE_DATE",
        clientName: clientName || "Unknown",
        details: `Updated part-paid invoice expected payment date to ${formattedNewDate} (${newDaysToPay} days to pay) on Confirmed row ${rowNumber} slot ${slot}.`
      });
    }, 25);

    await invalidatePmaClientCache(
      clientSheetId || null,
      masterSheetId || null,
      ["jobs", "invoices", "outgoings", "cash", "views"]
    ).catch(() => { });

    return {
      success: true,
      itemType: "invoice",
      newDaysToPay,
      formattedNewDate,
      isoDate: toInputDateFormat(parsedNewDate),
      message: `Expected payment date updated to ${formattedNewDate} (${newDaysToPay} days).`
    };

  } else if (itemType === "expense") {
    if (!cellCoord) {
      throw new Error("Missing cellCoord for expense date update");
    }
    const coordMatch = String(cellCoord).trim().match(/^([A-Z]{1,2})(\d{1,3})$/i);
    if (!coordMatch) {
      throw new Error(`Invalid cell coordinate: ${cellCoord}`);
    }
    const cleanCellCoord = `${coordMatch[1].toUpperCase()}${parseInt(coordMatch[2], 10)}`;
    const parsedExpRow = parseInt(coordMatch[2], 10);
    if (parsedExpRow < 12 || parsedExpRow > 228) {
      throw new Error(`Invalid Outgoings row in cellCoord: ${cellCoord}`);
    }
    cellCoord = cleanCellCoord;

    const cellRange = `Outgoings!${cellCoord}`;
    const metaResp = await sheets.spreadsheets.get({
      spreadsheetId: clientSheetId,
      ranges: [cellRange],
      fields: "sheets(properties.sheetId,properties.title,data(rowData(values(note))))"
    });
    const sheetObj = metaResp.data?.sheets?.[0];
    const gridSheetId = sheetObj?.properties?.sheetId;
    const currentNote = sheetObj?.data?.[0]?.rowData?.[0]?.values?.[0]?.note || "";

    let updatedNote = currentNote;
    if (appId && updatedNote.includes(appId)) {
      const blocks = updatedNote.split(/(?=\{App ID:)/i);
      const hasBalanceStatus = blocks.some(b => b.includes(appId) && (b.toLowerCase().includes("balance") || b.toLowerCase().includes("part-paid (balance)")));
      const newBlocks = blocks.map(b => {
        if (b.includes(appId)) {
          if (!hasBalanceStatus || b.toLowerCase().includes("balance") || b.toLowerCase().includes("part-paid (balance)")) {
            if (/\{Pay date:\s*[^}]*\}/i.test(b)) {
              return b.replace(/\{Pay date:\s*[^}]*\}/i, `{Pay date: ${formattedNewDate}}`);
            } else {
              return b + `{Pay date: ${formattedNewDate}}`;
            }
          }
        }
        return b;
      });
      updatedNote = newBlocks.join("");
    } else if (/\{Pay date:\s*[^}]*\}/i.test(updatedNote)) {
      updatedNote = updatedNote.replace(/\{Pay date:\s*[^}]*\}/i, `{Pay date: ${formattedNewDate}}`);
    } else {
      updatedNote = `${updatedNote}\n\n[${timestamp}]: Expected pay date adjusted to ${formattedNewDate} by ${userEmail || "user"}.`;
    }

    const match = cellCoord.match(/^([A-Z]+)(\d+)$/i);
    if (!match) throw new Error(`Invalid cell coordinate: ${cellCoord}`);
    const colLetters = match[1].toUpperCase();
    const rowNum = parseInt(match[2], 10);
    let colIdx = 0;
    for (let i = 0; i < colLetters.length; i++) {
      colIdx = colIdx * 26 + (colLetters.charCodeAt(i) - 64);
    }
    colIdx -= 1; // 0-indexed

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: clientSheetId,
      _deferBackgroundRecompute: true,
      requestBody: {
        requests: [{
          updateCells: {
            range: {
              sheetId: gridSheetId,
              startRowIndex: rowNum - 1,
              endRowIndex: rowNum,
              startColumnIndex: colIdx,
              endColumnIndex: colIdx + 1
            },
            rows: [{
              values: [{
                note: updatedNote
              }]
            }],
            fields: "note"
          }
        }]
      }
    });

    scheduleWaitUntil_(() =>
      logPmaActivity({
        userEmail: userEmail || "system",
        sessionId,
        alertKey: providedAlertKey,
        fingerprintHash: providedFp,
        action: "UPDATE_PART_PAID_EXPENSE_DATE",
        clientName: clientName || "Unknown",
        details: `Updated part-paid expense expected payment date to ${formattedNewDate} on Outgoings cell ${cellCoord}.`
      })
      , 25);

    await invalidatePmaClientCache(
      clientSheetId || null,
      masterSheetId || null,
      ["jobs", "invoices", "outgoings", "cash", "views"]
    ).catch(() => { });

    return {
      success: true,
      itemType: "expense",
      formattedNewDate,
      isoDate: toInputDateFormat(parsedNewDate),
      message: `Expected payment date updated to ${formattedNewDate}.`
    };
  }

  throw new Error(`Unknown itemType: "${itemType}"`);
}

/**
 * Checks the Client Sheet "Salaries" tab for recent months where salary actuals have been
 * captured for some staff, but one or more employees still have blank actuals (rows 4..53)
 * and are therefore silently pulling non-zero forecast costs (rows 154..203).
 */
export async function checkSalaryForecastInActualMonth_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  if (!clientSheetId || !sheets) return alerts;

  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: clientSheetId,
        ranges: [
          "Salaries!A1:JC53",
          "Salaries!L154:JC203",
          "Performance!A1:AZ2",
          "Outgoings!A1:AZ112",
        ],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    );

    const ranges = resp.data?.valueRanges || [];
    const salTop = ranges[0]?.values || [];
    const salForecast = ranges[1]?.values || [];
    const perfGrid = ranges[2]?.values || [];
    const outgoingsGrid = ranges[3]?.values || [];

    if (salTop.length < 4) return alerts;

    const salHeaderRow = salTop[0] || [];
    const employeesRows = salTop.slice(3, 53); // Rows 4..53
    const actualsRows = employeesRows.map((r) => (r || []).slice(11)); // Col L onwards

    // Build month -> colIndex maps for Performance & Outgoings
    const perfHeaderRow = perfGrid[0] || [];
    const perfStatusRow = perfGrid[1] || [];
    const perfStatusByKey = new Map();
    for (let c = 6; c < perfHeaderRow.length; c++) {
      const m = parseHeaderMonthMeta_(perfHeaderRow[c]);
      if (m) {
        perfStatusByKey.set(`${m.year}-${m.monthIdx}`, String(perfStatusRow[c] || "").trim().toLowerCase());
      }
    }

    const outgHeaderRow = outgoingsGrid[0] || [];
    const outgColByKey = new Map();
    for (let c = 6; c < outgHeaderRow.length; c++) {
      const m = parseHeaderMonthMeta_(outgHeaderRow[c]);
      if (m) {
        outgColByKey.set(`${m.year}-${m.monthIdx}`, c);
      }
    }
    const contractorsRows = outgoingsGrid.slice(11, 112); // Outgoings rows 12..112

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const minCheckMonthStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);

    for (let c = 11; c < salHeaderRow.length; c += 7) {
      const mMeta = parseHeaderMonthMeta_(salHeaderRow[c]);
      if (!mMeta) continue;

      const monthKey = `${mMeta.year}-${mMeta.monthIdx}`;
      const monthStart = new Date(mMeta.year, mMeta.monthIdx, 1);
      if (monthStart < minCheckMonthStart) continue;
      const perfStatus = perfStatusByKey.get(monthKey) || "";

      const colOffset = c - 11;
      const outgoingsMonthColIdx = outgColByKey.has(monthKey) ? outgColByKey.get(monthKey) : -1;

      const { actualEmployeeCount, forecastOnlyEmployees } = findForecastOnlyEmployeesInMonth_({
        employeesRows,
        actualsRows,
        forecastRows: salForecast,
        colOffset,
        monthMeta: mMeta,
        contractorsRows,
        outgoingsMonthColIdx,
      });

      // Only alert on months where actuals have been captured AND the month is closed/actual
      if (actualEmployeeCount < 1) continue;
      if (perfStatus !== "actual" && monthStart >= currentMonthStart) continue;
      if (forecastOnlyEmployees.length === 0) continue;

      const colStartLetter = colIdxToLetter(c);

      for (const emp of forecastOnlyEmployees) {
        const contractorNote = emp.contractorAmount > 0
          ? ` Also has £${emp.contractorAmount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} recorded under Contractors in ${mMeta.label}.`
          : "";
        const rolePart = emp.role ? ` (${emp.role})` : "";
        const costFmt = emp.forecastEmployerCost.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        alerts.push({
          alertType: "salary_forecast_in_actual_month",
          alertKey: `salary_forecast_in_actual_month|${clientName}|${emp.sheetRow}|${mMeta.label}`,
          legacyAlertKey: `salary_forecast_in_actual_month|${clientName}|${emp.name}|${mMeta.label}`,
          heading: `${emp.name} still on salary forecast in ${mMeta.label}`,
          detail: `${emp.name}${rolePart} has no salary actuals recorded for ${mMeta.label} and is still contributing £${costFmt} from forecast.${contractorNote}`,
          explanation: `Salary actuals are recorded for ${actualEmployeeCount} team member${actualEmployeeCount !== 1 ? "s" : ""} in ${mMeta.label}, but ${emp.name} has no actuals entered so Pulse is still including £${costFmt} from forecast (Salary £${emp.forecastSalary.toFixed(2)}, Er NICs £${emp.forecastErNic.toFixed(2)}, Er pension £${emp.forecastErPen.toFixed(2)}).${contractorNote}`,
          clientName,
          employeeName: emp.name,
          role: emp.role,
          monthLabel: mMeta.label,
          sheetRow: emp.sheetRow,
          colStartLetter,
          forecastSalary: emp.forecastSalary,
          forecastErNic: emp.forecastErNic,
          forecastErPen: emp.forecastErPen,
          forecastEmployerCost: emp.forecastEmployerCost,
          deliveryPct: emp.deliveryPct,
          startDate: emp.startDate,
          isoStartDate: emp.isoStartDate,
          suggestedNextStartIso: emp.suggestedNextStartIso,
          contractorAmount: emp.contractorAmount,
          actualEmployeeCount,
          metadata: {
            clientName,
            clientSheetId,
            masterSheetId,
            employeeName: emp.name,
            role: emp.role,
            monthLabel: mMeta.label,
            sheetRow: emp.sheetRow,
            colStartLetter,
            forecastSalary: emp.forecastSalary,
            forecastErNic: emp.forecastErNic,
            forecastErPen: emp.forecastErPen,
            forecastEmployerCost: emp.forecastEmployerCost,
            deliveryPct: emp.deliveryPct,
            startDate: emp.startDate,
            isoStartDate: emp.isoStartDate,
            suggestedNextStartIso: emp.suggestedNextStartIso,
            contractorAmount: emp.contractorAmount,
            actualEmployeeCount,
            explanation: `Salary actuals are recorded for ${actualEmployeeCount} team member${actualEmployeeCount !== 1 ? "s" : ""} in ${mMeta.label}, but ${emp.name} has no actuals entered so Pulse is still including £${costFmt} from forecast (Salary £${emp.forecastSalary.toFixed(2)}, Er NICs £${emp.forecastErNic.toFixed(2)}, Er pension £${emp.forecastErPen.toFixed(2)}).${contractorNote}`,
          },
        });
      }
    }
  } catch (err) {
    console.error(`Error in checkSalaryForecastInActualMonth_ for ${clientName}:`, err.message);
  }

  return alerts;
}

export async function handleResolveSalaryForecastMismatch(sheets, {
  clientName,
  clientSheetId,
  masterSheetId,
  sheetRow,
  colStartLetter,
  monthLabel,
  resolutionAction,
  newStartDate,
  sessionUser,
}) {
  return await applySalaryForecastResolution_({
    sheets,
    clientSheetId,
    masterSheetId,
    clientName,
    sheetRow,
    colStartLetter,
    monthLabel,
    resolutionAction,
    newStartDate,
    sessionUser,
  });
}