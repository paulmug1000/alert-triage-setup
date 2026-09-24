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
    if (!ref || ref.toUpperCase().indexOf("MANUAL-INV") === 0) continue;
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
        let detail1 = `${clientNameRow} - ${jobName}: invoice was scheduled for ${fmtDate(unsentSendDate)} but has no reference number — it may not have been sent yet.`;
        if (possibleMatch1) {
          detail1 += `\nPossible match: invoice ${possibleMatch1.invoiceNo} for £${possibleMatch1.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch1.sentDate} (confidence: ${possibleMatch1.confidence})${possibleMatch1.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch1.attachedToRow}` : " — not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
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
              detail2 += `\nPossible match: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate} (confidence: ${possibleMatch2.confidence})${possibleMatch2.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch2.attachedToRow}` : " — not yet attached to any job in Confirmed"}. This may mean the retainer value has changed.`;
            } else {
              detail2 += `\nInvoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)} was sent to ${clientNameRow} on ${possibleMatch2.sentDate}, matching the expected retainer amount${possibleMatch2.attachedToRow ? ` — already attached to Confirmed row ${possibleMatch2.attachedToRow}.` : ", but not yet attached to this job in Confirmed."}`;
            }
          } else {
            possibleMatchCase = "draft";
            detail2 += `\nNote: invoice ${possibleMatch2.invoiceNo} for £${possibleMatch2.amount.toFixed(2)}${possibleMatch2.attachedToRow ? ` already exists on Confirmed row ${possibleMatch2.attachedToRow}` : " already exists"} but is still marked "${possibleMatch2.status || "unsent"}" — it likely just needs sending.`;
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
            alertType: "revenue_mismatch", alertKey: `revenue_mismatch|${clientName}|${jobClient0}|${jobName0}${projectCode0 ? `|${projectCode0}` : ""}`,
            heading: "Revenue / total invoiced mismatch",
            detail: `${jobClient0} | ${jobName0} (Row ${r + 1})${projectCode0 ? ` [${projectCode0}]` : ""}: revenue = £0.00 but total invoiced (incl. placeholders) = £${totalInvoiced0.toFixed(2)} — job revenue appears to be missing or not yet set.`,
            jobName: jobName0, endClientName: jobClient0, projectCode: projectCode0, confirmedRow: r + 1, isRetainer: false,
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

      let mismatch = false, detail = "";

      if (!isRetainer) {
        let totalInvoiced = 0;
        for (let jr = 0; jr < jobRows.length; jr++) totalInvoiced += sumInvSlotAmounts_(jobRows[jr].row);
        if (totalInvoiced === 0) { r += jobRows.length; continue; }

        const diff = Math.abs(totalInvoiced - revenueAmt);
        if (diff > TOLERANCE) {
          mismatch = true;
          detail = `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: revenue = £${revenueAmt.toFixed(2)}, total invoiced (incl. placeholders) = £${totalInvoiced.toFixed(2)} — difference of £${diff.toFixed(2)}`;
        }
      } else {
          const childRows = jobRows.filter(jr => !jr.isParent);
          if (childRows.length === 0) {
            const parentTotal = sumInvSlotAmounts_(row);
            if (parentTotal === 0) { r += jobRows.length; continue; }
            const diffA = Math.abs(parentTotal - revenueAmt);
            if (diffA > TOLERANCE) {
              mismatch = true;
              detail = `${jobClient} | ${jobName} (Row ${r + 1}) [retainer, single-row]: monthly revenue = £${revenueAmt.toFixed(2)}, total invoiced on parent = £${parentTotal.toFixed(2)} — difference of £${diffA.toFixed(2)}`;
            }
          } else {
            for (let ci = 0; ci < childRows.length; ci++) {
              const cr = childRows[ci];
              const childTotal = sumInvSlotAmounts_(cr.row);
              if (childTotal === 0) continue;
              const mult = detectPeriodMultiplier_(cr.row, revenueAmt);
              const expectedForRow = revenueAmt * mult;
              const diffC = Math.abs(childTotal - expectedForRow);
              if (diffC > TOLERANCE) {
                const ref = String(cr.row[42] || "").trim();
                const sentDate = String(cr.row[43] || "").trim();
                const suffix = ref || sentDate || `child-${ci}`;
                
                alerts.push({
                  alertType: "revenue_mismatch", 
                  alertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}|${suffix}${projectCode ? `|${projectCode}` : ""}`,
                  heading: "Revenue / total invoiced mismatch", 
                  detail: `${jobClient} | ${jobName} (Row ${cr.sheetRow}) [retainer, multi-row]: £${childTotal.toFixed(2)} invoiced, expected £${expectedForRow.toFixed(2)} (${mult}× monthly revenue of £${revenueAmt.toFixed(2)}) — diff £${diffC.toFixed(2)}`, 
                  jobName, endClientName: jobClient, projectCode, confirmedRow: cr.sheetRow, isRetainer,
                });
              }
            }
          }
        }

        if (mismatch) {
          alerts.push({
            alertType: "revenue_mismatch", alertKey: `revenue_mismatch|${clientName}|${jobClient}|${jobName}${projectCode ? `|${projectCode}` : ""}`,
            heading: "Revenue / total invoiced mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, isRetainer,
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

        let mismatch = false, detail = "";

        if (!isRetainer) {
          let totalExpenses = 0;
          for (let jr = 0; jr < jobRows.length; jr++) totalExpenses += sumExpSlotAmounts_(jobRows[jr].row);
          if (totalExpenses === 0) { r += jobRows.length; continue; }

          const diff = Math.abs(totalExpenses - directCostsAmt);
          if (diff > TOLERANCE) {
            mismatch = true;
            detail = `${jobClient} | ${jobName} (Row ${sheetRow})${projectCode ? ` [${projectCode}]` : ""} [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses (incl. placeholders) = £${totalExpenses.toFixed(2)} — difference of £${diff.toFixed(2)}`;
          }
        } else {
          const childRows = jobRows.filter(jr => !jr.isParent);
          if (childRows.length === 0) {
            const parentExp = sumExpSlotAmounts_(row);
            if (parentExp === 0) { r += jobRows.length; continue; }
            const diffA = Math.abs(parentExp - directCostsAmt);
            if (diffA > TOLERANCE) {
              mismatch = true;
              detail = `${jobClient} | ${jobName} (Row ${sheetRow}) [retainer, single-row] [${tabName} tab]: direct cost budget = £${directCostsAmt.toFixed(2)}, total expenses on parent = £${parentExp.toFixed(2)} — difference of £${diffA.toFixed(2)}`;
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
                  alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}|${suffix}${projectCode ? `|${projectCode}` : ""}`,
                  heading: "Direct costs / total expenses mismatch", 
                  detail: `${jobClient} | ${jobName} (Row ${childSheetRow}) [retainer, multi-row] [${tabName} tab]: £${childExp.toFixed(2)} expenses, expected £${expectedForRow.toFixed(2)} (${mult}× monthly budget of £${directCostsAmt.toFixed(2)}) — diff £${diffC.toFixed(2)}`, 
                  jobName, endClientName: jobClient, projectCode, confirmedRow: childSheetRow, isRetainer, tab: tabName,
                });
              }
            }
          }
        }

        if (mismatch) {
          alerts.push({
            alertType: "direct_costs_mismatch", alertKey: `direct_costs_mismatch|${clientName}|${jobClient}|${jobName}|${tabName}${projectCode ? `|${projectCode}` : ""}`,
            heading: "Direct costs / total expenses mismatch", detail, jobName, endClientName: jobClient, projectCode, confirmedRow: sheetRow, isRetainer, tab: tabName,
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
        alertType: "pipeline_confirmed_overlap", alertKey: `pipeline_confirmed_overlap|${clientName}|${confClient}|${confCode || confJob}`,
        heading: "Job in both Pipeline and Confirmed — Pipeline not closed out", detail, jobName: confJob, endClientName: confClient,
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
        alertType: "retainer_shrink_blocked", alertKey: `retainer_shrink_blocked|${clientName}|${endClientStr || "unknown"}|${jobName || clientJobStr}|row${childRowNum}`,
        heading: "Retainer child row blocked from trimming — manual review needed",
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
          const ref = String(jRow[s.ref] || "").trim().toUpperCase();
          const amtNum = parseFloat(String(jRow[s.amt] || "0").replace(/[£$€,\s]/g, "")) || 0;
          if (ref && !ref.startsWith("MANUAL-INV") && amtNum > 0) {
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
          alertKey: `uninvoiced_new_job|${clientName}|${jobClient || ""}|${stableKey}`,
          legacyAlertKey: `uninvoiced_new_job|${stableKey}`,
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
        const draftNote = draftCount > 0 ? ` Note: ${draftCount} invoice(s) totalling £${draftTotal.toFixed(2)} have a reference but are still Draft (not yet sent) — these are not counted as invoiced.` : "";
        alerts.push({
          alertType: "uninvoiced_revenue",
          alertKey: `uninvoiced_revenue|${clientName}|${jobClient || ""}|${stableKey}`,
          legacyAlertKey: `uninvoiced_revenue|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Completed job has uninvoiced revenue",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, revenue = £${revenueAmt.toFixed(2)}, real sent/paid invoiced (excl. placeholders and drafts) = £${totalRealInvoiced.toFixed(2)} — £${uninvoiced.toFixed(2)} uninvoiced.${draftNote}`,
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
      if (!ref || ref.toUpperCase().indexOf("MANUAL-INV") === 0 || missingFlag !== "1") continue;
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
        detail: `Invoice ${candidateRef} (${found.foundClientName}${found.jobName ? ` - ${found.jobName}` : ""}), sent ${sentDateStr}${amountNum > 0 ? `, £${amountNum.toFixed(2)}` : ""}, has a real reference on the Confirmed tab (row ${found.rowNum}, invoice slot ${found.slotNum}) but no longer appears in the accounting system. It may have been deleted or voided — check Xero directly.`,
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
          problems.push(`${rowLabel}: retainer has data in invoice slot 2 or 3 — retainers should only ever use slot 1 per row`);
        }
        if (isRetainer && hasChildren && jobRows[jr].isParent && hasVal(jRow[invAmtIdx[0]])) {
          problems.push(`${rowLabel}: retainer has child rows but the parent row also holds an invoice — once child rows exist, the parent should stay empty`);
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
      if (!appId || appId.toUpperCase().indexOf("MANUAL-ENTRY") === 0 || appId.toUpperCase().indexOf("UNRECON-GAP") === 0 || appId.toUpperCase().indexOf("MANUAL-GAP") === 0 || missingFlag !== "1") continue;

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
        detail: `Expense ${appId} (${jobClientD}${jobNameD ? ` - ${jobNameD}` : ""})${description ? `, ${description}` : ""}, received ${recDateStr}${grossAmount > 0 ? `, £${grossAmount.toFixed(2)}` : ""}${foundRow ? ` (Confirmed row ${foundRow}, expense slot${foundSlot})` : ""} but no longer appears in the accounting system. It may have been deleted or voided — check Xero directly.`,
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
          const refVal = String(jRow[expSlots[s].ref] || "").trim().toUpperCase();
          if (refVal.indexOf("MANUAL-ENTRY") === 0 || refVal.indexOf("UNRECON-GAP") === 0 || refVal.indexOf("MANUAL-GAP") === 0) {
            placeholderCount++; placeholderTotal += amtNum;
          } else { totalRealReceived += amtNum; }
        }
      }

      const unreceived = directCostsAmt - totalRealReceived;
      if (unreceived > TOLERANCE) {
        const placeholderNote = placeholderCount > 0 ? ` Note: ${placeholderCount} expense(s) totalling £${placeholderTotal.toFixed(2)} are manual estimates or unreconciled-gap placeholders — these are not counted as received.` : "";
        const stableKey = buildStableJobKey_(jobClient, jobName, projectCode, startVal, endVal);
        alerts.push({
          alertType: "unreceived_expenses",
          alertKey: `unreceived_expenses|${clientName}|${jobClient || ""}|${stableKey}`,
          legacyAlertKey: `unreceived_expenses|${stableKey}`,
          stableJobKey: stableKey,
          heading: "Completed job has unreceived expenses",
          detail: `${jobClient} | ${jobName} (Row ${r + 1})${projectCode ? ` [${projectCode}]` : ""}: job ended ${fmtDate(endDate)}, direct cost budget = £${directCostsAmt.toFixed(2)}, real received expenses (excl. estimates/gaps) = £${totalRealReceived.toFixed(2)} — £${unreceived.toFixed(2)} unreceived.${placeholderNote}`,
          jobName, endClientName: jobClient, projectCode, confirmedRow: r + 1, directCosts: String(directCostsAmt), endDate: fmtDate(endDate), unreceivedAmount: String(unreceived.toFixed(2)), placeholderCount: String(placeholderCount), placeholderTotal: String(placeholderTotal.toFixed(2)),
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