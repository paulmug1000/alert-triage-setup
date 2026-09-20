import { getSheetsClient, withRetry, extractSheetIdFromUrl, colIndexToLetter } from "./sheetsClient";
import { getToleranceValues, checkAllGASLocks } from "./sharedHelpers";

const RET_MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

export function retParseSheetDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
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
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function retFmtDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return d.getDate() + "-" + months[d.getMonth()] + "-" + d.getFullYear();
}

export function retParseMoney(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const clean = String(val).replace(/[^0-9.-]/g, "");
  return parseFloat(clean) || 0;
}

export async function retFindTrueLastRow(sheets, spreadsheetId, allRows) {
  let trueLastRow = 0;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const row = allRows[r] || [];
    const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
    const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
    const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
    const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
    if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
  }
  return trueLastRow;
}

export function retDetectIntervalMonths(childDates) {
  if (childDates.length < 2) return 1;
  const d1 = childDates[childDates.length - 2];
  const d2 = childDates[childDates.length - 1];
  const diffDays = Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86400000);
  const calc = Math.round(diffDays / 30);
  return calc > 0 ? calc : 1;
}

export function retDetectInvoiceTimingOffset_(allInvoiceDates, jobStartDate, intervalMonths) {
  const dates = (allInvoiceDates || []).filter(Boolean);
  if (dates.length === 0) return "during";
  if (dates.length === 1) {
    if (jobStartDate && dates[0].getTime() < jobStartDate.getTime()) return "before";
    return "during";
  }
  if (!jobStartDate) return "during"; 
  const interval = intervalMonths || 1;
  const addMonths = (y, m, n) => {
    const total = (y * 12 + m) + n; 
    return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
  };
  let beforeVotes = 0, duringVotes = 0;
  dates.forEach((sent, i) => {
    const { y, m } = addMonths(jobStartDate.getFullYear(), jobStartDate.getMonth(), i * interval);
    const periodStart = new Date(y, m, 1);
    if (sent.getTime() < periodStart.getTime()) beforeVotes++;
    else duringVotes++;
  });
  const total = beforeVotes + duringVotes;
  if (beforeVotes === total) return "before";
  if (duringVotes === total) return "during";
  if (beforeVotes / total >= 2 / 3) return "before";
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
    if (!isRetainer || !revenue) { ri++; continue; }

    const parentRowNum = ri + 1;
    const endDate = retParseSheetDate(row[38]);
    if (onlyActiveOrRecentlyEnded && endDate && endDate < twoMonthsAgo) {
      let cj2 = ri + 1;
      while (cj2 < rows.length) {
        const nx = rows[cj2] || [];
        if (String(nx[0]||"").trim() === client && String(nx[1]||"").trim() === jobName &&
            !String(nx[32]||"").trim() && !String(nx[37]||"").trim()) { cj2++; } else break;
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

const RET_INV_SLOTS = [
  { amt: 41, ref: 42, sent: 43, days: 44, status: 45 },
  { amt: 48, ref: 49, sent: 50, days: 51, status: 52 },
  { amt: 55, ref: 56, sent: 57, days: 58, status: 59 },
];

export async function handleGetRetainerJobs(req, res, sheets) {
  const { clientSheetId } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const retainerJobs = retFindRetainerJobs(rows, { onlyActiveOrRecentlyEnded: true });

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: colVal(row,base+4) };
      }),
    });

    const jobs = retainerJobs.map(job => ({
      client: job.client, jobName: job.jobName, projectCode: job.projectCode,
      revenue: job.revenue, vat: job.vat, projectRetainer: job.projectRetainer,
      parentRowNum: job.parentRowNum,
      rows: [buildRowData(job.parentRowNum, job.parentRow, true)]
        .concat(job.childRows.map(cr => buildRowData(cr.rowNum, cr.row, false))),
    }));

    jobs.sort((a, b) => {
      const da = retParseSheetDate(a.rows[0]?.startDate);
      const db = retParseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    return res.status(200).json({ success: true, jobs });
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
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== oldClient || String(parentRow[1]||"").trim() !== oldJobName) {
      return res.status(400).json({ success: false, error: "Row mismatch — job may have moved. Please refresh and try again." });
    }

    const targetRows = [parentRowNum];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0]||"").trim() === oldClient && String(next[1]||"").trim() === oldJobName &&
          !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
        targetRows.push(cj + 1);
        cj++;
      } else break;
    }

    const data = targetRows.map(rn => ({ range: `Confirmed!B${rn}`, values: [[newJobName]] }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { valueInputOption: "RAW", data },
    });

    return res.status(200).json({ success: true, rowsUpdated: targetRows.length });
  } catch (err) {
    console.error("❌ rename_retainer_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleChangeRetainerEndDate(req, res, sheets) {
  const { clientSheetId, masterSheetId, client, jobName, parentRowNum, newEndDate } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || !newEndDate) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
      return res.status(400).json({ success: false, error: "Row mismatch — job may have moved." });
    }

    const oldEndDate = retParseSheetDate(parentRow[38]);
    const newEnd = retParseSheetDate(newEndDate);
    if (!newEnd) return res.status(400).json({ success: false, error: "Invalid new end date" });

    const revenue = retParseMoney(parentRow[32]);
    const vat = parentRow[34];
    const startDate = retParseSheetDate(parentRow[37]);

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
          !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    const childDates = childRows.map(cr => retParseSheetDate(cr.row[43])).filter(Boolean); 

    const intervalMonthsForOffset = retDetectIntervalMonths(childDates);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(childDates, startDate, intervalMonthsForOffset);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0; 

    const isGrowing = !oldEndDate || newEnd > oldEndDate;

    if (!isGrowing) {
      const newEndVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
      const toTrim = [];
      for (let c = childRows.length - 1; c >= 0; c--) {
        const cr = childRows[c];
        const invDate = retParseSheetDate(cr.row[43]);
        const rowMonthVal = invDate ? (invDate.getFullYear() * 12 + invDate.getMonth() + timingMonthAdjust) : null;
        if (rowMonthVal !== null && rowMonthVal > newEndVal) {
          toTrim.push(cr);
        } else {
          break;
        }
      }

      const hasRealData = (row) => {
        for (const s of RET_INV_SLOTS) {
          const ref = String(row[s.ref] || "").trim().toUpperCase();
          if (ref && !ref.startsWith("MANUAL-INV")) return true;
        }
        const expSlots = [{ id: 81 }, { id: 88 }, { id: 95 }]; 
        for (const s of expSlots) {
          const id = String(row[s.id] || "").trim().toUpperCase();
          if (id && !id.startsWith("MANUAL-ENTRY") && !id.startsWith("UNRECON-GAP")) return true;
        }
        return false;
      };
      const blockedRow = toTrim.find(cr => hasRealData(cr.row));
      if (blockedRow) {
        return res.status(200).json({
          success: false, blocked: true,
          error: `Cannot shorten this retainer — row ${blockedRow.rowNum} already has a real invoice or expense recorded.`,
        });
      }

      if (toTrim.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
          valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
        });
        return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
      }

      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      const gridSheetId = confirmedSheet.properties.sheetId;
      const rowGroups = confirmedSheet.rowGroups || [];
      const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

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
        }
      }
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { requests } });
      }

      const trimRowNums = toTrim.map(cr => cr.rowNum).sort((a, b) => a - b);
      const clearRanges = [];
      for (const rn of trimRowNums) {
        clearRanges.push(`Confirmed!A${rn}:AM${rn}`, `Confirmed!AP${rn}:BH${rn}`, `Confirmed!BX${rn}:CR${rn}`);
      }
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId: sheetIdClean, requestBody: { ranges: clearRanges },
      });

      const freshResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
      });
      const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

      const blockStartIdx0 = trimRowNums[0] - 1;
      const blockEndIdx0 = trimRowNums[trimRowNums.length - 1]; 
      if (blockStartIdx0 <= trueLastRow) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: blockStartIdx0, endIndex: blockEndIdx0 },
              destinationIndex: trueLastRow + 1,
            },
          }] },
        });
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
        valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
      });

      return res.status(200).json({ success: true, trimmed: trimRowNums.length, grown: 0 });

    } else {
      const today = new Date(); today.setHours(0,0,0,0);
      const currentMonthVal = today.getFullYear() * 12 + today.getMonth();
      const pastCount = childDates.filter(d => (d.getFullYear()*12 + d.getMonth() + timingMonthAdjust) <= currentMonthVal).length;
      const targetCount = pastCount + 18;

      if (childRows.length >= targetCount) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
          valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
        });
        return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
      }

      const intervalMonths = retDetectIntervalMonths(childDates);
      const totalInvoiced = childRows.reduce((sum, cr) => sum + retParseMoney(cr.row[41]), 0) + retParseMoney(parentRow[41]);
      const diffDays = Math.round(Math.abs(newEnd.getTime() - (startDate || newEnd).getTime()) / 86400000);
      const durationMonths = Math.max(1, Math.round(diffDays / 30.4375));
      const totalContractValue = durationMonths * revenue;

      const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
      const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

      let lastDate = childDates.length > 0 ? childDates[childDates.length - 1] : new Date(startDate || newEnd);
      if (childDates.length === 0) lastDate.setMonth(lastDate.getMonth() - 1);

      const rowsNeeded = targetCount - childRows.length;
      const newRowDates = [];
      let simulatedTotal = totalInvoiced;
      let nextTestDate = new Date(lastDate);
      for (let k = 0; k < rowsNeeded; k++) {
        nextTestDate = new Date(nextTestDate);
        nextTestDate.setMonth(nextTestDate.getMonth() + intervalMonths);
        const testVal = nextTestDate.getFullYear() * 12 + nextTestDate.getMonth();
        const endVal = newEnd.getFullYear() * 12 + newEnd.getMonth();
        if (testVal > endVal) break;
        if ((simulatedTotal + revenue) > (totalContractValue + 1.00)) break;
        simulatedTotal += revenue;
        newRowDates.push(new Date(nextTestDate));
      }

      if (newRowDates.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
          valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
        });
        return res.status(200).json({ success: true, trimmed: 0, grown: 0 });
      }

      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      const gridSheetId = confirmedSheet.properties.sheetId;
      let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

      const freshResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
      });
      let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

      const insertAfterRowNum = childRows.length > 0 ? childRows[childRows.length-1].rowNum : parentRowNum;

      if ((currentMaxRows - (trueLastRow + 1)) < newRowDates.length) {
        const toAdd = newRowDates.length - (currentMaxRows - (trueLastRow + 1)) + 5;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
          }] },
        });
        currentMaxRows += toAdd;
      }

      if (newRowDates.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + newRowDates.length },
              destinationIndex: insertAfterRowNum,
            },
          }] },
        });
        trueLastRow += newRowDates.length;
      }

      const writeData = [];
      const dateWriteData = [];
      for (let m = 0; m < newRowDates.length; m++) {
        const rn = insertAfterRowNum + 1 + m;
        writeData.push(
          { range: `Confirmed!A${rn}`, values: [[client]] },
          { range: `Confirmed!B${rn}`, values: [[jobName]] },
          { range: `Confirmed!AI${rn}`, values: [[vat || ""]] },
          { range: `Confirmed!AP${rn}`, values: [[revenue]] },
          { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
        );
        dateWriteData.push({ range: `Confirmed!AR${rn}`, values: [[retFmtDate(newRowDates[m])]] });
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
      });
      if (dateWriteData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
        });
      }

      try {
        const metaResp2 = await sheets.spreadsheets.get({ spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)" });
        const cs2 = metaResp2.data.sheets.find(s => s.properties.title === "Confirmed");
        const groups2 = cs2.rowGroups || [];
        const anchorIdx0 = insertAfterRowNum - 1;
        const coveringGroup = groups2.find(g => g.range?.startIndex <= anchorIdx0 && g.range?.endIndex > anchorIdx0);
        const newRangeEnd = insertAfterRowNum + newRowDates.length;
        if (coveringGroup) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: [
              { deleteDimensionGroup: { range: {
                  sheetId: gridSheetId, dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                } } },
              { addDimensionGroup: { range: {
                  sheetId: gridSheetId, dimension: "ROWS",
                  startIndex: coveringGroup.range.startIndex, endIndex: newRangeEnd,
                } } },
            ] },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: [{
              addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: insertAfterRowNum, endIndex: newRangeEnd } },
            }] },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for grown retainer rows failed`);
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean, range: `Confirmed!AM${parentRowNum}`,
        valueInputOption: "USER_ENTERED", requestBody: { values: [[newEndDate]] },
      });

      return res.status(200).json({ success: true, trimmed: 0, grown: newRowDates.length });
    }
  } catch (err) {
    console.error("❌ change_retainer_end_date error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleChangeRetainerMonthlyAmount(req, res, sheets) {
  const {
    clientSheetId, client, jobName, parentRowNum, changeMonth, changeYear, newMonthlyAmount,
    sourceInvoiceRef, sourceInvoiceSentDate, sourceInvoiceDaysToPay, sourceInvoiceStatus, sourceConfirmedRow,
  } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || changeMonth === undefined || !changeYear || !newMonthlyAmount) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }

    const oldEndDate = retParseSheetDate(parentRow[38]);
    const changeMonthVal = changeYear * 12 + changeMonth;

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
          !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    const allRows = [{ rowNum: parentRowNum, row: parentRow, isParent: true }].concat(childRows);
    const datedRows = allRows.map(r => ({ ...r, invDate: retParseSheetDate(r.row[43]) })).filter(r => r.invDate);
    const intervalMonths = retDetectIntervalMonths(datedRows.map(r => r.invDate));

    const jobStartDateForOffset = retParseSheetDate(parentRow[37]);
    const invoiceTimingOffset = retDetectInvoiceTimingOffset_(datedRows.map(r => r.invDate), jobStartDateForOffset, intervalMonths);
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0;

    let matchedRow = null;
    let matchedRowPeriodStartVal = null;
    for (let i = datedRows.length - 1; i >= 0; i--) {
      const rowMonthVal = datedRows[i].invDate.getFullYear() * 12 + datedRows[i].invDate.getMonth() + timingMonthAdjust;
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

    const metaResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
    });
    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

    const freshValsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
    });
    let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshValsResp.data.values || []);

    if ((currentMaxRows - (trueLastRow + 1)) < 1) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: { requests: [{
          insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
        }] },
      });
      currentMaxRows += 5;
    }
    const newParentDestIdx0 = matchedRow.rowNum - 1;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: { requests: [{
        moveDimension: {
          source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: trueLastRow, endIndex: trueLastRow + 1 },
          destinationIndex: newParentDestIdx0,
        },
      }] },
    });
    const newParentRowNum = matchedRow.rowNum;

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const changeMonthLabel = `${months[changeMonth]} ${changeYear}`;
    const suffixPattern = /\s*\(\w{3} \d{4}-\)\s*$/;
    const baseJobName = jobName.replace(suffixPattern, "").trim();
    const newJobName = `${baseJobName} (${changeMonthLabel}-)`;

    const oldJobNewEndDate = new Date(changeYear, changeMonth, 0);
    const newJobStartDate = new Date(changeYear, changeMonth, 1);

    const copiedAE = parentRow.slice(0, 5);
    const copiedAGtoAM = parentRow.slice(32, 39);

    const writeData = [];
    const dateWriteData = [{ range: `Confirmed!AM${parentRowNum}`, values: [[retFmtDate(oldJobNewEndDate)]] }];

    for (let i = 0; i < copiedAE.length; i++) {
      const colLetter = ["A","B","C","D","E"][i];
      const val = (colLetter === "B") ? newJobName : (copiedAE[i] !== undefined ? copiedAE[i] : "");
      writeData.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[val]] });
    }
    const agToAmCols = ["AG","AH","AI","AJ","AK","AL","AM"];
    for (let i = 0; i < agToAmCols.length; i++) {
      const colLetter = agToAmCols[i];
      let val = copiedAGtoAM[i] !== undefined ? copiedAGtoAM[i] : "";
      if (colLetter === "AG") val = newMonthlyAmount;
      if (colLetter === "AH") val = retParseMoney(val);
      if (colLetter === "AL") val = retFmtDate(newJobStartDate);
      if (colLetter === "AM") val = oldEndDate ? retFmtDate(oldEndDate) : (copiedAGtoAM[i] || "");
      const target = (colLetter === "AL" || colLetter === "AM") ? dateWriteData : writeData;
      target.push({ range: `Confirmed!${colLetter}${newParentRowNum}`, values: [[val]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
    });
    if (dateWriteData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
      });
    }

    const relabelStartRow = matchedRow.rowNum + 1;
    const relabelRows = childRows.filter(cr => cr.rowNum >= matchedRow.rowNum).map(cr => cr.rowNum + 1);
    const newPerInvoiceAmount = newMonthlyAmount * (intervalMonths || 1);
    const relabelData = [];
    const relabelDateData = [];
    for (const rn of relabelRows) {
      relabelData.push({ range: `Confirmed!B${rn}`, values: [[newJobName]] });
      relabelData.push({ range: `Confirmed!AP${rn}`, values: [[newPerInvoiceAmount]] });
    }
    
    if (sourceInvoiceRef || sourceInvoiceSentDate) {
      relabelData.push({ range: `Confirmed!AQ${relabelStartRow}`, values: [[sourceInvoiceRef || ""]] });
      const parsedDaysToPay = parseInt(String(sourceInvoiceDaysToPay || "").replace(/[^\d.-]/g, ""), 10);
      relabelData.push({ range: `Confirmed!AS${relabelStartRow}`, values: [[!isNaN(parsedDaysToPay) && parsedDaysToPay > 0 ? parsedDaysToPay : 30]] });
      relabelData.push({ range: `Confirmed!AT${relabelStartRow}`, values: [[sourceInvoiceStatus || ""]] });
      if (sourceInvoiceSentDate) {
        const parsedSourceSent = retParseSheetDate(sourceInvoiceSentDate);
        if (parsedSourceSent) relabelDateData.push({ range: `Confirmed!AR${relabelStartRow}`, values: [[retFmtDate(parsedSourceSent)]] });
      }
    }
    if (relabelData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: relabelData } });
    }
    if (relabelDateData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: relabelDateData } });
    }

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
          if (String(next[0]||"").trim() === srcClient && String(next[1]||"").trim() === srcJobName &&
              !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
            srcRowsToClearOriginal.push(srcChildIdx + 1);
            srcChildIdx++;
          } else break;
        }
        const clearRanges = [];
        for (const originalRowNum of srcRowsToClearOriginal) {
          let adjustedRow = originalRowNum;
          const idx0Original = originalRowNum - 1;
          if (idx0Original >= newParentDestIdx0) adjustedRow += 1;
          clearRanges.push(
            `Confirmed!A${adjustedRow}:E${adjustedRow}`,
            `Confirmed!AG${adjustedRow}:AM${adjustedRow}`,
            `Confirmed!AP${adjustedRow}:BH${adjustedRow}`,
            `Confirmed!BX${adjustedRow}:CR${adjustedRow}`
          );
        }
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheetIdClean, requestBody: { ranges: clearRanges },
        });
      }
    }

    try {
      const oldJobLastChildBeforeSplit = childRows.filter(cr => cr.rowNum < matchedRow.rowNum);
      const newGroupStart = relabelRows.length > 0 ? relabelRows[0] : null;
      const newGroupEnd = relabelRows.length > 0 ? relabelRows[relabelRows.length - 1] : null;

      const freshGroupsResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean, fields: "sheets(properties.title,rowGroups)",
      });
      const freshConfirmedSheet = (freshGroupsResp.data.sheets || []).find(s => s.properties?.title === "Confirmed");
      const currentRowGroups = freshConfirmedSheet?.rowGroups || [];

      if (newGroupStart !== null) {
        const oldFirstChildRowNum = childRows.length > 0 ? childRows[0].rowNum : parentRowNum;
        const scanStartIdx0 = oldFirstChildRowNum - 1;
        const scanEndIdx0 = newGroupEnd;
        const overlappingGroups = currentRowGroups.filter(g =>
          g.range && g.range.startIndex < scanEndIdx0 && g.range.endIndex > scanStartIdx0
        );

        const deleteRequests = [];
        const addRequestsSequential = [];
        for (const g of overlappingGroups) {
          const spansSplitPoint = g.range.startIndex < (newParentRowNum - 1) && g.range.endIndex > (newParentRowNum - 1);
          if (!spansSplitPoint) continue;
          deleteRequests.push({ deleteDimensionGroup: { range: {
            sheetId: gridSheetId, dimension: "ROWS",
            startIndex: g.range.startIndex, endIndex: g.range.endIndex,
          } } });
          const keepEnd = Math.min(g.range.endIndex, newParentRowNum - 1);
          if (keepEnd > g.range.startIndex) {
            addRequestsSequential.push({ startIndex: g.range.startIndex, endIndex: keepEnd });
          }
        }
        addRequestsSequential.push({ startIndex: newGroupStart - 1, endIndex: newGroupEnd });

        if (deleteRequests.length > 0) {
          await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetIdClean, requestBody: { requests: deleteRequests } });
        }
        for (const r of addRequestsSequential) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: [{ addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: r.startIndex, endIndex: r.endIndex } } }] },
          });
        }
      }
    } catch (groupErr) {
      console.log(`  ⚠ Row grouping for retainer split failed`);
    }

    return res.status(200).json({ success: true, newParentRowNum, newJobName, relabelledRows: relabelRows.length });
  } catch (err) {
    console.error("❌ change_retainer_monthly_amount error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateRetainerJob(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, client, jobName, monthlyRevenue, monthlyDirectCosts,
    vat, startDate, endDate, invoiceFrequency, invoiceSendDay,
  } = req.body;
  if (!clientSheetId || !client || !jobName || !monthlyRevenue || !startDate || !endDate || !invoiceFrequency || !invoiceSendDay) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const intervalMonths = invoiceFrequency === "quarterly" ? 3 : 1;
    const start = retParseSheetDate(startDate);
    const end = retParseSheetDate(endDate);
    if (!start || !end) return res.status(400).json({ success: false, error: "Invalid start or end date" });
    if (end < start) return res.status(400).json({ success: false, error: "End date can't be before start date" });

    const sendDay = parseInt(invoiceSendDay, 10);
    if (!sendDay || sendDay < 1 || sendDay > 31) return res.status(400).json({ success: false, error: "Invalid invoice send day" });

    const revenue = parseFloat(monthlyRevenue) || 0;
    const directCosts = parseFloat(monthlyDirectCosts) || 0;
    const perInvoiceAmount = revenue * intervalMonths;

    const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
    const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

    const today = new Date(); today.setHours(0,0,0,0);
    const currentMonthVal = today.getFullYear() * 12 + today.getMonth();

    const periodStarts = [];
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonthVal = end.getFullYear() * 12 + end.getMonth();
    while (true) {
      const cursorMonthVal = cursor.getFullYear() * 12 + cursor.getMonth();
      if (cursorMonthVal > endMonthVal) break;
      periodStarts.push(new Date(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + intervalMonths, 1);
    }
    const pastCount = periodStarts.filter(d => (d.getFullYear()*12 + d.getMonth()) <= currentMonthVal).length;
    const targetPeriodCount = Math.min(periodStarts.length, pastCount + 18);

    if (targetPeriodCount === 0) return res.status(400).json({ success: false, error: "No invoice periods fall within dates." });

    const childSendDates = periodStarts.slice(0, targetPeriodCount).map(p => new Date(p.getFullYear(), p.getMonth(), sendDay));

    const metaResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
    });
    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

    const freshResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
    });
    let trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);

    const rowsNeeded = 1 + childSendDates.length;
    if ((currentMaxRows - (trueLastRow + 1)) < rowsNeeded) {
      const toAdd = rowsNeeded - (currentMaxRows - (trueLastRow + 1)) + 5;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: { requests: [{
          insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true },
        }] },
      });
      currentMaxRows += toAdd;
    }

    const newParentRowNum = trueLastRow + 1;
    const writeData = [
      { range: `Confirmed!A${newParentRowNum}`, values: [[client]] },
      { range: `Confirmed!B${newParentRowNum}`, values: [[jobName]] },
      { range: `Confirmed!AG${newParentRowNum}`, values: [[revenue]] },
      { range: `Confirmed!AH${newParentRowNum}`, values: [[directCosts]] },
      { range: `Confirmed!AI${newParentRowNum}`, values: [[vat || "No"]] },
      { range: `Confirmed!AJ${newParentRowNum}`, values: [["Retainer"]] },
    ];
    const dateWriteData = [
      { range: `Confirmed!AL${newParentRowNum}`, values: [[retFmtDate(start)]] },
      { range: `Confirmed!AM${newParentRowNum}`, values: [[retFmtDate(end)]] },
    ];

    for (let i = 0; i < childSendDates.length; i++) {
      const rn = newParentRowNum + 1 + i;
      writeData.push(
        { range: `Confirmed!A${rn}`, values: [[client]] },
        { range: `Confirmed!B${rn}`, values: [[jobName]] },
        { range: `Confirmed!AP${rn}`, values: [[perInvoiceAmount]] },
        { range: `Confirmed!AS${rn}`, values: [[defaultDaysToPay]] },
      );
      dateWriteData.push({ range: `Confirmed!AR${rn}`, values: [[retFmtDate(childSendDates[i])]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
    });

    if (childSendDates.length > 0) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            addDimensionGroup: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: newParentRowNum, endIndex: newParentRowNum + childSendDates.length } },
          }] },
        });
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for new retainer failed`);
      }
    }

    return res.status(200).json({ success: true, parentRowNum: newParentRowNum, childRowCount: childSendDates.length });
  } catch (err) {
    console.error("❌ create_retainer_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleTidyUpRetainers(req, res, sheets) {
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
      spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)"
    });
    const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
    if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
    const gridSheetId = confirmedSheet.properties.sheetId;
    let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

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
      const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
      const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
      const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
      if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
    }

    if (currentMaxRows - trueLastRow < 4) {
      const toAdd = 4 - (currentMaxRows - trueLastRow) + 5;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: { requests: [{
          insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + toAdd }, inheritFromBefore: true }
        }] }
      });
      currentMaxRows += toAdd;
    }

    const blocks = [];
    let r = 1; 
    let blockId = 0;
    const today = new Date(); today.setHours(0,0,0,0);

    const parseDateLocal = (val) => {
      if (!val) return null;
      if (typeof val === "number") return new Date((val - 25569) * 86400 * 1000);
      const s = String(val).trim();
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
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
      const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
      const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
      const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
      const hasData = z1 || z2 || z3 || z4;

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
        const endDate = parseDateLocal(row[38]);
        const isFinished = endDate && endDate < today;

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
          isFinished, client, jobName,
          size: cj - r, originalStartIdx: r
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

    let targetBlocks = [...filteredBaseBlocks];

    let finInsertIdx = finCluster ? getInsertIndex(finCluster) : 0;
    if (finishedRetainers.length > 0) {
        targetBlocks.splice(finInsertIdx, 0, spacers[0], ...finishedRetainers, spacers[1]);
    }

    let actInsertIdx;
    if (actCluster && actCluster !== finCluster) {
        const anchor = getAnchorBlock(actCluster);
        actInsertIdx = anchor ? targetBlocks.findIndex(b => b.id === anchor.id) + 1 : 0;
    } else {
        actInsertIdx = finishedRetainers.length > 0 ? targetBlocks.findIndex(b => b.id === spacers[1].id) + 1 : finInsertIdx;
    }

    if (activeRetainers.length > 0) {
        targetBlocks.splice(actInsertIdx, 0, spacers[2], ...activeRetainers, spacers[3]);
    }

    if (extraneousBlanks.length > 0) {
        targetBlocks.push(...extraneousBlanks);
    }

    let currentState = [...initialSheetState];
    const blockSizes = {};
    for (const b of currentState) blockSizes[b.id] = b.size;

    const getAbsoluteIndex = (state, index) => {
        let sum = 1; 
        for (let i = 0; i < index; i++) sum += blockSizes[state[i].id];
        return sum;
    };

    const moveRequests = [];

    for (let i = 0; i < targetBlocks.length; i++) {
        const targetBlock = targetBlocks[i];
        const currIdx = currentState.findIndex(b => b.id === targetBlock.id);

        if (currIdx > i) {
            const startIndex = getAbsoluteIndex(currentState, currIdx);
            const endIndex = startIndex + blockSizes[targetBlock.id];
            const destinationIndex = getAbsoluteIndex(currentState, i);

            moveRequests.push({
                moveDimension: {
                    source: { sheetId: gridSheetId, dimension: "ROWS", startIndex, endIndex },
                    destinationIndex
                }
            });

            const [moved] = currentState.splice(currIdx, 1);
            currentState.splice(i, 0, moved);
        }
    }

    if (moveRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: { requests: moveRequests }
        });
    }

    return res.status(200).json({ success: true, moves: moveRequests.length });

  } catch (err) {
    console.error("❌ tidy_up_retainers error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleComputeRetainerAlertResolution(req, res, sheets) {
  const { clientSheetId, masterSheetId, client, jobName, parentRowNum, resolutionType,
    lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo, possibleMatchConfirmedRow } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || !resolutionType) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }

    const jobStartDate = retParseSheetDate(parentRow[37]);

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
          !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
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
    const timingMonthAdjust = invoiceTimingOffset === "before" ? 1 : 0;

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    if (resolutionType === "end") {
      const lastSent = retParseSheetDate(lastInvoiceDate);
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
          ? `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal/12)} to ${months[coveredPeriodEndVal % 12]} ${endYear}`
          : `${months[coveredPeriodStartVal % 12]} ${Math.floor(coveredPeriodStartVal/12)}`,
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
              if (String(next[0]||"").trim() === String(srcRow[0]||"").trim() && String(next[1]||"").trim() === String(srcRow[1]||"").trim() &&
                  !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
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
  const { clientSheetId, client, jobName, parentRowNum,
    lastInvoiceDate, possibleMatchSentDate, possibleMatchAmount, possibleMatchInvoiceNo,
    possibleMatchVatAmount, possibleMatchStatus, possibleMatchConfirmedRow } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || !lastInvoiceDate || !possibleMatchSentDate || possibleMatchAmount === undefined) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }

    const standardMonthlyAmount = retParseMoney(parentRow[32]); 
    const altAmount = parseFloat(possibleMatchAmount) || 0;
    const altSentDate = retParseSheetDate(possibleMatchSentDate);
    const lastSent = retParseSheetDate(lastInvoiceDate);
    if (!altSentDate || !lastSent) return res.status(400).json({ success: false, error: "Could not parse invoice dates." });

    const childRows = [];
    let cj = parentRowNum;
    while (cj < rows.length) {
      const next = rows[cj] || [];
      if (String(next[0]||"").trim() === client && String(next[1]||"").trim() === jobName &&
          !String(next[32]||"").trim() && !String(next[37]||"").trim()) {
        childRows.push({ rowNum: cj + 1, row: next });
        cj++;
      } else break;
    }
    const missingRow = childRows
      .map(cr => ({ ...cr, invDate: retParseSheetDate(cr.row[43]) }))
      .filter(cr => cr.invDate && cr.invDate.getTime() > lastSent.getTime())
      .sort((a, b) => a.invDate.getTime() - b.invDate.getTime())[0];

    if (!missingRow) return res.status(400).json({ success: false, error: "Could not find the missing invoice's row." });

    const difference = altAmount - standardMonthlyAmount;
    const vatAmount = parseFloat(possibleMatchVatAmount) || 0;

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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
    });
  } catch (err) {
    console.error("❌ compute_retainer_split_invoice_preview error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleApplyRetainerSplitInvoice(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, client, jobName, parentRowNum, missingRowNum,
    standardMonthlyAmount, altAmount, altSentDate, altInvoiceNo, altStatus, vatAmount, difference,
    extraJobName, extraJobMonth, extraJobYear, existingConfirmedRow,
  } = req.body;
  if (!clientSheetId || !jobName || !parentRowNum || !missingRowNum || difference === undefined) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    const parentRow = rows[parentRowNum - 1] || [];
    if (String(parentRow[0]||"").trim() !== client || String(parentRow[1]||"").trim() !== jobName) {
      return res.status(400).json({ success: false, error: "Row mismatch" });
    }

    const { defaultDaysToPay: rawDefaultDaysToPay } = await getToleranceValues(sheets, masterSheetId || sheetIdClean);
    const defaultDaysToPay = parseInt(String(rawDefaultDaysToPay).replace(/[^\d.-]/g, ""), 10) || 30;

    const writeData = [
      { range: `Confirmed!AP${missingRowNum}`, values: [[standardMonthlyAmount]] },
      { range: `Confirmed!AQ${missingRowNum}`, values: [[altInvoiceNo || ""]] },
      { range: `Confirmed!AS${missingRowNum}`, values: [[defaultDaysToPay]] },
      { range: `Confirmed!AT${missingRowNum}`, values: [[altStatus || ""]] },
    ];
    const dateWriteData = [];
    const parsedAltSentDate = retParseSheetDate(altSentDate);
    if (parsedAltSentDate) dateWriteData.push({ range: `Confirmed!AR${missingRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: writeData },
    });
    if (dateWriteData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
      });
    }

    const monthStart = new Date(extraJobYear, extraJobMonth, 1);
    const monthEnd = new Date(extraJobYear, extraJobMonth + 1, 0);
    const vatYesNo = (parseFloat(vatAmount) || 0) > 0 ? "Yes" : "No";

    if (existingConfirmedRow) {
      const extraWriteData = [
        { range: `Confirmed!B${existingConfirmedRow}`, values: [[extraJobName]] },
        { range: `Confirmed!D${existingConfirmedRow}`, values: [[parentRow[3] || ""]] },   
        { range: `Confirmed!E${existingConfirmedRow}`, values: [[parentRow[4] || ""]] },   
        { range: `Confirmed!AG${existingConfirmedRow}`, values: [[difference]] },
        { range: `Confirmed!AJ${existingConfirmedRow}`, values: [["Retainer"]] },
        { range: `Confirmed!AK${existingConfirmedRow}`, values: [[parentRow[36] || ""]] },  
        { range: `Confirmed!AP${existingConfirmedRow}`, values: [[difference]] },
      ];
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: extraWriteData },
      });
      return res.status(200).json({ success: true, mode: "converted", extraJobRow: existingConfirmedRow });
    } else {
      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean, fields: "sheets(properties.sheetId,properties.title,properties.gridProperties)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      const gridSheetId = confirmedSheet.properties.sheetId;
      let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;

      const freshResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean, range: "Confirmed!A1:CR" + currentMaxRows, valueRenderOption: "UNFORMATTED_VALUE",
      });
      const trueLastRow = await retFindTrueLastRow(sheets, sheetIdClean, freshResp.data.values || []);
      const newRowNum = trueLastRow + 1;

      if ((currentMaxRows - (trueLastRow + 1)) < 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: { requests: [{
            insertDimension: { range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 }, inheritFromBefore: true },
          }] },
        });
      }

      const newWriteData = [
        { range: `Confirmed!A${newRowNum}`, values: [[client]] },
        { range: `Confirmed!B${newRowNum}`, values: [[extraJobName]] },
        { range: `Confirmed!D${newRowNum}`, values: [[parentRow[3] || ""]] },   
        { range: `Confirmed!E${newRowNum}`, values: [[parentRow[4] || ""]] },   
        { range: `Confirmed!AG${newRowNum}`, values: [[difference]] },
        { range: `Confirmed!AI${newRowNum}`, values: [[vatYesNo]] },
        { range: `Confirmed!AJ${newRowNum}`, values: [["Retainer"]] },
        { range: `Confirmed!AK${newRowNum}`, values: [[parentRow[36] || ""]] },  
        { range: `Confirmed!AP${newRowNum}`, values: [[difference]] },
        { range: `Confirmed!AQ${newRowNum}`, values: [[altInvoiceNo || ""]] },
        { range: `Confirmed!AS${newRowNum}`, values: [[defaultDaysToPay]] },
        { range: `Confirmed!AT${newRowNum}`, values: [[altStatus || ""]] },
      ];
      const newDateWriteData = [
        { range: `Confirmed!AL${newRowNum}`, values: [[retFmtDate(monthStart)]] },
        { range: `Confirmed!AM${newRowNum}`, values: [[retFmtDate(monthEnd)]] },
      ];
      if (parsedAltSentDate) newDateWriteData.push({ range: `Confirmed!AR${newRowNum}`, values: [[retFmtDate(parsedAltSentDate)]] });

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "RAW", data: newWriteData },
      });
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: newDateWriteData },
      });
      return res.status(200).json({ success: true, mode: "created", extraJobRow: newRowNum });
    }
  } catch (err) {
    console.error("❌ apply_retainer_split_invoice error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}