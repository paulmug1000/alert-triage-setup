/**
 * ============================================================================
 * NEW BUSINESS TO FIND SERVICE
 * ============================================================================
 * Manages "NBtoFind" data from Client Sheet:
 * - 3 Financial Years (FY1, FY2, FY3) with 12 months each
 * - Options in Cell A12 ("Use budget for income targets? Yes / No")
 * - Options in Cell A21 ("NB direct costs as a percentage? 0%=No")
 * - Row 3: New business to find income (manual monthly target input)
 * - Row 10: Total income target
 * - Row 12: Budget targets
 * - Row 14: NB to find figure based on target
 * - Row 18: NB to find figure to use
 * - Row 20: Direct costs %
 * - Row 23: NB to find direct costs to use
 * - Row 25: "Use NB to find?" Yes/No dropdown underneath each month
 * ============================================================================
 */

import { getSheetsClient, withRetry } from "./sheetsClient.js";
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

/**
 * Fetch and parse all NBtoFind data
 */
export async function fetchNBToFindData(clientName, clientSheetId, bypassCache = false) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cacheKey = `pma_nbtofind_${clientSheetId}`;

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
      console.warn("NBtoFind cache read error:", e?.message);
    }
  }

  const sheets = await getSheetsClient();

  const response = await withRetry(async () => {
    return await sheets.spreadsheets.values.batchGet({
      spreadsheetId: clientSheetId,
      ranges: [
        "NBtoFind!A1:AV25",
        "KeyInfo!B15",
      ],
      valueRenderOption: "FORMATTED_VALUE",
    });
  });

  const valueRanges = response.data.valueRanges || [];
  const rows = valueRanges[0]?.values || [];
  const keyInfoB15 = String(valueRanges[1]?.values?.[0]?.[0] || "").trim();

  // Resolve Revenue Focus / Mode ("Income" vs "Revenue") from KeyInfo!B15 or sheet labels
  const row3LabelRaw = String(rows[2]?.[0] || "").toLowerCase();
  const inferredFromSheet = row3LabelRaw.includes("income") ? "Income" : row3LabelRaw.includes("revenue") ? "Revenue" : "Revenue";
  const revenueFocus = keyInfoB15.toLowerCase() === "income" ? "Income" : keyInfoB15.toLowerCase() === "revenue" ? "Revenue" : inferredFromSheet;
  const modeTerm = revenueFocus; // "Income" | "Revenue"

  const row1 = rows[0] || [];

  // Define the 3 Financial Years
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

  // Extract cell A12 (Use budget for income targets?) and cell A21 (NB direct costs as a percentage?)
  const cellA12 = String(rows[11]?.[0] || "").trim(); // Row 12, index 11
  const cellA21 = String(rows[20]?.[0] || "").trim(); // Row 21, index 20

  const useBudgetForIncomeTargets = cellA12.toLowerCase() === "yes" ? "Yes" : "No";
  const directCostsPercentage = cellA21 || "0%";

  // Helper to extract a row's data across each FY
  const extractRowData = (rowIdx, defaultLabel) => {
    const r = rows[rowIdx] || [];
    const label = String(r[0] || defaultLabel).trim();
    const result = {};

    fyConfigs.forEach((fy) => {
      const months = fy.monthCols.map((m) => ({
        colLetter: m.colLetter,
        monthLabel: m.label,
        value: r[m.colIdx] || "",
      }));
      const total = r[fy.totalCol] || "£0";
      result[fy.id] = { label, months, total };
    });

    return { label, fyData: result };
  };

  // Row 3: New business to find income/revenue (manual inputs)
  const row3 = extractRowData(2, `New business to find ${modeTerm.toLowerCase()}`);
  // Row 10: Total income/revenue target
  const row10 = extractRowData(9, `Total ${modeTerm.toLowerCase()} target`);
  // Row 12: Use budget for income/revenue targets? (Budget values)
  const row12 = extractRowData(11, `Budget ${modeTerm.toLowerCase()} targets`);
  // Row 14: NB to find figure based on target
  const row14 = extractRowData(13, "NB to find figure based on target");
  // Row 18: NB to find figure to use (Final target figure)
  const row18 = extractRowData(17, "NB to find figure to use");
  // Row 20: NB direct costs as a percentage
  const row20 = extractRowData(19, "NB direct costs calculation");
  // Row 23: NB to find direct costs to use
  const row23 = extractRowData(22, "NB to find direct costs to use");

  // Row 25: "Use NB to find?" Yes/No dropdown for each month
  const row25Raw = rows[24] || [];
  const row25Label = String(row25Raw[0] || "Use NB to find?").trim();
  const row25 = { label: row25Label, fyData: {} };

  fyConfigs.forEach((fy) => {
    const months = fy.monthCols.map((m) => {
      const val = String(row25Raw[m.colIdx] || "").trim();
      return {
        colLetter: m.colLetter,
        monthLabel: m.label,
        value: val.toLowerCase() === "no" ? "No" : "Yes",
      };
    });
    row25.fyData[fy.id] = { label: row25Label, months };
  });

  const result = {
    success: true,
    clientName,
    clientSheetId,
    revenueFocus,
    modeTerm,
    defaultFyIndex,
    fyConfigs,
    settings: {
      useBudgetForIncomeTargets, // Cell A12
      directCostsPercentage,     // Cell A21
      revenueFocus,
      modeTerm,
    },
    sections: {
      row3,
      row10,
      row12,
      row14,
      row18,
      row20,
      row23,
      row25,
    },
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
    console.warn("NBtoFind cache write error:", e?.message);
  }

  return result;
}

/**
 * Save settings: Cell A12 ("Use budget for income targets?") and/or Cell A21 ("NB direct costs as a percentage")
 */
export async function saveNBToFindSettings({
  clientName,
  clientSheetId,
  useBudgetForIncomeTargets, // "Yes" | "No"
  directCostsPercentage,     // e.g. "0%", "15%"
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const updates = [];

  if (useBudgetForIncomeTargets !== undefined) {
    const cleanBudget = useBudgetForIncomeTargets === "Yes" || useBudgetForIncomeTargets === true ? "Yes" : "No";
    updates.push({
      range: "NBtoFind!A12",
      values: [[cleanBudget]],
    });
  }

  if (directCostsPercentage !== undefined) {
    let cleanPct = String(directCostsPercentage || "").trim();
    if (!cleanPct.endsWith("%") && !isNaN(parseFloat(cleanPct))) {
      cleanPct = `${cleanPct}%`;
    }
    if (!cleanPct) cleanPct = "0%";
    updates.push({
      range: "NBtoFind!A21",
      values: [[cleanPct]],
    });
  }

  if (updates.length === 0) return { success: true, updated: 0 };

  const sheets = await getSheetsClient();

  await withRetry(async () => {
    return await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });
  });

  // Invalidate cache
  const cacheKey = `pma_nbtofind_${clientSheetId}`;
  try {
    if (redisClient?.isOpen) await redisClient.del(cacheKey);
    else memoryCache.delete(cacheKey);
  } catch {}

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "UPDATE_NBTOFIND_SETTINGS",
    clientName,
    details: `Updated NBtoFind settings (Budget A12: ${useBudgetForIncomeTargets}, Direct Costs A21: ${directCostsPercentage})`,
  });

  return { success: true, updated: updates.length };
}

/**
 * Save monthly amounts for a given row in NBtoFind (Row 3 manual targets, Row 10 income targets, or Row 25 Yes/No)
 */
export async function saveNBToFindMonthlyValues({
  clientName,
  clientSheetId,
  sheetRow, // 3, 10, or 25
  monthlyValues, // { [colLetter]: value }
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");
  const rowNum = parseInt(sheetRow, 10);
  if (![3, 10, 25].includes(rowNum)) {
    throw new Error(`Invalid NBtoFind editable row: ${sheetRow}. Allowed rows are 3, 10, or 25.`);
  }

  if (!monthlyValues || typeof monthlyValues !== "object") {
    throw new Error("monthlyValues object is required");
  }

  const updates = [];
  for (const [colLetter, val] of Object.entries(monthlyValues)) {
    const cleanLetter = String(colLetter).toUpperCase().trim();
    if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
    let cleanVal = String(val ?? "").trim();
    if (rowNum === 25) {
      cleanVal = cleanVal.toLowerCase() === "no" ? "No" : "Yes";
    } else {
      cleanVal = sanitizeFormulaInput(cleanVal);
    }
    updates.push({
      range: `NBtoFind!${cleanLetter}${rowNum}`,
      values: [[cleanVal]],
    });
  }

  if (updates.length === 0) return { success: true, updated: 0 };

  const sheets = await getSheetsClient();

  await withRetry(async () => {
    return await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });
  });

  // Invalidate cache
  const cacheKey = `pma_nbtofind_${clientSheetId}`;
  try {
    if (redisClient?.isOpen) await redisClient.del(cacheKey);
    else memoryCache.delete(cacheKey);
  } catch {}

  await logPmaActivity({
    userEmail: userEmail || "system",
    action: "UPDATE_NBTOFIND_VALUES",
    clientName,
    details: `Updated ${updates.length} monthly value(s) in NBtoFind Row ${rowNum}`,
  });

  return { success: true, sheetRow: rowNum, updated: updates.length };
}
