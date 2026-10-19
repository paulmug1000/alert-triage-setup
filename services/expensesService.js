/**
 * ============================================================================
 * EXPENSES SERVICE
 * ============================================================================
 * Manages expense data from Client Sheet "Outgoings" tab (rows 126:225):
 * - Financial Years (FY1, FY2, FY3) with 12 months each
 * - Expense Categories (Col A)
 * - VAT? Chooser (Col B: "Yes" / "No")
 * - Delivery % (Col E: "100%" delivery vs "0%" non-delivery)
 * - Monthly expense figures (Cols G:R for FY1, V:AG for FY2, AK:AV for FY3)
 * - Totals for delivery (Row 227) and non-delivery (Row 228)
 * - Add new expense to first empty row in rows 126:225
 * - Move category between delivery and non-delivery (updates Col E)
 * ============================================================================
 */

import { getSheetsClient, withRetry, getSheetGid, colLetterToNum } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { memoryCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";

export function colIdxToLetter(colIdx) {
  let temp = colIdx + 1;
  let letter = "";
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseMonthYearHeader(label) {
  if (!label || typeof label !== "string") return null;
  const match = label.trim().match(/^([A-Za-z]{3})\s*'?(\d{2,4})$/i);
  if (!match) return null;
  const mStr = match[1].toLowerCase();
  const monthIdx = MONTH_NAMES.indexOf(mStr);
  if (monthIdx === -1) return null;
  let year = parseInt(match[2], 10);
  if (year < 100) year += 2000;
  return { monthIdx, year, label: `${match[1]} ${String(year).slice(-2)}` };
}

export function parseNum(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return 0;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const cleaned = s.replace(/[£$€,\s()]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isNeg ? -Math.abs(num) : num;
}

/**
 * Fetch and parse expenses data from Client Sheet Outgoings tab
 */
export async function fetchExpensesData(clientName, clientSheetId, bypassCache = false) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cacheKey = `pma_expenses_${clientSheetId}`;

  if (!bypassCache) {
    try {
      if (redisClient?.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } else {
        const mem = memoryCache.get(cacheKey);
        if (mem) return mem;
      }
    } catch (e) {
      console.warn("Expenses cache read error:", e?.message);
    }
  }

  const sheets = await getSheetsClient();

  const [headerResp, gridResp] = await Promise.all([
    withRetry(async () => {
      return await sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: "Outgoings!A1:AZ2",
        valueRenderOption: "FORMATTED_VALUE",
      });
    }),
    withRetry(async () => {
      return await sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        ranges: ["Outgoings!A126:AZ228"],
        includeGridData: true,
        fields: "sheets.data.rowData.values(formattedValue,note)",
      });
    }),
  ]);

  const row1 = headerResp.data.values?.[0] || [];
  const rowData = gridResp.data.sheets?.[0]?.data?.[0]?.rowData || [];

  // Define the 3 Financial Year configurations
  const fyConfigs = [
    {
      index: 0,
      id: "fy1",
      startCol: 6,  // Col G
      count: 12,    // G to R
      totalCol: 19, // Col T
      totalColLetter: "T",
      label: String(row1[19] || "").trim() || "FY1",
    },
    {
      index: 1,
      id: "fy2",
      startCol: 21, // Col V
      count: 12,    // V to AG
      totalCol: 34, // Col AI
      totalColLetter: "AI",
      label: String(row1[34] || "").trim() || "FY2",
    },
    {
      index: 2,
      id: "fy3",
      startCol: 36, // Col AK
      count: 12,    // AK to AV
      totalCol: 49, // Col AX
      totalColLetter: "AX",
      label: String(row1[49] || "").trim() || "FY3",
    },
  ];

  // Resolve month columns for each FY
  const now = new Date();
  let defaultFyIndex = 0;

  fyConfigs.forEach((fy, fIdx) => {
    const monthCols = [];
    for (let j = 0; j < fy.count; j++) {
      const colIdx = fy.startCol + j;
      const rawHdr = String(row1[colIdx] || "").trim();
      const colLetter = colIdxToLetter(colIdx);
      monthCols.push({
        colIdx,
        colLetter,
        label: rawHdr || `M${j + 1}`,
      });

      // Check if current date falls in this FY
      const parsed = parseMonthYearHeader(rawHdr);
      if (parsed) {
        const mDate = new Date(parsed.year, parsed.monthIdx, 1);
        const mEnd = new Date(parsed.year, parsed.monthIdx + 1, 0, 23, 59, 59);
        if (now >= mDate && now <= mEnd) {
          defaultFyIndex = fIdx;
        }
      }
    }
    fy.monthCols = monthCols;
  });

  // Parse Expense Rows (Rows 126 to 225, i.e. indices 0 to 99 in rowData)
  const expenses = [];
  let firstEmptyRow = null;

  for (let i = 0; i < 100; i++) {
    const sheetRow = 126 + i;
    const rValues = rowData[i]?.values || [];
    const category = String(rValues[0]?.formattedValue || "").trim();
    const vat = String(rValues[1]?.formattedValue || "").trim() || "No";
    const deliveryPct = String(rValues[4]?.formattedValue || "").trim() || "0%";
    const isPopulated = category !== "";

    if (!isPopulated && firstEmptyRow === null) {
      firstEmptyRow = sheetRow;
    }

    // Determine delivery vs non-delivery based on column E %
    const numDelPct = parseNum(deliveryPct);
    const isDelivery = numDelPct > 0 || deliveryPct.toLowerCase() === "100%";

    // Monthly data across all 3 FYs
    const fyData = {};
    fyConfigs.forEach((fy) => {
      const months = fy.monthCols.map((m) => {
        const cell = rValues[m.colIdx];
        return {
          colLetter: m.colLetter,
          monthLabel: m.label,
          value: cell?.formattedValue || "£0",
          note: cell?.note || "",
        };
      });
      const total = rValues[fy.totalCol]?.formattedValue || "£0";
      fyData[fy.id] = { months, total };
    });

    expenses.push({
      sheetRow,
      index: i,
      category,
      vat: vat.toLowerCase() === "yes" ? "Yes" : "No",
      deliveryPct: deliveryPct || "0%",
      isDelivery,
      isPopulated,
      fyData,
    });
  }

  // Parse Totals Rows (Row 227 and Row 228)
  // Row 227 is at index (227 - 126) = 101
  // Row 228 is at index (228 - 126) = 102
  const row227Values = rowData[101]?.values || [];
  const row228Values = rowData[102]?.values || [];

  const totals = {};
  fyConfigs.forEach((fy) => {
    const deliveryMonths = fy.monthCols.map((m) => row227Values[m.colIdx]?.formattedValue || "£0");
    const deliveryTotal = row227Values[fy.totalCol]?.formattedValue || "£0";

    const nonDeliveryMonths = fy.monthCols.map((m) => row228Values[m.colIdx]?.formattedValue || "£0");
    const nonDeliveryTotal = row228Values[fy.totalCol]?.formattedValue || "£0";

    totals[fy.id] = {
      delivery: {
        label: String(row227Values[0]?.formattedValue || "Total other expenses - delivery").trim(),
        months: deliveryMonths,
        total: deliveryTotal,
      },
      nonDelivery: {
        label: String(row228Values[0]?.formattedValue || "Total other expenses - non-del").trim(),
        months: nonDeliveryMonths,
        total: nonDeliveryTotal,
      },
    };
  });

  const result = {
    success: true,
    clientName,
    clientSheetId,
    defaultFyIndex,
    fyConfigs,
    expenses,
    totals,
    firstAvailableRow: firstEmptyRow || 225,
    lastUpdated: new Date().toISOString(),
  };

  try {
    const payload = JSON.stringify(result);
    if (redisClient?.isOpen) {
      await redisClient.setEx(cacheKey, 60, payload);
    } else {
      memoryCache.set(cacheKey, result, 60);
    }
  } catch (e) {
    console.warn("Expenses cache write error:", e?.message);
  }

  return result;
}

/**
 * Save an expense row's metadata (Category, VAT, Delivery %)
 */
export async function saveExpenseMetadata({
  clientName,
  clientSheetId,
  sheetRow,
  category,
  vat,
  deliveryPct,
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 225) {
    throw new Error(`Invalid expense sheet row: ${sheetRow}. Must be between 126 and 225.`);
  }

  const cleanCategory = sanitizeFormulaInput(category || "");
  const cleanVat = vat === "Yes" || vat === true ? "Yes" : "No";
  let cleanDelPct = String(deliveryPct || "").trim();
  if (!cleanDelPct.endsWith("%") && !isNaN(parseFloat(cleanDelPct))) {
    cleanDelPct = `${cleanDelPct}%`;
  }
  if (!cleanDelPct) cleanDelPct = "0%";

  const sheets = await getSheetsClient();

  // Outgoings Col A: Category, Col B: VAT?, Col E: Del %
  await withRetry(async () => {
    return await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          {
            range: `Outgoings!A${rowNum}:B${rowNum}`,
            values: [[cleanCategory, cleanVat]],
          },
          {
            range: `Outgoings!E${rowNum}`,
            values: [[cleanDelPct]],
          },
        ],
      },
    });
  });

  // Invalidate cache
  const cacheKey = `pma_expenses_${clientSheetId}`;
  try {
    if (redisClient?.isOpen) await redisClient.del(cacheKey);
    else memoryCache.delete(cacheKey);
  } catch { }

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "UPDATE_EXPENSE_ROW",
    clientName,
    details: `Updated expense row ${rowNum}: "${cleanCategory}" (VAT: ${cleanVat}, Del: ${cleanDelPct})`,
  });

  return { success: true, sheetRow: rowNum };
}

/**
 * Move an expense category between delivery and non-delivery (updates Column E)
 */
export async function toggleExpenseDelivery({
  clientName,
  clientSheetId,
  sheetRow,
  targetDelivery, // boolean or "100%" / "0%"
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 225) {
    throw new Error(`Invalid expense sheet row: ${sheetRow}. Must be between 126 and 225.`);
  }

  const isDel = targetDelivery === true || targetDelivery === "100%" || targetDelivery === "delivery";
  const newDelPct = isDel ? "100%" : "0%";

  const sheets = await getSheetsClient();

  await withRetry(async () => {
    return await sheets.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: `Outgoings!E${rowNum}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[newDelPct]],
      },
    });
  });

  // Invalidate cache
  const cacheKey = `pma_expenses_${clientSheetId}`;
  try {
    if (redisClient?.isOpen) await redisClient.del(cacheKey);
    else memoryCache.delete(cacheKey);
  } catch { }

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "MOVE_EXPENSE_CATEGORY",
    clientName,
    details: `Moved expense row ${rowNum} to ${isDel ? "Delivery" : "Non-delivery"} (${newDelPct})`,
  });

  return { success: true, sheetRow: rowNum, deliveryPct: newDelPct };
}

/**
 * Save a single monthly expense amount or multiple amounts, plus optional cell notes
 */
export async function saveExpenseAmount({
  clientName,
  clientSheetId,
  sheetRow,
  monthlyAmounts, // { [colLetter]: value }
  cellNotes, // { [colLetter]: note }
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 225) {
    throw new Error(`Invalid expense sheet row: ${sheetRow}. Must be between 126 and 225.`);
  }

  const dataUpdates = [];
  if (monthlyAmounts && typeof monthlyAmounts === "object") {
    for (const [colLetter, val] of Object.entries(monthlyAmounts)) {
      const cleanLetter = String(colLetter).toUpperCase().trim();
      if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
      const cleanVal = sanitizeFormulaInput(String(val ?? "").trim());
      dataUpdates.push({
        range: `Outgoings!${cleanLetter}${rowNum}`,
        values: [[cleanVal]],
      });
    }
  }

  const sheets = await getSheetsClient();

  if (dataUpdates.length > 0) {
    await withRetry(async () => {
      return await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: dataUpdates,
        },
      });
    });
  }

  // Update cell notes if provided
  if (cellNotes && typeof cellNotes === "object") {
    const gid = await getSheetGid(sheets, clientSheetId, "Outgoings");
    const noteRequests = [];
    for (const [colLetter, noteVal] of Object.entries(cellNotes)) {
      const cleanLetter = String(colLetter).toUpperCase().trim();
      if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
      const colIdx = colLetterToNum(cleanLetter) - 1;
      noteRequests.push({
        updateCells: {
          range: {
            sheetId: gid,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1,
          },
          rows: [{ values: [{ note: String(noteVal ?? "") }] }],
          fields: "note",
        },
      });
    }

    if (noteRequests.length > 0) {
      await withRetry(async () => {
        return await sheets.spreadsheets.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: {
            requests: noteRequests,
          },
        });
      });
    }
  }

  if (dataUpdates.length === 0 && (!cellNotes || Object.keys(cellNotes).length === 0)) {
    return { success: true, updated: 0 };
  }

  // Invalidate cache
  const cacheKey = `pma_expenses_${clientSheetId}`;
  try {
    if (redisClient?.isOpen) await redisClient.del(cacheKey);
    else memoryCache.delete(cacheKey);
  } catch { }

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "UPDATE_EXPENSE_AMOUNTS",
    clientName,
    details: `Updated ${dataUpdates.length} monthly amount(s) on row ${rowNum}`,
  });

  return { success: true, sheetRow: rowNum, updated: dataUpdates.length };
}

/**
 * Add a new expense into the first available empty row in 126:225
 */
export async function addExpenseCategory({
  clientName,
  clientSheetId,
  category,
  vat = "No",
  deliveryPct = "0%",
  monthlyAmounts = {},
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const cleanCategory = sanitizeFormulaInput(String(category || "").trim());
  if (!cleanCategory) throw new Error("Expense category name is required");

  // First fetch current data to find the first empty row
  const currentData = await fetchExpensesData(clientName, clientSheetId, true);
  const targetRow = currentData.firstAvailableRow;
  if (!targetRow || targetRow > 225) {
    throw new Error("No available empty rows in Outgoings expense range (rows 126-225).");
  }

  // Save metadata
  await saveExpenseMetadata({
    clientName,
    clientSheetId,
    sheetRow: targetRow,
    category: cleanCategory,
    vat,
    deliveryPct,
    userEmail,
  });

  // If monthly amounts provided, save them too
  if (Object.keys(monthlyAmounts).length > 0) {
    await saveExpenseAmount({
      clientName,
      clientSheetId,
      sheetRow: targetRow,
      monthlyAmounts,
      userEmail,
    });
  }

  return { success: true, sheetRow: targetRow, category: cleanCategory };
}
