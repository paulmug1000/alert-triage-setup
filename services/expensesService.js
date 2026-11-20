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

import { waitUntil } from "@vercel/functions";
import { getSheetsClient, withRetry, getSheetGid, getSheetTitles, colLetterToNum, extractSheetIdFromUrl } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput, unwrapSheetId } from "./userPermissions.js";
import { memoryCache, resolvePortalCache, invalidatePmaClientCache } from "./cacheService.js";
import { redisClient } from "./redisClient.js";
import { getClients } from "./workspaces.js";

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
export async function fetchExpensesData(clientName, clientSheetId, bypassCache = false, options = {}) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
  const cacheKey = `pma_expenses_${cleanClientId}`;

  const cachedResult = await resolvePortalCache({
    cacheKey,
    bypassCache: Boolean(bypassCache),
    minBypassAgeMs: options?.minBypassAgeMs || 0,
    l1TtlSecs: 120,
    redisTtlSecs: 86400,
    isValidPayload: (p) => Boolean(p && p.success && Array.isArray(p.expenses)),
    fetchFreshFn: async () => {
      const sheets = await getSheetsClient();

      // Resolve client reconSheetId to inspect CR2 reconciliation status per month in parallel with Outgoings read
      let reconSheetId = null;
      try {
        const clients = await getClients();
        const match = (clients || []).find(
          (c) =>
            (c.clientSheetId && (extractSheetIdFromUrl(c.clientSheetId) || c.clientSheetId) === cleanClientId) ||
            (c.clientName && c.clientName.toLowerCase().trim() === clientName.toLowerCase().trim())
        );
        if (match) {
          reconSheetId = match.reconSheetId || extractSheetIdFromUrl(match.reconSheetUrl) || null;
        }
      } catch (err) {
        console.warn("Could not resolve reconSheetId for client:", clientName, err?.message);
      }

      const fetchReconMap = async () => {
        const map = {};
        if (!reconSheetId) return map;
        try {
          const reconTitleSet = await getSheetTitles(sheets, reconSheetId);
          const reconTabs = [...(reconTitleSet || [])].filter((t) => /^\d{4}$/.test(t));
          if (reconTabs.length > 0) {
            const batchRanges = reconTabs.map((t) => `'${t}'!CR2`);
            const batchResp = await withRetry(() =>
              sheets.spreadsheets.values.batchGet({
                spreadsheetId: reconSheetId,
                ranges: batchRanges,
                valueRenderOption: "FORMATTED_VALUE",
              })
            );
            const vRanges = batchResp.data.valueRanges || [];
            reconTabs.forEach((tab, idx) => {
              const val = vRanges[idx]?.values?.[0]?.[0];
              const isRecon = Boolean(val === true || String(val || "").trim().toUpperCase() === "TRUE");
              map[tab] = isRecon;
              const yy = parseInt(tab.slice(0, 2), 10);
              const mm = tab.slice(2, 4);
              const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
              map[`${fullYear}-${mm}`] = isRecon;
            });
          }
        } catch (e) {
          console.warn("Failed to fetch CR2 reconciliation status from Recon Sheet:", e?.message);
        }
        return map;
      };

      const [headerResp, gridResp, reconStatusMap] = await Promise.all([
        withRetry(async () => {
          return await sheets.spreadsheets.values.get({
            spreadsheetId: cleanClientId,
            range: "Outgoings!A1:AZ2",
            valueRenderOption: "FORMATTED_VALUE",
          });
        }),
        withRetry(async () => {
          return await sheets.spreadsheets.get({
            spreadsheetId: cleanClientId,
            ranges: ["Outgoings!A126:AZ228"],
            includeGridData: true,
            fields: "sheets.data.rowData.values(formattedValue,note)",
          });
        }),
        fetchReconMap(),
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
          const parsed = parseMonthYearHeader(rawHdr);

          let isReconciled = false;
          let tabName = null;
          let isoMonth = null;
          if (parsed) {
            tabName = `${String(parsed.year).slice(-2)}${String(parsed.monthIdx + 1).padStart(2, "0")}`;
            isoMonth = `${parsed.year}-${String(parsed.monthIdx + 1).padStart(2, "0")}`;
            isReconciled = Boolean(reconStatusMap[tabName] || reconStatusMap[isoMonth]);
          }

          monthCols.push({
            colIdx,
            colLetter,
            label: rawHdr || `M${j + 1}`,
            isReconciled,
            tabName,
            isoMonth,
          });

          // Check if current date falls in this FY
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

      // Parse Expense Rows (Rows 126 to 226, i.e. indices 0 to 100 in rowData; 225 & 226 are non-editable system rows)
      const expenses = [];
      let firstEmptyRow = null;

      for (let i = 0; i < 101; i++) {
        const sheetRow = 126 + i;
        const rValues = rowData[i]?.values || [];
        const category = String(rValues[0]?.formattedValue || "").trim();
        const vat = String(rValues[1]?.formattedValue || "").trim() || "No";
        const deliveryPct = String(rValues[4]?.formattedValue || "").trim() || "0%";
        const isHidden = category.toLowerCase() === "hide";
        const isSystemRow =
          sheetRow === 225 ||
          sheetRow === 226 ||
          /^recharged expenses\s*\((forecast|recovery)\)$/i.test(category) ||
          category.toLowerCase() === "recharged expenses recovery";
        const isPopulated = category !== "" && !isHidden;

        if (category === "" && !isSystemRow && sheetRow <= 224 && firstEmptyRow === null) {
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
              isReconciled: Boolean(m.isReconciled),
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
          isSystemRow,
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
        reconSheetId: reconSheetId || null,
        reconStatusMap,
        defaultFyIndex,
        fyConfigs,
        expenses,
        totals,
        firstAvailableRow: firstEmptyRow || null,
        lastUpdated: new Date().toISOString(),
      };

      return result;
    },
  });

  return cachedResult.data;
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
  _skipFormulaRecompute = false,
}) {
  if (!clientSheetId) throw new Error("Client identifier is required.");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 224) {
    throw new Error("Invalid or system-managed expense entry.");
  }

  const cleanCategory = sanitizeFormulaInput(category || "");
  const cleanVat = vat === "Yes" || vat === true ? "Yes" : "No";
  const pctNum = parseFloat(String(deliveryPct ?? "").replace(/%/g, "").trim());
  const cleanDelPct = Number.isFinite(pctNum) ? `${Math.max(0, Math.min(100, pctNum))}%` : "0%";

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
      _skipFormulaRecompute,
      _deferBackgroundRecompute: !_skipFormulaRecompute,
    });
  });

  await invalidateExpensesCaches(clientSheetId);

  waitUntil(
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_EXPENSE_ROW",
      clientName,
      details: `Updated expense entry "${cleanCategory}" (VAT: ${cleanVat}, Del: ${cleanDelPct})`,
    }).catch(() => { })
  );

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
  if (!clientSheetId) throw new Error("Client identifier is required.");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 224) {
    throw new Error("Invalid or system-managed expense entry.");
  }

  const isDel = targetDelivery === true || targetDelivery === "100%" || targetDelivery === "delivery";
  const newDelPct = isDel ? "100%" : "0%";

  const sheets = await getSheetsClient();

  await withRetry(async () => {
    return await sheets.spreadsheets.values.update({
      spreadsheetId: clientSheetId,
      range: `Outgoings!E${rowNum}`,
      valueInputOption: "USER_ENTERED",
      _deferBackgroundRecompute: true,
      requestBody: {
        values: [[newDelPct]],
      },
    });
  });

  await invalidateExpensesCaches(clientSheetId);

  waitUntil(
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "MOVE_EXPENSE_CATEGORY",
      clientName,
      details: `Moved expense entry to ${isDel ? "Delivery" : "Non-delivery"} (${newDelPct})`,
    }).catch(() => { })
  );

  return { success: true, sheetRow: rowNum, deliveryPct: newDelPct };
}

const isOutgoingsMonthlyCol = (colIdx) =>
  (colIdx >= 6 && colIdx <= 17) || (colIdx >= 21 && colIdx <= 32) || (colIdx >= 36 && colIdx <= 47);

async function invalidateExpensesCaches(clientSheetId) {
  const cleanId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
  const cacheKeys = new Set([`pma_expenses_${cleanId}`, `pma_expenses_${clientSheetId}`]);
  try {
    for (const k of cacheKeys) {
      memoryCache.del(k);
      if (redisClient?.isOpen) await redisClient.del(k);
    }
    await invalidatePmaClientCache(cleanId, null, ["outgoings", "views", "cash"]);
  } catch { }
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
  prefetchedData = null,
}) {
  if (!clientSheetId) throw new Error("Client identifier is required.");
  const rowNum = parseInt(sheetRow, 10);
  if (isNaN(rowNum) || rowNum < 126 || rowNum > 224) {
    throw new Error("Invalid or system-managed expense entry.");
  }

  // Verify CR2 gate: if any target column belongs to a reconciled month, reject modification
  const currentData = prefetchedData || (await fetchExpensesData(clientName, clientSheetId, false));
  const reconciledColLetters = new Set();
  (currentData?.fyConfigs || []).forEach((fy) => {
    (fy.monthCols || []).forEach((m) => {
      if (m.isReconciled && m.colLetter) {
        reconciledColLetters.add(m.colLetter.toUpperCase());
      }
    });
  });

  const targetCols = [
    ...Object.keys(monthlyAmounts || {}),
    ...Object.keys(cellNotes || {}),
  ].map((c) => String(c).toUpperCase().trim());

  for (const c of targetCols) {
    if (reconciledColLetters.has(c)) {
      throw new Error("Cannot modify expenses for a reconciled month.");
    }
  }

  const dataUpdates = [];
  if (monthlyAmounts && typeof monthlyAmounts === "object") {
    for (const [colLetter, val] of Object.entries(monthlyAmounts)) {
      const cleanLetter = String(colLetter).toUpperCase().trim();
      if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
      const colIdx = colLetterToNum(cleanLetter) - 1;
      if (!isOutgoingsMonthlyCol(colIdx)) continue;
      const cleanVal = sanitizeFormulaInput(String(val ?? "").trim());
      dataUpdates.push({
        range: `Outgoings!${cleanLetter}${rowNum}`,
        values: [[cleanVal]],
      });
    }
  }

  const sheets = await getSheetsClient();
  const hasNoteUpdates = Boolean(
    cellNotes &&
    typeof cellNotes === "object" &&
    Object.keys(cellNotes).some((k) => {
      const cleanLetter = String(k).toUpperCase().trim();
      if (!/^[A-Z]{1,2}$/.test(cleanLetter)) return false;
      return isOutgoingsMonthlyCol(colLetterToNum(cleanLetter) - 1);
    })
  );

  if (dataUpdates.length > 0) {
    await withRetry(async () => {
      return await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        _skipFormulaRecompute: hasNoteUpdates,
        _deferBackgroundRecompute: true,
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
      if (!isOutgoingsMonthlyCol(colIdx)) continue;
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
          _deferBackgroundRecompute: true,
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

  await invalidateExpensesCaches(clientSheetId);

  waitUntil(
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_EXPENSE_AMOUNTS",
      clientName,
      details: `Updated ${dataUpdates.length} monthly expense amount(s)`,
    }).catch(() => { })
  );

  return { success: true, sheetRow: rowNum, updated: dataUpdates.length };
}

/**
 * Batch save monthly expense amounts and cell notes across multiple rows and columns.
 */
export async function saveExpenseBatch({
  clientName,
  clientSheetId,
  updates = [], // [{ sheetRow, colLetter, value }]
  cellNotes = [], // [{ sheetRow, colLetter, note }]
  userEmail,
}) {
  if (!clientSheetId) throw new Error("Client identifier is required.");

  const currentData = await fetchExpensesData(clientName, clientSheetId, false);
  const reconciledColLetters = new Set();
  (currentData?.fyConfigs || []).forEach((fy) => {
    (fy.monthCols || []).forEach((m) => {
      if (m.isReconciled && m.colLetter) {
        reconciledColLetters.add(m.colLetter.toUpperCase());
      }
    });
  });

  const systemRowSet = new Set([225, 226]);
  (currentData?.expenses || []).forEach((exp) => {
    if (exp.isSystemRow) systemRowSet.add(exp.sheetRow);
  });

  // Deduplicate by cell coordinate (last update wins)
  const dedupedValues = new Map();
  for (const up of updates || []) {
    const rowNum = parseInt(up?.sheetRow, 10);
    const cleanLetter = String(up?.colLetter || "").toUpperCase().trim();
    if (isNaN(rowNum) || rowNum < 126 || rowNum > 224 || systemRowSet.has(rowNum)) continue;
    if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
    const colIdx = colLetterToNum(cleanLetter) - 1;
    if (!isOutgoingsMonthlyCol(colIdx)) continue;
    if (reconciledColLetters.has(cleanLetter)) {
      throw new Error("Cannot modify expenses for a reconciled month.");
    }
    const cleanVal = sanitizeFormulaInput(String(up?.value ?? "").trim());
    dedupedValues.set(`${rowNum}_${cleanLetter}`, {
      range: `Outgoings!${cleanLetter}${rowNum}`,
      values: [[cleanVal]],
    });
  }

  const dedupedNotes = new Map();
  for (const cn of cellNotes || []) {
    const rowNum = parseInt(cn?.sheetRow, 10);
    const cleanLetter = String(cn?.colLetter || "").toUpperCase().trim();
    if (isNaN(rowNum) || rowNum < 126 || rowNum > 224 || systemRowSet.has(rowNum)) continue;
    if (!/^[A-Z]{1,2}$/.test(cleanLetter)) continue;
    const colIdx = colLetterToNum(cleanLetter) - 1;
    if (!isOutgoingsMonthlyCol(colIdx)) continue;
    if (reconciledColLetters.has(cleanLetter)) {
      throw new Error("Cannot modify expenses for a reconciled month.");
    }
    dedupedNotes.set(`${rowNum}_${cleanLetter}`, {
      rowNum,
      colIdx,
      note: String(cn?.note ?? ""),
    });
  }

  const dataUpdates = Array.from(dedupedValues.values());
  const noteItems = Array.from(dedupedNotes.values());

  if (dataUpdates.length === 0 && noteItems.length === 0) {
    return { success: true, savedValuesCount: 0, savedNotesCount: 0 };
  }

  const sheets = await getSheetsClient();

  if (noteItems.length > 0) {
    const gid = await getSheetGid(sheets, clientSheetId, "Outgoings");
    const noteRequests = noteItems.map((item) => ({
      updateCells: {
        range: {
          sheetId: gid,
          startRowIndex: item.rowNum - 1,
          endRowIndex: item.rowNum,
          startColumnIndex: item.colIdx,
          endColumnIndex: item.colIdx + 1,
        },
        rows: [{ values: [{ note: item.note }] }],
        fields: "note",
      },
    }));

    await withRetry(async () => {
      return await sheets.spreadsheets.batchUpdate({
        spreadsheetId: clientSheetId,
        _skipFormulaRecompute: dataUpdates.length > 0,
        requestBody: {
          requests: noteRequests,
        },
      });
    });
  }

  if (dataUpdates.length > 0) {
    await withRetry(async () => {
      return await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        _deferBackgroundRecompute: true,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: dataUpdates,
        },
      });
    });
  }

  await invalidateExpensesCaches(clientSheetId);

  const summary = [];
  if (dataUpdates.length > 0) {
    summary.push(`${dataUpdates.length} amount${dataUpdates.length > 1 ? "s" : ""}`);
  }
  if (noteItems.length > 0) {
    summary.push(`${noteItems.length} note${noteItems.length > 1 ? "s" : ""}`);
  }

  waitUntil(
    logPmaActivity({
      userEmail: userEmail || "system",
      action: "UPDATE_EXPENSE_AMOUNTS",
      clientName,
      details: `Batch updated ${summary.join(" and ")} in expenses`,
    }).catch(() => { })
  );

  return {
    success: true,
    savedValuesCount: dataUpdates.length,
    savedNotesCount: noteItems.length,
  };
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
  if (!clientSheetId) throw new Error("Client identifier is required.");
  const cleanCategory = sanitizeFormulaInput(String(category || "").trim());
  if (!cleanCategory) throw new Error("Expense category name is required.");

  // First fetch current data to find the first empty row
  const currentData = await fetchExpensesData(clientName, clientSheetId, true);
  const targetRow = currentData.firstAvailableRow;
  if (!targetRow || targetRow > 224) {
    throw new Error("All editable expense slots are currently full.");
  }

  const hasMonthlyAmounts = Boolean(monthlyAmounts && Object.keys(monthlyAmounts).length > 0);

  // Save metadata
  await saveExpenseMetadata({
    clientName,
    clientSheetId,
    sheetRow: targetRow,
    category: cleanCategory,
    vat,
    deliveryPct,
    userEmail,
    _skipFormulaRecompute: hasMonthlyAmounts,
  });

  // If monthly amounts provided, save them too (reuse already-fetched currentData)
  if (hasMonthlyAmounts) {
    await saveExpenseAmount({
      clientName,
      clientSheetId,
      sheetRow: targetRow,
      monthlyAmounts,
      userEmail,
      prefetchedData: currentData,
    });
  }

  return { success: true, sheetRow: targetRow, category: cleanCategory };
}
