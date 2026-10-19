import { createHash } from "crypto";
import { isPlaceholderInvoice, isPlaceholderExpense } from "../utils/helpers.js";
import { withRetry, colIndexToLetter, applySheetFontFormat, getSheetGid } from "./sheetsClient.js";
import { getClientWebAppUrl, getAllClients } from "./workspaces.js";
import { redisClient } from "./redisClient.js";
import { ensureAlertMemoryTab, readAlertMemory, updateAlertMemoryRow, findMemoryRow } from "./alertMemory.js";

export function parseConfirmedDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  
  if (typeof val === "number") {
    return new Date((val - 25569) * 86400 * 1000);
  }
  
  const s = String(val).trim();
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(yr, months[m[2]], parseInt(m[1], 10));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function detectPeriodMultiplier_(childRow, monthlyRevenue) {
  if (!monthlyRevenue || monthlyRevenue <= 0) return 1;
  const inv1Amt = parseFloat(String(childRow[41] || "0").replace(/[£$€,\s]/g, "")) || 0;
  if (inv1Amt <= 0) return 1;
  return Math.max(1, Math.round(inv1Amt / monthlyRevenue));
}

export function sumInvSlotAmounts_(row) {
  let total = 0;
  const slotAmtIdxs = [41, 48, 55];
  for (let s = 0; s < slotAmtIdxs.length; s++) {
    const raw = row[slotAmtIdxs[s]];
    if (raw === "" || raw === null || raw === undefined) continue;
    total += parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
  }
  return total;
}

export function sumRealInvSlotAmounts_(row) {
  let total = 0, draftCount = 0, draftTotal = 0;
  const slots = [
    { amtIdx: 41, refIdx: 42, statusIdx: 45 },
    { amtIdx: 48, refIdx: 49, statusIdx: 52 },
    { amtIdx: 55, refIdx: 56, statusIdx: 59 },
  ];
  for (let s = 0; s < slots.length; s++) {
    const ref = String(row[slots[s].refIdx] || "").trim();
    if (!ref || isPlaceholderInvoice(ref)) continue;
    const raw = row[slots[s].amtIdx];
    if (raw === "" || raw === null || raw === undefined) continue;
    const amt = parseFloat(String(raw).replace(/[£$€,\s]/g, "")) || 0;
    const status = String(row[slots[s].statusIdx] || "").trim().toLowerCase();
    if (status.indexOf("sent") !== -1 || status.indexOf("paid") !== -1) {
      total += amt;
    } else {
      draftCount++;
      draftTotal += amt;
    }
  }
  return { total, draftCount, draftTotal };
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
  const parentJob    = String(data[parentIdx][1] || "").trim().toLowerCase();
  rows.push({ row: data[parentIdx], sheetRow: parentIdx + 1, isParent: true });
  for (let ri = parentIdx + 1; ri < data.length; ri++) {
    const r = data[ri];
    const rc = String(r[0] || "").trim().toLowerCase();
    const rj = String(r[1] || "").trim().toLowerCase();
    if (!rc || !rj) break;
    if (rc !== parentClient || rj !== parentJob) break;
    if (r[32] || r[37] || r[38]) break;
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
    if (status !== "sent" && status !== "paid") continue;
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
    gaps.push(Math.round((sortedDates[i].getTime() - sortedDates[i-1].getTime()) / 86400000));
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

export async function findPossibleRetainerInvoice_(masterSheetId, clientSheetId, endClientName, expectedDate, sharedData, sheets) {
  try {
    let invData = [];
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!A6:K5000" });
      invData = resp.data.values || [];
    } catch(e) { return null; }

    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const expectedTime = expectedDate.getTime();
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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

      const invoiceNo    = String(row[5] || "").trim();
      const invoiceAmt   = parseFloat(String(row[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const vatAmount    = parseFloat(String(row[4] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const status       = String(row[9] || "").trim();
      candidates.push({ invoiceNo, amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt, sentDate, vatAmount, status });
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aReal = (String(a.status||"").toLowerCase() === "sent" || String(a.status||"").toLowerCase() === "paid");
      const bReal = (String(b.status||"").toLowerCase() === "sent" || String(b.status||"").toLowerCase() === "paid");
      if (aReal !== bReal) return aReal ? -1 : 1;
      return Math.abs(a.sentDate.getTime() - expectedTime) - Math.abs(b.sentDate.getTime() - expectedTime);
    });
    const best = candidates[0];

    const result = {
      invoiceNo: best.invoiceNo, amount: best.amount, sentDate: fmtDate(best.sentDate),
      vatAmount: best.vatAmount || 0, status: best.status || "", confidence: "medium", attachedToRow: null,
    };

    let confData = sharedData?.confirmedData;
    if (!confData) {
      try {
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BH5000" });
        confData = confResp.data.values || [];
      } catch(e) { confData = []; }
    }

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
            attachedJobEnd   = parentRow[38];
            attachedJobInvCount = 0;
            for (let jr = parentIdx; jr < confData.length; jr++) {
              const jrow = confData[jr];
              if (jr > parentIdx && String(jrow[0]||"").trim() !== String(parentRow[0]||"").trim()) break;
              if (jr > parentIdx && String(jrow[1]||"").trim() !== String(parentRow[1]||"").trim()) break;
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
          const jEnd   = attachedJobEnd instanceof Date ? attachedJobEnd : new Date(attachedJobEnd);
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
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const jobType  = String(row[35] || "").toLowerCase();
      if (!jobType.includes("retainer")) continue;

      const revenue  = row[32];
      const startVal = row[37];
      const endVal   = row[38];
      if (!revenue || !startVal || !endVal) continue;

      const clientNameRow = String(row[0] || "").trim();
      const jobName       = String(row[1] || "").trim();
      if (!jobName) continue;

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate) continue;
      const startDate = parseConfirmedDate_(startVal);

      const sentInvoices = [];
      collectSentInvoices_(row, sentInvoices);

      let childRowCount = 0;
      for (let cr = r + 1; cr < data.length; cr++) {
        const childRow = data[cr];
        const childClient  = String(childRow[0] || "").trim();
        const childJob     = String(childRow[1] || "").trim();
        if ((childRow[32] || childRow[37] || childRow[38]) && (childClient !== clientNameRow || childJob !== jobName)) break;
        if (childClient !== clientNameRow || childJob !== jobName) break;
        collectSentInvoices_(childRow, sentInvoices);
        childRowCount++;
      }

      if (sentInvoices.length === 0) {
        let hasUnsentScheduled = false;
        let unsentSendDate = null;
        for (let checkRow2 = r + 1; checkRow2 < data.length; checkRow2++) {
          const cr2 = data[checkRow2];
          if ((cr2[32] || cr2[37] || cr2[38]) && (String(cr2[0]||"").trim() !== clientNameRow || String(cr2[1]||"").trim() !== jobName)) break;
          if (String(cr2[0]||"").trim() !== clientNameRow || String(cr2[1]||"").trim() !== jobName) break;
          const slots2 = [{ sentIdx: 43, refIdx: 42 }, { sentIdx: 50, refIdx: 49 }, { sentIdx: 57, refIdx: 56 }];
          for (let s2 = 0; s2 < slots2.length; s2++) {
            const sentVal2 = cr2[slots2[s2].sentIdx];
            const refVal2  = String(cr2[slots2[s2].refIdx] || "").trim();
            if (!sentVal2) continue;
            const sentDate2 = parseConfirmedDate_(sentVal2);
            if (!sentDate2) continue;
            if (sentDate2 < today && !refVal2) { hasUnsentScheduled = true; unsentSendDate = sentDate2; }
          }
        }
        if (!hasUnsentScheduled) continue;
        const possibleMatch1 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, unsentSendDate, sharedData, sheets);
        let detail1 = `${clientNameRow} - ${jobName}: invoice was scheduled for ${fmtDate(unsentSendDate)} but has no reference number - it may not have been sent yet.`;
        if (possibleMatch1) {
          detail1 += `\nPossible match: invoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch1.sentDate} (confidence: ${possibleMatch1.confidence})${possibleMatch1.attachedToRow ? ` - already attached to Confirmed row ${possibleMatch1.attachedToRow}` : " - not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
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
          endDate: fmtDate(endDate), lastInvoiceDate: fmtDate(unsentSendDate), expectedByDate: fmtDate(unsentSendDate),
          possibleMatchInvoiceNo: possibleMatch1?.invoiceNo || "", possibleMatchAmount: String(possibleMatch1?.amount || ""),
          possibleMatchSentDate: possibleMatch1?.sentDate || "", possibleMatchVatAmount: String(possibleMatch1?.vatAmount || 0),
          possibleMatchStatus: possibleMatch1?.status || "", possibleMatchConfidence: possibleMatch1?.confidence || "",
          possibleMatchConfirmedRow: possibleMatch1?.attachedToRow ? String(possibleMatch1.attachedToRow) : "",
        });
        continue;
      }

      sentInvoices.sort((a, b) => a.getTime() - b.getTime());
      const lastInvoice = sentInvoices[sentInvoices.length - 1];
      const contractMonths = Math.max(1, Math.round((endDate.getTime() - (startDate ? startDate.getTime() : endDate.getTime())) / (30.4375 * 24 * 60 * 60 * 1000)));
      const monthlyRevenue = parseFloat(String(revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
      const totalContractValue = monthlyRevenue * contractMonths;

      let totalInvoiced = 0;
      const allJobRows = [row];
      for (let ar = r + 1; ar < data.length; ar++) {
        if (String(data[ar][0]||"").trim() !== clientNameRow || String(data[ar][1]||"").trim() !== jobName) break;
        allJobRows.push(data[ar]);
      }
      for (let aj = 0; aj < allJobRows.length; aj++) {
        totalInvoiced += sumRealInvSlotAmounts_(allJobRows[aj]).total;
      }

      if (totalContractValue > 0 && totalInvoiced >= totalContractValue * 0.95) continue;

      let frequencyDays = 30;
      if (sentInvoices.length >= 2) {
        frequencyDays = inferFrequency_(sentInvoices);
      } else if (monthlyRevenue > 0) {
        let firstInvAmt = 0;
        for (let fj = 0; fj < allJobRows.length; fj++) {
          const fjReal = sumRealInvSlotAmounts_(allJobRows[fj]).total;
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

      if (today > expectedBy && endDate > nextPeriodStart) {
        const possibleMatch2 = await findPossibleRetainerInvoice_(masterSheetId, clientSheetId, clientNameRow, expectedBy, sharedData, sheets);
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
  } catch(e) { }
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
      const details   = String(row[3] || "");
      if (!details.includes(WARNING_TEXT)) continue;

      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");
      const sequenceType = String(row[1] || "");
      const summary      = String(row[2] || "");
      const jobMatch = details.match(/Job[:\s]+([^\n,]+)/i);
      const jobInfo = jobMatch ? jobMatch[1].trim() : "";

      alerts.push({
        alertType: "crm_wipe", alertKey: `crm_wipe|${clientName}|${tsStr}`,
        heading: "CRM data wipe warning",
        detail: `AutoLog entry at ${tsStr} contains: "${WARNING_TEXT}". Review CRM data for ${clientName}.`,
        timestamp: tsStr, sequenceType, summary, jobInfo, detailsSnippet: details.slice(0, 300),
      });
    }
  } catch(e) {}
  return alerts;
}

export async function checkRevenueMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const TOLERANCE = 1.00;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue  = row[32];
      const jobType  = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal   = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;

      if (revenueAmt <= 0) {
        const jobRows0 = collectJobRows_(data, r);
        let totalInvoiced0 = 0;
        for (let jr0 = 0; jr0 < jobRows0.length; jr0++) totalInvoiced0 += sumInvSlotAmounts_(jobRows0[jr0].row);
        if (totalInvoiced0 > 0) {
          const jobClient0  = String(row[0] || "").trim();
          const jobName0    = String(row[1] || "").trim();
          const projectCode0 = String(row[2] || "").trim();
          alerts.push({
            alertType: "revenue_mismatch",
            alertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}|rev:0.00|inv:${totalInvoiced0.toFixed(2)}`,
            legacyAlertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}`,
            heading: "Revenue / total invoiced mismatch",
            detail: `${jobClient0} | ${jobName0} (Row ${r + 1})${projectCode0 ? ` [${projectCode0}]` : ""}: revenue = £0.00 but total invoiced (incl. placeholders) = £${totalInvoiced0.toFixed(2)} - job revenue appears to be missing or not yet set.`,
            jobName: jobName0, endClientName: jobClient0, projectCode: projectCode0, confirmedRow: r + 1, isRetainer: jobType.includes("retainer"),
            revenue: "0.00", totalInvoiced: totalInvoiced0.toFixed(2), diff: totalInvoiced0.toFixed(2),
          });
        }
        r += jobRows0.length;
        continue;
      }

      const startDate = parseConfirmedDate_(startVal);
      if (startDate && startDate > today) { r++; continue; }

      const jobClient   = String(row[0] || "").trim();
      const jobName     = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const isRetainer = jobType.includes("retainer");
      const jobRows    = collectJobRows_(data, r);

      let mismatch = false, detail = "", mismatchTotalInvoiced = 0;

      if (!isRetainer) {
        let totalInvoiced = 0;
        for (let jr = 0; jr < jobRows.length; jr++) totalInvoiced += sumInvSlotAmounts_(jobRows[jr].row);
        if (totalInvoiced === 0) { r += jobRows.length; continue; }

        const diff = Math.abs(totalInvoiced - revenueAmt);
        if (diff > TOLERANCE) {
          mismatch = true;
          mismatchTotalInvoiced = totalInvoiced;
          detail = `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: revenue = £${revenueAmt.toFixed(2)}, total invoiced (incl. placeholders) = £${totalInvoiced.toFixed(2)} - difference of £${diff.toFixed(2)}`;
        }
      }
      // Note: Retainers recognise revenue according to their monthly job revenue amount (Col AG),
      // even if actual monthly invoices vary due to FX / currency conversions or billing adjustments.
      // Therefore, differences between monthly invoice amounts and the monthly revenue rate
      // are normal and do not raise revenue_mismatch alerts.

      if (mismatch) {
        alerts.push({
          alertType: "revenue_mismatch",
          alertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}|rev:${revenueAmt.toFixed(2)}|inv:${mismatchTotalInvoiced.toFixed(2)}`,
          legacyAlertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}`,
          heading: "Revenue / total invoiced mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
          revenue: revenueAmt.toFixed(2), totalInvoiced: mismatchTotalInvoiced.toFixed(2), diff: Math.abs(mismatchTotalInvoiced - revenueAmt).toFixed(2),
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

export async function checkDirectCostsMismatch_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  const TAB_CONFIGS = [{ tabName: "Confirmed", startRow: 2 }, { tabName: "Pipeline", startRow: 2 }];
  for (let tc = 0; tc < TAB_CONFIGS.length; tc++) {
    const tabName  = TAB_CONFIGS[tc].tabName;
    const startRow = TAB_CONFIGS[tc].startRow;
    try {
      let data = [];
      if (tabName === "Confirmed" && sharedData?.confirmedData) {
        data = sharedData.confirmedData.slice(startRow - 1);
      } else if (tabName === "Pipeline" && sharedData?.pipelineData) {
        data = sharedData.pipelineData.slice(startRow - 1);
      } else { continue; }

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const TOLERANCE = 1.00;
      let r = 0;
      while (r < data.length) {
        const row = data[r];
        const revenue      = row[32];
        const directCosts  = row[33];
        const jobType      = String(row[35] || "").toLowerCase();
        const startVal     = row[37];
        const endVal       = row[38];

        if (!revenue || !startVal || !endVal) { r++; continue; }

        const directCostsAmt = parseFloat(String(directCosts || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (directCostsAmt <= 0) {
          const skipRows = collectJobRows_(data, r);
          r += skipRows.length;
          continue;
        }

        const startDate = parseConfirmedDate_(startVal);
        if (startDate && startDate > today) { r++; continue; }

        const revenueAmt  = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
        const jobClient   = String(row[0] || "").trim();
        const jobName     = String(row[1] || "").trim();
        const projectCode = String(row[2] || "").trim();
        if (!jobName) { r++; continue; }

        const isRetainer = jobType.includes("retainer");
        const jobRows    = collectJobRows_(data, r);
        const sheetRow   = startRow + r;

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
            directCosts: directCostsAmt.toFixed(2), totalExpenses: mismatchExpTotal.toFixed(2),
          });
        }
        r += jobRows.length;
      }
    } catch(e) {}
  }
  return alerts;
}

export async function checkPipelineConfirmedOverlap_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const confData = sharedData?.confirmedData || [];
    const pipeData = sharedData?.pipelineData || [];
    if (confData.length < 2 || pipeData.length < 6) return alerts;

    const pipeByCode = {}, pipeByJob = {};
    for (let p = 1; p < pipeData.length; p++) {
      const pr = pipeData[p];
      const pClient = String(pr[0] || "").trim();
      const pJob    = String(pr[1] || "").trim();
      const pCode   = String(pr[2] || "").trim();
      const pLikelihood = String(pr[39] || "").trim();
      const pCopied = String(pr[107] || "").trim();
      if (!pClient && !pJob && !pCode) continue;

      const pipeInfo = { sheetRow: p + 1, likelihood: pLikelihood, copiedToConf: pCopied, jobName: pJob, clientName: pClient, projectCode: pCode };
      if (pCode) pipeByCode[pCode.toLowerCase()] = pipeInfo;
      if (pClient && pJob) pipeByJob[`${pClient.toLowerCase()}|||${pJob.toLowerCase()}`] = pipeInfo;
    }

    for (let r = 1; r < confData.length; r++) {
      const row = confData[r];
      const confClient  = String(row[0] || "").trim();
      const confJob     = String(row[1] || "").trim();
      const confCode    = String(row[2] || "").trim();
      const confRevenue = row[32];
      const confStart   = row[37];
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
  } catch(e) {}
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
  } catch(e) {}
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
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32], startVal = row[37], endVal = row[38];

      if (!revenue || !startVal) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
      if (revenueAmt <= 0) { r += collectJobRows_(data, r).length; continue; }

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
        const slots = [{ ref: 42, amt: 41 }, { ref: 49, amt: 48 }, { ref: 56, amt: 55 }];
        for (const s of slots) {
          const ref = String(jRow[s.ref] || "").trim();
          const amtNum = parseFloat(String(jRow[s.amt] || "0").replace(/[£$€,\s]/g, "")) || 0;
          if (ref && !isPlaceholderInvoice(ref) && amtNum > 0) {
            hasRealInvoice = true;
            break;
          }
        }
        if (hasRealInvoice) break;
      }

      if (!hasRealInvoice) {
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        alerts.push({
          alertType: "uninvoiced_new_job",
          alertKey: `uninvoiced_new_job|${clientName}|${jobClient || ""}|${stableKey}|rev:${revenueAmt.toFixed(2)}`,
          legacyAlertKey: `uninvoiced_new_job|${clientName}|${jobClient || ""}|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Job started over a month ago with no invoices sent",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job started ${fmtDate(startDate)} (over a month ago) but no real invoices have been recorded yet. All invoice slots are empty or contain manual placeholders.`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), startDate: fmtDate(startDate),
          metadata: { jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), startDate: fmtDate(startDate), stableJobKey: stableKey },
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
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
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDate = (d) => `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const revenue = row[32];
      const jobType = String(row[35] || "").toLowerCase();
      const startVal = row[37];
      const endVal   = row[38];

      if (!revenue || !startVal || !endVal) { r++; continue; }
      if (jobType.includes("retainer")) { r += collectJobRows_(data, r).length; continue; }

      const endDate = parseConfirmedDate_(endVal);
      if (!endDate || (today.getTime() - endDate.getTime()) <= TWO_WEEKS_MS) { r += collectJobRows_(data, r).length; continue; }

      const jobClient   = String(row[0] || "").trim();
      const jobName     = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      if (!jobName) { r++; continue; }

      const revenueAmt = parseFloat(String(revenue).replace(/[£$€,\s]/g, "")) || 0;
      const jobRows = collectJobRows_(data, r);

      let totalRealInvoiced = 0, draftCount = 0, draftTotal = 0;
      for (let jr = 0; jr < jobRows.length; jr++) {
        const slotResult = sumRealInvSlotAmounts_(jobRows[jr].row);
        totalRealInvoiced += slotResult.total;
        draftCount += slotResult.draftCount;
        draftTotal += slotResult.draftTotal;
      }

      const uninvoiced = revenueAmt - totalRealInvoiced;
      if (uninvoiced > TOLERANCE) {
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        const draftNote = draftCount > 0 ? ` Note: ${draftCount} invoice(s) totalling £${draftTotal.toFixed(2)} have a reference but are still Draft (not yet sent) - these are not counted as invoiced.` : "";
        alerts.push({
          alertType: "uninvoiced_revenue",
          alertKey: `uninvoiced_revenue|${clientName}|${jobClient || ""}|${stableKey}|uninv:${uninvoiced.toFixed(2)}|rev:${revenueAmt.toFixed(2)}|drafts:${draftCount}`,
          legacyAlertKey: `uninvoiced_revenue|${clientName}|${jobClient || ""}|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Completed job has uninvoiced revenue",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, revenue = £${revenueAmt.toFixed(2)}, real sent/paid invoiced (excl. placeholders and drafts) = £${totalRealInvoiced.toFixed(2)} - £${uninvoiced.toFixed(2)} uninvoiced.${draftNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)),
          metadata: { jobClient, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, revenue: String(revenueAmt), endDate: fmtDate(endDate), uninvoicedAmount: String(uninvoiced.toFixed(2)), draftCount: String(draftCount), draftTotal: String(draftTotal.toFixed(2)), stableJobKey: stableKey },
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

export async function checkDeletedInvoices_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let rightData = [];
    try {
      const invCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "InvComp!AT6:BS5000" });
      rightData = invCompResp.data.values || [];
    } catch(e) { return alerts; }

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
        const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:BH5000" });
        confData = confResp.data.values || [];
      } catch(e) { return alerts; }
    }

    const slotDefs = [{ ref: 42, amt: 41, sent: 43 }, { ref: 49, amt: 48, sent: 50 }, { ref: 56, amt: 55, sent: 57 }];
    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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
        const sentDateStr = sentDateValid ? `${String(sentDateObj.getDate()).padStart(2,'0')}-${months[sentDateObj.getMonth()]}-${String(sentDateObj.getFullYear()).slice(-2)}` : String(found.sentDate || "(unknown)");

      alerts.push({
        alertType: "deleted_invoice", alertKey: `deleted_invoice|${clientName}|${candidateRef}`,
        heading: "Invoice reference no longer found in accounting system",
        detail: `Invoice ${candidateRef} (${found.foundClientName}${found.jobName ? ` - ${found.jobName}` : ""}), sent ${sentDateStr}${amountNum > 0 ? `, £${amountNum.toFixed(2)}` : ""}, has a real reference on the Confirmed tab (row ${found.rowNum}, invoice slot ${found.slotNum}) but no longer appears in the accounting system. It may have been deleted or voided - check Xero directly.`,
        jobName: found.jobName, endClientName: found.foundClientName, projectCode: found.projectCode, confirmedRow: found.rowNum, stableJobKey: candidateRef,
      });
    }
  } catch(e) {}
  return alerts;
}

export async function checkJobStructureErrors_(clientName, clientSheetId, sharedData) {
  const alerts = [];
  try {
    const data = sharedData?.confirmedDataWide || sharedData?.confirmedData || [];
    if (data.length < 2) return alerts;

    const invAmtIdx = [41, 48, 55], expAmtIdx = [76, 83, 90];
    const hasVal = (v) => v !== "" && v !== null && v !== undefined;
    const fmtDate = (d) => {
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    };

    let r = 1;
    while (r < data.length) {
      const row = data[r];
      const jobClient   = String(row[0] || "").trim();
      const jobNameV    = String(row[1] || "").trim();
      const projectCode = String(row[2] || "").trim();
      const revenue = row[32], jobType = String(row[35] || "").toLowerCase(), startVal = row[37], endVal = row[38];

      if (!jobClient || !jobNameV || !hasVal(revenue) || !hasVal(startVal) || !hasVal(endVal)) { r++; continue; }

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
          problems.push(`${rowLabel}: retainer has data in invoice slot 2 or 3 - retainers should only ever use slot 1 per row`);
        }
        if (isRetainer && hasChildren && jobRows[jr].isParent && hasVal(jRow[invAmtIdx[0]])) {
          problems.push(`${rowLabel}: retainer has child rows but the parent row also holds an invoice - once child rows exist, the parent should stay empty`);
        }
        if (hasVal(jRow[invAmtIdx[1]]) && !hasVal(jRow[invAmtIdx[0]])) problems.push(`${rowLabel}: invoice slot 2 has data but slot 1 is empty`);
        if (hasVal(jRow[invAmtIdx[2]]) && (!hasVal(jRow[invAmtIdx[0]]) || !hasVal(jRow[invAmtIdx[1]]))) problems.push(`${rowLabel}: invoice slot 3 has data but slot 1 or 2 is empty`);
        if (hasVal(jRow[expAmtIdx[1]]) && !hasVal(jRow[expAmtIdx[0]])) problems.push(`${rowLabel}: expense slot 2 has data but slot 1 is empty`);
        if (hasVal(jRow[expAmtIdx[2]]) && (!hasVal(jRow[expAmtIdx[0]]) || !hasVal(jRow[expAmtIdx[1]]))) problems.push(`${rowLabel}: expense slot 3 has data but slot 1 or 2 is empty`);
      }

      if (problems.length > 0) {
        const problemFootprint = Buffer.from(problems.join("; ")).toString("base64");
        
        alerts.push({
          alertType: "job_structure_error", 
          alertKey: `job_structure_error|${clientName}|${jobClient}|${jobNameV}${projectCode ? `|${projectCode}` : ""}|${problemFootprint}`,
          heading: "Job structure doesn't match expected invoice/expense layout",
          detail: `${jobClient} | ${jobNameV}${projectCode ? ` [${projectCode}]` : ""} (${isRetainer ? "Retainer" : "Project"}): ${problems.join("; ")}`,
          jobName: jobNameV, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
        });
      }
      r += jobRows.length;
    }
  } catch(e) {}
  return alerts;
}

export async function checkDeletedExpenses_(clientName, clientSheetId, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    let wideData = [];
    try {
      const dirCompResp = await sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "DirComp!DG6:FQ5000" });
      wideData = dirCompResp.data.values || [];
    } catch(e) { return alerts; }

    const now = new Date();
    const bufferMs = 2 * 24 * 60 * 60 * 1000;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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
      const recDateStr = recDateValid ? `${String(recDateObj.getDate()).padStart(2,'0')}-${months[recDateObj.getMonth()]}-${String(recDateObj.getFullYear()).slice(-2)}` : String(recDateRaw || "(unknown)");

      let foundRow = null, foundSlot = null;
      if (confData === null) {
        try {
          const confResp = await sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Confirmed!A1:CR5000" });
          confData = confResp.data.values || [];
        } catch(e) { confData = []; }
      }
      for (let cr = 1; cr < confData.length && !foundRow; cr++) {
        const crow = confData[cr];
        for (let s = 0; s < expSlotDefs.length; s++) {
          if (String(crow[expSlotDefs[s].ref] || "").trim() === appId) {
            foundRow = cr + 1; foundSlot = s + 1; break;
          }
        }
      }

      alerts.push({
        alertType: "deleted_expense", alertKey: `deleted_expense|${clientName}|${appId}`,
        heading: "Expense reference no longer found in accounting system",
        detail: `Expense ${appId} (${jobClientD}${jobNameD ? ` - ${jobNameD}` : ""})${description ? `, ${description}` : ""}, received ${recDateStr}${grossAmount > 0 ? `, £${grossAmount.toFixed(2)}` : ""}${foundRow ? ` (Confirmed row ${foundRow}, expense slot${foundSlot})` : ""} but no longer appears in the accounting system. It may have been deleted or voided - check Xero directly.`,
        jobName: jobNameD, endClientName: jobClientD, confirmedRow: foundRow || "", stableJobKey: appId,
      });
    }
  } catch(e) {}
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
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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
  } catch(e) {}
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
  const clientJobMatch = line.match(/(?:Row\s*\d+,\s*|\(\s*)([^|\n]+)\s*\|\s*([^,\n\-:\)]+)/);
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
  
  const p1 = /(?:[-–•,\n:]|^)\s*([A-Za-z\s]+?)\s*:\s*('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/g;
  let m;
  while ((m = p1.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanAutoLogVal_(m[2]);
    const toVal = cleanAutoLogVal_(m[3]);
    if (rawField.length <= 35 && fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  const p2 = /(?:[-–•,:\n]|^)\s*(Extended days|Date moved)\s+('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/gi;
  while ((m = p2.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanAutoLogVal_(m[2]);
    const toVal = cleanAutoLogVal_(m[3]);
    if (fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  return results;
}

export async function checkAutoLogErrors_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    if (!data.length) return alerts;

    const errorRegex = /error:\s*([^\n\r]+)/i;
    const errorsBySignature = new Map();

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const summary = String(row[2] || "").trim();
      const details = String(row[3] || "").trim();

      const combinedText = `${summary}\n${details}`;
      const match = combinedText.match(errorRegex);
      if (!match) continue;

      const rawErrorText = match[1].trim();
      if (!rawErrorText) continue;

      const cleanSignature = rawErrorText
        .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*/g, "")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .slice(0, 80);

      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      if (!errorsBySignature.has(cleanSignature)) {
        errorsBySignature.set(cleanSignature, {
          latestTs: tsStr,
          count: 1,
          category,
          summary,
          errorText: rawErrorText,
          detailsSnippet: details.slice(0, 300),
        });
      } else {
        const item = errorsBySignature.get(cleanSignature);
        item.count += 1;
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

      // Detect P&L Outgoings updates from automated sequence
      if (summary.toLowerCase().startsWith("p&l outgoings updated:")) {
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
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      let currentContext = { invNo: "", rowNo: "", endClientName: "", jobName: "", slotNo: "" };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const lineEntity = extractEntityFromAutoLogLine_(line);
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

      const completedOscillations = [];
      let i = 0;
      while (i < history.length) {
        const tStart = history[i];
        let revIdx = -1;
        for (let j = i + 1; j < history.length; j++) {
          const tNext = history[j];
          if (
            tNext.fromVal.toLowerCase() === tStart.toVal.toLowerCase() &&
            tNext.toVal.toLowerCase() === tStart.fromVal.toLowerCase()
          ) {
            revIdx = j;
            break;
          }
        }

        if (revIdx !== -1) {
          const tEnd = history[revIdx];
          completedOscillations.push({
            tStart,
            tEnd,
            intraRun: tStart.runIndex === tEnd.runIndex,
          });
          // Advance past the reversing transition to ensure distinct cycles
          i = revIdx + 1;
        } else {
          i++;
        }
      }

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
        suggestion = "Likely caused by a naming mismatch between accounting software (Xero) and CRM.";
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
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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

export async function checkQuarantinedPLCategories_(clientName, masterSheetId, sharedData, sheets) {
  const alerts = [];
  try {
    if (!masterSheetId || !sheets) return alerts;

    const compResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "PLComp!B180:B229"
      })
    );

    const rows = compResp.data.values || [];
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
      const logInfo = logDetailsMap.get(catName.toLowerCase());
      const tsStr = logInfo?.timestamp || new Date().toISOString();
      const alertKey = `unmapped_pl_category|${clientName}|${catName}`;

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
        detail: `The nominal account "${catName}" was detected in the P&L report but has not yet been classified. It has been temporarily quarantined in PLComp!B${q.rowNum} to protect Outgoings from unverified expenses. Please choose how this account should be classified.`,
        clientName,
        timestamp: tsStr,
        metadata: {
          clientName,
          categoryName: catName,
          cleanName: catName,
          quarantineRow: q.rowNum,
          masterSheetId,
          timestamp: tsStr,
          logDetails: logInfo?.details || ""
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
export async function pushCategoryPLAmountsToOutgoings_(sheets, masterSheetId, clientSheetId, categoryName, targetSheetRow) {
  if (!masterSheetId || !clientSheetId || !categoryName || !targetSheetRow) return;
  const normClean = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();

  // Helper to parse header labels into standardized 'YYYY-MM'
  function parseHeaderToMonthKey(str) {
    if (!str) return null;
    const s = String(str).trim();
    // 1. Match 'Jul 26' or 'Jul-26'
    const m = s.match(/^([A-Za-z]{3})[\s\-_]*(\d{2})$/);
    if (m) {
      const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const mIdx = monthNames.indexOf(m[1].toLowerCase());
      if (mIdx !== -1) {
        const yr = 2000 + parseInt(m[2], 10);
        return `${yr}-${String(mIdx + 1).padStart(2, '0')}`;
      }
    }
    // 2. Match 'July 2026' or 'July 26'
    const mLong = s.match(/^([A-Za-z]+)[\s\-_]*(\d{2,4})$/);
    if (mLong) {
      const monthNamesLong = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const mIdx = monthNamesLong.indexOf(mLong[1].toLowerCase());
      if (mIdx !== -1) {
        let yr = parseInt(mLong[2], 10);
        if (yr < 100) yr += 2000;
        return `${yr}-${String(mIdx + 1).padStart(2, '0')}`;
      }
    }
    // 3. Fallback standard Date
    const d = new Date(s);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2010) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return null;
  }

  const monthlyAmounts = new Map(); // 'YYYY-MM' -> number

  // 1. Read PLFromApp (historical P&L report actuals)
  try {
    const plAppRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "PLFromApp!A1:AZ100"
    }));
    const plAppRows = plAppRes.data.values || [];
    const plAppHeaders = plAppRows[0] || [];
    const plAppCatRow = plAppRows.find(r => {
      const name = String(r[0] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return name === normClean || name.includes(normClean) || normClean.includes(name);
    });

    if (plAppCatRow) {
      for (let c = 1; c < plAppHeaders.length; c++) {
        const mKey = parseHeaderToMonthKey(plAppHeaders[c]);
        if (mKey) {
          const val = parseFloat(String(plAppCatRow[c] || "0").replace(/[£$€,\s]/g, "")) || 0;
          monthlyAmounts.set(mKey, val);
        }
      }
    }
  } catch (e) {
    console.warn("[P&L Amount Push] Could not read PLFromApp:", e.message);
  }

  // 2. Read PLComp (Master calculation & comparison sheet)
  try {
    const plCompRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "PLComp!A1:AZ200"
    }));
    const plCompRows = plCompRes.data.values || [];
    const plCompHeaders = plCompRows[0] || [];
    const plCompCatRow = plCompRows.find(r => {
      const bVal = String(r[1] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      const eVal = String(r[4] || "").replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return bVal === normClean || eVal === normClean || bVal.includes(normClean) || eVal.includes(normClean);
    });

    if (plCompCatRow) {
      for (let c = 5; c < plCompHeaders.length; c++) {
        const hStr = plCompHeaders[c];
        if (!hStr) continue;
        const mKey = parseHeaderToMonthKey(hStr);
        if (mKey) {
          const val = parseFloat(String(plCompCatRow[c] || "0").replace(/[£$€,\s]/g, "")) || 0;
          if (val !== 0 || !monthlyAmounts.has(mKey)) {
            monthlyAmounts.set(mKey, val);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[P&L Amount Push] Could not read PLComp:", e.message);
  }

  // 3. Read Outgoings Row 1 month headers & template row formulas (Row 126)
  const [outHRes, tmplRes] = await Promise.all([
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

  const outHeaders = outHRes.data.values?.[0] || [];
  const templateRow = tmplRes.data.values?.[0] || [];
  if (outHeaders.length <= 6) return;

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
    const mKey = parseHeaderToMonthKey(headerStr);
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

  // Helper to convert 1-indexed column number to A1 notation column letter
  function colIndexToA1(colIdx) {
    let temp = colIdx;
    let letter = "";
    while (temp > 0) {
      let rem = (temp - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      temp = Math.floor((temp - 1) / 26);
    }
    return letter;
  }

  const startColLetter = "G";
  const endColLetter = colIndexToA1(6 + rowValues.length);

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: clientSheetId,
    range: `Outgoings!${startColLetter}${targetSheetRow}:${endColLetter}${targetSheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowValues] }
  }));

  // 4. Consolidate formatting into a single batchUpdate: format whole row as Arial 9pt, and any decimal cells with currency pattern
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

  const nonZeroCount = rowValues.filter(v => typeof v === "number" && v !== 0).length;
  console.log(`[P&L Amount Push] Successfully populated row ${targetSheetRow} (${nonZeroCount} actual months, formulas preserved, spacers blank) into Outgoings!${startColLetter}${targetSheetRow}:${endColLetter}${targetSheetRow} for "${categoryName}".`);
}

export async function ensureCategoryInOutgoings_(sheets, clientSheetId, categoryName, isDeliveryExpense = false, masterSheetId = null) {
  if (!clientSheetId || !categoryName) return null;
  const cleanName = categoryName.replace(/^\d+\s*[-–]\s*/, "").trim();
  const normClean = cleanName.toLowerCase();

  const MIN_CATEGORY_ROW = 126;
  const MAX_CATEGORY_ROW = 223; // Fixed: Last usable row of the Other expenses section is Row 223

  // Read Outgoings!A124:A225 to inspect existing categories
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: clientSheetId,
    range: `Outgoings!A124:A${MAX_CATEGORY_ROW + 2}`
  }));
  const rows = res.data.values || [];

  const existingCats = new Set();
  const populatedCategoryRows = [];

  // Gather existing populated categories strictly within rows 126 up to 223
  for (let r = MIN_CATEGORY_ROW; r <= MAX_CATEGORY_ROW; r++) {
    const raw = String(rows[r - 124]?.[0] || "").trim();
    const lower = raw.toLowerCase();

    if (raw && !raw.startsWith("#") && !lower.includes("#n/a") && !lower.startsWith("total") && !lower.startsWith("---") && !lower.startsWith("===") && lower !== "other expenses") {
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
  if (masterSheetId) {
    try {
      const jnlsRes = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "JnlsFromApp!A2:G500"
      }));
      const jnlsRows = jnlsRes.data.values || [];
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

  const payload = [[cleanName, ...defaults]];

  // Write header metadata (Columns A through F)
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: clientSheetId,
    range: `Outgoings!A${targetSheetRow}:F${targetSheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: payload }
  }));

  // P&L Amount Push: Extract monthly amounts from PLFromApp and PLComp on Master Sheet and write to Columns G onwards
  // pushCategoryPLAmountsToOutgoings_ automatically formats the entire row as Arial 9pt in its consolidated batchUpdate
  if (masterSheetId) {
    try {
      await pushCategoryPLAmountsToOutgoings_(sheets, masterSheetId, clientSheetId, cleanName, targetSheetRow);
    } catch (plErr) {
      console.warn(`[Outgoings Provision] Could not push P&L amounts for "${cleanName}":`, plErr.message);
      await applySheetFontFormat(sheets, clientSheetId, "Outgoings", targetSheetRow - 1, targetSheetRow, 0, 50, "Arial", 9);
    }
  } else {
    // If no masterSheetId, apply Arial 9pt font formatting directly
    await applySheetFontFormat(sheets, clientSheetId, "Outgoings", targetSheetRow - 1, targetSheetRow, 0, 50, "Arial", 9);
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
  userEmail
}) {
  if (!clientName || !categoryName || !classification) {
    throw new Error("Missing clientName, categoryName, or classification");
  }

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
    } catch (e) {}
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

  // 2. Apply mapping based on classification
  if (classification === "contractor") {
    // Read KeyInfo!AW2:AW161 to find full nominal code prefix (e.g. "318 - Contractor")
    const awRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!AW2:AW161"
    }));
    const awRows = (awRes.data.values || []).map(r => String(r[0] || "").trim()).filter(Boolean);
    let contractorEntry = awRows.find(item => {
      const itemClean = item.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
      return itemClean === cleanName.toLowerCase() || item.toLowerCase() === categoryName.toLowerCase();
    });
    if (!contractorEntry) {
      contractorEntry = awRows.find(item => item.toLowerCase().includes(cleanName.toLowerCase())) || categoryName;
    }

    // Append to first empty cell in KeyInfo!AT4:AT22
    const atRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!AT4:AT22"
    }));
    const atRows = atRes.data.values || [];
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

    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: `KeyInfo!AT${targetAtRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[contractorEntry]] }
    }));

  } else if (classification === "non_delivery_expense") {
    // Non-delivery expense: Auto-provision as Overhead on Client Sheet Outgoings tab
    if (targetClientSheetId) {
      await ensureCategoryInOutgoings_(sheets, targetClientSheetId, cleanName, false, masterSheetId);
    }
  } else {
    // Target sections in KeyInfo!AZ -> KeyInfo!BA
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

    const targetConfig = SECTION_MAPPING[classification];
    if (!targetConfig) {
      throw new Error(`Unknown classification: "${classification}"`);
    }

    // Read KeyInfo!AZ1:BA185
    const azBaRes = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!AZ1:BA185"
    }));
    const rows = azBaRes.data.values || [];

    let sectionStartRow = -1;
    let sectionEndRow = 185;

    for (let i = 0; i < rows.length; i++) {
      const azVal = String(rows[i]?.[0] || "").trim().toLowerCase();
      if (azVal === targetConfig.label.toLowerCase()) {
        sectionStartRow = i + 1; // 1-indexed
        for (let j = i + 1; j < rows.length; j++) {
          const nextAz = String(rows[j]?.[0] || "").trim();
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
      const baVal = String(rows[r - 1]?.[1] || "").trim();
      if (!baVal) {
        targetBaRow = r;
        break;
      }
    }

    if (targetBaRow === -1) {
      throw new Error(`No available slots in KeyInfo section "${targetConfig.label}".`);
    }

    // Write cleanName (without code prefix) to KeyInfo!BA
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: masterSheetId,
      range: `KeyInfo!BA${targetBaRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[cleanName]] }
    }));

    // If classified as Delivery expense (Other costs of sale), auto-provision onto Outgoings tab as CoS
    if (classification === "delivery_expense" && targetClientSheetId) {
      await ensureCategoryInOutgoings_(sheets, targetClientSheetId, cleanName, true, masterSheetId);
    }
  }

  // 3. Clear from quarantine in PLComp!B180:B229
  const plCompRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: masterSheetId,
    range: "PLComp!B180:B229"
  }));
  const plCompRows = plCompRes.data.values || [];
  for (let i = 0; i < plCompRows.length; i++) {
    const val = String(plCompRows[i]?.[0] || "").trim();
    const valClean = val.replace(/^\d+\s*[-–]\s*/, "").trim().toLowerCase();
    if (valClean === cleanName.toLowerCase() || val.toLowerCase() === categoryName.toLowerCase()) {
      const clearRow = 180 + i;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: masterSheetId,
        range: `PLComp!B${clearRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[""]] }
      }));
    }
  }

  // 4. Log to AutoLog on Master Sheet
  try {
    const nowStr = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: masterSheetId,
      range: "AutoLog!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          nowStr,
          "EXPENSES",
          `P&L Category Classified: "${cleanName}" -> ${classificationLabel}`,
          `User ${userEmail || "admin"} classified quarantined category "${categoryName}" as ${classificationLabel}. Added to KeyInfo and cleared from PLComp quarantine. Full expense & Outgoings sync triggered.`
        ]]
      }
    }));
  } catch (logErr) {
    console.warn("⚠️ Could not write classification to AutoLog:", logErr.message);
  }

  // 5. Auto-resolve the alert in redis cache & AlertMemory
  const alertKey = `unmapped_pl_category|${clientName}|${categoryName}`;
  if (redisClient?.isOpen) {
    try {
      const cacheKey = `pulse:triage_state:${clientName}`;
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const state = JSON.parse(cached);
        if (state.alerts) {
          state.alerts = state.alerts.filter(a => a.alertKey !== alertKey && a.metadata?.cleanName !== cleanName);
          await redisClient.set(cacheKey, JSON.stringify(state));
        }
      }
    } catch (re) {
      console.warn("Could not prune resolved alert from redis:", re.message);
    }
  }

  if (automationCommanderSheetId && sheets) {
    try {
      const fp = createHash("sha256").update(alertKey).digest("hex").substring(0, 16);
      await ensureAlertMemoryTab(sheets, automationCommanderSheetId);
      const memoryRows = await readAlertMemory(sheets, automationCommanderSheetId);
      const row = findMemoryRow(memoryRows, fp) || memoryRows.find(r =>
        r.alertType === "unmapped_pl_category" &&
        r.clientName === clientName &&
        (r.alertSummary.toLowerCase().includes(cleanName.toLowerCase()) || r.alertSummary.toLowerCase().includes(categoryName.toLowerCase()))
      );
      if (row) {
        await updateAlertMemoryRow(sheets, automationCommanderSheetId, row.rowIndex, {
          ...row,
          status: "accepted",
          lastRechecked: new Date().toISOString()
        });
      }
    } catch (amErr) {
      console.warn("Could not update AlertMemory row for classified category:", amErr.message);
    }
  }

  // 6. Trigger Master Sheet Full Sync via webAppUrl in background (non-blocking)
  // Fires push_outgoings (to execute pushOutgoingsToClientSheet) and sync_expense_breakdown
  // (to execute syncExpenseTransactionBreakdownToClientSheet_ for row 300 / rows 304-305).
  const webAppUrl = await getClientWebAppUrl(sheets, clientName, automationCommanderSheetId);
  if (webAppUrl) {
    const secret = process.env.AGENT_TRIGGER_SECRET || process.env.CRON_SECRET || "triage-cron-2026-AY4K2LDMXBV8DS7";
    fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, action: "push_outgoings", clientName })
    }).catch(err => {
      console.warn("⚠️ Master WebApp push_outgoings error:", err.message);
    });

    fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, action: "sync_expense_breakdown", clientName })
    }).catch(syncErr => {
      console.warn("⚠️ Master WebApp sync_expense_breakdown error:", syncErr.message);
    });
  }

  return {
    success: true,
    message: `Successfully classified "${cleanName}" as ${classificationLabel} and triggered Outgoings sync.`
  };
}