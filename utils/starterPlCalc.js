/**
 * ============================================================================
 * STARTER PL PURE CALCULATION HELPERS (utils/starterPlCalc.js)
 * ============================================================================
 *
 * Client- & server-safe pure functions shared between starterPlService.js and
 * StarterPlModal.jsx so UK tax-band salary calculations and rounding rules have
 * a single source of truth without duplicating business logic.
 */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (raw === null || raw === undefined || raw === "") return 0;
  const cleaned = String(raw).replace(/[£$€,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function roundToNearest10(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return 0;
  return Math.round(v / 10) * 10;
}

export function roundToNearest50(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return 0;
  return Math.round(v / 50) * 50;
}

const MONTH_MAP_LOWER = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Parses common Pulse sheet date strings ("1-Sep-26", "2026-09-01", "01/09/2026")
 * into a local Date object or null.
 */
export function parseStarterPlDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dmy = /^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/.exec(s);
  if (dmy) {
    const m = MONTH_MAP_LOWER[dmy[2].toLowerCase()];
    if (m !== undefined) {
      let y = Number(dmy[3]);
      if (y < 100) y += y >= 70 ? 1900 : 2000;
      return new Date(y, m, Number(dmy[1]));
    }
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (slash) {
    let y = Number(slash[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    return new Date(y, Number(slash[2]) - 1, Number(slash[1]));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pure heuristic computing a vendor's future monthly forecast schedule across futureMonths:
 * - Active in all 3 of the previous 3 months -> every future month at avg rounded to £50.
 * - Else if consistent periodic cadence in window -> scheduled every k months at avg rounded to £50.
 * - Else -> £0 forecast across future months.
 */
export function computeVendorForecastSchedule(
  windowMonthAmounts = [],
  windowMonthDates = [],
  futureMonths = [],
  { shortFyFallbackPattern = null } = {}
) {
  const activeIndices = [];
  for (let i = 0; i < windowMonthAmounts.length; i++) {
    if ((Number(windowMonthAmounts[i]) || 0) > 0.005) {
      activeIndices.push(i);
    }
  }
  const forecastMap = {};
  for (const fm of futureMonths) forecastMap[fm.monthKey] = 0;

  if (activeIndices.length === 0) {
    return { pattern: "none", roundedAmount: 0, forecastByMonth: forecastMap };
  }

  const avgActive =
    activeIndices.reduce((s, idx) => s + Number(windowMonthAmounts[idx] || 0), 0) / activeIndices.length;
  const roundedAmount = roundToNearest50(avgActive);
  if (roundedAmount <= 0) {
    return { pattern: "none", roundedAmount: 0, forecastByMonth: forecastMap };
  }

  const len = windowMonthAmounts.length;
  const toDateObj = (d) => (d instanceof Date ? d : parseStarterPlDate(d) || new Date());

  // Short Current FY (< 3 checked months): if active in every checked FY month -> monthly;
  // or if trailing 12m established a monthly/periodic cadence, re-price using Current FY active average.
  if (len < 3) {
    if (activeIndices.length === len || shortFyFallbackPattern === "monthly") {
      for (const fm of futureMonths) forecastMap[fm.monthKey] = roundedAmount;
      return { pattern: "monthly", periodMonths: 1, roundedAmount, forecastByMonth: forecastMap };
    }
    if (shortFyFallbackPattern && /^every_(\d+)m$/.test(shortFyFallbackPattern)) {
      const periodMonths = Number(/^every_(\d+)m$/.exec(shortFyFallbackPattern)[1]) || 1;
      const lastDate = toDateObj(windowMonthDates[activeIndices[activeIndices.length - 1]]);
      const lastYm = lastDate.getFullYear() * 12 + lastDate.getMonth();
      for (const fm of futureMonths) {
        const fmDate = toDateObj(fm.dateObj || fm.monthKey);
        const diff = fmDate.getFullYear() * 12 + fmDate.getMonth() - lastYm;
        if (diff > 0 && diff % periodMonths === 0) forecastMap[fm.monthKey] = roundedAmount;
      }
      return { pattern: shortFyFallbackPattern, periodMonths, roundedAmount, forecastByMonth: forecastMap };
    }
    return { pattern: "irregular", roundedAmount: 0, forecastByMonth: forecastMap };
  }

  // Paid in all 3 of the latest 3 months OR all 3 of the 3 months leading up to the previous month
  const activeAllLatest3 =
    windowMonthAmounts[len - 1] > 0.005 &&
    windowMonthAmounts[len - 2] > 0.005 &&
    windowMonthAmounts[len - 3] > 0.005;
  const activeAllPrevToLatest3 =
    len >= 4 &&
    windowMonthAmounts[len - 2] > 0.005 &&
    windowMonthAmounts[len - 3] > 0.005 &&
    windowMonthAmounts[len - 4] > 0.005;

  if (activeAllLatest3 || activeAllPrevToLatest3) {
    for (const fm of futureMonths) forecastMap[fm.monthKey] = roundedAmount;
    return { pattern: "monthly", periodMonths: 1, roundedAmount, forecastByMonth: forecastMap };
  }

  // Check for consistent periodic cadence (>= 2 months; "monthly" requires the explicit 3-month rule above)
  if (activeIndices.length >= 2) {
    const deltas = [];
    for (let i = 1; i < activeIndices.length; i++) {
      deltas.push(activeIndices[i] - activeIndices[i - 1]);
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const medianPeriod = sorted[Math.floor(sorted.length / 2)];
    if (medianPeriod >= 2 && medianPeriod <= 12) {
      const matching = deltas.filter((d) => Math.abs(d - medianPeriod) <= (medianPeriod >= 3 ? 1 : 0));
      const isConsistent =
        activeIndices.length >= 3
          ? matching.length / deltas.length >= 0.65
          : medianPeriod >= 2 && medianPeriod <= 6 && activeIndices[activeIndices.length - 1] >= len - medianPeriod - 1;

      if (isConsistent) {
        const lastIdx = activeIndices[activeIndices.length - 1];
        const lastDate = windowMonthDates[lastIdx] ? toDateObj(windowMonthDates[lastIdx]) : null;
        if (lastDate) {
          const lastYm = lastDate.getFullYear() * 12 + lastDate.getMonth();
          for (const fm of futureMonths) {
            const fmDate = toDateObj(fm.dateObj || fm.monthKey);
            const diff = fmDate.getFullYear() * 12 + fmDate.getMonth() - lastYm;
            if (diff > 0 && diff % medianPeriod === 0) {
              forecastMap[fm.monthKey] = roundedAmount;
            }
          }
          return {
            pattern: medianPeriod === 1 ? "monthly" : `every_${medianPeriod}m`,
            periodMonths: medianPeriod,
            roundedAmount,
            forecastByMonth: forecastMap,
          };
        }
      }
    }
  }

  return { pattern: "irregular", roundedAmount: 0, forecastByMonth: forecastMap };
}

/**
 * Returns the KeyInfo!A77:T77 suffix prefix ("26", "27", "28", ...) matching
 * Salaries!P153: =concatenate(right(if(month(M153)<=3,year(M153),year(M153)+1),2),"a")
 */
export function getUkTaxYearPrefix(date) {
  let d = date instanceof Date ? date : null;
  if (!d && typeof date === "string") {
    const m = /^(\d{4})-(\d{2})/.exec(date.trim());
    if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    else {
      const parsed = new Date(date);
      if (!Number.isNaN(parsed.getTime())) d = parsed;
    }
  }
  if (!d) d = new Date();
  const taxYearEndYear = d.getMonth() + 1 <= 3 ? d.getFullYear() : d.getFullYear() + 1;
  return String(taxYearEndYear).slice(-2);
}

/**
 * Parses KeyInfo!A77:T105 grid into lookup helper matching MATCH(key, A77:T77, 0) & INDEX(A77:T105, row1, col).
 */
export function parseKeyInfoTaxTable(grid = []) {
  const headerRow = grid[0] || [];
  const colIndexByKey = new Map();
  for (let c = 0; c < headerRow.length; c++) {
    const k = String(headerRow[c] ?? "").trim().toLowerCase();
    if (k) colIndexByKey.set(k, c);
  }
  const availablePrefixes = [];
  for (const k of colIndexByKey.keys()) {
    const m = /^(\d{2})a$/.exec(k);
    if (m) availablePrefixes.push(m[1]);
  }
  availablePrefixes.sort();

  const valAt = (row1BasedInBlock, key) => {
    const cIdx = colIndexByKey.get(String(key).toLowerCase());
    if (cIdx === undefined) return 0;
    return parseNum(grid[row1BasedInBlock - 1]?.[cIdx]);
  };

  const getParamsForDate = (date) => {
    let prefix = getUkTaxYearPrefix(date);
    if (!colIndexByKey.has(`${prefix}a`) && availablePrefixes.length > 0) {
      const older = availablePrefixes.filter((p) => p <= prefix);
      prefix = older.length > 0 ? older[older.length - 1] : availablePrefixes[availablePrefixes.length - 1];
    }
    const ka = `${prefix}a`;
    const kb = `${prefix}b`;
    const kc = `${prefix}c`;
    return {
      taxYearPrefix: prefix,
      eeNicPT: valAt(3, ka) || 1048,
      eeNicUEL: valAt(4, ka) || 4189,
      eeNicMainRate: valAt(4, kb) || 0.08,
      eeNicMaxMain: valAt(4, kc) || 251,
      eeNicUpperRate: valAt(5, kb) || 0.02,
      erNicST: valAt(7, ka) || 417,
      erNicRate: valAt(8, kb) || 0.15,
      stLoanThresh: valAt(11, ka) || 2728,
      stLoanRate: valAt(11, kb) || 0.09,
      pensMin: valAt(14, ka) || 520,
      pensMax: valAt(15, ka) || 4189,
      pensEeRate: valAt(16, kb) || 0.05,
      pensErRate: valAt(17, kb) || 0.03,
      payePA: valAt(20, ka) || 1048,
      payeBasicLim: valAt(21, ka) || 4189,
      payeBasicRate: valAt(21, kb) || 0.2,
      payeBasicMax: valAt(21, kc) || 628,
      payeHigherLim: valAt(22, ka) || 10428,
      payeHigherRate: valAt(22, kb) || 0.4,
      payeHigherMax: valAt(22, kc) || 2496,
      payeAddRate: valAt(23, kb) || 0.45,
      taperStart: valAt(24, ka) || 8333,
      taperEnd: valAt(25, ka) || 10428,
      taperMaxExtra: valAt(25, kc) || 1048,
      taperFrac: valAt(26, ka) || 0.5,
    };
  };

  return { getParamsForDate };
}

/**
 * Computes Ee NIC, Er NIC, St Loan, Ee Pension, Er Pension, PAYE, and Net Pay from
 * a monthly Gross Salary using the exact formula logic of Salaries!M154:R154.
 */
export function computePayrollFromGross(grossPm, p, { stLoan = false, pension = true } = {}) {
  const gross = Math.max(0, round2(grossPm));
  if (gross <= 0) {
    return {
      grossSalary: 0,
      eeNic: 0,
      erNic: 0,
      studentLoan: 0,
      eePension: 0,
      erPension: 0,
      paye: 0,
      netPay: 0,
    };
  }

  let eeNic = 0;
  if (gross > p.eeNicUEL) {
    eeNic = p.eeNicMaxMain + (gross - p.eeNicUEL) * p.eeNicUpperRate;
  } else if (gross >= p.eeNicPT) {
    eeNic = (gross - p.eeNicPT) * p.eeNicMainRate;
  }

  const erNic = gross >= p.erNicST ? (gross - p.erNicST) * p.erNicRate : 0;

  const studentLoan =
    stLoan && gross > p.stLoanThresh ? (gross - p.stLoanThresh) * p.stLoanRate : 0;

  let eePension = 0;
  let erPension = 0;
  if (pension && gross >= p.pensMin) {
    const pensBase = Math.min(gross, p.pensMax) - p.pensMin;
    eePension = pensBase * p.pensEeRate;
    erPension = pensBase * p.pensErRate;
  }

  let basePaye = 0;
  if (gross >= p.payePA) {
    if (gross < p.payeBasicLim) {
      basePaye = (gross - p.payePA) * p.payeBasicRate;
    } else if (gross < p.payeHigherLim) {
      basePaye = p.payeBasicMax + (gross - p.payeBasicLim) * p.payeHigherRate;
    } else {
      basePaye = p.payeBasicMax + p.payeHigherMax + (gross - p.payeHigherLim) * p.payeAddRate;
    }
  }

  let taperPaye = 0;
  if (gross >= p.taperStart) {
    if (gross < p.taperEnd) {
      taperPaye = (gross - p.taperStart) * p.taperFrac * p.payeHigherRate;
    } else {
      taperPaye = p.taperMaxExtra * p.payeHigherRate;
    }
  }

  const paye = basePaye + taperPaye;
  const eeNicR = round2(eeNic);
  const erNicR = round2(erNic);
  const stLoanR = round2(studentLoan);
  const eePensR = round2(eePension);
  const erPensR = round2(erPension);
  const payeR = round2(paye);
  const netPayR = round2(gross - payeR - eeNicR - eePensR - stLoanR);

  return {
    grossSalary: gross,
    eeNic: eeNicR,
    erNic: erNicR,
    studentLoan: stLoanR,
    eePension: eePensR,
    erPension: erPensR,
    paye: payeR,
    netPay: netPayR,
  };
}

/**
 * Exact Budget!F59 cost-per-month formula replica:
 * (B/12) + ER NIC above KeyInfo!$B$83 at KeyInfo!$C$84 + ER Pension between B90..B91 at C93
 */
export function computeBudgetEmployeeCostPm(equivSalary, params = {}) {
  const b = Math.max(0, Number(equivSalary) || 0);
  if (b <= 0) return 0;
  const erNicST = Number(params.erNicST) || 417;
  const erNicRate = Number(params.erNicRate) || 0.15;
  const pensMin = Number(params.pensMin) || 520;
  const pensMax = Number(params.pensMax) || 4189;
  const pensErRate = Number(params.pensErRate) || 0.03;

  const grossPm = b / 12;
  const erNic = grossPm < erNicST ? 0 : (grossPm - erNicST) * erNicRate;
  const erPension =
    grossPm < pensMin
      ? 0
      : grossPm > pensMax
        ? (pensMax - pensMin) * pensErRate
        : (grossPm - pensMin) * pensErRate;
  return round2(grossPm + erNic + erPension);
}
