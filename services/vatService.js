/**
 * ============================================================================
 * VAT SERVICE
 * ============================================================================
 * Reads VAT calculations from Client Sheet "VAT" tab (A1:AX29) and VAT settings
 * from "KeyInfo" (B6: VAT quarters, B8: VAT payment scheme, C4:D5: currency):
 * - Accrual scheme: Rows 3-15 (Confirmed only: 3-8, Total: 10-15)
 * - Cash scheme: Rows 17-29 (Confirmed only: 17-22, Total: 24-29)
 * - Computes 3-month "VAT return totals" per section across the full 36-month
 *   horizon (spanning financial year boundaries when VAT quarters straddle FYs).
 * ============================================================================
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { unwrapSheetId } from "./userPermissions.js";
import { resolvePortalCache } from "./cacheService.js";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

export function parseMonthYearHeader(label) {
  if (label === null || label === undefined || label === "") return null;
  if (typeof label === "number" && label > 20000 && label < 100000) {
    const d = new Date(Math.round((label - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) {
      const m = d.getUTCMonth();
      const y = d.getUTCFullYear();
      return { monthIdx: m, year: y, label: `${SHORT_MONTHS[m]} ${String(y).slice(-2)}` };
    }
  }
  const s = String(label).trim();
  if (!s) return null;

  // e.g. "Apr 26", "Apr '26", "Apr-26", "Sept 2026"
  const m1 = s.match(/^([A-Za-z]{3,9})[\s\-']*(\d{2,4})$/);
  if (m1) {
    const monthIdx = MONTH_NAMES.indexOf(m1[1].toLowerCase().slice(0, 3));
    if (monthIdx !== -1) {
      let year = parseInt(m1[2], 10);
      if (year < 100) year += 2000;
      return { monthIdx, year, label: `${SHORT_MONTHS[monthIdx]} ${String(year).slice(-2)}` };
    }
  }

  // ISO YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const monthIdx = parseInt(iso[2], 10) - 1;
    if (monthIdx >= 0 && monthIdx <= 11) {
      return { monthIdx, year, label: `${SHORT_MONTHS[monthIdx]} ${String(year).slice(-2)}` };
    }
  }

  // DD/MM/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let year = parseInt(slash[3], 10);
    if (year < 100) year += 2000;
    const monthIdx = parseInt(slash[2], 10) - 1;
    if (monthIdx >= 0 && monthIdx <= 11) {
      return { monthIdx, year, label: `${SHORT_MONTHS[monthIdx]} ${String(year).slice(-2)}` };
    }
  }

  return null;
}

/**
 * Derive quarter modulo (0, 1, or 2) from KeyInfo!B6 ("VAT quarters").
 * - "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec" -> 0 (months 0,3,6,9 start quarters)
 * - "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan" -> 1 (months 1,4,7,10 start quarters)
 * - "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb" -> 2 (months 2,5,8,11 start quarters)
 */
export function getVatQuarterMod(vatQuartersStr) {
  const s = String(vatQuartersStr || "").trim().toLowerCase();
  if (!s) return 0;
  const firstMonthMatch = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!firstMonthMatch) return 0;
  const idx = MONTH_NAMES.indexOf(firstMonthMatch[1]);
  return idx >= 0 ? idx % 3 : 0;
}

export function formatPeriodLabel(periodStartAbs) {
  const periodEndAbs = periodStartAbs + 2;
  const startYear = Math.floor(periodStartAbs / 12);
  const startMonth = ((periodStartAbs % 12) + 12) % 12;
  const endYear = Math.floor(periodEndAbs / 12);
  const endMonth = ((periodEndAbs % 12) + 12) % 12;
  const startYr2 = String(startYear).slice(-2);
  const endYr2 = String(endYear).slice(-2);
  if (startYear === endYear) {
    return `${SHORT_MONTHS[startMonth]}–${SHORT_MONTHS[endMonth]} ${endYr2}`;
  }
  return `${SHORT_MONTHS[startMonth]} ${startYr2}–${SHORT_MONTHS[endMonth]} ${endYr2}`;
}

function parseNumericCell(unformattedVal, formattedVal) {
  const fStr = formattedVal !== undefined && formattedVal !== null ? String(formattedVal).trim() : "";
  if (fStr.startsWith("#")) {
    return { num: 0, isError: true, rawDisplay: fStr };
  }
  if (typeof unformattedVal === "number" && !isNaN(unformattedVal)) {
    return { num: unformattedVal, isError: false, rawDisplay: fStr };
  }
  const uStr = unformattedVal !== undefined && unformattedVal !== null ? String(unformattedVal).trim() : "";
  const candidate = uStr || fStr;
  if (!candidate || candidate === "-" || candidate === "£-" || candidate === "$-" || candidate === "€-") {
    return { num: 0, isError: false, rawDisplay: fStr };
  }
  const isNeg = (candidate.startsWith("(") && candidate.endsWith(")")) || candidate.startsWith("-");
  const cleaned = candidate.replace(/[£$€,\s()]/g, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) {
    return { num: 0, isError: false, rawDisplay: fStr };
  }
  return { num: isNeg ? -Math.abs(parsed) : parsed, isError: false, rawDisplay: fStr };
}

function buildSectionPayload({
  sectionKey,
  headerRowIdx,
  lineRowIndices,
  totalRowIdx,
  defaultHeaderTitle,
  defaultLineLabels,
  formattedRows,
  unformattedRows,
  fyConfigs,
  allMonths,
  quarterMod,
}) {
  const title = String(formattedRows[headerRowIdx]?.[0] || "").trim() || defaultHeaderTitle;

  const extractRowValues = (rowIdx, defaultLabel, isTotalRow = false) => {
    const fRow = formattedRows[rowIdx] || [];
    // unformattedRows starts at G4 (row 4 = idx 0, col G = idx 0 -> colIdx - 6)
    const uRowIdx = rowIdx - 3;
    const uRow = uRowIdx >= 0 ? (unformattedRows[uRowIdx] || []) : [];
    const label = String(fRow[0] || "").trim() || defaultLabel;

    const byGlobalMonth = allMonths.map((m) => {
      const fVal = fRow[m.colIdx];
      const uVal = uRow[m.colIdx - 6];
      return parseNumericCell(uVal, fVal);
    });

    const fyData = {};
    fyConfigs.forEach((fy) => {
      const months = fy.monthCols.map((m) => {
        const parsed = byGlobalMonth[m.globalIdx] || { num: 0, isError: false, rawDisplay: "" };
        return {
          colIdx: m.colIdx,
          colLetter: m.colLetter,
          label: m.label,
          value: parsed.num,
          isError: parsed.isError,
          rawDisplay: parsed.rawDisplay,
        };
      });

      const fTotalVal = fRow[fy.totalCol];
      const uTotalVal = uRow[fy.totalCol - 6];
      const parsedTotal = parseNumericCell(uTotalVal, fTotalVal);
      // Fallback to sum of 12 months if sheet total cell is blank
      const fyTotalValue =
        (uTotalVal === undefined || uTotalVal === "" || uTotalVal === null) && !parsedTotal.isError
          ? months.reduce((acc, item) => acc + item.value, 0)
          : parsedTotal.num;

      fyData[fy.id] = {
        months,
        total: fyTotalValue,
        isError: parsedTotal.isError,
      };
    });

    return {
      sheetRow: rowIdx + 1,
      label,
      isTotalRow,
      byGlobalMonth,
      fyData,
    };
  };

  const rows = [
    ...lineRowIndices.map((rIdx, i) => extractRowValues(rIdx, defaultLineLabels[i], false)),
    extractRowValues(totalRowIdx, "VAT owed to HMRC", true),
  ];

  const hmrcRow = rows[rows.length - 1];

  // Build 3-month VAT return totals per FY, summing all 3 months across FY boundaries
  const vatReturnTotalsByFy = {};
  fyConfigs.forEach((fy) => {
    const fyMonths = allMonths.filter((m) => m.fyIdx === fy.index);
    const groups = [];
    for (const m of fyMonths) {
      if (m.absMonth === null || m.absMonth === undefined) {
        groups.push({
          key: `m_${m.globalIdx}`,
          periodLabel: m.label,
          colSpan: 1,
          total: hmrcRow.byGlobalMonth[m.globalIdx]?.num || 0,
          includedCount: 1,
          includedMonths: [m.label],
          isAlignedFullQuarter: false,
        });
        continue;
      }

      const monthMod = ((m.monthIdx - quarterMod) % 3 + 3) % 3;
      const periodStartAbs = m.absMonth - monthMod;
      const periodEndAbs = periodStartAbs + 2;

      const last = groups[groups.length - 1];
      if (last && last.periodStartAbs === periodStartAbs) {
        last.colSpan += 1;
      } else {
        const matchingMonths = allMonths.filter(
          (am) => am.absMonth !== null && am.absMonth >= periodStartAbs && am.absMonth <= periodEndAbs
        );
        const total = matchingMonths.reduce(
          (sum, am) => sum + (hmrcRow.byGlobalMonth[am.globalIdx]?.num || 0),
          0
        );
        groups.push({
          key: `p_${periodStartAbs}`,
          periodStartAbs,
          periodEndAbs,
          periodLabel: formatPeriodLabel(periodStartAbs),
          colSpan: 1,
          total,
          includedCount: matchingMonths.length,
          includedMonths: matchingMonths.map((am) => am.label),
          isCrossFyBoundary: matchingMonths.some((am) => am.fyIdx !== fy.index),
        });
      }
    }

    const isFullyAlignedFy = groups.length === 4 && groups.every((g) => g.colSpan === 3 && g.includedCount === 3);
    const fyReturnSum = isFullyAlignedFy ? groups.reduce((acc, g) => acc + g.total, 0) : null;

    vatReturnTotalsByFy[fy.id] = {
      groups,
      isFullyAlignedFy,
      fyReturnSum,
    };
  });

  return {
    key: sectionKey,
    title,
    rows: rows.map(({ byGlobalMonth, ...rest }) => rest),
    vatReturnTotalsByFy,
  };
}

/**
 * Fetch and parse VAT tab data + VAT settings for a client.
 */
export async function fetchVatData(clientName, clientSheetId, bypassCache = false) {
  if (!clientSheetId) throw new Error("Client Sheet ID is required");

  const cleanClientId = unwrapSheetId(extractSheetIdFromUrl(clientSheetId) || clientSheetId);
  const cacheKey = `pma_vat_${cleanClientId}`;

  const cachedResult = await resolvePortalCache({
    cacheKey,
    bypassCache: Boolean(bypassCache),
    l1TtlSecs: 120,
    redisTtlSecs: 86400,
    isValidPayload: (p) => Boolean(p && p.success && Array.isArray(p.sections) && Array.isArray(p.fyConfigs)),
    fetchFreshFn: async () => {
      const sheets = await getSheetsClient();

      const [formattedRes, unformattedRes] = await Promise.all([
        withRetry(async () => {
          return await sheets.spreadsheets.values.batchGet({
            spreadsheetId: cleanClientId,
            ranges: [
              "VAT!A1:AX29",
              "KeyInfo!B6:B8",
              "KeyInfo!C4:D5",
            ],
            valueRenderOption: "FORMATTED_VALUE",
          });
        }),
        withRetry(async () => {
          return await sheets.spreadsheets.values.batchGet({
            spreadsheetId: cleanClientId,
            ranges: ["VAT!G4:AX29"],
            valueRenderOption: "UNFORMATTED_VALUE",
          });
        }),
      ]);

      const fRanges = formattedRes.data.valueRanges || [];
      const formattedRows = fRanges[0]?.values || [];
      const keyInfoB6B8 = fRanges[1]?.values || [];
      const currencyRows = fRanges[2]?.values || [];
      const unformattedRows = unformattedRes.data.valueRanges?.[0]?.values || [];

      if (!formattedRows.length) {
        throw new Error("VAT data could not be found for this client.");
      }

      const vatQuarters = String(keyInfoB6B8[0]?.[0] || "").trim() || "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec";
      const rawScheme = String(keyInfoB6B8[2]?.[0] || "").trim();
      const vatScheme = rawScheme.toLowerCase().includes("cash") ? "Cash" : "Accrual";
      const quarterMod = getVatQuarterMod(vatQuarters);

      const rawCurrencySymbol = String(
        currencyRows?.[0]?.[1] ||
        (currencyRows?.[0]?.[0] && currencyRows?.[0]?.[0] !== "Tracker currency" ? currencyRows?.[0]?.[0] : "") ||
        "£"
      ).trim() || "£";
      let currencySymbol = rawCurrencySymbol;
      if (currencySymbol.toUpperCase() === "EUR" || currencySymbol === "€") currencySymbol = "€";
      else if (currencySymbol.toUpperCase() === "GBP" || currencySymbol === "£") currencySymbol = "£";
      else if (currencySymbol.toUpperCase() === "USD" || currencySymbol === "$") currencySymbol = "$";

      const rawThousandsSeparator = String(
        currencyRows?.[1]?.[1] ||
        (currencyRows?.[1]?.[0] && currencyRows?.[1]?.[0] !== "Thous. separator" ? currencyRows?.[1]?.[0] : "") ||
        ""
      ).trim();
      const thousandsSeparator = rawThousandsSeparator || (currencySymbol === "€" ? "." : ",");

      const row1 = formattedRows[0] || [];
      const fyDefs = [
        { index: 0, id: "fy1", startCol: 6, count: 12, totalCol: 19 },
        { index: 1, id: "fy2", startCol: 21, count: 12, totalCol: 34 },
        { index: 2, id: "fy3", startCol: 36, count: 12, totalCol: 49 },
      ];

      const now = new Date();
      let defaultFyIndex = 0;
      let prevAbsMonth = null;
      const allMonths = [];

      const fyConfigs = fyDefs.map((def, fIdx) => {
        const rawTotalHeader = String(row1[def.totalCol] || "").trim();
        const fyLabel = rawTotalHeader ? rawTotalHeader.replace(/\s*total$/i, "").trim() : `FY${fIdx + 1}`;
        const totalHeaderLabel = rawTotalHeader || `${fyLabel} total`;
        const monthCols = [];

        for (let j = 0; j < def.count; j++) {
          const colIdx = def.startCol + j;
          const rawHdr = String(row1[colIdx] || "").trim();
          const colLetter = colIdxToLetter(colIdx);
          let parsed = parseMonthYearHeader(rawHdr);

          if (!parsed && prevAbsMonth !== null) {
            const inferredAbs = prevAbsMonth + 1;
            const y = Math.floor(inferredAbs / 12);
            const m = ((inferredAbs % 12) + 12) % 12;
            parsed = { monthIdx: m, year: y, label: `${SHORT_MONTHS[m]} ${String(y).slice(-2)}` };
          }

          const absMonth = parsed ? parsed.year * 12 + parsed.monthIdx : null;
          if (absMonth !== null) {
            prevAbsMonth = absMonth;
            const mDate = new Date(parsed.year, parsed.monthIdx, 1);
            const mEnd = new Date(parsed.year, parsed.monthIdx + 1, 0, 23, 59, 59);
            if (now >= mDate && now <= mEnd) {
              defaultFyIndex = fIdx;
            }
          }

          const globalIdx = allMonths.length;
          const mObj = {
            globalIdx,
            fyIdx: fIdx,
            colIdx,
            colLetter,
            label: parsed?.label || rawHdr || `M${j + 1}`,
            year: parsed?.year ?? null,
            monthIdx: parsed?.monthIdx ?? null,
            absMonth,
          };
          allMonths.push(mObj);
          monthCols.push(mObj);
        }

        return {
          index: def.index,
          id: def.id,
          label: fyLabel,
          totalHeaderLabel,
          totalCol: def.totalCol,
          totalColLetter: colIdxToLetter(def.totalCol),
          monthCols,
        };
      });

      const isCash = vatScheme === "Cash";
      const sections = isCash
        ? [
            buildSectionPayload({
              sectionKey: "confirmed",
              headerRowIdx: 16, // Row 17
              lineRowIndices: [17, 18, 19, 20], // Rows 18-21
              totalRowIdx: 21, // Row 22
              defaultHeaderTitle: "VAT - confirmed only (cash)",
              defaultLineLabels: [
                "Input VAT on contractors",
                "Input VAT on other expenses",
                "Input VAT on confirmed 3P invoices",
                "Output VAT on confirmed invoices",
              ],
              formattedRows,
              unformattedRows,
              fyConfigs,
              allMonths,
              quarterMod,
            }),
            buildSectionPayload({
              sectionKey: "total",
              headerRowIdx: 23, // Row 24
              lineRowIndices: [24, 25, 26, 27], // Rows 25-28
              totalRowIdx: 28, // Row 29
              defaultHeaderTitle: "VAT - total (cash)",
              defaultLineLabels: [
                "Input VAT on contractors",
                "Input VAT on other expenses",
                "Input VAT on total 3P invoices",
                "Output VAT on total invoices",
              ],
              formattedRows,
              unformattedRows,
              fyConfigs,
              allMonths,
              quarterMod,
            }),
          ]
        : [
            buildSectionPayload({
              sectionKey: "confirmed",
              headerRowIdx: 2, // Row 3
              lineRowIndices: [3, 4, 5, 6], // Rows 4-7
              totalRowIdx: 7, // Row 8
              defaultHeaderTitle: "VAT - confirmed only (accrual)",
              defaultLineLabels: [
                "Input VAT on contractors",
                "Input VAT on other expenses",
                "Input VAT on confirmed 3P invoices",
                "Output VAT on confirmed invoices",
              ],
              formattedRows,
              unformattedRows,
              fyConfigs,
              allMonths,
              quarterMod,
            }),
            buildSectionPayload({
              sectionKey: "total",
              headerRowIdx: 9, // Row 10
              lineRowIndices: [10, 11, 12, 13], // Rows 11-14
              totalRowIdx: 14, // Row 15
              defaultHeaderTitle: "VAT - total (accrual)",
              defaultLineLabels: [
                "Input VAT on contractors",
                "Input VAT on other expenses",
                "Input VAT on total 3P invoices",
                "Output VAT on total invoices",
              ],
              formattedRows,
              unformattedRows,
              fyConfigs,
              allMonths,
              quarterMod,
            }),
          ];

      return {
        success: true,
        clientName: clientName || "Client",
        clientSheetId: cleanClientId,
        vatScheme,
        vatQuarters,
        currencySymbol,
        thousandsSeparator,
        fyConfigs,
        defaultFyIndex,
        sections,
        lastUpdated: new Date().toISOString(),
      };
    },
  });

  return cachedResult.data;
}
