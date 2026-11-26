/**
 * ============================================================================
 * CREATE BUDGET SETUP SERVICE (services/budgetSetupService.js)
 * ============================================================================
 *
 * Seeds and saves the client's FY1 Budget tab (Client!Budget) during onboarding
 * (`p3_other_expenses`: "Create budget") using data already established in Setup:
 * - Revenue & Direct costs from Confirmed + Pipeline + NB to find (Dashboard / Performance / NBtoFind)
 * - Salaries from Client!Salaries (actuals for historical months, formula/Equiv salary for future)
 * - Dividends in lieu of salary, Contractors, and Other expenses from Client!Outgoings
 * - Making up CoS (Budget!B142) defaulted to 0%
 */

import {
  getSheetsClient,
  withRetry,
  extractSheetIdFromUrl,
  colIndexToLetter,
} from "./sheetsClient.js";
import { unwrapSheetId } from "./sheetTokenService.js";
import { parseYear0Date, parseYear0Number } from "./year0SetupService.js";
import { parseHeaderMonthMeta_ } from "./salariesService.js";
import { invalidatePmaClientCache } from "./cacheService.js";
import {
  flushImmediateAndScheduleBackgroundClientRecomputes,
  resolveClientSheetIdFromMaster,
  resolveSupabaseSheetContext,
} from "./masterEngineService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { sanitizeFormulaInput } from "./userPermissions.js";
import { toSheetDateFormat } from "../utils/helpers.js";
import {
  computeBudgetEmployeeCostPm,
  parseStarterPlDate,
} from "../utils/starterPlCalc.js";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveCleanId(rawId) {
  if (!rawId) return "";
  const unwrapped = unwrapSheetId(String(rawId).trim());
  return extractSheetIdFromUrl(unwrapped) || unwrapped;
}

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shortMonthLabel(d) {
  return `${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

function formatDMmmYy(d) {
  return `${d.getDate()}-${SHORT_MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Loads FY1 Budget setup seed data combining Dashboard/Performance/NBtoFind,
 * Salaries (actuals + roster), and Outgoings (Dividends, Contractors, Other expenses).
 */
export async function pullBudgetSetupData({ clientName, masterSheetId }) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: [
        "KeyInfo!B2",
        "KeyInfo!B15:B17",
        "KeyInfo!D8",
        "KeyInfo!X28",
        "StarterPL!Q82:AB82",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );

  const mvr = kiResp.data?.valueRanges || [];
  const startDate = parseYear0Date(mvr[0]?.values?.[0]?.[0]);
  if (!startDate) throw new Error("A valid start date is required in KeyInfo!B2.");
  const b15to17 = mvr[1]?.values || [];
  const isIncomeMode = String(b15to17[0]?.[0] || "Revenue").trim().toLowerCase() === "income";
  const isGpMethod = String(b15to17[1]?.[0] || "Yes").trim().toLowerCase() !== "no";
  const currency = String(b15to17[2]?.[0] || "GBP").trim() || "GBP";
  const directCostsMode = isIncomeMode
    ? "Pass-through"
    : String(mvr[2]?.values?.[0]?.[0] || "Contractors").trim();
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: mvr[3]?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");
  const starterPlChk = mvr[4]?.values?.[0] || [];

  const clientResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanClientId,
      ranges: [
        "Budget!A1:R255",
        "Dashboard!A1:R20",
        "Performance!A1:R18",
        "NBtoFind!A1:R8",
        "Salaries!A1:JC55",
        "Outgoings!A1:R227",
        "KeyInfo!A80:D96",
      ],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cvr = clientResp.data?.valueRanges || [];
  const budgetGrid = cvr[0]?.values || [];
  const dashGrid = cvr[1]?.values || [];
  const perfGrid = cvr[2]?.values || [];
  const nbGrid = cvr[3]?.values || [];
  const salGrid = cvr[4]?.values || [];
  const outgGrid = cvr[5]?.values || [];
  const kiRatesGrid = cvr[6]?.values || [];

  // Parse KeyInfo payroll parameters (B83, C84, B90, B91, C93)
  const budgetFormulaParams = {
    erNicST: parseYear0Number(kiRatesGrid[3]?.[1]) || 417, // Row 83
    erNicRate: parseYear0Number(kiRatesGrid[4]?.[2]) || 0.15, // Row 84
    pensMin: parseYear0Number(kiRatesGrid[10]?.[1]) || 520, // Row 90
    pensMax: parseYear0Number(kiRatesGrid[11]?.[1]) || 4189, // Row 91
    pensErRate: parseYear0Number(kiRatesGrid[13]?.[2]) || 0.03, // Row 93
  };

  // Build 12 FY1 month descriptors from Budget!G1:R1 (fallback KeyInfo!B2)
  const fy1Months = [];
  const bRow1 = budgetGrid[0] || [];
  for (let i = 0; i < 12; i++) {
    const col0 = 6 + i; // G=6 .. R=17
    const parsedHdr = parseHeaderMonthMeta_(bRow1[col0]);
    const fallbackD = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const dObj = parsedHdr ? new Date(parsedHdr.year, parsedHdr.monthIdx, 1) : fallbackD;
    fy1Months.push({
      col0,
      colLetter: colIndexToLetter(col0 + 1),
      monthIndex: i,
      monthKey: monthKeyFromDate(dObj),
      shortLabel: shortMonthLabel(dObj),
      dateObj: dObj,
    });
  }

  // Determine historical months: use StarterPL checkboxes if any were set, else <= prev calendar month
  const now = new Date();
  const prevCalYm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevCalMonthYm = prevCalYm.getFullYear() * 12 + prevCalYm.getMonth();
  const hasExplicitStarterChk = starterPlChk.some(
    (v) => v === true || String(v).toUpperCase() === "TRUE"
  );
  const historicalMonthKeys = [];
  for (let i = 0; i < fy1Months.length; i++) {
    const m = fy1Months[i];
    const mYm = m.dateObj.getFullYear() * 12 + m.dateObj.getMonth();
    const isHist = hasExplicitStarterChk
      ? starterPlChk[i] === true || String(starterPlChk[i]).toUpperCase() === "TRUE"
      : mYm <= prevCalMonthYm;
    if (isHist) historicalMonthKeys.push(m.monthKey);
  }
  const histSet = new Set(historicalMonthKeys);

  // 1. Seed Revenue (R5..7) & Direct Costs (R13..15) from Dashboard / Performance / NBtoFind
  const read12Cols = (grid, row1, fallbackGrid = null, fallbackRow1 = null) => {
    const out = {};
    fy1Months.forEach((m, idx) => {
      const c = 6 + idx;
      let val = parseYear0Number(grid[row1 - 1]?.[c]);
      if (val === 0 && fallbackGrid && fallbackRow1) {
        val = parseYear0Number(fallbackGrid[fallbackRow1 - 1]?.[c]);
      }
      out[m.monthKey] = round2(val);
    });
    return out;
  };

  const revenueRows = {
    confirmed: read12Cols(dashGrid, 4, perfGrid, 5),
    pipeline: read12Cols(dashGrid, 5, perfGrid, 6),
    nbToFind: read12Cols(dashGrid, 6, nbGrid, 3),
  };

  const directCostRows = {
    confirmed: read12Cols(perfGrid, 13),
    pipeline: read12Cols(perfGrid, 14),
    nbToFind: read12Cols(perfGrid, 15, nbGrid, 5),
  };

  // 2. Seed Salaries from Client!Salaries (A4:I53 roster + L4:JC53 historical actuals)
  const salHdrRow1 = salGrid[0] || [];
  const salColByMonthKey = new Map();
  for (let c = 11; c < salHdrRow1.length; c += 7) {
    const parsed = parseHeaderMonthMeta_(salHdrRow1[c]);
    if (!parsed) continue;
    const mk = monthKeyFromDate(new Date(parsed.year, parsed.monthIdx, 1));
    salColByMonthKey.set(mk, c);
  }

  const salaryRows = [];
  for (let r = 3; r <= 52; r++) {
    const row = salGrid[r] || [];
    const name = String(row[0] || "").trim();
    if (!name) continue;
    const fteSalary = parseYear0Number(row[2]);
    const fte = parseYear0Number(row[3]) || 1;
    const equivSalary = round2(fteSalary * fte);
    const startRaw = row[4];
    const endRaw = row[5];
    const startD = parseYear0Date(startRaw);
    const endD = parseYear0Date(endRaw);
    const startDateStr = startD ? formatDMmmYy(startD) : formatDMmmYy(startDate);
    const endDateStr = endD ? formatDMmmYy(endD) : "";
    const delRaw = parseYear0Number(row[6]);
    const deliveryPct = round2(delRaw <= 1 && delRaw > 0 ? delRaw * 100 : delRaw);

    const monthlyValues = {};
    const costPm = computeBudgetEmployeeCostPm(equivSalary, budgetFormulaParams);
    for (const m of fy1Months) {
      if (histSet.has(m.monthKey)) {
        const sc = salColByMonthKey.get(m.monthKey);
        if (sc !== undefined) {
          // Actual employer cost = Gross Salary (sc+0) + Er NIC (sc+2) + Er Pension (sc+5)
          const actualEmployerCost = round2(
            parseYear0Number(row[sc]) +
            parseYear0Number(row[sc + 2]) +
            parseYear0Number(row[sc + 5])
          );
          monthlyValues[m.monthKey] = actualEmployerCost;
        } else {
          monthlyValues[m.monthKey] = 0;
        }
      } else {
        const sDate = startD || startDate;
        const sYm = sDate.getFullYear() * 12 + sDate.getMonth();
        const eYm = endD ? endD.getFullYear() * 12 + endD.getMonth() : Infinity;
        const mYm = m.dateObj.getFullYear() * 12 + m.dateObj.getMonth();
        monthlyValues[m.monthKey] = mYm >= sYm && mYm <= eYm ? costPm : 0;
      }
    }

    salaryRows.push({
      id: `bud-sal-${salaryRows.length + 1}`,
      name,
      equivSalary,
      startDate: startDateStr,
      endDate: endDateStr,
      deliveryPct,
      monthlyValues,
    });
  }

  // 3. Seed Dividends in lieu of salary from Outgoings!Row 118
  const divRowOutg = outgGrid[117] || [];
  const divDelRaw = parseYear0Number(divRowOutg[4]);
  const dividendRow = {
    name: String(divRowOutg[0] || "Div in lieu of salary").trim(),
    deliveryPct: round2(divDelRaw <= 1 && divDelRaw > 0 ? divDelRaw * 100 : divDelRaw),
    monthlyValues: Object.fromEntries(
      fy1Months.map((m, idx) => [m.monthKey, round2(parseYear0Number(divRowOutg[6 + idx]))])
    ),
  };

  // 4. Seed Contractors from Outgoings!A13:R110 (excluding Making up CoS rows 111..112)
  const rawContractors = [];
  for (let r = 12; r <= 109; r++) {
    const row = outgGrid[r] || [];
    const name = String(row[0] || "").trim();
    if (!name || /total contractor|making up cos/i.test(name)) continue;
    const delRaw = parseYear0Number(row[4]);
    const deliveryPct = row[4] === "" || row[4] === undefined ? 100 : round2(delRaw <= 1 ? delRaw * 100 : delRaw);
    const monthlyValues = {};
    let total = 0;
    fy1Months.forEach((m, idx) => {
      const v = round2(parseYear0Number(row[6 + idx]));
      monthlyValues[m.monthKey] = v;
      total += Math.abs(v);
    });
    if (total === 0 && rawContractors.length >= 14) continue;
    rawContractors.push({
      id: `bud-con-${rawContractors.length + 1}`,
      name,
      deliveryPct,
      monthlyValues,
      totalAbs: total,
    });
  }

  // Budget!127..140 has 14 contractor slots; consolidate overflow cleanly if > 14
  let contractorRows = rawContractors;
  if (rawContractors.length > 14) {
    const sorted = [...rawContractors].sort((a, b) => b.totalAbs - a.totalAbs);
    const top13 = sorted.slice(0, 13);
    const rest = sorted.slice(13);
    const otherVals = {};
    for (const m of fy1Months) {
      otherVals[m.monthKey] = round2(rest.reduce((s, r) => s + (r.monthlyValues[m.monthKey] || 0), 0));
    }
    contractorRows = [
      ...top13,
      {
        id: "bud-con-14",
        name: "Other contractors",
        deliveryPct: 100,
        monthlyValues: otherVals,
      },
    ];
  }

  // 5. Seed Other expenses from Outgoings!A126:R224 (excl. Recharged expenses & Total lines)
  const expenseRows = [];
  for (let r = 125; r <= 223; r++) {
    const row = outgGrid[r] || [];
    const name = String(row[0] || "").trim();
    if (!name) continue;
    if (/^recharged expenses|^total\b|^non-operating|^profit share/i.test(name)) continue;
    const delRaw = parseYear0Number(row[4]);
    const deliveryPct = round2(delRaw <= 1 && delRaw > 0 ? delRaw * 100 : delRaw);
    const monthlyValues = {};
    fy1Months.forEach((m, idx) => {
      monthlyValues[m.monthKey] = round2(parseYear0Number(row[6 + idx]));
    });
    expenseRows.push({
      id: `bud-exp-${expenseRows.length + 1}`,
      name,
      deliveryPct,
      monthlyValues,
    });
  }

  return {
    clientName: clientName || "",
    currency,
    isIncomeMode,
    isGpMethod,
    directCostsMode,
    startDateFormatted: formatDMmmYy(startDate),
    fy1Months: fy1Months.map((m) => ({
      col0: m.col0,
      colLetter: m.colLetter,
      monthKey: m.monthKey,
      shortLabel: m.shortLabel,
      isHistorical: histSet.has(m.monthKey),
    })),
    historicalMonthKeys,
    budgetFormulaParams,
    revenueRows,
    directCostRows,
    salaryRows,
    dividendRow,
    contractorRows,
    makingUpCosPct: 0, // Default to 0% per requirements
    expenseRows,
  };
}

/**
 * Saves the approved FY1 Budget back to Client!Budget while preserving formula cells.
 */
export async function saveBudgetSetupData({
  clientName,
  masterSheetId,
  fy1Months = [],
  historicalMonthKeys = [],
  revenueRows = {},
  directCostRows = {},
  salaryRows = [],
  dividendRow = {},
  contractorRows = [],
  makingUpCosPct = 0,
  expenseRows = [],
}) {
  const cleanMasterId = resolveCleanId(masterSheetId);
  if (!cleanMasterId) throw new Error("Master workspace ID is required.");

  const sheets = await getSheetsClient();
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!X28",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const cleanClientId = await resolveClientSheetIdFromMaster({
    clientName,
    masterSheetId: cleanMasterId,
    rawKeyInfoX28: kiResp.data?.values?.[0]?.[0] || "",
  });
  if (!cleanClientId) throw new Error("Client workspace sheet ID is not configured.");

  const histSet = new Set(historicalMonthKeys || []);
  const mCols = Array.from({ length: 12 }, (_, i) => {
    const rawKey = String(fy1Months?.[i]?.monthKey || "").trim();
    const safeKey = /^\d{4}-\d{2}$/.test(rawKey) ? rawKey : `m-${i}`;
    const colLetter = colIndexToLetter(7 + i);
    if (!/^[G-R]$/.test(colLetter)) {
      throw new Error("Invalid Budget month column offset.");
    }
    return {
      colLetter,
      monthKey: safeKey,
    };
  });

  // 1. Revenue (R5..7) & Direct Costs (R13..15)
  const build12Row = (obj) => mCols.map((m) => round2(parseYear0Number(obj?.[m.monthKey])));
  const dataWrites = [
    {
      range: "Budget!G5:R7",
      values: [
        build12Row(revenueRows.confirmed),
        build12Row(revenueRows.pipeline),
        build12Row(revenueRows.nbToFind),
      ],
    },
    {
      range: "Budget!G13:R15",
      values: [
        build12Row(directCostRows.confirmed),
        build12Row(directCostRows.pipeline),
        build12Row(directCostRows.nbToFind),
      ],
    },
  ];

  // 2. Salaries Roster (Budget!A59:E108) & Monthly cells (Budget!G59:R108)
  // Historical checked months write static actuals; future months preserve live template formulas
  const salCount = 50; // Rows 59..108
  const finalSal = (salaryRows || []).slice(0, salCount);
  const salMetaRows = Array.from({ length: salCount }, (_, idx) => {
    const s = finalSal[idx];
    if (!s) return ["", 0, "", "", 1];
    const startRaw = String(s.startDate || "").trim();
    const endRaw = String(s.endDate || "").trim();
    const startFormatted = startRaw ? (toSheetDateFormat(startRaw) || sanitizeFormulaInput(startRaw)) : "";
    const endFormatted = endRaw ? (toSheetDateFormat(endRaw) || sanitizeFormulaInput(endRaw)) : "";
    return [
      sanitizeFormulaInput(String(s.name || "").trim()),
      round2(parseYear0Number(s.equivSalary)),
      startFormatted,
      endFormatted,
      Math.max(0, Math.min(100, parseYear0Number(s.deliveryPct))) / 100,
    ];
  });
  dataWrites.push({ range: "Budget!A59:E108", values: salMetaRows });

  const salMonthGrid = Array.from({ length: salCount }, (_, idx) => {
    const row1 = 59 + idx;
    const emp = finalSal[idx];
    return mCols.map((m) => {
      if (emp && histSet.has(m.monthKey)) {
        const val = round2(parseYear0Number(emp.monthlyValues?.[m.monthKey]));
        return val;
      }
      const cLet = m.colLetter;
      return `=if($B${row1}=0,"",if(AND($C${row1}<=${cLet}$1,OR($D${row1}>${cLet}$1,$D${row1}="")),$F${row1},""))`;
    });
  });
  dataWrites.push({ range: "Budget!G59:R108", values: salMonthGrid });

  // 3. Dividends (Budget!E119 & G119:R119)
  const divDelRatio = Math.max(0, Math.min(100, parseYear0Number(dividendRow?.deliveryPct))) / 100;
  dataWrites.push({ range: "Budget!E119", values: [[divDelRatio]] });
  dataWrites.push({
    range: "Budget!G119:R119",
    values: [build12Row(dividendRow?.monthlyValues)],
  });

  // 4. Contractors (Budget!R127..140: 14 slots)
  const conSlots = 14;
  const finalCons = (contractorRows || []).slice(0, conSlots);
  const conNames = [];
  const conDels = [];
  const conMonths = [];
  for (let i = 0; i < conSlots; i++) {
    const c = finalCons[i];
    if (!c) {
      conNames.push([""]);
      conDels.push([1]);
      conMonths.push(Array(12).fill(""));
    } else {
      conNames.push([sanitizeFormulaInput(String(c.name || "").trim())]);
      conDels.push([Math.max(0, Math.min(100, parseYear0Number(c.deliveryPct ?? 100))) / 100]);
      conMonths.push(
        mCols.map((m) => {
          const v = round2(parseYear0Number(c.monthlyValues?.[m.monthKey]));
          return v === 0 ? "" : v;
        })
      );
    }
  }
  dataWrites.push({ range: "Budget!A127:A140", values: conNames });
  dataWrites.push({ range: "Budget!E127:E140", values: conDels });
  dataWrites.push({ range: "Budget!G127:R140", values: conMonths });

  // 5. Making up CoS (Budget!B142)
  const mucRatio = Math.max(0, Math.min(100, parseYear0Number(makingUpCosPct))) / 100;
  dataWrites.push({ range: "Budget!B142", values: [[mucRatio]] });

  // 6. Other expenses (Budget!R150..251: 102 slots)
  const expSlots = 102; // Rows 150..251
  const finalExps = (expenseRows || []).slice(0, expSlots);
  const expNames = [];
  const expDels = [];
  const expMonths = [];
  for (let i = 0; i < expSlots; i++) {
    const ex = finalExps[i];
    if (!ex) {
      expNames.push([""]);
      expDels.push([0]);
      expMonths.push(Array(12).fill(""));
    } else {
      expNames.push([sanitizeFormulaInput(String(ex.name || "").trim())]);
      expDels.push([Math.max(0, Math.min(100, parseYear0Number(ex.deliveryPct))) / 100]);
      expMonths.push(
        mCols.map((m) => {
          const v = round2(parseYear0Number(ex.monthlyValues?.[m.monthKey]));
          return v === 0 ? "" : v;
        })
      );
    }
  }
  dataWrites.push({ range: "Budget!A150:A251", values: expNames });
  dataWrites.push({ range: "Budget!E150:E251", values: expDels });
  dataWrites.push({ range: "Budget!G150:R251", values: expMonths });

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: cleanClientId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: dataWrites,
      },
    })
  );

  const flushCtx = await resolveSupabaseSheetContext({
    clientName: clientName || "",
    spreadsheetId: cleanClientId || cleanMasterId,
  }).catch(() => null);
  const flushTargetClient = flushCtx?.clientName || clientName || "";
  if (flushTargetClient) {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, flushTargetClient).catch(() => {});
  }
  await invalidatePmaClientCache(cleanClientId, cleanMasterId, ["budget", "performance", "dashboard", "views", "all"]).catch(() => {});

  await logPmaActivity(sheets, {
    clientName: clientName || "",
    category: "SETUP",
    action: "BUDGET_CREATED",
    summary: `Created FY1 Budget (${finalSal.length} salary row(s), ${finalCons.length} contractor(s), ${finalExps.length} expense line(s), Making up CoS ${round2(makingUpCosPct)}%)`,
    details: { makingUpCosPct },
  }).catch(() => {});

  return {
    success: true,
    salariesWritten: finalSal.length,
    contractorsWritten: finalCons.length,
    expensesWritten: finalExps.length,
  };
}
