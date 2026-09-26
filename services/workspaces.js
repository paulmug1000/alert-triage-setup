import { getSheetsClient, withRetry, extractSheetIdFromUrl, colLetterToNum, colIndexToLetter, getSheetGid, getSheetId } from "./sheetsClient";
import { setMasterSwitch, checkAllGASLocks, fetchJobRowsForDisplay } from "./sharedHelpers";
import { logPmaActivity, DEFAULT_AC_SHEET_ID } from "./pmaLogger";
import { isPlaceholderInvoice } from "../utils/helpers";

export let assignedExpensesTabVerified = false;

export async function ensureAssignedExpensesTab_(sheets, spreadsheetId) {
  return;
}

const clientSheetIdToNameCache = new Map();

export async function resolveClientNameBySheetId(sheets, sheetId, acId = DEFAULT_AC_SHEET_ID) {
  if (!sheetId) return "";
  const cleanId = extractSheetIdFromUrl(sheetId) || sheetId;
  if (clientSheetIdToNameCache.has(cleanId)) {
    return clientSheetIdToNameCache.get(cleanId);
  }
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId || DEFAULT_AC_SHEET_ID,
        range: "AutoUpdates!A2:L70"
      })
    );
    const rows = resp.data.values || [];
    for (const r of rows) {
      const cName = String(r[0] || "").trim();
      const clientUrl = String(r[11] || "").trim();
      const masterUrl = String(r[12] || "").trim();
      const cId = extractSheetIdFromUrl(clientUrl) || clientUrl;
      const mId = extractSheetIdFromUrl(masterUrl) || masterUrl;
      if (cId && cName) clientSheetIdToNameCache.set(cId, cName);
      if (mId && cName) clientSheetIdToNameCache.set(mId, cName);
      if ((cId === cleanId || mId === cleanId) && cName) {
        return cName;
      }
    }
  } catch (err) {
    console.warn("⚠️ Error resolving clientName by sheetId:", err.message);
  }
  return "";
}

export async function handleGetAllClients(req, res, sheets) {
  const { automationCommanderSheetId } = req.body;
  if (!automationCommanderSheetId) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  }
  try {
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: "AutoUpdates!A2:DB500",
    }));
    const rows = resp.data.values || [];
    const clientsArray = [];
    const clientsObj = {};
    for (const row of rows) {
      const clientName = String(row[0] || "").trim();
      const scriptId   = String(row[10] || "").trim();
      const clientSheetUrl = row[11];
      const masterSheetUrl = row[12];
      const hasWebAppUrl = !!String(row[13] || "").trim();
      const splitEnabled = String(row[104] || "").trim().toLowerCase() === "yes";
      if (!clientName || !clientSheetUrl) continue;
      if (clientName.toLowerCase() === "client" || clientName.toLowerCase() === "client name") continue;
      const clientSheetId = extractSheetIdFromUrl(clientSheetUrl) || String(clientSheetUrl).trim();
      const masterSheetId = extractSheetIdFromUrl(masterSheetUrl) || String(masterSheetUrl || "").trim();
      clientsArray.push({ clientName, clientSheetId, masterSheetId, scriptId, hasWebAppUrl, splitEnabled });
      if (clientSheetId || masterSheetId) clientsObj[clientName] = { clientSheetId, masterSheetId, scriptId, hasWebAppUrl };
    }
    clientsArray.sort((a, b) => a.clientName.localeCompare(b.clientName));
    return res.status(200).json({ success: true, clients: clientsArray, clientsMap: clientsObj });
  } catch (err) {
    console.error("❌ get_all_clients error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAssignedExpenses(req, res, sheets) {
  const { automationCommanderSheetId: aeAcId } = req.body;
  if (!aeAcId) return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId" });
  try {
    await ensureAssignedExpensesTab_(sheets, aeAcId);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" }));
    const assignedByClient = {};
    (resp.data.values || []).forEach(r => {
      if (!r[0] || !r[1]) return;
      if (!assignedByClient[r[0]]) assignedByClient[r[0]] = [];
      assignedByClient[r[0]].push(r[1]);
    });
    return res.status(200).json({ success: true, assignedByClient });
  } catch (err) {
    console.error("❌ get_assigned_expenses error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleMarkExpenseAssigned(req, res, sheets) {
  const { automationCommanderSheetId: aeAcId, clientName: aeClientName, appId: aeAppId } = req.body;
  if (!aeAcId || !aeClientName || !aeAppId) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or appId" });
  }
  try {
    await ensureAssignedExpensesTab_(sheets, aeAcId);
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: aeAcId, range: "AssignedExpenses!A:C", valueInputOption: "RAW",
      requestBody: { values: [[aeClientName, aeAppId, new Date().toISOString()]] },
    }));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ mark_expense_assigned error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handlePruneAssignedExpenses(req, res, sheets) {
  const { automationCommanderSheetId: aeAcId, clientName: aeClientName, validAppIds } = req.body;
  if (!aeAcId || !aeClientName || !Array.isArray(validAppIds)) {
    return res.status(400).json({ success: false, error: "Missing automationCommanderSheetId, clientName, or validAppIds" });
  }
  try {
    await ensureAssignedExpensesTab_(sheets, aeAcId);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: aeAcId, range: "AssignedExpenses!A2:C50000" });
    const rows = resp.data.values || [];
    const validSet = new Set(validAppIds);
    const keptRows = rows.filter(r => !(r[0] === aeClientName) || validSet.has(r[1]));
    if (keptRows.length !== rows.length) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: aeAcId, range: `AssignedExpenses!A2:C${rows.length + 1}` });
      if (keptRows.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: aeAcId, range: "AssignedExpenses!A2", valueInputOption: "RAW", requestBody: { values: keptRows },
        });
      }
    }
    return res.status(200).json({ success: true, removed: rows.length - keptRows.length });
  } catch (err) {
    console.error("❌ prune_assigned_expenses error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetOutgoingsInbox(req, res, sheets) {
  const { masterSheetId, clientSheetId } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;
    const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
    const expLock = allLocks.expense;
    if (expLock.locked) {
      return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Expense automation is currently running — try again in a moment" });
    }

    await setMasterSwitch(sheets, sheetIdClean, "DirComp", true);
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "DirComp!A6:AV1000",
    });
    await setMasterSwitch(sheets, sheetIdClean, "DirComp", false);

    const rows = dataResp.data.values || [];
    const inbox = [];
    let skippedNoFlag = 0, skippedNoAppId = 0;
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const rawFlag = String(row[40] || "").trim();
      const isMissing = rawFlag === "1";
      if (!isMissing) { skippedNoFlag++; continue; }

      const date        = String(row[0] || "").trim();
      const description = String(row[1] || "").trim();
      const amount      = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const reference   = String(row[3] || "").trim();
      const accountName = String(row[4] || "").trim();
      const status      = String(row[5] || "").trim();
      const appId       = String(row[6] || "").trim();
      const datePaid    = String(row[7] || "").trim();
      const vatAmount   = parseFloat(String(row[8] || "0").replace(/[£$€,]/g, "")) || 0;

      if (!appId) { skippedNoAppId++; continue; }
      inbox.push({ appId, amount, date, description, reference, accountName, status, datePaid, vatAmount });
    }

    return res.status(200).json({ success: true, inbox });
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "DirComp", false); } catch(e) {}
    console.error("❌ get_outgoings_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoicesInbox(req, res, sheets) {
  const { masterSheetId, clientSheetId } = req.body;
  const sheetId = masterSheetId || clientSheetId;
  if (!sheetId) return res.status(400).json({ success: false, error: "Missing masterSheetId or clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(sheetId) || sheetId;

    const allLocks = await checkAllGASLocks(sheets, sheetIdClean);
    const invLock = allLocks.invoice;
    if (invLock.locked) {
      return res.status(200).json({ success: true, inbox: [], locked: true, lockMessage: "Invoice automation is currently running — try again in a moment" });
    }

    await setMasterSwitch(sheets, sheetIdClean, "InvComp", true);
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "InvComp!A6:Y1000",
    });
    await setMasterSwitch(sheets, sheetIdClean, "InvComp", false);

    const rows = dataResp.data.values || [];
    const inbox = [];
    let skippedNoFlag = 0, skippedNoInvNo = 0;
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const isMissing = String(row[18] || "").trim() === "1";
      if (!isMissing) { skippedNoFlag++; continue; }

      const client       = String(row[0] || "").trim();
      const job          = String(row[1] || "").trim();
      const invoiceAmt   = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
      const totalExclVAT = parseFloat(String(row[3] || "0").replace(/,/g, "")) || 0;
      const vatIncluded  = parseFloat(String(row[4] || "0").replace(/,/g, "")) || 0;
      const invoiceNo    = String(row[5] || "").trim();
      
      const fmtDate = (dStr) => {
        if (!dStr) return "";
        const nativeParsed = new Date(dStr);
        let d = null;
        if (!isNaN(nativeParsed.getTime())) d = nativeParsed;
        else {
          const MONTHS_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
          const parts = String(dStr).split(/[-\/]/);
          if (parts.length === 3) {
            const mNum = MONTHS_MAP[parts[1]?.toLowerCase()?.substring(0,3)];
            if (mNum !== undefined) {
              const yr = parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
              d = new Date(yr, mNum, parseInt(parts[0]));
            }
          }
        }
        if (!d) return String(dStr).trim();
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      };
      
      const sentDate     = fmtDate(row[6]);
      const dueDate      = fmtDate(row[7]);
      const fullyPaidOn  = fmtDate(row[8]);
      const status       = String(row[9] || "").trim();
      const currency     = String(row[10] || "").trim() || "GBP";

      if (!invoiceNo) { skippedNoInvNo++; continue; }
      inbox.push({
        invoiceNo, client, job, currency, sentDate, dueDate, fullyPaidOn, status,
        amount: totalExclVAT > 0 ? totalExclVAT : invoiceAmt,
        grossAmount: invoiceAmt, vatAmount: vatIncluded,
      });
    }

    return res.status(200).json({ success: true, inbox });
  } catch (err) {
    try { await setMasterSwitch(sheets, extractSheetIdFromUrl(req.body.masterSheetId || req.body.clientSheetId) || req.body.masterSheetId || req.body.clientSheetId, "InvComp", false); } catch(e) {}
    console.error("❌ get_invoices_inbox error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateOutgoingsVendor(req, res, sheets) {
  const { clientSheetId, vendorName, vatFlag, invTiming, payTiming, deliveryPct } = req.body;
  if (!clientSheetId || !vendorName) return res.status(400).json({ success: false, error: "Missing clientSheetId or vendorName" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const checkResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Outgoings!A13:A110",
    });
    const rows = checkResp.data.values || [];
    let lastRow = 12;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.[0]) { lastRow = 12 + i; break; }
    }
    const newRow = lastRow + 2;
    if (newRow > 110) return res.status(400).json({ success: false, error: "Contractors section is full (max row 110)" });

    const pctValue = deliveryPct !== undefined && deliveryPct !== "" ? String(deliveryPct).replace(/%/g, "") : "100";
    const pctString = `${pctValue}%`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `Outgoings!A${newRow}:E${newRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[vendorName, vatFlag || "Yes", invTiming || "Next", payTiming || "Next", pctString]] },
    });

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: "Vendor Created",
      summary: `Created new contractor/vendor '${vendorName}' for ${tenantClient || "Client"} (Row ${newRow})`,
      details: {
        vendorName,
        vatFlag: vatFlag || "Yes",
        invTiming: invTiming || "Next",
        payTiming: payTiming || "Next",
        deliveryPct: pctString,
        row: newRow,
        clientName: tenantClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, sheetRow: newRow });
  } catch (err) {
    console.error("❌ create_outgoings_vendor error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetOutgoings(req, res, sheets) {
  const { clientSheetId } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const gridResp = await sheets.spreadsheets.get({
      spreadsheetId: sheetIdClean,
      ranges: ["Outgoings!A1:BG1", "Outgoings!A13:BG110"],
      includeGridData: true,
      fields: "sheets.data.rowData.values(formattedValue,note,effectiveValue)",
    });

    const sheetGrids = gridResp.data.sheets?.[0]?.data || [];
    const headerGridData = sheetGrids[0];
    const contractorGridData = sheetGrids[1];

    const headerCells = headerGridData?.rowData?.[0]?.values || [];
    const contractorRows = contractorGridData?.rowData || [];

    const SHEET_EPOCH = new Date(1899, 11, 30);
    const months = [];
    for (let i = 6; i < headerCells.length; i++) {
      const cell = headerCells[i];
      if (!cell) continue;
      const fv = cell.formattedValue || "";
      const ev = cell.effectiveValue;

      if (fv.toLowerCase().includes("total") || fv.toLowerCase().includes("fy")) continue;

      let dateObj = null;
      if (ev?.numberValue) {
        const d = new Date(SHEET_EPOCH.getTime() + ev.numberValue * 86400000);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }
      if (!dateObj && fv) {
        const d = new Date(fv);
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020) dateObj = d;
      }

      if (dateObj) {
        const label = dateObj.toLocaleString("en-GB", { month: "short", year: "2-digit" });
        const isoMonth = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
        months.push({ colIndex: i, colLetter: colIndexToLetter(i + 1), label, isoMonth, dateObj: dateObj.toISOString() });
      }
    }

    const parseNoteBlocks = (note) => {
      if (!note) return [];
      const blocks = [];
      const blockRegex = /\{App ID:\s*([^}]+)\}\{Amt:\s*([^}]+)\}(?:\{Status:\s*([^}]*)\})?(?:\{Rec date:\s*([^}]*)\})?(?:\{Pay date:\s*([^}]*)\})?(?:\{Description:\s*([^}]*)\})?/g;
      let match;
      while ((match = blockRegex.exec(note)) !== null) {
        blocks.push({
          appId:       match[1]?.trim() || "",
          amount:      parseFloat(String(match[2] || "").replace(/[£$€,\s]/g, "")) || 0,
          status:      match[3]?.trim() || "",
          recDate:     match[4]?.trim() || "",
          payDate:     match[5]?.trim() || "",
          description: match[6]?.trim() || "",
        });
      }
      return blocks;
    };

    const contractors = [];
    for (let r = 0; r < contractorRows.length; r++) {
      const rowCells = contractorRows[r]?.values || [];
      const name = String(rowCells[0]?.formattedValue || "").trim();
      if (!name) continue;
      if (name.toLowerCase() === "contractors" || name.startsWith("Total") || name.startsWith("=")) continue;

      const vatFlag   = String(rowCells[1]?.formattedValue || "").trim();
      const invTiming = String(rowCells[2]?.formattedValue || "").trim();
      const payTiming = String(rowCells[3]?.formattedValue || "").trim();

      const cells = {};
      for (const month of months) {
        const cellData = rowCells[month.colIndex];
        const note = cellData?.note || "";
        const value = cellData?.formattedValue || "";
        cells[month.colLetter] = { value, note, blocks: parseNoteBlocks(note) };
      }

      contractors.push({ sheetRow: 13 + r, name, vatFlag, invTiming, payTiming, cells });
    }

    return res.status(200).json({ success: true, contractors, months });
  } catch (err) {
    console.error("❌ get_outgoings error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetDirectCostsJobs(req, res, sheets) {
  const { clientSheetId, showAll } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: null, copiedToConf: null,
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
          transactionId: colVal(row,base+6), highlighted: false };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const budgetNum = parseFloat(String(row[33]||"").replace(/[£$€,\s]/g,"")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0]||"").trim();
        const nj = String(next[1]||"").trim();
        const nRevenue = String(next[32]||"").trim();
        const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
        const nStart = String(next[37]||"").trim();
        if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
          jobRows.push(buildRowData(cj + 1, next, false));
          cj++;
        } else {
          break;
        }
      }
      ri = cj;

      const startDate = parseSheetDate(row[37]);
      const passesFilter = showAll || (budgetNum > 0 && startDate && startDate >= sixMonthsAgo);
      if (passesFilter) {
        jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows });
      }
    }

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    return res.status(200).json({ success: true, jobs });
  } catch (err) {
    console.error("❌ get_direct_costs_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetInvoiceJobs(req, res, sheets) {
  const { clientSheetId, showAll } = req.body;
  if (!clientSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: null, copiedToConf: null,
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
          transactionId: colVal(row,base+6), highlighted: false };
      }),
    });

    const jobs = [];
    let ri = 1;
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      const revenueNum = parseFloat(String(row[32]||"").replace(/[£$€,\s]/g,"")) || 0;
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0]||"").trim();
        const nj = String(next[1]||"").trim();
        const nRevenue = String(next[32]||"").trim();
        const nBudget = parseFloat(String(next[33]||"").replace(/[£$€,\s]/g,"")) || 0;
        const nStart = String(next[37]||"").trim();
        if (nc === client && nj === jobName && !nRevenue && !nBudget && !nStart) {
          jobRows.push(buildRowData(cj + 1, next, false));
          cj++;
        } else {
          break;
        }
      }
      ri = cj;

      let realInvoicedTotal = 0;
      for (const jr of jobRows) {
        for (const slot of jr.invoiceSlots) {
          const ref = String(slot.ref || "").trim();
          const isReal = ref && !isPlaceholderInvoice(ref);
          if (isReal) realInvoicedTotal += parseFloat(String(slot.amount||"").replace(/[£$€,\s]/g,"")) || 0;
        }
      }
      const uninvoicedAmount = revenueNum - realInvoicedTotal;
      const passesFilter = showAll || uninvoicedAmount > 0;
      if (passesFilter) {
        jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows, uninvoicedAmount });
      }
    }

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    return res.status(200).json({ success: true, jobs });
  } catch (err) {
    console.error("❌ get_invoice_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleGetAllClientJobs(req, res, sheets) {
  const { clientSheetId, tabName } = req.body;
  if (!clientSheetId || !tabName) return res.status(400).json({ success: false, error: "Missing clientSheetId or tabName" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: `${tabName}!A1:DD5000`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = (rowNum, row, isParent) => ({
      rowNum, isParent,
      client: colVal(row, 0), jobName: colVal(row, 1), projectCode: colVal(row, 2),
      dateConf: colVal(row, 3), 
      leadSrc: colVal(row, 4), 
      unevenSplit: colVal(row, 30), 
      revenue: colVal(row, 32), directCosts: colVal(row, 33), vat: colVal(row, 34),
      projectRetainer: colVal(row, 35), prodLine: colVal(row, 36), 
      startDate: colVal(row, 37), endDate: colVal(row, 38),
      likelihood: tabName === "Pipeline" ? colVal(row, 39) : null,
      copiedToConf: tabName === "Pipeline" ? colVal(row, 107) : null,
      leftToInvoice: colVal(row, 74), 
      costsOutstanding: colVal(row, 106), 
      invoiceSlots: [1,2,3].map(n => {
        const base = n === 1 ? 41 : n === 2 ? 48 : 55;
        return { slotNum: n, amount: colVal(row,base), ref: colVal(row,base+1), sentDate: colVal(row,base+2),
          daysToPay: colVal(row,base+3), status: colVal(row,base+4), highlighted: false };
      }),
      expenseSlots: [1,2,3].map(n => {
        const base = n === 1 ? 75 : n === 2 ? 82 : 89;
        return { slotNum: n, description: colVal(row,base), amount: colVal(row,base+1), vat: colVal(row,base+2),
          date: colVal(row,base+3), daysToPay: colVal(row,base+4), status: colVal(row,base+5),
          transactionId: colVal(row,base+6), highlighted: false };
      }),
    });

    const jobs = [];
    let ri = tabName === "Pipeline" ? 5 : 1; 
    while (ri < rows.length) {
      const row = rows[ri] || [];
      const client = String(row[0] || "").trim();
      const jobName = String(row[1] || "").trim();
      if (!client && !jobName) { ri++; continue; }

      const parentRowNum = ri + 1;
      const jobRows = [buildRowData(parentRowNum, row, true)];
      let cj = ri + 1;
      while (cj < rows.length) {
        const next = rows[cj] || [];
        const nc = String(next[0]||"").trim();
        const nj = String(next[1]||"").trim();
        const nRevenue = String(next[32]||"").trim();
        const nStart = String(next[37]||"").trim();
        if (nc === client && nj === jobName && !nRevenue && !nStart) {
          jobRows.push(buildRowData(cj + 1, next, false));
          cj++;
        } else {
          break;
        }
      }
      ri = cj;
      
      jobs.push({ client, jobName, projectCode: row[2] || "", rows: jobRows });
    }

    const parseSheetDate = (d) => {
      if (!d) return null;
      const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
      if (!m) return null;
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx === undefined) return null;
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
      return new Date(yr, mIdx, parseInt(m[1]));
    };

    jobs.sort((a, b) => {
      const da = parseSheetDate(a.rows[0]?.startDate);
      const db = parseSheetDate(b.rows[0]?.startDate);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da;
    });

    return res.status(200).json({ success: true, jobs });
  } catch (err) {
    console.error("❌ get_all_client_jobs error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateJobField(req, res, sheets) {
  const { clientSheetId, tabName, cellRef, value, colLetter, rowNum, fieldName, endClientName, jobName } = req.body;
  if (!clientSheetId || !tabName || !cellRef) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: `${tabName}!${cellRef}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] }
    });

    const targetCol = (colLetter || cellRef.replace(/[0-9]/g, "")).toUpperCase();
    const targetRow = rowNum || cellRef.replace(/[^0-9]/g, "");

    const FIELD_NAMES = {
      A: "Client",
      B: "Job Name",
      C: "Project Code",
      D: "Date Confirmed",
      E: "Lead Source",
      AE: "Revenue Split",
      AG: "Revenue",
      AH: "Direct Costs",
      AI: "VAT",
      AJ: "Type",
      AK: "Product Line",
      AL: "Start Date",
      AM: "End Date",
      AN: "Likelihood",
      DD: "Copied to Confirmed"
    };
    const resolvedFieldName = fieldName || FIELD_NAMES[targetCol] || `Field ${targetCol}`;

    // Resolve clientName (the Pulse tenant, e.g. "Ayefour Design")
    let resolvedClient = req.body.clientName || "";
    if (!resolvedClient) {
      resolvedClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }

    // Resolve endClient and jobName
    let resolvedEndClient = endClientName || "";
    let resolvedJobName = jobName || "";

    if ((!resolvedEndClient || !resolvedJobName) && targetRow) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `${tabName}!A${targetRow}:B${targetRow}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!resolvedEndClient && rowVals[0]) resolvedEndClient = String(rowVals[0]).trim();
        if (!resolvedJobName && rowVals[1]) resolvedJobName = String(rowVals[1]).trim();
      } catch (nameErr) {
        console.warn("⚠️ Could not read job row identity:", nameErr.message);
      }
    }

    // If the edit itself changed column A (End Client) or B (Job Name), reflect the new value
    if (targetCol === "A" && value) resolvedEndClient = value;
    if (targetCol === "B" && value) resolvedJobName = value;

    let jobIdentifier = "";
    if (resolvedEndClient && resolvedJobName) {
      jobIdentifier = `"${resolvedEndClient} - ${resolvedJobName}"`;
    } else if (resolvedJobName) {
      jobIdentifier = `"${resolvedJobName}"`;
    } else if (resolvedEndClient) {
      jobIdentifier = `"${resolvedEndClient}"`;
    } else {
      jobIdentifier = `Row ${targetRow || cellRef}`;
    }

    const valStr = value !== "" && value !== null && value !== undefined ? ` to "${value}"` : " (cleared)";
    const summary = `Updated ${resolvedFieldName} for ${jobIdentifier}${valStr}`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: resolvedClient,
      category: "JOB",
      action: `Job ${resolvedFieldName} Updated`,
      summary,
      details: {
        tabName,
        cellRef,
        field: resolvedFieldName,
        endClient: resolvedEndClient,
        jobName: resolvedJobName,
        newValue: value,
        clientName: resolvedClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ update_job_field error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAssignExpenseToJob(req, res, sheets) {
  const { clientSheetId, masterSheetId, rowNum, slotNum, expense, createNewRow, jobLastRow, jobClient, jobName } = req.body;
  if (!clientSheetId || !expense) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or expense" });
  }
  if (!createNewRow && (!rowNum || !slotNum)) {
    return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
  }
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    };

    const vatAmountRaw = parseFloat(String(expense.vatAmount || "0").replace(/[£$€,]/g, "")) || 0;
    const vatYesNo = vatAmountRaw > 0 ? "Yes" : "No";

    let targetRowNum = rowNum;
    let targetSlotNum = slotNum;

    if (createNewRow) {
      if (!jobLastRow) return res.status(400).json({ success: false, error: "Missing jobLastRow for createNewRow" });

      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
      const gridSheetId = confirmedSheet.properties.sheetId;
      const currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
      const existingRowGroups = confirmedSheet.rowGroups || [];

      const fullResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR" + currentMaxRows,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const allRows = fullResp.data.values || [];
      let trueLastRow = 0;
      for (let r = allRows.length - 1; r >= 0; r--) {
        const row = allRows[r] || [];
        const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
        const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
        const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
        const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
        if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
      }

      const jobVAT = allRows[jobLastRow - 1]?.[34] ?? "";

      if (currentMaxRows - (trueLastRow + 1) < 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            requests: [{
              insertDimension: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
                inheritFromBefore: true,
              },
            }],
          },
        });
      }

      const sourceRowIndex0 = trueLastRow; 
      const destRowIndex0 = jobLastRow;    

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
              destinationIndex: destRowIndex0,
            },
          }],
        },
      });

      targetRowNum = jobLastRow + 1; 
      targetSlotNum = 1; 

      try {
        const destRowIndex1based0 = jobLastRow; 
        const coveringGroup = existingRowGroups.find(g =>
          g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
        );
        if (coveringGroup) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [
                { deleteDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                  } } },
                { addDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex + 1,
                  } } },
              ],
            },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [{
                addDimensionGroup: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
                },
              }],
            },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for new child row failed (non-fatal): ${groupErr.message}`);
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `Confirmed!A${targetRowNum}`, values: [[jobClient || ""]] },
            { range: `Confirmed!B${targetRowNum}`, values: [[jobName || ""]] },
            { range: `Confirmed!AI${targetRowNum}`, values: [[jobVAT]] },
          ],
        },
      });
    }

    const slotColsForSlot = slotCols[targetSlotNum];
    if (!slotColsForSlot) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!${slotColsForSlot.d}${targetRowNum}`,  values: [[expense.description || expense.accountName || ""]] },
          { range: `Confirmed!${slotColsForSlot.a}${targetRowNum}`,  values: [[expense.amount || 0]] },
          { range: `Confirmed!${slotColsForSlot.v}${targetRowNum}`,  values: [[vatYesNo]] },
          { range: `Confirmed!${slotColsForSlot.dp}${targetRowNum}`, values: [[30]] },
          { range: `Confirmed!${slotColsForSlot.st}${targetRowNum}`, values: [[expense.status || ""]] },
          { range: `Confirmed!${slotColsForSlot.id}${targetRowNum}`, values: [[expense.appId || ""]] },
        ],
      },
    });

    if (expense.date) {
      const parsedExpenseDate = (() => {
        if (!expense.date) return null;
        const m = String(expense.date).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedExpenseDate) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!${slotColsForSlot.dt}${targetRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[fmt(parsedExpenseDate)]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const jobIdentifier = (jobClient && jobName) ? `"${jobClient} - ${jobName}"` : `"${jobName || jobClient || "Job"}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: createNewRow ? "Expense Placed (New Row)" : "Expense Placed",
      summary: `Placed expense '${expense.description || expense.accountName || "Expense"}' (£${expense.amount || 0}) into ${jobIdentifier} (Row ${targetRowNum}, Slot ${targetSlotNum})`,
      details: {
        vendor: expense.description || expense.accountName,
        amount: expense.amount,
        endClient: jobClient,
        jobName,
        clientName: tenantClient,
        slot: targetSlotNum,
        row: targetRowNum,
        isNewRow: !!createNewRow
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, newRowNum: createNewRow ? targetRowNum : undefined });
  } catch (err) {
    console.error("❌ assign_expense_to_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateExpenseSlot(req, res, sheets) {
  const { clientSheetId, rowNum, slotNum, expense, deleteSlot } = req.body;
  if (!clientSheetId || !rowNum || !slotNum) return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
  if (!deleteSlot && !expense) return res.status(400).json({ success: false, error: "Missing expense (or set deleteSlot: true)" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const slotCols = {
      1: { d: "BX", a: "BY", v: "BZ", dt: "CA", dp: "CB", st: "CC", id: "CD" },
      2: { d: "CE", a: "CF", v: "CG", dt: "CH", dp: "CI", st: "CJ", id: "CK" },
      3: { d: "CL", a: "CM", v: "CN", dt: "CO", dp: "CP", st: "CQ", id: "CR" },
    }[slotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const values = deleteSlot
      ? ["", "", "", "", "", "", ""]
      : [
          expense.description || "",
          expense.amount || 0,
          expense.vat || "No",
          expense.date || "",
          expense.daysToPay || 30,
          expense.status || "",
          expense.transactionId || "",
        ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!${slotCols.d}${rowNum}`,  values: [[values[0]]] },
          { range: `Confirmed!${slotCols.a}${rowNum}`,  values: [[values[1]]] },
          { range: `Confirmed!${slotCols.v}${rowNum}`,  values: [[values[2]]] },
          { range: `Confirmed!${slotCols.dp}${rowNum}`, values: [[values[4]]] },
          { range: `Confirmed!${slotCols.st}${rowNum}`, values: [[values[5]]] },
          { range: `Confirmed!${slotCols.id}${rowNum}`, values: [[values[6]]] },
        ],
      },
    });

    if (deleteSlot) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: `Confirmed!${slotCols.dt}${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[""]] },
      });
    } else if (expense.date) {
      const parsedExpenseDate = (() => {
        if (!expense.date) return null;
        const m = String(expense.date).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedExpenseDate) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!${slotCols.dt}${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[fmt(parsedExpenseDate)]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    let endClient = req.body.endClientName || "";
    let job = req.body.jobName || "";
    if (!endClient || !job) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `Confirmed!A${rowNum}:B${rowNum}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!endClient && rowVals[0]) endClient = String(rowVals[0]).trim();
        if (!job && rowVals[1]) job = String(rowVals[1]).trim();
      } catch (e) {}
    }
    const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: deleteSlot ? "Expense Slot Cleared" : "Expense Slot Updated",
      summary: deleteSlot
        ? `Cleared expense slot #${slotNum} on Row ${rowNum} for ${jobIdentifier}`
        : `Updated expense slot #${slotNum} on Row ${rowNum} for ${jobIdentifier} (${expense?.description || "Expense"}, £${expense?.amount || 0})`,
      details: {
        slotNum,
        rowNum,
        endClient,
        jobName: job,
        clientName: tenantClient,
        deleteSlot: !!deleteSlot,
        description: expense?.description,
        amount: expense?.amount,
        status: expense?.status
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ update_expense_slot error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleAssignInvoiceToJob(req, res, sheets) {
  const {
    clientSheetId, masterSheetId, rowNum, slotNum, invoice, createNewRow,
    jobLastRow, jobClient, jobName, updateClientName, newClientName, jobRowNums
  } = req.body;
  if (!clientSheetId || !invoice) return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  if (!createNewRow && (!rowNum || !slotNum)) return res.status(400).json({ success: false, error: "Missing rowNum or slotNum" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    };

    let targetRowNum = rowNum;
    let targetSlotNum = slotNum;

    if (createNewRow) {
      if (!jobLastRow) return res.status(400).json({ success: false, error: "Missing jobLastRow for createNewRow" });

      const metaResp = await sheets.spreadsheets.get({
        spreadsheetId: sheetIdClean,
        fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
      });
      const confirmedSheet = metaResp.data.sheets.find(s => s.properties.title === "Confirmed");
      if (!confirmedSheet) return res.status(400).json({ success: false, error: "Confirmed tab not found" });
      const gridSheetId = confirmedSheet.properties.sheetId;
      let currentMaxRows = confirmedSheet.properties.gridProperties.rowCount;
      const existingRowGroups = confirmedSheet.rowGroups || [];

      const fullResp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdClean,
        range: "Confirmed!A1:CR" + currentMaxRows,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const allRows = fullResp.data.values || [];
      let trueLastRow = 0;
      for (let r = allRows.length - 1; r >= 0; r--) {
        const row = allRows[r] || [];
        const z1 = row.slice(0, 5).some(c => c !== "" && c != null);
        const z2 = row.slice(32, 39).some(c => c !== "" && c != null);
        const z3 = row.slice(41, 60).some(c => c !== "" && c != null);
        const z4 = row.slice(75, 96).some(c => c !== "" && c != null);
        if (z1 || z2 || z3 || z4) { trueLastRow = r + 1; break; }
      }

      const jobVAT = allRows[jobLastRow - 1]?.[34] ?? "";
      const vatAmountVal = parseFloat(String(invoice.vatAmount || invoice.vatIncluded || 0)) || 0;
      const vatVal = vatAmountVal > 0 ? "Yes" : (invoice.vatYesNo || jobVAT || "No");

      if (currentMaxRows - (trueLastRow + 1) < 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            requests: [{
              insertDimension: {
                range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: currentMaxRows, endIndex: currentMaxRows + 5 },
                inheritFromBefore: true,
              },
            }],
          },
        });
      }

      const sourceRowIndex0 = trueLastRow; 
      const destRowIndex0 = jobLastRow;    

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          requests: [{
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: sourceRowIndex0, endIndex: sourceRowIndex0 + 1 },
              destinationIndex: destRowIndex0,
            },
          }],
        },
      });

      targetRowNum = jobLastRow + 1; 
      targetSlotNum = 1; 

      try {
        const destRowIndex1based0 = jobLastRow; 
        const coveringGroup = existingRowGroups.find(g =>
          g.range?.startIndex <= destRowIndex1based0 - 1 && g.range?.endIndex >= destRowIndex1based0
        );
        if (coveringGroup) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [
                { deleteDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex,
                  } } },
                { addDimensionGroup: { range: {
                    sheetId: gridSheetId, dimension: "ROWS",
                    startIndex: coveringGroup.range.startIndex, endIndex: coveringGroup.range.endIndex + 1,
                  } } },
              ],
            },
          });
        } else {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetIdClean,
            requestBody: {
              requests: [{
                addDimensionGroup: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: destRowIndex1based0, endIndex: destRowIndex1based0 + 1 },
                },
              }],
            },
          });
        }
      } catch (groupErr) {
        console.log(`  ⚠ Row grouping for new child row failed (non-fatal): ${groupErr.message}`);
      }

      const effectiveClientName = (updateClientName && newClientName) ? newClientName : (jobClient || "");
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `Confirmed!A${targetRowNum}`, values: [[effectiveClientName]] },
            { range: `Confirmed!B${targetRowNum}`, values: [[jobName || ""]] },
            { range: `Confirmed!AI${targetRowNum}`, values: [[vatVal]] },
          ],
        },
      });
    }

    if (updateClientName && newClientName) {
      const rowsToUpdate = new Set(Array.isArray(jobRowNums) ? jobRowNums : []);
      if (rowNum) rowsToUpdate.add(rowNum);
      if (targetRowNum) rowsToUpdate.add(targetRowNum);

      if (rowsToUpdate.size > 0) {
        const clientUpdates = Array.from(rowsToUpdate).map(r => ({
          range: `Confirmed!A${r}`,
          values: [[newClientName]]
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetIdClean,
          requestBody: {
            valueInputOption: "RAW",
            data: clientUpdates,
          },
        });
      }
    }

    const slotColsForSlot = slotCols[targetSlotNum];
    if (!slotColsForSlot) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    let daysToPay = 30;
    if (invoice.sentDate && invoice.dueDate) {
      const parseD = (d) => {
        const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      };
      const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
      if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!${slotColsForSlot.a}${targetRowNum}`,    values: [[invoice.amount || 0]] },
          { range: `Confirmed!${slotColsForSlot.ref}${targetRowNum}`,  values: [[invoice.invoiceNo || ""]] },
          { range: `Confirmed!${slotColsForSlot.days}${targetRowNum}`, values: [[daysToPay]] },
          { range: `Confirmed!${slotColsForSlot.st}${targetRowNum}`,   values: [[invoice.status || "Sent"]] },
        ],
      },
    });

    if (invoice.sentDate) {
      const parsedSentDate = (() => {
        if (!invoice.sentDate) return null;
        const m = String(invoice.sentDate).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedSentDate) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!${slotColsForSlot.sent}${targetRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[fmt(parsedSentDate)]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = effectiveClientName || jobClient || "";
    const jobIdentifier = (endClient && jobName) ? `"${endClient} - ${jobName}"` : `"${jobName || endClient || "Job"}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "INVOICES",
      action: createNewRow ? "Invoice Placed (New Row)" : "Invoice Placed",
      summary: `Placed invoice #${invoice.invoiceNo} (£${invoice.amount || 0}) into ${jobIdentifier} (Row ${targetRowNum}, Slot ${targetSlotNum})`,
      details: {
        invoiceNumber: invoice.invoiceNo,
        amount: invoice.amount,
        jobName,
        endClient,
        clientName: tenantClient,
        slot: targetSlotNum,
        row: targetRowNum,
        isNewRow: !!createNewRow
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, newRowNum: createNewRow ? targetRowNum : undefined });
  } catch (err) {
    console.error("❌ assign_invoice_to_job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateInvoiceSlot(req, res, sheets) {
  const { clientSheetId, rowNum, slotNum, invoice, deleteSlot } = req.body;
  if (!clientSheetId || !rowNum || !slotNum) return res.status(400).json({ success: false, error: "Missing clientSheetId, rowNum, or slotNum" });
  if (!deleteSlot && !invoice) return res.status(400).json({ success: false, error: "Missing invoice (or set deleteSlot: true)" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const slotCols = {
      1: { a: "AP", ref: "AQ", sent: "AR", days: "AS", st: "AT" },
      2: { a: "AW", ref: "AX", sent: "AY", days: "AZ", st: "BA" },
      3: { a: "BD", ref: "BE", sent: "BF", days: "BG", st: "BH" },
    }[slotNum];
    if (!slotCols) return res.status(400).json({ success: false, error: "Invalid slotNum" });

    const values = deleteSlot
      ? ["", "", "", "", ""]
      : [
          invoice.amount || 0,
          invoice.invoiceNo || "",
          invoice.sentDate || "",
          invoice.daysToPay || 30,
          invoice.status || "",
        ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!${slotCols.a}${rowNum}`,    values: [[values[0]]] },
          { range: `Confirmed!${slotCols.ref}${rowNum}`,  values: [[values[1]]] },
          { range: `Confirmed!${slotCols.days}${rowNum}`, values: [[values[3]]] },
          { range: `Confirmed!${slotCols.st}${rowNum}`,   values: [[values[4]]] },
        ],
      },
    });

    if (deleteSlot) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetIdClean,
        range: `Confirmed!${slotCols.sent}${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[""]] },
      });
    } else if (invoice.sentDate) {
      const parsedSentDate = (() => {
        if (!invoice.sentDate) return null;
        const m = String(invoice.sentDate).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsedSentDate) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetIdClean,
          range: `Confirmed!${slotCols.sent}${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[fmt(parsedSentDate)]] },
        });
      }
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    let endClient = req.body.endClientName || "";
    let job = req.body.jobName || "";
    if (!endClient || !job) {
      try {
        const nameResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `Confirmed!A${rowNum}:B${rowNum}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        const rowVals = nameResp.data.values?.[0] || [];
        if (!endClient && rowVals[0]) endClient = String(rowVals[0]).trim();
        if (!job && rowVals[1]) job = String(rowVals[1]).trim();
      } catch (e) {}
    }
    const jobIdentifier = (endClient && job) ? `"${endClient} - ${job}"` : `"${job || endClient || `Row ${rowNum}`}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "INVOICES",
      action: deleteSlot ? "Invoice Slot Cleared" : "Invoice Slot Updated",
      summary: deleteSlot
        ? `Cleared invoice slot #${slotNum} on Row ${rowNum} for ${jobIdentifier}`
        : `Updated invoice slot #${slotNum} on Row ${rowNum} for ${jobIdentifier} (Inv #${invoice?.invoiceNo || ""}, £${invoice?.amount || 0})`,
      details: {
        slotNum,
        rowNum,
        endClient,
        jobName: job,
        clientName: tenantClient,
        deleteSlot: !!deleteSlot,
        invoiceNumber: invoice?.invoiceNo,
        amount: invoice?.amount,
        status: invoice?.status
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ update_invoice_slot error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleCreateJobFromInvoice(req, res, sheets) {
  const { clientSheetId, jobName, projectCode, revenue, directCosts, vatYesNo, projectType, startDate, endDate, invoice } = req.body;
  if (!clientSheetId || !invoice) return res.status(400).json({ success: false, error: "Missing clientSheetId or invoice" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;

    const confirmedResp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetIdClean,
      range: "Confirmed!A1:AM5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const confirmedRows = confirmedResp.data.values || [];
    let lastDataRow = 1;
    for (let i = confirmedRows.length - 1; i >= 1; i--) {
      const r = confirmedRows[i] || [];
      if (r[0] || r[1] || r[32] || r[37]) { lastDataRow = i + 1; break; }
    }
    const newRow = lastDataRow + 1;

    let daysToPay = 30;
    if (invoice.sentDate && invoice.dueDate) {
      const parseD = (d) => {
        const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      };
      const sent = parseD(invoice.sentDate), due = parseD(invoice.dueDate);
      if (sent && due) daysToPay = Math.round((due - sent) / 86400000);
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `Confirmed!A${newRow}`,  values: [[invoice.client || ""]] },
          { range: `Confirmed!B${newRow}`,  values: [[jobName || invoice.job || ""]] },
          { range: `Confirmed!C${newRow}`,  values: [[projectCode || ""]] },
          { range: `Confirmed!AG${newRow}`, values: [[revenue || invoice.amount || 0]] },
          { range: `Confirmed!AH${newRow}`, values: [[directCosts || 0]] },
          { range: `Confirmed!AI${newRow}`, values: [[vatYesNo || (invoice.vatAmount > 0 ? "Yes" : "No")]] },
          { range: `Confirmed!AJ${newRow}`, values: [[projectType || "Project"]] },
          { range: `Confirmed!AP${newRow}`, values: [[invoice.amount || 0]] },
          { range: `Confirmed!AQ${newRow}`, values: [[invoice.invoiceNo || ""]] },
          { range: `Confirmed!AS${newRow}`, values: [[daysToPay]] },
          { range: `Confirmed!AT${newRow}`, values: [[invoice.status || "Sent"]] },
        ],
      },
    });

    const dateFieldsToWrite = [
      { col: "AL", raw: startDate || invoice.sentDate },
      { col: "AM", raw: endDate || invoice.dueDate },
      { col: "AR", raw: invoice.sentDate },
    ];
    const dateWriteData = [];
    for (const f of dateFieldsToWrite) {
      if (!f.raw) continue;
      const parsed = (() => {
        const m = String(f.raw).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
        if (!m) return null;
        const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
        const mIdx = months[m[2].toLowerCase()];
        if (mIdx === undefined) return null;
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
        return new Date(yr, mIdx, parseInt(m[1]));
      })();
      if (parsed) {
        const fmt = (d) => { const ms = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return d.getDate() + "-" + ms[d.getMonth()] + "-" + d.getFullYear(); };
        dateWriteData.push({ range: `Confirmed!${f.col}${newRow}`, values: [[fmt(parsed)]] });
      }
    }
    if (dateWriteData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetIdClean, requestBody: { valueInputOption: "USER_ENTERED", data: dateWriteData },
      });
    }

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    const endClient = invoice?.client || "";
    const createdJob = jobName || invoice?.job || "Job";
    const jobIdentifier = endClient ? `"${endClient} - ${createdJob}"` : `"${createdJob}"`;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "INVOICES",
      action: "Job Created from Invoice",
      summary: `Created new job ${jobIdentifier} from invoice #${invoice?.invoiceNo} (£${invoice?.amount || 0}) (Row ${newRow})`,
      details: {
        jobName: createdJob,
        endClient,
        clientName: tenantClient,
        invoiceNumber: invoice?.invoiceNo,
        amount: invoice?.amount,
        projectCode,
        revenue,
        row: newRow
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, newRowNum: newRow });
  } catch (err) {
    console.error("❌ create_job_from_invoice error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateOutgoingNote(req, res, sheets) {
  const { clientSheetId, sheetRow, colLetter, blocks } = req.body;
  if (!clientSheetId || !sheetRow || !colLetter) return res.status(400).json({ success: false, error: "Missing required fields" });
  try {
    const sheetIdClean = extractSheetIdFromUrl(clientSheetId) || clientSheetId;
    const noteStr = (blocks || []).map(b =>
      `{App ID: ${b.appId}}{Amt: ${b.amount}}{Status:${b.status ? " " + b.status : ""}}{Rec date:${b.recDate ? " " + b.recDate : ""}}{Pay date:${b.payDate ? " " + b.payDate : ""}}{Description:${b.description ? " " + b.description : ""}}`
    ).join("\n");

    const cellTotal = (blocks || [])
      .filter(b => !b.appId.startsWith("UNRECON-GAP"))
      .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

    const cellRef = `Outgoings!${colLetter}${sheetRow}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetIdClean,
      range: cellRef,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[cellTotal || ""]] },
    });

    const colIndex = colLetterToNum(colLetter) - 1; 
    const rowIndex = sheetRow - 1; 
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetIdClean,
      requestBody: {
        requests: [{
          updateCells: {
            range: {
              sheetId: await getSheetGid(sheets, sheetIdClean, "Outgoings"),
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: colIndex,
              endColumnIndex: colIndex + 1,
            },
            rows: [{ values: [{ note: noteStr }] }],
            fields: "note",
          },
        }],
      },
    });

    console.log(`  ✅ Outgoings note updated: ${cellRef}`);

    let tenantClient = req.body.clientName || "";
    if (!tenantClient) {
      tenantClient = await resolveClientNameBySheetId(sheets, sheetIdClean, req.body.automationCommanderSheetId);
    }
    let contractor = req.body.contractorName || "";
    if (!contractor && sheetRow) {
      try {
        const vResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: sheetIdClean,
            range: `Outgoings!A${sheetRow}`,
            valueRenderOption: "FORMATTED_VALUE"
          })
        );
        contractor = String(vResp.data.values?.[0]?.[0] || "").trim();
      } catch (e) {}
    }
    const contractorIdentifier = contractor ? `"${contractor}" (${cellRef})` : cellRef;

    logPmaActivity(sheets, {
      automationCommanderSheetId: req.body.automationCommanderSheetId,
      clientName: tenantClient,
      category: "EXPENSES",
      action: "Outgoing Note Updated",
      summary: `Updated outgoings note for ${contractorIdentifier} (${(blocks || []).length} item${(blocks || []).length !== 1 ? "s" : ""}, Total: £${cellTotal.toFixed(2)})`,
      details: {
        vendor: contractor,
        cellRef,
        sheetRow,
        colLetter,
        itemCount: (blocks || []).length,
        total: cellTotal,
        clientName: tenantClient
      }
    }).catch(e => console.error("PMA log failed:", e));

    return res.status(200).json({ success: true, cellRef, blockCount: (blocks || []).length, cellTotal });
  } catch (err) {
    console.error("❌ update_outgoing_note error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleFireOutgoingsPull(req, res, sheets) {
  const { clientSheetId: pullClientSheetId, masterSheetId: pullMasterSheetId } = req.body;
  if (!pullClientSheetId || !pullMasterSheetId) return res.status(400).json({ success: false, error: "Missing clientSheetId or masterSheetId" });
  try {
    const pullClientIdClean = extractSheetIdFromUrl(pullClientSheetId) || pullClientSheetId;
    const pullMasterIdClean = extractSheetIdFromUrl(pullMasterSheetId) || pullMasterSheetId;
    const gasResp = await fetch("https://script.google.com/macros/s/AKfycbzVvLSDtqWj3aHcn0UV9VPCybNm82sBNWynMo1-bMpvs3NzerPZXWkrpPJvVHaqDwwy/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refreshOutgoings", clientSheetId: pullClientIdClean, masterSheetId: pullMasterIdClean }),
    });
    const gasData = await gasResp.json().catch(() => ({}));
    console.log(`  📋 fire_outgoings_pull GAS call: ${gasData.success ? "OK" : gasData.error || "no response"}`);
    return res.status(200).json({ success: true });
  } catch(err) {
    console.log(`  ⚠ fire_outgoings_pull GAS call failed (non-fatal): ${err.message}`);
    return res.status(200).json({ success: false, error: err.message });
  }
}

export async function handleMarkPipelineCopied(req, res, sheets) {
  const { clientSheetId: pipeClientSheetId, pipelineRow } = req.body;
  
  if (!pipeClientSheetId || !pipelineRow) {
    return res.status(400).json({ success: false, error: "Missing clientSheetId or pipelineRow" });
  }
  
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: pipeClientSheetId,
      range: `Pipeline!DD${pipelineRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Yes"]] },
    });
    
    console.log(`  ✅ mark_pipeline_copied: wrote Yes to Pipeline!DD${pipelineRow}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ mark_pipeline_copied error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}