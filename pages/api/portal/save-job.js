import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";

// Helper to convert 0-indexed column number to letters (e.g. 0 -> A, 27 -> AB)
function colToLetter(colIndex) {
  let temp, letter = "";
  let c = colIndex + 1;
  while (c > 0) {
    temp = (c - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    c = Math.floor((c - temp - 1) / 26);
  }
  return letter;
}

const parseMoney = (val) => {
  if (val === undefined || val === null || val === "") return "";
  const num = parseFloat(String(val).replace(/[£$€,\s]/g, ""));
  return isNaN(num) ? val : num;
};

const formatDate = (val) => {
  if (!val) return "";
  const str = String(val).trim();
  if (!str) return "";
  return str;
};

const parseNumber = (val, defaultVal = "") => {
  if (val === undefined || val === null || val === "") return defaultVal;
  const num = parseFloat(String(val).replace(/[£$€,\s%]/g, ""));
  return isNaN(num) ? val : num;
};

const parseText = (val) => {
  if (val === undefined || val === null) return "";
  return String(val).trim();
};

const parseStatus = (val) => {
  if (val === undefined || val === null) return "";
  const s = String(val).trim();
  if (s.toLowerCase() === "pending") return "";
  return s;
};

/**
 * Finds the last row containing actual job data in cols 1-39 or 42-60.
 */
async function findLastJobRow(sheets, spreadsheetId, sheetName, minRow = 1) {
  const dataResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:BH`,
      valueRenderOption: "FORMATTED_VALUE",
    })
  );
  const allRows = dataResp.data?.values || [];
  let lastJobRow = minRow;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const rowData = allRows[r] || [];
    const hasDataA = rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const hasDataB = rowData.slice(41, 60).some((v) => v !== undefined && String(v).trim() !== "");
    if (hasDataA || hasDataB) {
      lastJobRow = Math.max(lastJobRow, r + 1);
      break;
    }
  }
  return lastJobRow;
}

/**
 * Finds the second blank row after all job data and moves it directly after insertAfterRow.
 * Matches the original GAS findAndMoveBlankRow logic 1:1.
 */
async function findAndMoveBlankRow(sheets, spreadsheetId, sheetId, sheetName, insertAfterRow) {
  const dataResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:BH`,
      valueRenderOption: "FORMATTED_VALUE",
    })
  );
  const allRows = dataResp.data?.values || [];
  let lastJobRow = insertAfterRow;
  for (let r = allRows.length - 1; r >= 0; r--) {
    const rowData = allRows[r] || [];
    const hasDataA = rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const hasDataB = rowData.slice(41, 60).some((v) => v !== undefined && String(v).trim() !== "");
    if (hasDataA || hasDataB) {
      lastJobRow = Math.max(lastJobRow, r + 1);
      break;
    }
  }

  // Find at least 2 blank rows after lastJobRow
  const blankRows = [];
  for (let r = lastJobRow + 1; r <= allRows.length + 50; r++) {
    const rowData = r <= allRows.length ? allRows[r - 1] || [] : [];
    const isBlankA = !rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
    const isBlankB = !rowData.slice(41, 60).some((v) => v !== undefined && String(v).trim() !== "");
    if (isBlankA && isBlankB) {
      blankRows.push(r);
      if (blankRows.length >= 2) break;
    }
  }

  if (blankRows.length < 2) {
    throw new Error(`Need at least 2 blank rows after job data. Found ${blankRows.length}`);
  }

  // Use the SECOND blank row (original GAS Step 4)
  const blankRowToMove = blankRows[1];
  const targetRow = insertAfterRow + 1;

  if (blankRowToMove === targetRow) {
    return targetRow;
  }

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            moveDimension: {
              source: {
                sheetId,
                dimension: "ROWS",
                startIndex: blankRowToMove - 1,
                endIndex: blankRowToMove,
              },
              destinationIndex: targetRow - 1,
            },
          },
        ],
      },
    })
  );

  return targetRow;
}

/**
 * Writes parent row values into rowArray preserving formulas in unmapped columns.
 */
function applyParentRowValues(rowArray, job, cols, invoiceSlots, expenseSlots) {
  // Basic Info
  if (cols.client !== -1 && job.client !== undefined) rowArray[cols.client] = parseText(job.client);
  if (cols.jobName !== -1 && job.jobName !== undefined) rowArray[cols.jobName] = parseText(job.jobName);
  if (cols.projectCode !== -1 && job.projectCode !== undefined) rowArray[cols.projectCode] = parseText(job.projectCode);
  if (cols.lead !== -1 && job.lead !== undefined) rowArray[cols.lead] = parseText(job.lead);
  if (cols.dateConfirmed !== -1 && job.dateConfirmed !== undefined) rowArray[cols.dateConfirmed] = formatDate(job.dateConfirmed);
  if (cols.leadSource !== -1 && job.leadSource !== undefined) rowArray[cols.leadSource] = parseText(job.leadSource);
  if (cols.splitStr !== -1 && job.splitStr !== undefined) rowArray[cols.splitStr] = parseText(job.splitStr);
  if (cols.revenue !== -1 && job.revenue !== undefined) rowArray[cols.revenue] = parseMoney(job.revenue);
  if (cols.directCosts !== -1 && job.directCosts !== undefined) rowArray[cols.directCosts] = parseMoney(job.directCosts);
  if (cols.vat !== -1 && job.vat !== undefined) rowArray[cols.vat] = parseText(job.vat);
  if (cols.projectRetainer !== -1 && job.projectRetainer !== undefined) rowArray[cols.projectRetainer] = parseText(job.projectRetainer);
  if (cols.productLine !== -1 && job.productLine !== undefined) rowArray[cols.productLine] = parseText(job.productLine);
  if (cols.startDate !== -1 && job.startDate !== undefined) rowArray[cols.startDate] = formatDate(job.startDate);
  if (cols.endDate !== -1 && job.endDate !== undefined) rowArray[cols.endDate] = formatDate(job.endDate);
  if (cols.likelihood !== -1 && job.likelihood !== undefined) rowArray[cols.likelihood] = parseText(job.likelihood);
  if (cols.prodTime !== -1 && job.prodTime !== undefined) rowArray[cols.prodTime] = parseNumber(job.prodTime);

  // Invoices (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const invMap = cols.inv[s - 1];
    const inv = invoiceSlots?.[s];
    if (inv) {
      if (invMap.amount !== -1) rowArray[invMap.amount] = parseMoney(inv.amount);
      if (invMap.ref !== -1) rowArray[invMap.ref] = parseText(inv.ref);
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = formatDate(inv.sendDate);
      if (invMap.days !== -1) rowArray[invMap.days] = parseNumber(inv.days, 30);
      if (invMap.status !== -1) rowArray[invMap.status] = parseStatus(inv.status);
      if (invMap.desc !== -1 && inv.desc !== undefined) rowArray[invMap.desc] = parseText(inv.desc);
    } else {
      if (invMap.amount !== -1) rowArray[invMap.amount] = "";
      if (invMap.ref !== -1) rowArray[invMap.ref] = "";
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = "";
      if (invMap.days !== -1) rowArray[invMap.days] = "";
      if (invMap.status !== -1) rowArray[invMap.status] = "";
      if (invMap.desc !== -1) rowArray[invMap.desc] = "";
    }
  }

  // Direct Expenses (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const dirMap = cols.dir[s - 1];
    const exp = expenseSlots?.[s];
    if (exp) {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = parseText(exp.desc);
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = parseMoney(exp.amount);
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = parseText(exp.vat || "Yes");
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = formatDate(exp.recDate);
      if (dirMap.days !== -1) rowArray[dirMap.days] = parseNumber(exp.days, 30);
      if (dirMap.status !== -1) rowArray[dirMap.status] = parseStatus(exp.status);
      if (dirMap.appId !== -1 && exp.appId !== undefined) rowArray[dirMap.appId] = parseText(exp.appId);
    } else {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = "";
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = "";
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = "";
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = "";
      if (dirMap.days !== -1) rowArray[dirMap.days] = "";
      if (dirMap.status !== -1) rowArray[dirMap.status] = "";
      if (dirMap.appId !== -1) rowArray[dirMap.appId] = "";
    }
  }
}

/**
 * Writes child row values into rowArray.
 * Child rows inherit Client, Job Name, and VAT? from parent.
 * Revenue, Direct Costs, Dates, etc. are cleared.
 */
function applyChildRowValues(rowArray, job, cols, invoiceSlots, expenseSlots) {
  // Inherit Client, Job name, and VAT status from parent (critical for VAT & calculation formulas)
  if (cols.client !== -1 && job.client !== undefined) rowArray[cols.client] = parseText(job.client);
  if (cols.jobName !== -1 && job.jobName !== undefined) rowArray[cols.jobName] = parseText(job.jobName);
  if (cols.vat !== -1 && job.vat !== undefined) rowArray[cols.vat] = parseText(job.vat);

  // Clear non-inherited fields so child rows never have duplicate revenue, costs, dates, etc.
  if (cols.revenue !== -1) rowArray[cols.revenue] = "";
  if (cols.directCosts !== -1) rowArray[cols.directCosts] = "";
  if (cols.startDate !== -1) rowArray[cols.startDate] = "";
  if (cols.endDate !== -1) rowArray[cols.endDate] = "";
  if (cols.dateConfirmed !== -1) rowArray[cols.dateConfirmed] = "";
  if (cols.projectCode !== -1) rowArray[cols.projectCode] = "";
  if (cols.productLine !== -1) rowArray[cols.productLine] = "";
  if (cols.leadSource !== -1) rowArray[cols.leadSource] = "";
  if (cols.splitStr !== -1) rowArray[cols.splitStr] = "";
  if (cols.likelihood !== -1) rowArray[cols.likelihood] = "";
  if (cols.prodTime !== -1) rowArray[cols.prodTime] = "";

  // Invoices (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const invMap = cols.inv[s - 1];
    const inv = invoiceSlots?.[s];
    if (inv) {
      if (invMap.amount !== -1) rowArray[invMap.amount] = parseMoney(inv.amount);
      if (invMap.ref !== -1) rowArray[invMap.ref] = parseText(inv.ref);
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = formatDate(inv.sendDate);
      if (invMap.days !== -1) rowArray[invMap.days] = parseNumber(inv.days, 30);
      if (invMap.status !== -1) rowArray[invMap.status] = parseStatus(inv.status);
      if (invMap.desc !== -1 && inv.desc !== undefined) rowArray[invMap.desc] = parseText(inv.desc);
    } else {
      if (invMap.amount !== -1) rowArray[invMap.amount] = "";
      if (invMap.ref !== -1) rowArray[invMap.ref] = "";
      if (invMap.sendDate !== -1) rowArray[invMap.sendDate] = "";
      if (invMap.days !== -1) rowArray[invMap.days] = "";
      if (invMap.status !== -1) rowArray[invMap.status] = "";
      if (invMap.desc !== -1) rowArray[invMap.desc] = "";
    }
  }

  // Direct Expenses (slots 1-3)
  for (let s = 1; s <= 3; s++) {
    const dirMap = cols.dir[s - 1];
    const exp = expenseSlots?.[s];
    if (exp) {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = parseText(exp.desc);
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = parseMoney(exp.amount);
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = parseText(exp.vat || "Yes");
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = formatDate(exp.recDate);
      if (dirMap.days !== -1) rowArray[dirMap.days] = parseNumber(exp.days, 30);
      if (dirMap.status !== -1) rowArray[dirMap.status] = parseStatus(exp.status);
      if (dirMap.appId !== -1 && exp.appId !== undefined) rowArray[dirMap.appId] = parseText(exp.appId);
    } else {
      if (dirMap.desc !== -1) rowArray[dirMap.desc] = "";
      if (dirMap.amount !== -1) rowArray[dirMap.amount] = "";
      if (dirMap.vat !== -1) rowArray[dirMap.vat] = "";
      if (dirMap.recDate !== -1) rowArray[dirMap.recDate] = "";
      if (dirMap.days !== -1) rowArray[dirMap.days] = "";
      if (dirMap.status !== -1) rowArray[dirMap.status] = "";
      if (dirMap.appId !== -1) rowArray[dirMap.appId] = "";
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (sessionUser.isReadOnly) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const { clientSheetId, clientName, job } = req.body || {};

  if (!clientSheetId || !job) {
    return res.status(400).json({ success: false, error: "clientSheetId and job object are required" });
  }

  // Authorization check
  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  try {
    const sheets = await getSheetsClient();

    // 1. Determine target sheet name and sheet metadata
    const isTargetConfirmed = String(job.type || "").toLowerCase() === "confirmed";
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets.properties",
      })
    );
    const sheetMetaList = metaResp.data?.sheets || [];
    const existingTitles = new Set(sheetMetaList.map((s) => s.properties?.title));

    let sheetName = "";
    if (isTargetConfirmed) {
      sheetName = existingTitles.has("Confirmed") ? "Confirmed" : existingTitles.has("ConfCalcs") ? "ConfCalcs" : "Confirmed";
    } else {
      sheetName = existingTitles.has("Pipeline") ? "Pipeline" : existingTitles.has("PipeCalcs") ? "PipeCalcs" : "Pipeline";
    }

    const targetSheetObj = sheetMetaList.find((s) => s.properties?.title === sheetName);
    if (!targetSheetObj) {
      throw new Error(`Sheet "${sheetName}" not found in spreadsheet.`);
    }
    const sheetId = targetSheetObj.properties?.sheetId;

    // 2. Read headers of target sheet
    const headerResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!1:1`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );

    const headers = (headerResp.data?.values?.[0] || []).map((h) =>
      String(h || "").toLowerCase().trim().replace(/\s+/g, " ")
    );

    const colMap = {};
    headers.forEach((h, idx) => {
      if (h) colMap[h] = idx;
    });

    const getColIdx = (aliases) => {
      const list = Array.isArray(aliases) ? aliases : [aliases];
      for (const alias of list) {
        const norm = alias.toLowerCase().trim().replace(/\s+/g, " ");
        if (colMap[norm] !== undefined) return colMap[norm];
      }
      return -1;
    };

    // Exact dictionary column mapping (prevents substring bugs e.g. "vat" matching "Revenue ... excl VAT")
    const cols = {
      client: getColIdx(["client"]),
      jobName: getColIdx(["job name"]),
      projectCode: getColIdx(["project code"]),
      lead: getColIdx(["lead"]),
      dateConfirmed: getColIdx(["date conf", "date originally added to pipeline", "date confirmed", "date added"]),
      leadSource: getColIdx(["lead src", "lead source"]),
      splitStr: getColIdx(["revunevensplit", "rev uneven split", "rev_uneven_split", "uneven split"]) !== -1
        ? getColIdx(["revunevensplit", "rev uneven split", "rev_uneven_split", "uneven split"])
        : 30,
      revenue: getColIdx(["revenue (proj total / ongoing pm) - excl vat", "revenue"]),
      directCosts: getColIdx(["direct costs (proj total / ongoing pm) - excl vat", "direct costs"]),
      vat: getColIdx(["vat?"]),
      projectRetainer: getColIdx(["project / retainer", "project/retainer"]),
      productLine: getColIdx(["prod. line", "product line"]),
      startDate: getColIdx(["start date"]),
      endDate: getColIdx(["end date"]),
      likelihood: getColIdx(["% likel.", "% likelihood", "% likely", "likelihood"]),
      prodTime: getColIdx(["prod. time", "production time"]),

      inv: [1, 2, 3].map((slot) => ({
        amount: slot === 1
          ? getColIdx(["project invoice 1 / monthly retainer (excl vat)", "inv 1 amount"])
          : getColIdx([`project invoice ${slot} (excl vat)`, `inv ${slot} amount`]),
        ref: getColIdx([`inv ${slot} ref`]),
        sendDate: getColIdx([`inv ${slot} send date`, `inv ${slot} date`]),
        days: getColIdx([`inv ${slot} days to pay`, `inv ${slot} days`]),
        status: getColIdx([`inv ${slot} status`]),
        desc: getColIdx([`inv ${slot} descr.`, `inv ${slot} desc`]),
      })),

      dir: [1, 2, 3].map((slot) => ({
        desc: getColIdx([`direct inv ${slot} descr.`, `direct inv ${slot} desc`]),
        amount: getColIdx([`direct inv ${slot} amt`, `direct inv ${slot} amount`]),
        vat: getColIdx([`dir inv. ${slot} vat?`, `dir inv ${slot} vat?`, `direct inv ${slot} vat?`]),
        recDate: getColIdx([`direct inv ${slot} rec date`, `dir inv. ${slot} rec date`, `dir inv ${slot} rec date`]),
        days: getColIdx([`dir inv ${slot} days to pay`, `dir inv. ${slot} days to pay`, `dir inv ${slot} days`]),
        status: getColIdx([`dir inv ${slot} status`]),
        appId: getColIdx([`dir inv ${slot} app id`, `dir inv. ${slot} app id`]),
      })),
    };

    // 3. Determine if moving between sheets or if new job
    const origId = String(job.id || "");
    const wasPipeline = origId.startsWith("pipeline");
    const wasConfirmed = origId.startsWith("confirmed");
    const isSheetChange = (wasPipeline && isTargetConfirmed) || (wasConfirmed && !isTargetConfirmed);
    const isNewJob = origId === "new" || !job.rowNumber || isSheetChange;

    let parentRow = parseInt(job.rowNumber, 10);
    let existingChildRows = Array.isArray(job.childRowNumbers) ? [...job.childRowNumbers] : [];

    if (isSheetChange) {
      // Clear old rows on the previous sheet
      const oldSheetName = wasPipeline ? "Pipeline" : "Confirmed";
      const oldRow = parseInt(job.rowNumber, 10);
      if (!isNaN(oldRow) && oldRow >= 2) {
        const rowsToClear = [oldRow, ...existingChildRows].filter((r) => r >= 2);
        for (const r of rowsToClear) {
          try {
            await withRetry(() =>
              sheets.spreadsheets.values.clear({
                spreadsheetId: clientSheetId,
                range: `${oldSheetName}!A${r}:BH${r}`,
              })
            );
          } catch (clearErr) {
            console.warn(`Warning clearing old row ${r} on ${oldSheetName}:`, clearErr.message);
          }
        }
      }
      // Target sheet will place this as a new job at first blank row
      existingChildRows = [];
    }

    if (isNewJob || isNaN(parentRow) || parentRow < 2) {
      const lastJobRow = await findLastJobRow(sheets, clientSheetId, sheetName, 1);
      parentRow = lastJobRow + 1;
      existingChildRows = [];
    } else {
      // For existing job on the same sheet, if childRowNumbers wasn't passed or to verify,
      // inspect rows directly below parentRow
      if (existingChildRows.length === 0) {
        try {
          const checkCount = 10;
          const inspectResp = await withRetry(() =>
            sheets.spreadsheets.values.get({
              spreadsheetId: clientSheetId,
              range: `${sheetName}!A${parentRow + 1}:BH${parentRow + checkCount}`,
              valueRenderOption: "FORMATTED_VALUE",
            })
          );
          const nextRows = inspectResp.data?.values || [];
          for (let i = 0; i < nextRows.length; i++) {
            const r = nextRows[i];
            const rClient = (r[cols.client] || "").trim();
            const rJobName = (r[cols.jobName] || "").trim();
            const rRev = (r[cols.revenue] || "").trim();
            const rDc = (r[cols.directCosts] || "").trim();
            if (
              rClient.toLowerCase() === String(job.client || "").toLowerCase() &&
              rJobName.toLowerCase() === String(job.jobName || "").toLowerCase() &&
              rRev === "" &&
              rDc === ""
            ) {
              existingChildRows.push(parentRow + 1 + i);
            } else {
              break;
            }
          }
        } catch (e) {
          console.warn("Child row auto-detection warning:", e.message);
        }
      }
    }

    // 4. INVOICE AND EXPENSE PACKING LOGIC (1:1 with Original App)
    const validInvoices = (job.invoices || []).filter(
      (inv) =>
        (inv.amount !== undefined && String(inv.amount).trim() !== "") ||
        (inv.ref !== undefined && String(inv.ref).trim() !== "") ||
        (inv.sendDate !== undefined && String(inv.sendDate).trim() !== "")
    );

    const validExpenses = (job.directExpenses || []).filter(
      (exp) =>
        (exp.amount !== undefined && String(exp.amount).trim() !== "") ||
        (exp.desc !== undefined && String(exp.desc).trim() !== "") ||
        (exp.recDate !== undefined && String(exp.recDate).trim() !== "")
    );

    const isRetainer = String(job.projectRetainer || "").toLowerCase() === "retainer";

    const parentInvoices = {};
    const childInvoices = [];

    if (isRetainer) {
      if (validInvoices.length === 1) {
        // Retainer with 1 invoice: sits on parent row slot 1; slots 2 & 3 empty
        parentInvoices[1] = validInvoices[0];
      } else if (validInvoices.length > 1) {
        // Retainer with 2+ invoices: parent row slots 1, 2, 3 cleared; each invoice on its own child row slot 1
        validInvoices.forEach((inv, i) => {
          childInvoices[i] = { 1: inv };
        });
      }
    } else {
      // Project invoices: 1-3 on parent row, 4+ on child rows cycling slots 1-3
      validInvoices.forEach((inv, i) => {
        if (i < 3) {
          parentInvoices[i + 1] = inv;
        } else {
          const childIdx = Math.floor((i - 3) / 3);
          const slot = ((i - 3) % 3) + 1;
          if (!childInvoices[childIdx]) childInvoices[childIdx] = {};
          childInvoices[childIdx][slot] = inv;
        }
      });
    }

    // Direct Expenses (same rules for Project and Retainer):
    // 1-3 on parent row, 4+ on child rows cycling slots 1-3
    const parentExpenses = {};
    const childExpenses = [];

    validExpenses.forEach((exp, i) => {
      if (i < 3) {
        parentExpenses[i + 1] = exp;
      } else {
        const childIdx = Math.floor((i - 3) / 3);
        const slot = ((i - 3) % 3) + 1;
        if (!childExpenses[childIdx]) childExpenses[childIdx] = {};
        childExpenses[childIdx][slot] = exp;
      }
    });

    const childRowsForInvoices = childInvoices.length;
    const childRowsForExpenses = childExpenses.length;
    const totalChildRowsNeeded = Math.max(childRowsForInvoices, childRowsForExpenses);

    // 5. MANAGE CHILD ROWS (reuse existing, create new via moveDimension, or clear unused)
    const actualChildRows = [];

    for (let idx = 0; idx < totalChildRowsNeeded; idx++) {
      if (existingChildRows[idx]) {
        actualChildRows.push(existingChildRows[idx]);
      } else {
        const insertAfterRow =
          actualChildRows.length > 0 ? actualChildRows[actualChildRows.length - 1] : parentRow;
        const newChildRow = await findAndMoveBlankRow(
          sheets,
          clientSheetId,
          sheetId,
          sheetName,
          insertAfterRow
        );
        actualChildRows.push(newChildRow);
      }
    }

    // Clear any excess child rows that are no longer needed
    if (existingChildRows.length > totalChildRowsNeeded) {
      for (let i = totalChildRowsNeeded; i < existingChildRows.length; i++) {
        const rowToClear = existingChildRows[i];
        try {
          await withRetry(() =>
            sheets.spreadsheets.values.batchClear({
              spreadsheetId: clientSheetId,
              requestBody: {
                ranges: [
                  `${sheetName}!A${rowToClear}:BH${rowToClear}`,
                  `${sheetName}!BX${rowToClear}:CR${rowToClear}`,
                ],
              },
            })
          );
        } catch (e) {
          console.warn(`Warning clearing unused child row ${rowToClear}:`, e.message);
        }
      }
    }

    // 6. WRITE PARENT ROW (preserving formula cells in BI:BW, and never writing beyond CR to preserve CS:DC and DD)
    const maxCols = 96; // Columns 1-96 (A:CR) covers all editable job fields, invoices, and direct expenses
    const parentRowResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!A${parentRow}:CR${parentRow}`,
        valueRenderOption: "FORMULA",
      })
    );
    const existingParentRow = parentRowResp.data?.values?.[0] || [];
    const updatedParentRow = new Array(maxCols).fill("");
    for (let c = 0; c < maxCols; c++) {
      if (existingParentRow[c] !== undefined) {
        updatedParentRow[c] = existingParentRow[c];
      }
    }

    applyParentRowValues(updatedParentRow, job, cols, parentInvoices, parentExpenses);

    const parentEndColLetter = "CR";
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!A${parentRow}:${parentEndColLetter}${parentRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [updatedParentRow],
        },
      })
    );

    // 7. WRITE CHILD ROWS (confined to A:CR)
    for (let k = 0; k < totalChildRowsNeeded; k++) {
      const childRowNum = actualChildRows[k];
      const childRowResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A${childRowNum}:CR${childRowNum}`,
          valueRenderOption: "FORMULA",
        })
      );
      const existingChildRow = childRowResp.data?.values?.[0] || [];
      const updatedChildRow = new Array(maxCols).fill("");
      for (let c = 0; c < maxCols; c++) {
        if (existingChildRow[c] !== undefined) {
          updatedChildRow[c] = existingChildRow[c];
        }
      }

      applyChildRowValues(
        updatedChildRow,
        job,
        cols,
        childInvoices[k] || {},
        childExpenses[k] || {}
      );

      const childEndColLetter = "CR";
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A${childRowNum}:${childEndColLetter}${childRowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [updatedChildRow],
          },
        })
      );
    }

    // 7.5. GROUP CHILD ROWS (grouped with other children, but not with parent)
    try {
      const metaWithGroups = await withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: clientSheetId,
          fields: "sheets(properties.sheetId,properties.title,rowGroups)",
        })
      );
      const currentSheetObj = (metaWithGroups.data?.sheets || []).find(
        (s) => s.properties?.sheetId === sheetId
      );
      const existingRowGroups = currentSheetObj?.rowGroups || [];

      if (actualChildRows.length > 0) {
        const childStartIndex = actualChildRows[0] - 1; // 0-based inclusive
        const childEndIndex = actualChildRows[actualChildRows.length - 1]; // 0-based exclusive

        const overlappingGroups = existingRowGroups.filter(
          (g) => g.range && g.range.startIndex < childEndIndex && g.range.endIndex > childStartIndex
        );

        const exactMatch = overlappingGroups.find(
          (g) => g.range.startIndex === childStartIndex && g.range.endIndex === childEndIndex
        );

        if (!exactMatch) {
          const deleteReqs = overlappingGroups.map((g) => ({
            deleteDimensionGroup: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: g.range.startIndex,
                endIndex: g.range.endIndex,
              },
            },
          }));

          const addReq = {
            addDimensionGroup: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: childStartIndex,
                endIndex: childEndIndex,
              },
            },
          };

          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: clientSheetId,
              requestBody: {
                requests: [...deleteReqs, addReq],
              },
            })
          );
        }
      } else {
        // If 0 child rows, remove any old dimension group covering rows immediately below parentRow
        const parentIndex0 = parentRow; // 0-based index of row right below parent
        const coveringGroup = existingRowGroups.find(
          (g) => g.range?.startIndex === parentIndex0
        );
        if (coveringGroup) {
          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: clientSheetId,
              requestBody: {
                requests: [
                  {
                    deleteDimensionGroup: {
                      range: {
                        sheetId,
                        dimension: "ROWS",
                        startIndex: coveringGroup.range.startIndex,
                        endIndex: coveringGroup.range.endIndex,
                      },
                    },
                  },
                ],
              },
            })
          );
        }
      }
    } catch (groupErr) {
      console.warn("⚠️ Row grouping warning (non-fatal):", groupErr.message);
    }

    // 8. INVALIDATE CACHES FOR THIS CLIENT
    try {
      memoryCache.del(`pulse:portal:*:${clientSheetId}*`);
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // 9. LOG ACTIVITY
    try {
      const jobName = job.jobName || "Untitled Job";
      const action = isNewJob ? "JOB_CREATED" : "JOB_MODIFIED";
      const summary = isNewJob
        ? `Created new job: "${jobName}" (${sheetName})`
        : `Updated job: "${jobName}" (${sheetName})`;

      await logPulseActivity(sheets, {
        clientName: clientName || "Client",
        category: "JOB",
        action,
        summary,
        details: {
          jobName,
          client: job.client,
          sheetName,
          revenue: job.revenue,
          isNewJob,
          rowNumber: parentRow,
          childRows: actualChildRows.length
        },
        user: sessionUser.name || sessionUser.email
      });
    } catch (logErr) {
      console.warn("⚠️ Failed to log job activity:", logErr.message);
    }

    return res.status(200).json({
      success: true,
      rowNumber: parentRow,
      sheetName,
      childRowNumbers: actualChildRows,
    });
  } catch (err) {
    console.error("❌ /api/portal/save-job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
