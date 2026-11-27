/**
 * ============================================================================
 * YEAR 0 CALCULATION & FORMATTING HELPERS (utils/year0Calc.js)
 * ============================================================================
 *
 * Shared pure helpers for computing live Year 0 P&L totals, margins,
 * dividend splits, and KPI margin threshold colours across both Setup
 * (Year0SetupModal) and PMA Setup > Year 0 (Year0EditView).
 */

export function roundYear0(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function toYear0InputStrings(arr) {
  return Array.from({ length: 12 }, (_, i) => {
    const n = Number(arr?.[i]);
    if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "";
    return String(roundYear0(n));
  });
}

export function parseYear0InputsToNumbers(arr) {
  return Array.from({ length: 12 }, (_, i) => {
    const raw = String(arr?.[i] ?? "").trim();
    if (!raw) return 0;
    const parsed = parseFloat(raw.replace(/[£$€,\s]/g, ""));
    return Number.isFinite(parsed) ? roundYear0(parsed) : 0;
  });
}

export function resolveYear0CurrencySymbol(currencySymbol, currencyCode = "GBP") {
  const raw = String(currencySymbol || currencyCode || "£").trim();
  const upper = raw.toUpperCase();
  if (upper === "EUR" || raw === "€") return "€";
  if (upper === "USD" || raw === "$") return "$";
  if (upper === "GBP" || raw === "£") return "£";
  return raw || "£";
}

/**
 * Computes live Year 0 P&L rows, margins, and 12-month totals from base data,
 * dividends in lieu of salary, delivery %, and monthly category adjustments.
 */
export function computeYear0PnL({
  data,
  deliveryPct = "0",
  dividendInputs = [],
  revAdjInputs = [],
  cosAdjInputs = [],
  ohAdjInputs = [],
}) {
  const months =
    data?.months && data.months.length === 12
      ? data.months
      : Array.from({ length: 12 }, (_, i) => ({ index: i, shortLabel: `M${i + 1}` }));
  const splitDelivery = data?.splitDelivery !== false;
  const baseRev = data?.baseData?.revenue || Array(12).fill(0);
  const baseCosStaff = data?.baseData?.cosStaff || Array(12).fill(0);
  const baseCosOther = data?.baseData?.cosOther || Array(12).fill(0);
  const baseNonCosStaff = data?.baseData?.nonCosStaff || Array(12).fill(0);
  const baseOhOther = data?.baseData?.overheadsOther || Array(12).fill(0);

  const pctNum = Math.max(0, Math.min(100, parseFloat(String(deliveryPct || "0")) || 0));
  const pctRatio = pctNum / 100;

  const divNums = parseYear0InputsToNumbers(dividendInputs);
  const revAdjs = parseYear0InputsToNumbers(revAdjInputs);
  const cosAdjs = parseYear0InputsToNumbers(cosAdjInputs);
  const ohAdjs = parseYear0InputsToNumbers(ohAdjInputs);

  const cosDiv = divNums.map((d) => roundYear0(d * pctRatio));
  const nonCosDiv = divNums.map((d, i) => roundYear0(d - cosDiv[i]));

  const revenueBase = Array.from({ length: 12 }, (_, m) => roundYear0(baseRev[m] || 0));
  const revenueTotal = Array.from({ length: 12 }, (_, m) => roundYear0(revenueBase[m] + revAdjs[m]));

  const cosBase = Array.from({ length: 12 }, (_, m) =>
    splitDelivery ? roundYear0((baseCosStaff[m] || 0) + (baseCosOther[m] || 0) + cosDiv[m]) : 0
  );
  const cosTotal = Array.from({ length: 12 }, (_, m) =>
    splitDelivery ? roundYear0(cosBase[m] + cosAdjs[m]) : 0
  );

  const grossProfit = Array.from({ length: 12 }, (_, m) => roundYear0(revenueTotal[m] - cosTotal[m]));
  const gpMargin = Array.from({ length: 12 }, (_, m) =>
    Math.abs(revenueTotal[m]) > 0.005 ? grossProfit[m] / revenueTotal[m] : 0
  );

  const overheadsBase = Array.from({ length: 12 }, (_, m) => {
    const nonDeliveryStaff =
      (baseNonCosStaff[m] || 0) + nonCosDiv[m] + (!splitDelivery ? (baseCosStaff[m] || 0) + cosDiv[m] : 0);
    return roundYear0(nonDeliveryStaff + (baseOhOther[m] || 0));
  });
  const overheadsTotal = Array.from({ length: 12 }, (_, m) => roundYear0(overheadsBase[m] + ohAdjs[m]));
  const overheadsPct = Array.from({ length: 12 }, (_, m) =>
    Math.abs(revenueTotal[m]) > 0.005 ? overheadsTotal[m] / revenueTotal[m] : 0
  );

  const operatingProfit = Array.from({ length: 12 }, (_, m) => roundYear0(grossProfit[m] - overheadsTotal[m]));
  const operatingProfitPct = Array.from({ length: 12 }, (_, m) =>
    Math.abs(revenueTotal[m]) > 0.005 ? operatingProfit[m] / revenueTotal[m] : 0
  );

  const sumArr = (arr) => roundYear0(arr.reduce((a, b) => a + (Number(b) || 0), 0));

  const totRev = sumArr(revenueTotal);
  const totCos = sumArr(cosTotal);
  const totGp = sumArr(grossProfit);
  const totOh = sumArr(overheadsTotal);
  const totOp = sumArr(operatingProfit);

  return {
    months,
    splitDelivery,
    baseRev: revenueBase,
    baseCosStaff,
    baseCosOther,
    baseNonCosStaff,
    baseOhOther,
    cosBase,
    overheadsBase,
    divNums,
    cosDiv,
    nonCosDiv,
    revAdjs,
    cosAdjs,
    ohAdjs,
    revenueTotal,
    cosTotal,
    grossProfit,
    gpMargin,
    overheadsTotal,
    overheadsPct,
    operatingProfit,
    operatingProfitPct,
    totals: {
      baseRev: sumArr(revenueBase),
      revAdj: sumArr(revAdjs),
      revenue: totRev,
      cosBase: sumArr(cosBase),
      cosAdj: sumArr(cosAdjs),
      cosTotal: totCos,
      grossProfit: totGp,
      gpMargin: Math.abs(totRev) > 0.005 ? totGp / totRev : 0,
      ohBase: sumArr(overheadsBase),
      ohAdj: sumArr(ohAdjs),
      overheadsTotal: totOh,
      overheadsPct: Math.abs(totRev) > 0.005 ? totOh / totRev : 0,
      operatingProfit: totOp,
      operatingProfitPct: Math.abs(totRev) > 0.005 ? totOp / totRev : 0,
      dividends: sumArr(divNums),
      cosDiv: sumArr(cosDiv),
      nonCosDiv: sumArr(nonCosDiv),
    },
  };
}

/**
 * Traffic-light conditional cell shading matching BudgetView.
 */
export function getYear0MarginColor(label, numVal, thresholds = []) {
  const t = Array.isArray(thresholds) ? thresholds : [];
  const parseT = (idx, def) => {
    const v = t[idx];
    if (v === undefined || v === null || v === "") return def;
    if (typeof v === "number") return v > 1 ? v / 100 : v;
    const n = parseFloat(String(v).replace(/%/g, "").trim());
    return isNaN(n) ? def : String(v).includes("%") || n > 1 ? n / 100 : n;
  };

  if (label.includes("Gross profit margin") || label.includes("Gross profit %")) {
    const z42 = parseT(0, 0.495);
    const z43 = parseT(1, 0.445);
    if (numVal < z43) return "#f4cccc";
    if (numVal <= z42) return "#fce5cd";
    return "#d9ead3";
  }
  if (label.includes("Overheads as %")) {
    const z47 = parseT(5, 0.309);
    const z48 = parseT(6, 0.2);
    if (numVal > z47) return "#f4cccc";
    if (numVal >= z48) return "#d9ead3";
    return "#fce5cd";
  }
  if (label.includes("Operating profit %")) {
    const z52 = parseT(10, 0.145);
    const z53 = parseT(11, 0.05);
    if (numVal < z53) return "#f4cccc";
    if (numVal <= z52) return "#fce5cd";
    return "#d9ead3";
  }
  return null;
}
