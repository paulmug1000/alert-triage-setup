import React, { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "../Spinner";
import {
  parseKeyInfoTaxTable,
  computePayrollFromGross,
  computeVendorForecastSchedule,
  parseStarterPlDate,
  roundToNearest10,
  roundToNearest50,
} from "../../utils/starterPlCalc";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatMoney(val, currency = "GBP", decimals = 0) {
  const num = Number(val) || 0;
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

function parseNumericInput(raw) {
  if (raw === "" || raw === null || raw === undefined) return 0;
  const parsed = parseFloat(String(raw).replace(/[£$€,\s]/g, ""));
  return Number.isFinite(parsed) ? round2(parsed) : 0;
}

const SALARY_COL_DEFS = [
  { key: "grossSalary", label: "Salary" },
  { key: "eeNic", label: "Ee NIC" },
  { key: "erNic", label: "Er NIC" },
  { key: "studentLoan", label: "St loan" },
  { key: "eePension", label: "Ee pens" },
  { key: "erPension", label: "Er pens" },
  { key: "paye", label: "PAYE" },
];

const WIZARD_STEPS = [
  { num: 1, id: "salaries", label: "1. Salaries" },
  { id: 2, id: "contractors", label: "2. Contractors" },
  { id: 3, id: "dividends", label: "3. Dividends in lieu of salary" },
  { id: 4, id: "expenses", label: "4. Other expenses" },
  { id: 5, id: "pnl", label: "5. Full-year P&L" },
];

const MAPPING_SECTION_OPTIONS = [
  { id: "cos_staff", label: "CoS staff costs" },
  { id: "non_cos_staff", label: "Non-CoS staff costs" },
  { id: "other_cos", label: "Other costs of sale" },
  { id: "depreciation", label: "Depreciation" },
  { id: "non_op_income", label: "Non-operating income" },
  { id: "non_op_expenses", label: "Non-operating expenses" },
  { id: "corp_tax", label: "Corporation tax" },
  { id: "revenue", label: "Revenue" },
  { id: "ignore", label: "Ignore" },
];

export default function StarterPlModal({
  clientName,
  masterSheetId,
  isAdmin = false,
  isOpen,
  onClose,
  onCompleted,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [data, setData] = useState(null);

  const [currentStep, setCurrentStep] = useState(1); // 1..5 guided steps
  const [checkedMonthKeys, setCheckedMonthKeys] = useState([]);
  const [forecastBasis, setForecastBasis] = useState("trailing12"); // "trailing12" | "currentFy"
  const [showIndividualFutureExpenseMonths, setShowIndividualFutureExpenseMonths] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [pnlYearView, setPnlYearView] = useState(1); // 1 | 2 on Step 5

  // Editable sections state
  const [expenseItems, setExpenseItems] = useState([]);
  const [depreciationItem, setDepreciationItem] = useState(null);
  const [nonOpIncomeItems, setNonOpIncomeItems] = useState([]);
  const [nonOpExpenseItems, setNonOpExpenseItems] = useState([]);

  // Pending mapping selections & in-flight state per category name
  const [mappingSelections, setMappingSelections] = useState({});
  const [mappingBusyCat, setMappingBusyCat] = useState("");

  // Contractors state + drag-and-drop state + basis toggle
  const [contractors, setContractors] = useState([]);
  const [contractorForecastBasis, setContractorForecastBasis] = useState("trailing12"); // "trailing12" | "currentFy"
  const [dragPayload, setDragPayload] = useState(null); // { sourceVendorId, txnId }
  const [dropHoverTarget, setDropHoverTarget] = useState(null); // `${vendorId}__${monthKey}`
  const [bulkForecastVendorInput, setBulkForecastVendorInput] = useState({});
  const [historyVendorId, setHistoryVendorId] = useState("");

  const loadRequestIdRef = useRef(0);
  const abortControllerRef = useRef(null);

  // Salaries state
  const [salaryEmployees, setSalaryEmployees] = useState([]);
  const [combineSalariesAsSingleRow, setCombineSalariesAsSingleRow] = useState(false);
  const [expandedSalaryMonthKey, setExpandedSalaryMonthKey] = useState("");

  // Dividends state
  const [divDeliveryPct, setDivDeliveryPct] = useState("0");
  const [divMonthlyByKey, setDivMonthlyByKey] = useState({});
  const [divApplyFutureVal, setDivApplyFutureVal] = useState("");

  const computeAvgForBasis = (cat, basis, checkedKeys, allMonths) => {
    if (!cat) return 0;
    if (basis === "trailing12") return roundToNearest10(cat.trailing12mAvg ?? 0);
    const fy1Keys = (allMonths || [])
      .filter((m) => Number(m.fyIndex) === 1 && checkedKeys.includes(m.monthKey))
      .map((m) => m.monthKey);
    if (fy1Keys.length === 0) return 0;
    const sum = fy1Keys.reduce((acc, mk) => acc + (Number(cat.monthlyByKey?.[mk]) || 0), 0);
    return roundToNearest10(sum / fy1Keys.length);
  };

  const prepareExpenseItem = (cat, basis, checkedKeys, allMonths) => {
    const forecastAmount = computeAvgForBasis(cat, basis, checkedKeys, allMonths);
    return {
      ...cat,
      forecastAmount,
      manualForecastOverride: false,
      forecastMonthlyByKey: {},
    };
  };

  const hydrateFromPayload = (payload) => {
    setData(payload);
    const defaultChecked = Array.isArray(payload?.defaultCheckedMonthKeys)
      ? payload.defaultCheckedMonthKeys
      : [];
    const months = payload?.outgoingsMonths || [];
    setCheckedMonthKeys(defaultChecked);
    setForecastBasis("trailing12");
    setConfirmOverwrite(!(payload?.hasExistingOutgoings || payload?.hasExistingSalaries));
    setMappingSelections({});
    setMappingBusyCat("");
    setHistoryVendorId("");

    setExpenseItems(
      (payload?.expenseCategories || []).map((c) =>
        prepareExpenseItem(c, "trailing12", defaultChecked, months)
      )
    );
    setDepreciationItem(
      payload?.depreciationItem
        ? prepareExpenseItem(payload.depreciationItem, "trailing12", defaultChecked, months)
        : null
    );
    setNonOpIncomeItems(
      (payload?.nonOpIncomeCategories || []).map((c) =>
        prepareExpenseItem(c, "trailing12", defaultChecked, months)
      )
    );
    setNonOpExpenseItems(
      (payload?.nonOpExpenseCategories || []).map((c) =>
        prepareExpenseItem(c, "trailing12", defaultChecked, months)
      )
    );

    setContractors(
      (payload?.contractors || []).map((c) => ({
        ...c,
        manualForecastOverride: false,
        historicalTransactions: (c.historicalTransactions || []).map((t) => ({
          ...t,
          assignedMonthKey: t.assignedMonthKey || t.monthKey,
        })),
        forecastByMonth: { ...(c.forecastByMonth || {}) },
      }))
    );
    setContractorForecastBasis("trailing12");

    const emps = payload?.salaryEmployees || [];
    setSalaryEmployees(emps.map((e) => ({ ...e, monthlyOverrides: { ...(e.monthlyOverrides || {}) } })));
    setCombineSalariesAsSingleRow(emps.length <= 1);
    setExpandedSalaryMonthKey(defaultChecked[defaultChecked.length - 1] || "");

    setDivDeliveryPct(String(round2(payload?.dividends?.deliveryPct ?? 0)));
    setDivMonthlyByKey({ ...(payload?.dividends?.monthlyByKey || {}) });
    setDivApplyFutureVal(
      payload?.dividends?.forecastDefaultAmount
        ? String(round2(payload.dividends.forecastDefaultAmount))
        : ""
    );
  };

  const loadStarterPl = async () => {
    if (!clientName) return;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const reqId = ++loadRequestIdRef.current;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/starter-pl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "pull_and_analyse",
          clientName,
          masterSheetId,
        }),
      });
      const json = await res.json();
      if (reqId !== loadRequestIdRef.current) return;
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to pull P&L and transaction data." });
      } else {
        hydrateFromPayload(json);
      }
    } catch (err) {
      if (err?.name === "AbortError" || reqId !== loadRequestIdRef.current) return;
      setFeedback({ type: "error", message: err?.message || "Failed to load StarterPL data." });
    } finally {
      if (reqId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!isOpen || !clientName) return;
    setCurrentStep(1);
    setPnlYearView(1);
    setDragPayload(null);
    setDropHoverTarget(null);
    loadStarterPl();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, masterSheetId]);

  const currency = data?.currency || "GBP";
  const outgoingsMonths = useMemo(() => data?.outgoingsMonths || [], [data]);
  const fy1Months = useMemo(
    () => outgoingsMonths.filter((m) => Number(m.fyIndex) === 1),
    [outgoingsMonths]
  );
  const fy2Months = useMemo(
    () => outgoingsMonths.filter((m) => Number(m.fyIndex) === 2),
    [outgoingsMonths]
  );
  const checkedSet = useMemo(() => new Set(checkedMonthKeys), [checkedMonthKeys]);
  const checkedMonths = useMemo(
    () => outgoingsMonths.filter((m) => Number(m.fyIndex) === 1 && checkedSet.has(m.monthKey)),
    [outgoingsMonths, checkedSet]
  );
  const futureMonths = useMemo(
    () => outgoingsMonths.filter((m) => !checkedSet.has(m.monthKey)),
    [outgoingsMonths, checkedSet]
  );

  // Recalculate non-overridden forecast defaults when basis or checked months change
  const applyForecastBasis = (nextBasis, nextCheckedKeys) => {
    const syncList = (list) =>
      list.map((item) => {
        if (item.manualForecastOverride) return item;
        const nextAvg = computeAvgForBasis(item, nextBasis, nextCheckedKeys, outgoingsMonths);
        return { ...item, forecastAmount: nextAvg, forecastMonthlyByKey: {} };
      });
    setExpenseItems(syncList);
    setNonOpIncomeItems(syncList);
    setNonOpExpenseItems(syncList);
    if (depreciationItem && !depreciationItem.manualForecastOverride) {
      setDepreciationItem((prev) =>
        prev
          ? {
            ...prev,
            forecastAmount: computeAvgForBasis(prev, nextBasis, nextCheckedKeys, outgoingsMonths),
            forecastMonthlyByKey: {},
          }
          : null
      );
    }
  };

  const applyContractorForecastBasis = (nextBasis, nextCheckedKeys) => {
    const t12Keys = data?.trailing12MonthKeys || [];
    const nextCheckedSet = new Set(nextCheckedKeys);
    const nextFutureMonths = outgoingsMonths.filter((m) => !nextCheckedSet.has(m.monthKey));
    const nextCheckedFyMonths = outgoingsMonths.filter(
      (m) => Number(m.fyIndex) === 1 && nextCheckedSet.has(m.monthKey)
    );

    setContractors((prev) =>
      prev.map((c) => {
        if (c.manualForecastOverride || c.isCustom) return c;
        if (nextBasis === "trailing12") {
          const amounts = t12Keys.map((mk) => Number(c.trailingMonthlyByKey?.[mk]) || 0);
          const dates = t12Keys.map((mk) => parseStarterPlDate(`${mk}-01`) || new Date());
          const sched = computeVendorForecastSchedule(amounts, dates, nextFutureMonths);
          return {
            ...c,
            pattern: sched.pattern,
            suggestedMonthlyAmount: sched.roundedAmount,
            forecastByMonth: sched.forecastByMonth,
          };
        }
        const fyAmounts = nextCheckedFyMonths.map((cm) =>
          (c.historicalTransactions || [])
            .filter((t) => t.assignedMonthKey === cm.monthKey)
            .reduce((s, t) => s + (Number(t.amountNet) || 0), 0)
        );
        const fyDates = nextCheckedFyMonths.map(
          (cm) => parseStarterPlDate(`${cm.monthKey}-01`) || new Date()
        );
        const sched = computeVendorForecastSchedule(fyAmounts, fyDates, nextFutureMonths, {
          shortFyFallbackPattern: c.trailingPattern || c.pattern,
        });
        return {
          ...c,
          pattern: sched.pattern,
          suggestedMonthlyAmount: sched.roundedAmount,
          forecastByMonth: sched.forecastByMonth,
        };
      })
    );
  };

  const handleToggleMonth = (monthKey) => {
    const next = checkedSet.has(monthKey)
      ? checkedMonthKeys.filter((k) => k !== monthKey)
      : [...checkedMonthKeys, monthKey];
    setCheckedMonthKeys(next);
    applyForecastBasis(forecastBasis, next);
    applyContractorForecastBasis(contractorForecastBasis, next);
  };

  const handleChangeBasis = (nextBasis) => {
    setForecastBasis(nextBasis);
    applyForecastBasis(nextBasis, checkedMonthKeys);
  };

  const handleChangeContractorBasis = (nextBasis) => {
    setContractorForecastBasis(nextBasis);
    applyContractorForecastBasis(nextBasis, checkedMonthKeys);
  };

  const updateCategoryField = (setter, idx, updater) => {
    setter((prev) => prev.map((it, i) => (i === idx ? updater(it) : it)));
  };

  // --- Immediate KeyInfo Column BA mapping action (Step 4) ---
  const handleAssignCategoryMapping = async (categoryName, targetSection) => {
    if (!categoryName || !targetSection) return;
    setMappingBusyCat(categoryName);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/starter-pl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign_category_mapping",
          clientName,
          masterSheetId,
          categoryName,
          targetSection,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to update category mapping." });
        return;
      }

      // Immediately remove the reassigned category from all P&L setup lists
      const catLower = categoryName.trim().toLowerCase();
      setExpenseItems((prev) => prev.filter((it) => String(it.name || "").trim().toLowerCase() !== catLower));
      setNonOpIncomeItems((prev) => prev.filter((it) => String(it.name || "").trim().toLowerCase() !== catLower));
      setNonOpExpenseItems((prev) => prev.filter((it) => String(it.name || "").trim().toLowerCase() !== catLower));
      setDepreciationItem((prev) =>
        prev && String(prev.name || "").trim().toLowerCase() === catLower ? null : prev
      );
      setMappingSelections((prev) => {
        const next = { ...prev };
        delete next[categoryName];
        return next;
      });

      const secLabel = json.sectionLabel || targetSection;
      setFeedback({
        type: "success",
        message:
          isAdmin && json.targetBaRow
            ? `Mapped "${json.categoryName || categoryName}" to "${secLabel}" (KeyInfo!BA${json.targetBaRow}) and removed it from the P&L setup list.`
            : `Moved "${json.categoryName || categoryName}" to "${secLabel}" and removed it from this list.`,
      });
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to update category mapping." });
    } finally {
      setMappingBusyCat("");
    }
  };

  // --- Drag & Drop Handlers for Contractors ---
  const handleMoveTransaction = (sourceVendorId, txnId, targetVendorId, targetMonthKey) => {
    if (!txnId || !targetMonthKey) return;
    setContractors((prev) => {
      let movedTxn = null;
      const without = prev.map((c) => {
        if (c.id !== sourceVendorId) return c;
        const keep = [];
        for (const t of c.historicalTransactions || []) {
          if (t.id === txnId) {
            movedTxn = { ...t, assignedMonthKey: targetMonthKey };
          } else {
            keep.push(t);
          }
        }
        return { ...c, historicalTransactions: keep };
      });
      if (!movedTxn) return prev;
      return without.map((c) =>
        c.id === targetVendorId
          ? { ...c, historicalTransactions: [...(c.historicalTransactions || []), movedTxn] }
          : c
      );
    });
  };

  const handleAddContractor = () => {
    const uid = `con-custom-${Date.now()}`;
    const emptyForecast = {};
    for (const fm of futureMonths) emptyForecast[fm.monthKey] = 0;
    setContractors((prev) => [
      ...prev,
      {
        id: uid,
        name: "New contractor",
        vatSetting: "Yes",
        deliveryPct: 100,
        pattern: "Manual",
        suggestedMonthlyAmount: 0,
        forecastByMonth: emptyForecast,
        historicalTransactions: [],
        isCustom: true,
      },
    ]);
  };

  const handleApplyVendorBulkForecast = (vendorId, rawAmount) => {
    const amt = parseNumericInput(rawAmount);
    setContractors((prev) =>
      prev.map((c) => {
        if (c.id !== vendorId) return c;
        const nextForecast = { ...(c.forecastByMonth || {}) };
        for (const fm of futureMonths) {
          nextForecast[fm.monthKey] = amt;
        }
        return { ...c, manualForecastOverride: true, forecastByMonth: nextForecast };
      })
    );
  };

  // --- Contractor P&L Reconciliation ---
  const contractorReconciliation = useMemo(() => {
    const map = {};
    for (const cm of checkedMonths) {
      let allocated = 0;
      for (const c of contractors) {
        for (const t of c.historicalTransactions || []) {
          if (t.assignedMonthKey === cm.monthKey) {
            allocated += Number(t.amountNet) || 0;
          }
        }
      }
      const plTotal = Number(data?.contractorPlTotalsByMonth?.[cm.monthKey]) || 0;
      map[cm.monthKey] = {
        allocated: round2(allocated),
        plTotal: round2(plTotal),
        diff: round2(allocated - plTotal),
      };
    }
    return map;
  }, [checkedMonths, contractors, data]);

  // --- Salaries helpers ---
  const combinedSingleSalaryRow = useMemo(() => {
    if (salaryEmployees.length === 0) return null;
    if (salaryEmployees.length === 1) return salaryEmployees[0];
    const totalFteSalary = round2(salaryEmployees.reduce((s, e) => s + (Number(e.fteSalary) || 0), 0));
    const weightedDel =
      totalFteSalary > 0
        ? round2(
          salaryEmployees.reduce(
            (s, e) => s + (Number(e.fteSalary) || 0) * (Number(e.deliveryPct) || 0),
            0
          ) / totalFteSalary
        )
        : Number(salaryEmployees[0]?.deliveryPct) || 0;
    const overrides = {};
    for (const cm of checkedMonths) {
      const sum = { grossSalary: 0, eeNic: 0, erNic: 0, studentLoan: 0, eePension: 0, erPension: 0, paye: 0 };
      for (const e of salaryEmployees) {
        const m = e.monthlyOverrides?.[cm.monthKey];
        if (!m) continue;
        for (const def of SALARY_COL_DEFS) {
          sum[def.key] = round2(sum[def.key] + (Number(m[def.key]) || 0));
        }
      }
      overrides[cm.monthKey] = sum;
    }
    return {
      id: "emp-combined",
      name: "Team payroll (combined)",
      role: "Combined staff",
      fteSalary: totalFteSalary,
      fte: 1,
      startDate: salaryEmployees[0]?.startDate || data?.startDateFormatted || "",
      endDate: "",
      deliveryPct: weightedDel,
      studentLoan: salaryEmployees.some((e) => e.studentLoan),
      pension: salaryEmployees.some((e) => e.pension),
      monthlyOverrides: overrides,
    };
  }, [salaryEmployees, checkedMonths, data]);

  const displayedSalaryRows = useMemo(
    () =>
      combineSalariesAsSingleRow
        ? combinedSingleSalaryRow
          ? [combinedSingleSalaryRow]
          : []
        : salaryEmployees,
    [combineSalariesAsSingleRow, combinedSingleSalaryRow, salaryEmployees]
  );

  const handleAddSalaryEmployee = () => {
    setCombineSalariesAsSingleRow(false);
    const overrides = {};
    for (const cm of checkedMonths) {
      overrides[cm.monthKey] = {
        grossSalary: 0,
        eeNic: 0,
        erNic: 0,
        studentLoan: 0,
        eePension: 0,
        erPension: 0,
        paye: 0,
      };
    }
    setSalaryEmployees((prev) => [
      ...prev,
      {
        id: `emp-custom-${Date.now()}`,
        name: "New employee",
        role: "Team member",
        fteSalary: 0,
        fte: 1,
        startDate: data?.startDateFormatted || "",
        endDate: "",
        deliveryPct: 0,
        studentLoan: false,
        pension: true,
        monthlyOverrides: overrides,
      },
    ]);
  };

  // --- Full-Year P&L Preview Calculator (Step 5) ---
  const parsedTaxTable = useMemo(
    () => parseKeyInfoTaxTable(data?.keyInfoTaxGrid || []),
    [data]
  );

  const pnlMonthlySummary = useMemo(() => {
    const targetMonths = pnlYearView === 2 ? fy2Months : fy1Months;
    const divDelRatio = Math.max(0, Math.min(100, parseNumericInput(divDeliveryPct))) / 100;

    const getExpenseMonthVal = (item, mk, isHist) => {
      if (!item) return 0;
      if (isHist) return round2(Number(item.monthlyByKey?.[mk]) || 0);
      return round2(
        Number(
          item.forecastMonthlyByKey?.[mk] !== undefined
            ? item.forecastMonthlyByKey[mk]
            : item.forecastAmount
        ) || 0
      );
    };

    const cols = targetMonths.map((m) => {
      const mk = m.monthKey;
      const isHist = checkedSet.has(mk);
      const taxParams = parsedTaxTable.getParamsForDate(mk);

      // Revenue: historical checked months prefer pulled actual P&L revenue; fallback / future uses Dashboard forecast revenue
      const histRev = Number(data?.actualRevenueByKey?.[mk]) || 0;
      const fcRev = Number(data?.forecastRevenueByKey?.[mk]) || 0;
      const revenue = round2(isHist ? (histRev !== 0 ? histRev : fcRev) : fcRev);

      // Salaries (Gross + Er NIC + Er Pension) split by employee Delivery %
      let salCos = 0;
      let salAdmin = 0;
      for (const emp of displayedSalaryRows) {
        const delRatio = Math.max(0, Math.min(100, Number(emp.deliveryPct) || 0)) / 100;
        let empTotalCost = 0;
        if (isHist) {
          const ov = emp.monthlyOverrides?.[mk];
          if (ov) {
            empTotalCost =
              (Number(ov.grossSalary) || 0) +
              (Number(ov.erNic) || 0) +
              (Number(ov.erPension) || 0);
          }
        } else {
          const monthDate = parseStarterPlDate(`${mk}-01`);
          const empStart = parseStarterPlDate(emp.startDate);
          const empEnd = parseStarterPlDate(emp.endDate);
          const startYm = empStart ? empStart.getFullYear() * 12 + empStart.getMonth() : -Infinity;
          const endYm = empEnd ? empEnd.getFullYear() * 12 + empEnd.getMonth() : Infinity;
          const curYm = monthDate ? monthDate.getFullYear() * 12 + monthDate.getMonth() : 0;

          if (curYm >= startYm && curYm <= endYm) {
            const fte = Number(emp.fte) > 0 ? Number(emp.fte) : 1;
            const grossPm = ((Number(emp.fteSalary) || 0) * fte) / 12;
            const calc = computePayrollFromGross(grossPm, taxParams, {
              stLoan: Boolean(emp.studentLoan),
              pension: Boolean(emp.pension),
            });
            empTotalCost = calc.grossSalary + calc.erNic + calc.erPension;
          }
        }
        salCos += empTotalCost * delRatio;
        salAdmin += empTotalCost * (1 - delRatio);
      }

      // Contractors split by contractor Delivery %
      let conCos = 0;
      let conAdmin = 0;
      for (const con of contractors) {
        const delRatio = Math.max(0, Math.min(100, Number(con.deliveryPct ?? 100))) / 100;
        const amt = isHist
          ? (con.historicalTransactions || [])
            .filter((t) => t.assignedMonthKey === mk)
            .reduce((s, t) => s + (Number(t.amountNet) || 0), 0)
          : Number(con.forecastByMonth?.[mk]) || 0;
        conCos += amt * delRatio;
        conAdmin += amt * (1 - delRatio);
      }

      // Dividends in lieu of salary split by Dividends Delivery %
      const divAmt = Number(divMonthlyByKey?.[mk]) || 0;
      const divCos = divAmt * divDelRatio;
      const divAdmin = divAmt * (1 - divDelRatio);

      // Other expenses split into CoS vs Overheads
      let otherCos = 0;
      let otherOh = 0;
      for (const item of expenseItems) {
        const v = getExpenseMonthVal(item, mk, isHist);
        if (item.sectionType === "CoS") otherCos += v;
        else otherOh += v;
      }

      const depreciation = depreciationItem ? getExpenseMonthVal(depreciationItem, mk, isHist) : 0;

      let nonOpIncome = 0;
      for (const item of nonOpIncomeItems) {
        nonOpIncome += getExpenseMonthVal(item, mk, isHist);
      }
      let nonOpExpense = 0;
      for (const item of nonOpExpenseItems) {
        nonOpExpense += getExpenseMonthVal(item, mk, isHist);
      }

      const totalCos = round2(salCos + conCos + divCos + otherCos);
      const grossProfit = round2(revenue - totalCos);
      const totalOverheads = round2(salAdmin + conAdmin + divAdmin + otherOh + depreciation);
      const operatingProfit = round2(grossProfit - totalOverheads);
      const netProfit = round2(operatingProfit + nonOpIncome - nonOpExpense);

      return {
        monthKey: mk,
        shortLabel: m.shortLabel,
        isHist,
        revenue,
        salCos: round2(salCos),
        conCos: round2(conCos),
        divCos: round2(divCos),
        otherCos: round2(otherCos),
        totalCos,
        grossProfit,
        grossMarginPct: revenue > 0.01 ? round2((grossProfit / revenue) * 100) : null,
        salAdmin: round2(salAdmin),
        conAdmin: round2(conAdmin),
        divAdmin: round2(divAdmin),
        otherOh: round2(otherOh),
        depreciation: round2(depreciation),
        totalOverheads,
        operatingProfit,
        nonOpIncome: round2(nonOpIncome),
        nonOpExpense: round2(nonOpExpense),
        netProfit,
      };
    });

    const sumKey = (k) => round2(cols.reduce((s, c) => s + (Number(c[k]) || 0), 0));
    const totals = {
      revenue: sumKey("revenue"),
      salCos: sumKey("salCos"),
      conCos: sumKey("conCos"),
      divCos: sumKey("divCos"),
      otherCos: sumKey("otherCos"),
      totalCos: sumKey("totalCos"),
      grossProfit: sumKey("grossProfit"),
      salAdmin: sumKey("salAdmin"),
      conAdmin: sumKey("conAdmin"),
      divAdmin: sumKey("divAdmin"),
      otherOh: sumKey("otherOh"),
      depreciation: sumKey("depreciation"),
      totalOverheads: sumKey("totalOverheads"),
      operatingProfit: sumKey("operatingProfit"),
      nonOpIncome: sumKey("nonOpIncome"),
      nonOpExpense: sumKey("nonOpExpense"),
      netProfit: sumKey("netProfit"),
    };
    totals.grossMarginPct =
      totals.revenue > 0.01 ? round2((totals.grossProfit / totals.revenue) * 100) : null;

    return { cols, totals };
  }, [
    pnlYearView,
    fy1Months,
    fy2Months,
    checkedSet,
    parsedTaxTable,
    data,
    displayedSalaryRows,
    contractors,
    divDeliveryPct,
    divMonthlyByKey,
    expenseItems,
    depreciationItem,
    nonOpIncomeItems,
    nonOpExpenseItems,
  ]);

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    setFeedback(null);
    try {
      const payloadSalaries =
        combineSalariesAsSingleRow && combinedSingleSalaryRow
          ? [combinedSingleSalaryRow]
          : salaryEmployees;

      const res = await fetch("/api/setup/starter-pl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push_to_outgoings",
          clientName,
          masterSheetId,
          checkedMonthKeys,
          outgoingsMonths,
          expenseItems,
          depreciationItem,
          nonOpIncomeItems,
          nonOpExpenseItems,
          contractors,
          salaryEmployees: payloadSalaries,
          dividends: {
            deliveryPct: parseNumericInput(divDeliveryPct),
            monthlyByKey: divMonthlyByKey,
          },
          combineSalariesAsSingleRow,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save StarterPL setup." });
      } else {
        setFeedback({ type: "success", message: json.message || "StarterPL setup saved." });
        if (typeof onCompleted === "function") {
          onCompleted(json);
        }
        onClose();
      }
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to save StarterPL setup." });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const hasExistingWarning = Boolean(data?.hasExistingOutgoings || data?.hasExistingSalaries);
  const canSave = Boolean(data && !loading && !saving && (!hasExistingWarning || confirmOverwrite));

  const renderCategorySection = (title, items, setter, accentBg = "#F8FAFC") => {
    if (!items || items.length === 0) return null;
    const catColW = 280;
    const mapColW = 230;
    const actColW = 88;
    const fcColW = 118;
    const futColW = 86;
    const totalTableW =
      catColW +
      mapColW +
      checkedMonths.length * actColW +
      fcColW +
      (showIndividualFutureExpenseMonths ? futureMonths.length * futColW : 0);

    return (
      <div style={{ marginBottom: "18px", width: `${totalTableW}px` }}>
        <div
          style={{
            fontSize: "12px",
            fontWeight: 700,
            color: "#334155",
            padding: "6px 12px",
            backgroundColor: accentBg,
            border: "1px solid #E2E8F0",
            borderBottom: "none",
            borderTopLeftRadius: "8px",
            borderTopRightRadius: "8px",
          }}
        >
          {title} ({items.length})
        </div>
        <div style={{ border: "1px solid #E2E8F0", borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" }}>
          <table style={{ width: `${totalTableW}px`, tableLayout: "fixed", borderCollapse: "collapse", fontSize: "12px" }}>
            <colgroup>
              <col style={{ width: `${catColW}px` }} />
              <col style={{ width: `${mapColW}px` }} />
              {checkedMonths.map((cm) => (
                <col key={`col-${cm.monthKey}`} style={{ width: `${actColW}px` }} />
              ))}
              <col style={{ width: `${fcColW}px` }} />
              {showIndividualFutureExpenseMonths &&
                futureMonths.map((fm) => (
                  <col key={`col-fut-${fm.monthKey}`} style={{ width: `${futColW}px` }} />
                ))}
            </colgroup>
            <thead>
              <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                <th style={{ textAlign: "left", padding: "7px 10px", position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 2 }}>
                  Category
                </th>
                <th style={{ textAlign: "left", padding: "7px 8px", whiteSpace: "nowrap" }}>
                  Reassign mapping
                </th>
                {checkedMonths.map((cm) => (
                  <th key={cm.monthKey} style={{ textAlign: "right", padding: "7px 10px", whiteSpace: "nowrap" }}>
                    {cm.shortLabel}
                    <div style={{ fontSize: "10px", fontWeight: 500, color: "#64748B" }}>Actual</div>
                  </th>
                ))}
                <th
                  style={{
                    textAlign: "right",
                    padding: "7px 10px",
                    backgroundColor: "#EFF6FF",
                    color: "#1E40AF",
                    borderLeft: "2px solid #93C5FD",
                    whiteSpace: "nowrap",
                  }}
                >
                  Forecast / mo
                  <div style={{ fontSize: "10px", fontWeight: 500, color: "#3B82F6" }}>Nearest £10</div>
                </th>
                {showIndividualFutureExpenseMonths &&
                  futureMonths.map((fm) => (
                    <th key={fm.monthKey} style={{ textAlign: "right", padding: "7px 8px", backgroundColor: "#F0FDF4", color: "#166534", whiteSpace: "nowrap" }}>
                      {fm.shortLabel}
                      <div style={{ fontSize: "10px", fontWeight: 500, color: "#15803D" }}>FY{fm.fyIndex} f/c</div>
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const selectedSec = mappingSelections[item.name] || "";
                const isMoving = mappingBusyCat === item.name;
                return (
                  <tr key={`${item.name}-${idx}`} style={{ borderBottom: "1px solid #F1F5F9" }}>
                    <td
                      style={{
                        padding: "6px 10px",
                        fontWeight: 600,
                        color: "#0F172A",
                        position: "sticky",
                        left: 0,
                        backgroundColor: "#FFFFFF",
                        zIndex: 1,
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {item.name}
                    </td>
                    <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <select
                          aria-label={`Reassign mapping for ${item.name}`}
                          value={selectedSec}
                          disabled={Boolean(mappingBusyCat)}
                          onChange={(e) =>
                            setMappingSelections((prev) => ({
                              ...prev,
                              [item.name]: e.target.value,
                            }))
                          }
                          style={{
                            padding: "3px 6px",
                            borderRadius: "5px",
                            border: "1px solid #CBD5E1",
                            fontSize: "11px",
                            color: selectedSec ? "#0F172A" : "#64748B",
                            backgroundColor: "#FFFFFF",
                            maxWidth: "155px",
                          }}
                        >
                          <option value="">Move mapping...</option>
                          {MAPPING_SECTION_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        {selectedSec && (
                          <button
                            type="button"
                            disabled={isMoving}
                            onClick={() => handleAssignCategoryMapping(item.name, selectedSec)}
                            style={{
                              padding: "3px 8px",
                              borderRadius: "5px",
                              border: "none",
                              backgroundColor: isMoving ? "#94A3B8" : "#023f98",
                              color: "#FFFFFF",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: isMoving ? "not-allowed" : "pointer",
                            }}
                          >
                            {isMoving ? "Saving..." : "Apply"}
                          </button>
                        )}
                      </div>
                    </td>
                    {checkedMonths.map((cm) => {
                      const val = Number(item.monthlyByKey?.[cm.monthKey]) || 0;
                      return (
                        <td key={cm.monthKey} style={{ textAlign: "right", padding: "6px 8px", color: Math.abs(val) < 0.01 ? "#94A3B8" : "#0F172A" }}>
                          {formatMoney(val, currency, Math.abs(val % 1) > 0.005 ? 2 : 0)}
                        </td>
                      );
                    })}
                    <td style={{ padding: "4px 8px", backgroundColor: "#EFF6FF", borderLeft: "2px solid #93C5FD", textAlign: "right" }}>
                      <input
                        type="number"
                        step="1"
                        value={item.forecastAmount ?? 0}
                        onChange={(e) => {
                          const val = parseNumericInput(e.target.value);
                          updateCategoryField(setter, idx, (prev) => ({
                            ...prev,
                            forecastAmount: val,
                            manualForecastOverride: true,
                            forecastMonthlyByKey: {},
                          }));
                        }}
                        style={{
                          width: "88px",
                          textAlign: "right",
                          padding: "4px 6px",
                          borderRadius: "6px",
                          border: "1px solid #93C5FD",
                          fontSize: "12px",
                          fontWeight: 600,
                          backgroundColor: "#FFFFFF",
                        }}
                      />
                    </td>
                    {showIndividualFutureExpenseMonths &&
                      futureMonths.map((fm) => {
                        const monthVal =
                          item.forecastMonthlyByKey?.[fm.monthKey] !== undefined
                            ? item.forecastMonthlyByKey[fm.monthKey]
                            : item.forecastAmount ?? 0;
                        return (
                          <td key={fm.monthKey} style={{ padding: "4px 6px", backgroundColor: "#F0FDF4", textAlign: "right" }}>
                            <input
                              type="number"
                              step="1"
                              value={monthVal}
                              onChange={(e) => {
                                const val = parseNumericInput(e.target.value);
                                updateCategoryField(setter, idx, (prev) => ({
                                  ...prev,
                                  manualForecastOverride: true,
                                  forecastMonthlyByKey: {
                                    ...(prev.forecastMonthlyByKey || {}),
                                    [fm.monthKey]: val,
                                  },
                                }));
                              }}
                              style={{
                                width: "74px",
                                textAlign: "right",
                                padding: "3px 5px",
                                borderRadius: "5px",
                                border: "1px solid #BBF7D0",
                                fontSize: "11px",
                                backgroundColor: "#FFFFFF",
                              }}
                            />
                          </td>
                        );
                      })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderPnlRow = (label, fieldKey, { bold = false, bg = "#FFFFFF", borderTop = false, isNegativeCost = false, isMargin = false, color = "#0F172A" } = {}) => (
    <tr
      style={{
        backgroundColor: bg,
        fontWeight: bold ? 700 : 500,
        borderTop: borderTop ? "2px solid #CBD5E1" : "1px solid #F1F5F9",
        color,
      }}
    >
      <td
        style={{
          padding: "7px 12px",
          position: "sticky",
          left: 0,
          backgroundColor: bg,
          zIndex: 1,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </td>
      {pnlMonthlySummary.cols.map((c) => {
        const rawVal = c[fieldKey];
        if (isMargin) {
          return (
            <td key={c.monthKey} style={{ textAlign: "right", padding: "7px 8px", color: "#475569" }}>
              {rawVal === null || rawVal === undefined ? "—" : `${rawVal.toFixed(1)}%`}
            </td>
          );
        }
        const displayVal = isNegativeCost && Number(rawVal) > 0 ? -Number(rawVal) : Number(rawVal) || 0;
        return (
          <td
            key={c.monthKey}
            style={{
              textAlign: "right",
              padding: "7px 8px",
              color: Math.abs(displayVal) < 0.01 ? "#94A3B8" : color,
            }}
          >
            {formatMoney(displayVal, currency, 0)}
          </td>
        );
      })}
      <td
        style={{
          textAlign: "right",
          padding: "7px 12px",
          backgroundColor: bg === "#FFFFFF" ? "#F8FAFC" : bg,
          borderLeft: "2px solid #CBD5E1",
          fontWeight: 700,
        }}
      >
        {isMargin
          ? pnlMonthlySummary.totals.grossMarginPct === null
            ? "—"
            : `${pnlMonthlySummary.totals.grossMarginPct.toFixed(1)}%`
          : formatMoney(
            isNegativeCost && Number(pnlMonthlySummary.totals[fieldKey]) > 0
              ? -Number(pnlMonthlySummary.totals[fieldKey])
              : Number(pnlMonthlySummary.totals[fieldKey]) || 0,
            currency,
            0
          )}
      </td>
    </tr>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Run StarterPL setup"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        style={{
          width: "96vw",
          maxWidth: "1520px",
          maxHeight: "94vh",
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0F172A" }}>
              Run StarterPL setup — {clientName}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
              Step {currentStep} of {WIZARD_STEPS.length}: complete each section in order, then review the full-year P&amp;L before saving.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={loadStarterPl}
              disabled={loading || saving}
              style={{
                padding: "7px 14px",
                borderRadius: "8px",
                border: "1px solid #2563EB",
                backgroundColor: "#EFF6FF",
                color: "#1D4ED8",
                fontWeight: 600,
                fontSize: "12px",
                cursor: loading || saving ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Refreshing P&L..." : "Refresh P&L & transactions"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              style={{
                border: "none",
                background: "transparent",
                fontSize: "20px",
                lineHeight: 1,
                color: "#64748B",
                cursor: "pointer",
                padding: "4px 6px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Stepper Bar */}
        <div
          style={{
            padding: "10px 24px",
            backgroundColor: "#F8FAFC",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {WIZARD_STEPS.map((st, idx) => {
            const isActive = currentStep === st.num;
            const isDone = currentStep > st.num;
            return (
              <React.Fragment key={st.id}>
                <button
                  type="button"
                  disabled={!data || loading}
                  onClick={() => setCurrentStep(st.num)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "999px",
                    border: `1px solid ${isActive ? "#047857" : isDone ? "#BFDBFE" : "#CBD5E1"}`,
                    backgroundColor: isActive ? "#047857" : isDone ? "#EFF6FF" : "#FFFFFF",
                    color: isActive ? "#FFFFFF" : isDone ? "#1E40AF" : "#475569",
                    fontSize: "12px",
                    fontWeight: isActive ? 700 : 600,
                    cursor: !data || loading ? "not-allowed" : "pointer",
                  }}
                >
                  {st.label}
                </button>
                {idx < WIZARD_STEPS.length - 1 && (
                  <span style={{ color: "#CBD5E1", fontSize: "12px" }}>›</span>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Feedback banner */}
        {feedback && (
          <div
            style={{
              padding: "10px 24px",
              fontSize: "13px",
              fontWeight: 500,
              backgroundColor: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
              color: feedback.type === "error" ? "#B91C1C" : "#047857",
              borderBottom: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
            }}
          >
            {feedback.message}
          </div>
        )}

        {/* Body: single unified scroll container so mouse-wheel scrolling works smoothly over all tables */}
        <div
          style={{
            padding: "16px 24px",
            overflow: "auto",
            flex: "1 1 auto",
            minHeight: 0,
          }}
        >
          {loading && !data ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 0", gap: "12px" }}>
              <Spinner size="md" />
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                Pulling profit &amp; loss categories, contractor bills, bank payments, and dividend movements...
              </div>
            </div>
          ) : data ? (
            <>
              {/* Year 1 Historical Month Selector (persistent reference strip on Steps 1-4) */}
              {currentStep < 5 && (
                <div
                  style={{
                    position: "sticky",
                    left: 0,
                    marginBottom: "14px",
                    padding: "10px 14px",
                    borderRadius: "10px",
                    backgroundColor: "#F8FAFC",
                    border: "1px solid #E2E8F0",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "8px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#0F172A" }}>
                      Historical months to push as actuals (pre-checked through {data.prevCalendarMonthLabel})
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748B" }}>
                      Start date: {data.startDateFormatted} · Source: {data.accountingTool}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {fy1Months.map((m) => {
                      const checked = checkedSet.has(m.monthKey);
                      return (
                        <label
                          key={m.monthKey}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            border: `1px solid ${checked ? "#2563EB" : "#CBD5E1"}`,
                            backgroundColor: checked ? "#EFF6FF" : "#FFFFFF",
                            color: checked ? "#1E40AF" : "#475569",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleToggleMonth(m.monthKey)}
                          />
                          {m.shortLabel}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* STEP 1: SALARIES */}
              {currentStep === 1 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "12px",
                      marginBottom: "14px",
                      padding: "10px 14px",
                      borderRadius: "8px",
                      backgroundColor: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "12px", fontWeight: 700, color: "#0F172A" }}>
                        Estimation mode:
                      </span>
                      <div style={{ display: "inline-flex", borderRadius: "7px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                        {[
                          { id: "detected", label: `Detected employees (${salaryEmployees.length})`, combined: false },
                          { id: "single", label: "Combine as single row", combined: true },
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setCombineSalariesAsSingleRow(opt.combined)}
                            style={{
                              padding: "6px 12px",
                              border: "none",
                              backgroundColor: combineSalariesAsSingleRow === opt.combined ? "#023f98" : "#FFFFFF",
                              color: combineSalariesAsSingleRow === opt.combined ? "#FFFFFF" : "#334155",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <span style={{ fontSize: "11px", color: "#64748B" }}>
                        End date stays blank so ongoing salaries automatically forecast using configured UK tax &amp; NI bands.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={handleAddSalaryEmployee}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "7px",
                        border: "1px solid #023f98",
                        backgroundColor: "#FFFFFF",
                        color: "#023f98",
                        fontSize: "12px",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      + Add employee
                    </button>
                  </div>

                  {/* Employee Roster Table */}
                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", marginBottom: "18px", width: "fit-content", minWidth: "100%" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "170px" }}>Name</th>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "140px" }}>Role</th>
                          <th style={{ textAlign: "right", padding: "8px 10px", minWidth: "110px" }}>FTE salary</th>
                          <th style={{ textAlign: "right", padding: "8px 8px", minWidth: "66px" }}>FTE</th>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "100px" }}>Start date</th>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "96px" }}>End date</th>
                          <th style={{ textAlign: "right", padding: "8px 8px", minWidth: "74px" }}>Del %</th>
                          <th style={{ textAlign: "center", padding: "8px 8px", minWidth: "76px" }}>St loan?</th>
                          <th style={{ textAlign: "center", padding: "8px 8px", minWidth: "72px" }}>Pens?</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedSalaryRows.map((emp) => (
                          <tr key={emp.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                            <td style={{ padding: "6px 10px" }}>
                              <input
                                type="text"
                                value={emp.name || ""}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) => (x.id === emp.id ? { ...x, name: e.target.value } : x))
                                  )
                                }
                                style={{ width: "100%", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px", fontWeight: 600 }}
                              />
                            </td>
                            <td style={{ padding: "6px 10px" }}>
                              <input
                                type="text"
                                value={emp.role || ""}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) => (x.id === emp.id ? { ...x, role: e.target.value } : x))
                                  )
                                }
                                style={{ width: "100%", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                            <td style={{ padding: "6px 10px", textAlign: "right" }}>
                              <input
                                type="number"
                                value={emp.fteSalary ?? 0}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) =>
                                      x.id === emp.id ? { ...x, fteSalary: parseNumericInput(e.target.value) } : x
                                    )
                                  )
                                }
                                style={{ width: "92px", textAlign: "right", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px", fontWeight: 600 }}
                              />
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>
                              <input
                                type="number"
                                step="0.1"
                                min="0.1"
                                max="1"
                                value={emp.fte ?? 1}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) =>
                                      x.id === emp.id ? { ...x, fte: parseFloat(e.target.value) || 1 } : x
                                    )
                                  )
                                }
                                style={{ width: "54px", textAlign: "right", padding: "4px 5px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                            <td style={{ padding: "6px 10px" }}>
                              <input
                                type="text"
                                value={emp.startDate || ""}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) => (x.id === emp.id ? { ...x, startDate: e.target.value } : x))
                                  )
                                }
                                style={{ width: "88px", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                            <td style={{ padding: "6px 10px" }}>
                              <input
                                type="text"
                                placeholder="Ongoing"
                                value={emp.endDate || ""}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) => (x.id === emp.id ? { ...x, endDate: e.target.value } : x))
                                  )
                                }
                                style={{ width: "88px", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                value={emp.deliveryPct ?? 0}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) =>
                                      x.id === emp.id
                                        ? { ...x, deliveryPct: Math.max(0, Math.min(100, parseNumericInput(e.target.value))) }
                                        : x
                                    )
                                  )
                                }
                                style={{ width: "56px", textAlign: "right", padding: "4px 5px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              <select
                                value={emp.studentLoan ? "Yes" : "No"}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) =>
                                      x.id === emp.id ? { ...x, studentLoan: e.target.value === "Yes" } : x
                                    )
                                  )
                                }
                                style={{ padding: "3px 5px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "11px" }}
                              >
                                <option value="No">No</option>
                                <option value="Yes">Yes</option>
                              </select>
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              <select
                                value={emp.pension ? "Yes" : "No"}
                                disabled={combineSalariesAsSingleRow}
                                onChange={(e) =>
                                  setSalaryEmployees((prev) =>
                                    prev.map((x) =>
                                      x.id === emp.id ? { ...x, pension: e.target.value === "Yes" } : x
                                    )
                                  )
                                }
                                style={{ padding: "3px 5px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "11px" }}
                              >
                                <option value="Yes">Yes</option>
                                <option value="No">No</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Historical Monthly Payroll Breakdown & Overrides */}
                  {checkedMonths.length > 0 && (
                    <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", padding: "12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#0F172A" }}>
                          Historical monthly payroll figures
                        </div>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          {checkedMonths.map((cm) => {
                            const activeM = expandedSalaryMonthKey === cm.monthKey;
                            return (
                              <button
                                key={cm.monthKey}
                                type="button"
                                onClick={() => setExpandedSalaryMonthKey(cm.monthKey)}
                                style={{
                                  padding: "4px 10px",
                                  borderRadius: "6px",
                                  border: `1px solid ${activeM ? "#023f98" : "#CBD5E1"}`,
                                  backgroundColor: activeM ? "#EFF6FF" : "#FFFFFF",
                                  color: activeM ? "#023f98" : "#475569",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                }}
                              >
                                {cm.shortLabel}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {expandedSalaryMonthKey && (
                        <div>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                            <thead>
                              <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                                <th style={{ textAlign: "left", padding: "6px 8px" }}>Employee</th>
                                {SALARY_COL_DEFS.map((col) => (
                                  <th key={col.key} style={{ textAlign: "right", padding: "6px 8px", minWidth: "82px" }}>
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {displayedSalaryRows.map((emp) => {
                                const mVals = emp.monthlyOverrides?.[expandedSalaryMonthKey] || {};
                                return (
                                  <tr key={emp.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{emp.name}</td>
                                    {SALARY_COL_DEFS.map((col) => (
                                      <td key={col.key} style={{ padding: "4px 6px", textAlign: "right" }}>
                                        <input
                                          type="number"
                                          step="0.01"
                                          value={mVals[col.key] ?? 0}
                                          disabled={combineSalariesAsSingleRow}
                                          onChange={(e) => {
                                            const val = parseNumericInput(e.target.value);
                                            setSalaryEmployees((prev) =>
                                              prev.map((x) =>
                                                x.id === emp.id
                                                  ? {
                                                    ...x,
                                                    monthlyOverrides: {
                                                      ...(x.monthlyOverrides || {}),
                                                      [expandedSalaryMonthKey]: {
                                                        ...(x.monthlyOverrides?.[expandedSalaryMonthKey] || {}),
                                                        [col.key]: val,
                                                      },
                                                    },
                                                  }
                                                  : x
                                              )
                                            );
                                          }}
                                          style={{
                                            width: "74px",
                                            textAlign: "right",
                                            padding: "3px 5px",
                                            borderRadius: "4px",
                                            border: "1px solid #CBD5E1",
                                            fontSize: "11px",
                                          }}
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot>
                              <tr style={{ backgroundColor: "#F8FAFC", fontWeight: 700, borderTop: "1px solid #CBD5E1" }}>
                                <td style={{ padding: "6px 8px" }}>P&amp;L payroll benchmark</td>
                                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                                  {formatMoney(data.plPayrollByMonth?.[expandedSalaryMonthKey]?.grossSalary || 0, currency, 2)}
                                </td>
                                <td style={{ padding: "6px 8px", textAlign: "right", color: "#64748B" }}>—</td>
                                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                                  {formatMoney(data.plPayrollByMonth?.[expandedSalaryMonthKey]?.erNic || 0, currency, 2)}
                                </td>
                                <td style={{ padding: "6px 8px", textAlign: "right", color: "#64748B" }}>—</td>
                                <td style={{ padding: "6px 8px", textAlign: "right", color: "#64748B" }}>—</td>
                                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                                  {formatMoney(data.plPayrollByMonth?.[expandedSalaryMonthKey]?.erPension || 0, currency, 2)}
                                </td>
                                <td style={{ padding: "6px 8px", textAlign: "right", color: "#64748B" }}>—</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* STEP 2: CONTRACTORS */}
              {currentStep === 2 && (
                <div>
                  <div
                    style={{
                      position: "sticky",
                      left: 0,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "12px",
                      marginBottom: "12px",
                      padding: "10px 14px",
                      backgroundColor: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      borderRadius: "8px",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxWidth: "960px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "12px", fontWeight: 700, color: "#0F172A" }}>
                          Forecast calculation basis:
                        </span>
                        <div style={{ display: "inline-flex", borderRadius: "7px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                          {[
                            { id: "trailing12", label: "Last 12 months" },
                            { id: "currentFy", label: "Current financial year" },
                          ].map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => handleChangeContractorBasis(opt.id)}
                              style={{
                                padding: "6px 12px",
                                border: "none",
                                backgroundColor: contractorForecastBasis === opt.id ? "#023f98" : "#FFFFFF",
                                color: contractorForecastBasis === opt.id ? "#FFFFFF" : "#334155",
                                fontSize: "12px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <span style={{ fontSize: "11px", color: "#64748B" }}>
                          Monthly only when paid in all 3 of the latest 3 months (or the 3 months leading up to the previous month); periodic cadences (2m+) schedule on that cadence; active average rounded to the nearest £50.
                        </span>
                      </div>
                      <div style={{ fontSize: "11px", color: "#475569" }}>
                        Drag any transaction chip to reassign its month.{" "}
                        {data.trackedContractorCategories?.length > 0 && (
                          <span style={{ color: "#64748B" }}>
                            Tracked categories: {data.trackedContractorCategories.join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleAddContractor}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "7px",
                        border: "1px solid #023f98",
                        backgroundColor: "#FFFFFF",
                        color: "#023f98",
                        fontSize: "12px",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      + Add contractor
                    </button>
                  </div>

                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", width: "fit-content", minWidth: "100%" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "185px", position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 3 }}>
                            Contractor
                          </th>
                          <th style={{ textAlign: "center", padding: "8px 6px", minWidth: "62px" }}>VAT?</th>
                          <th style={{ textAlign: "center", padding: "8px 6px", minWidth: "66px" }}>Del %</th>
                          <th style={{ textAlign: "left", padding: "8px 8px", minWidth: "125px" }}>Pattern</th>
                          {checkedMonths.map((cm) => (
                            <th key={cm.monthKey} style={{ textAlign: "left", padding: "8px", minWidth: "136px", backgroundColor: "#F8FAFC", whiteSpace: "nowrap" }}>
                              {cm.shortLabel}
                              <div style={{ fontSize: "10px", fontWeight: 500, color: "#64748B" }}>Actuals (drag)</div>
                            </th>
                          ))}
                          {futureMonths.map((fm, fIdx) => (
                            <th
                              key={fm.monthKey}
                              style={{
                                textAlign: "right",
                                padding: "8px",
                                minWidth: "88px",
                                backgroundColor: "#EFF6FF",
                                color: "#1E40AF",
                                borderLeft: fIdx === 0 ? "2px solid #93C5FD" : undefined,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {fm.shortLabel}
                              <div style={{ fontSize: "10px", fontWeight: 500, color: "#3B82F6" }}>FY{fm.fyIndex} f/c</div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {contractors.length === 0 ? (
                          <tr>
                            <td colSpan={4 + checkedMonths.length + futureMonths.length} style={{ padding: "24px", textAlign: "center", color: "#64748B" }}>
                              No contractor bills or payments detected in the tracked categories. Use &ldquo;+ Add contractor&rdquo; to create a forecast row.
                            </td>
                          </tr>
                        ) : (
                          contractors.map((con) => (
                            <tr key={con.id} style={{ borderBottom: "1px solid #E2E8F0", verticalAlign: "top" }}>
                              <td
                                style={{
                                  padding: "7px 10px",
                                  position: "sticky",
                                  left: 0,
                                  backgroundColor: "#FFFFFF",
                                  zIndex: 2,
                                }}
                              >
                                <input
                                  type="text"
                                  value={con.name}
                                  onChange={(e) =>
                                    setContractors((prev) =>
                                      prev.map((c) => (c.id === con.id ? { ...c, name: e.target.value } : c))
                                    )
                                  }
                                  style={{
                                    width: "100%",
                                    border: "1px solid transparent",
                                    borderRadius: "4px",
                                    padding: "3px 4px",
                                    fontWeight: 600,
                                    fontSize: "12px",
                                    color: "#0F172A",
                                    backgroundColor: con.isCustom ? "#F8FAFC" : "transparent",
                                  }}
                                />
                                <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px" }}>
                                  <input
                                    type="number"
                                    placeholder="Set future"
                                    value={bulkForecastVendorInput[con.id] ?? ""}
                                    onChange={(e) =>
                                      setBulkForecastVendorInput((prev) => ({ ...prev, [con.id]: e.target.value }))
                                    }
                                    style={{
                                      width: "76px",
                                      padding: "2px 5px",
                                      fontSize: "11px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleApplyVendorBulkForecast(con.id, bulkForecastVendorInput[con.id] ?? 0)}
                                    style={{
                                      padding: "2px 6px",
                                      fontSize: "10px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      backgroundColor: "#F8FAFC",
                                      color: "#334155",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Fill future
                                  </button>
                                </div>
                              </td>
                              <td style={{ padding: "7px 6px", textAlign: "center" }}>
                                <select
                                  value={con.vatSetting === "No" ? "No" : "Yes"}
                                  onChange={(e) =>
                                    setContractors((prev) =>
                                      prev.map((c) => (c.id === con.id ? { ...c, vatSetting: e.target.value } : c))
                                    )
                                  }
                                  style={{ padding: "3px 4px", fontSize: "11px", borderRadius: "4px", border: "1px solid #CBD5E1" }}
                                >
                                  <option value="Yes">Yes</option>
                                  <option value="No">No</option>
                                </select>
                              </td>
                              <td style={{ padding: "7px 6px", textAlign: "center" }}>
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  value={con.deliveryPct ?? 100}
                                  onChange={(e) =>
                                    setContractors((prev) =>
                                      prev.map((c) =>
                                        c.id === con.id
                                          ? { ...c, deliveryPct: Math.max(0, Math.min(100, parseNumericInput(e.target.value))) }
                                          : c
                                      )
                                    )
                                  }
                                  style={{ width: "48px", textAlign: "right", padding: "3px 4px", fontSize: "11px", borderRadius: "4px", border: "1px solid #CBD5E1" }}
                                />
                              </td>
                              <td style={{ padding: "7px 8px", fontSize: "11px", color: "#475569" }}>
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      padding: "2px 7px",
                                      borderRadius: "999px",
                                      backgroundColor: con.pattern === "monthly" ? "#DBEAFE" : "#F1F5F9",
                                      color: con.pattern === "monthly" ? "#1E40AF" : "#334155",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {con.pattern || "Manual"}
                                  </span>
                                  {!con.isCustom && (
                                    <button
                                      type="button"
                                      onClick={() => setHistoryVendorId(con.id)}
                                      style={{
                                        padding: "2px 7px",
                                        borderRadius: "5px",
                                        border: "1px solid #CBD5E1",
                                        backgroundColor: "#FFFFFF",
                                        color: "#023f98",
                                        fontSize: "10px",
                                        fontWeight: 600,
                                        cursor: "pointer",
                                      }}
                                    >
                                      12m history
                                    </button>
                                  )}
                                </div>
                              </td>

                              {checkedMonths.map((cm) => {
                                const txnsInCell = (con.historicalTransactions || []).filter(
                                  (t) => t.assignedMonthKey === cm.monthKey
                                );
                                const cellTotal = round2(
                                  txnsInCell.reduce((s, t) => s + (Number(t.amountNet) || 0), 0)
                                );
                                const hoverKey = `${con.id}__${cm.monthKey}`;
                                const isHover = dropHoverTarget === hoverKey;

                                return (
                                  <td
                                    key={cm.monthKey}
                                    onDragOver={(e) => {
                                      e.preventDefault();
                                      if (dropHoverTarget !== hoverKey) setDropHoverTarget(hoverKey);
                                    }}
                                    onDragLeave={() => {
                                      if (dropHoverTarget === hoverKey) setDropHoverTarget(null);
                                    }}
                                    onDrop={(e) => {
                                      e.preventDefault();
                                      setDropHoverTarget(null);
                                      if (dragPayload?.txnId) {
                                        handleMoveTransaction(
                                          dragPayload.sourceVendorId,
                                          dragPayload.txnId,
                                          con.id,
                                          cm.monthKey
                                        );
                                        setDragPayload(null);
                                      }
                                    }}
                                    style={{
                                      padding: "6px",
                                      minHeight: "48px",
                                      backgroundColor: isHover ? "#DBEAFE" : "#FFFFFF",
                                      borderLeft: "1px solid #F1F5F9",
                                      transition: "background-color 120ms ease",
                                    }}
                                  >
                                    {txnsInCell.length > 0 && (
                                      <div style={{ fontSize: "11px", fontWeight: 700, color: "#0F172A", marginBottom: "4px" }}>
                                        {formatMoney(cellTotal, currency, Math.abs(cellTotal % 1) > 0.005 ? 2 : 0)}
                                      </div>
                                    )}
                                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                      {txnsInCell.map((tx) => (
                                        <div
                                          key={tx.id}
                                          draggable
                                          onDragStart={(e) => {
                                            setDragPayload({ sourceVendorId: con.id, txnId: tx.id });
                                            if (e.dataTransfer) {
                                              e.dataTransfer.effectAllowed = "move";
                                              e.dataTransfer.setData("text/plain", tx.id);
                                            }
                                          }}
                                          onDragEnd={() => {
                                            setDragPayload(null);
                                            setDropHoverTarget(null);
                                          }}
                                          title={`${tx.description || "Contractor transaction"}${tx.recDate ? ` (Date: ${tx.recDate})` : ""}`}
                                          style={{
                                            padding: "3px 6px",
                                            borderRadius: "5px",
                                            backgroundColor: "#EFF6FF",
                                            border: "1px solid #BFDBFE",
                                            color: "#1E40AF",
                                            fontSize: "11px",
                                            cursor: "grab",
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            gap: "4px",
                                          }}
                                        >
                                          <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                                            {formatMoney(tx.amountNet, currency, Math.abs(tx.amountNet % 1) > 0.005 ? 2 : 0)}
                                          </span>
                                          <select
                                            aria-label="Move transaction month"
                                            value={tx.assignedMonthKey}
                                            onChange={(e) =>
                                              handleMoveTransaction(con.id, tx.id, con.id, e.target.value)
                                            }
                                            style={{
                                              border: "none",
                                              background: "transparent",
                                              color: "#3B82F6",
                                              fontSize: "10px",
                                              cursor: "pointer",
                                              maxWidth: "56px",
                                            }}
                                          >
                                            {checkedMonths.map((optM) => (
                                              <option key={optM.monthKey} value={optM.monthKey}>
                                                {optM.shortLabel}
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                );
                              })}

                              {futureMonths.map((fm, fIdx) => (
                                <td
                                  key={fm.monthKey}
                                  style={{
                                    padding: "6px",
                                    backgroundColor: "#F8FAFC",
                                    borderLeft: fIdx === 0 ? "2px solid #93C5FD" : "1px solid #F1F5F9",
                                    textAlign: "right",
                                  }}
                                >
                                  <input
                                    type="number"
                                    step="10"
                                    value={con.forecastByMonth?.[fm.monthKey] ?? 0}
                                    onChange={(e) => {
                                      const v = parseNumericInput(e.target.value);
                                      setContractors((prev) =>
                                        prev.map((c) =>
                                          c.id === con.id
                                            ? {
                                              ...c,
                                              manualForecastOverride: true,
                                              forecastByMonth: {
                                                ...(c.forecastByMonth || {}),
                                                [fm.monthKey]: v,
                                              },
                                            }
                                            : c
                                        )
                                      );
                                    }}
                                    style={{
                                      width: "72px",
                                      textAlign: "right",
                                      padding: "4px 6px",
                                      borderRadius: "5px",
                                      border: "1px solid #CBD5E1",
                                      fontSize: "12px",
                                      backgroundColor: "#FFFFFF",
                                    }}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                      {checkedMonths.length > 0 && (
                        <tfoot>
                          <tr style={{ backgroundColor: "#F1F5F9", borderTop: "2px solid #CBD5E1", fontWeight: 700, fontSize: "11px" }}>
                            <td colSpan={4} style={{ padding: "8px 10px", position: "sticky", left: 0, backgroundColor: "#F1F5F9", zIndex: 2 }}>
                              Allocated vs tracked contractor P&amp;L total
                            </td>
                            {checkedMonths.map((cm) => {
                              const rec = contractorReconciliation[cm.monthKey] || { allocated: 0, plTotal: 0, diff: 0 };
                              const matched = Math.abs(rec.diff) < 1;
                              return (
                                <td key={cm.monthKey} style={{ padding: "6px 8px", color: matched ? "#047857" : "#B45309" }}>
                                  <div>Alloc: {formatMoney(rec.allocated, currency, 0)}</div>
                                  <div>P&amp;L: {formatMoney(rec.plTotal, currency, 0)}</div>
                                  <div style={{ fontSize: "10px" }}>
                                    Diff: {rec.diff >= 0 ? "+" : ""}{formatMoney(rec.diff, currency, 0)}
                                  </div>
                                </td>
                              );
                            })}
                            {futureMonths.map((fm, fIdx) => {
                              const totalFc = contractors.reduce(
                                (s, c) => s + (Number(c.forecastByMonth?.[fm.monthKey]) || 0),
                                0
                              );
                              return (
                                <td
                                  key={fm.monthKey}
                                  style={{
                                    padding: "8px 6px",
                                    textAlign: "right",
                                    color: "#1E40AF",
                                    borderLeft: fIdx === 0 ? "2px solid #93C5FD" : undefined,
                                  }}
                                >
                                  {formatMoney(totalFc, currency, 0)}
                                </td>
                              );
                            })}
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              )}

              {/* STEP 3: DIVIDENDS IN LIEU OF SALARY */}
              {currentStep === 3 && (
                <div>
                  {data.dividends?.inheritedFromYear0 ? (
                    <div
                      style={{
                        marginBottom: "14px",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        backgroundColor: "#EFF6FF",
                        border: "1px solid #BFDBFE",
                        color: "#1E40AF",
                        fontSize: "12px",
                      }}
                    >
                      No dividends were detected in the checked months of the current financial year, so monthly amounts ({formatMoney(data.dividends.year0MonthlyAvg, currency, 2)} / month) and Delivery % ({data.dividends.deliveryPct}%) have been inherited from your Year 0 setup.
                    </div>
                  ) : data.dividends?.sourceAccountName ? (
                    <div
                      style={{
                        marginBottom: "14px",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        backgroundColor: "#ECFDF5",
                        border: "1px solid #A7F3D0",
                        color: "#047857",
                        fontSize: "12px",
                      }}
                    >
                      Detected dividend movements from account &ldquo;{data.dividends.sourceAccountName}&rdquo;. You can adjust any historical or forecast month below.
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "16px",
                      flexWrap: "wrap",
                      marginBottom: "14px",
                      padding: "10px 14px",
                      backgroundColor: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      borderRadius: "8px",
                    }}
                  >
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12px", fontWeight: 700 }}>
                      Delivery %
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={divDeliveryPct}
                        onChange={(e) => setDivDeliveryPct(e.target.value)}
                        style={{ width: "70px", textAlign: "right", padding: "5px 7px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                      />
                    </label>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="number"
                        placeholder="Monthly amount"
                        value={divApplyFutureVal}
                        onChange={(e) => setDivApplyFutureVal(e.target.value)}
                        style={{ width: "120px", textAlign: "right", padding: "5px 8px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const v = parseNumericInput(divApplyFutureVal);
                          setDivMonthlyByKey((prev) => {
                            const next = { ...prev };
                            for (const fm of futureMonths) next[fm.monthKey] = v;
                            return next;
                          });
                        }}
                        style={{
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "1px solid #023f98",
                          backgroundColor: "#FFFFFF",
                          color: "#023f98",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Apply to future months
                      </button>
                    </div>
                  </div>

                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", width: "fit-content", minWidth: "100%" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                          <th style={{ textAlign: "left", padding: "8px 10px", minWidth: "160px", position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 2 }}>
                            Month
                          </th>
                          {checkedMonths.map((cm) => (
                            <th key={cm.monthKey} style={{ textAlign: "right", padding: "8px", minWidth: "90px", whiteSpace: "nowrap" }}>
                              {cm.shortLabel}
                              <div style={{ fontSize: "10px", fontWeight: 500, color: "#64748B" }}>Actual</div>
                            </th>
                          ))}
                          {futureMonths.map((fm, fIdx) => (
                            <th
                              key={fm.monthKey}
                              style={{
                                textAlign: "right",
                                padding: "8px",
                                minWidth: "90px",
                                backgroundColor: "#EFF6FF",
                                color: "#1E40AF",
                                borderLeft: fIdx === 0 ? "2px solid #93C5FD" : undefined,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {fm.shortLabel}
                              <div style={{ fontSize: "10px", fontWeight: 500, color: "#3B82F6" }}>FY{fm.fyIndex} f/c</div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ padding: "8px 10px", fontWeight: 700, position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                            Dividends in lieu of salary
                          </td>
                          {checkedMonths.map((cm) => (
                            <td key={cm.monthKey} style={{ padding: "6px", textAlign: "right" }}>
                              <input
                                type="number"
                                value={divMonthlyByKey[cm.monthKey] ?? 0}
                                onChange={(e) => {
                                  const v = parseNumericInput(e.target.value);
                                  setDivMonthlyByKey((prev) => ({ ...prev, [cm.monthKey]: v }));
                                }}
                                style={{ width: "78px", textAlign: "right", padding: "4px 6px", borderRadius: "5px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                              />
                            </td>
                          ))}
                          {futureMonths.map((fm, fIdx) => (
                            <td
                              key={fm.monthKey}
                              style={{
                                padding: "6px",
                                textAlign: "right",
                                backgroundColor: "#F8FAFC",
                                borderLeft: fIdx === 0 ? "2px solid #93C5FD" : undefined,
                              }}
                            >
                              <input
                                type="number"
                                value={divMonthlyByKey[fm.monthKey] ?? 0}
                                onChange={(e) => {
                                  const v = parseNumericInput(e.target.value);
                                  setDivMonthlyByKey((prev) => ({ ...prev, [fm.monthKey]: v }));
                                }}
                                style={{ width: "78px", textAlign: "right", padding: "4px 6px", borderRadius: "5px", border: "1px solid #93C5FD", fontSize: "12px" }}
                              />
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* STEP 4: OTHER EXPENSES & NON-OPERATING + IMMEDIATE RE-MAPPING */}
              {currentStep === 4 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "12px",
                      marginBottom: "14px",
                      padding: "10px 14px",
                      backgroundColor: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      borderRadius: "8px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "12px", fontWeight: 700, color: "#0F172A" }}>
                        Forecast calculation basis:
                      </span>
                      <div style={{ display: "inline-flex", borderRadius: "7px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                        {[
                          { id: "trailing12", label: "Trailing 12 months" },
                          { id: "currentFy", label: "Current financial year average" },
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleChangeBasis(opt.id)}
                            style={{
                              padding: "6px 12px",
                              border: "none",
                              backgroundColor: forecastBasis === opt.id ? "#023f98" : "#FFFFFF",
                              color: forecastBasis === opt.id ? "#FFFFFF" : "#334155",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <span style={{ fontSize: "11px", color: "#64748B" }}>
                        Rounded to nearest £10. Use &ldquo;Reassign mapping&rdquo; on any category to move it immediately to another P&amp;L mapping section.
                      </span>
                    </div>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, color: "#334155", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={showIndividualFutureExpenseMonths}
                        onChange={(e) => setShowIndividualFutureExpenseMonths(e.target.checked)}
                      />
                      Edit individual future months ({futureMonths.length})
                    </label>
                  </div>

                  {renderCategorySection(
                    "Other costs of sale (CoS)",
                    expenseItems.filter((it) => it.sectionType === "CoS"),
                    (updater) =>
                      setExpenseItems((prev) => {
                        const slice = prev.filter((it) => it.sectionType === "CoS");
                        const nextSlice = updater(slice);
                        let si = 0;
                        return prev.map((it) => (it.sectionType === "CoS" ? nextSlice[si++] : it));
                      }),
                    "#F1F5F9"
                  )}

                  {renderCategorySection(
                    "Overheads",
                    expenseItems.filter((it) => it.sectionType !== "CoS"),
                    (updater) =>
                      setExpenseItems((prev) => {
                        const slice = prev.filter((it) => it.sectionType !== "CoS");
                        const nextSlice = updater(slice);
                        let si = 0;
                        return prev.map((it) => (it.sectionType !== "CoS" ? nextSlice[si++] : it));
                      }),
                    "#F1F5F9"
                  )}

                  {depreciationItem &&
                    renderCategorySection(
                      "Depreciation",
                      [depreciationItem],
                      (updater) => setDepreciationItem((prev) => updater([prev])[0]),
                      "#F1F5F9"
                    )}

                  {renderCategorySection(
                    "Non-operating income",
                    nonOpIncomeItems,
                    setNonOpIncomeItems,
                    "#ECFDF5"
                  )}

                  {renderCategorySection(
                    "Non-operating expenses",
                    nonOpExpenseItems,
                    setNonOpExpenseItems,
                    "#FEF2F2"
                  )}

                  {expenseItems.length === 0 &&
                    nonOpIncomeItems.length === 0 &&
                    nonOpExpenseItems.length === 0 && (
                      <div style={{ padding: "24px", textAlign: "center", color: "#64748B", fontSize: "13px" }}>
                        No mapped expense or non-operating categories found.
                      </div>
                    )}
                </div>
              )}

              {/* STEP 5: FULL-YEAR P&L SUMMARY & SAVE */}
              {currentStep === 5 && (
                <div>
                  {hasExistingWarning && (
                    <div
                      style={{
                        marginBottom: "14px",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        backgroundColor: "#FFFBEB",
                        border: "1px solid #FDE68A",
                        color: "#92400E",
                        fontSize: "12px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "12px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <strong>Existing figures detected:</strong>{" "}
                        {isAdmin
                          ? "Client Outgoings and/or Salaries already contain values. Saving will overwrite checked historical months and future forecast values."
                          : "Historical costs or salary records already exist. Saving will update the checked months and forecast."}
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={confirmOverwrite}
                          onChange={(e) => setConfirmOverwrite(e.target.checked)}
                        />
                        Confirm overwrite on save
                      </label>
                    </div>
                  )}

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "10px",
                      marginBottom: "12px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#0F172A" }}>
                        Full-year profit &amp; loss preview
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748B" }}>
                        Combines your Salaries, Contractors, Dividends in lieu of salary, and Other expenses settings across checked actual months and future forecast months.
                      </div>
                    </div>
                    <div style={{ display: "inline-flex", borderRadius: "7px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                      {[
                        { id: 1, label: "Year 1 (actuals + forecast)" },
                        { id: 2, label: "Year 2 (forecast)" },
                      ].map((yr) => (
                        <button
                          key={yr.id}
                          type="button"
                          onClick={() => setPnlYearView(yr.id)}
                          style={{
                            padding: "6px 12px",
                            border: "none",
                            backgroundColor: pnlYearView === yr.id ? "#023f98" : "#FFFFFF",
                            color: pnlYearView === yr.id ? "#FFFFFF" : "#334155",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {yr.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", width: "fit-content", minWidth: "100%" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                          <th style={{ textAlign: "left", padding: "8px 12px", minWidth: "230px", position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 2 }}>
                            Profit &amp; loss line
                          </th>
                          {pnlMonthlySummary.cols.map((c) => (
                            <th key={c.monthKey} style={{ textAlign: "right", padding: "8px", minWidth: "90px", whiteSpace: "nowrap" }}>
                              {c.shortLabel}
                            </th>
                          ))}
                          <th
                            rowSpan={2}
                            style={{ textAlign: "right", padding: "8px 12px", minWidth: "100px", backgroundColor: "#EFF6FF", color: "#1E40AF", borderLeft: "2px solid #CBD5E1", verticalAlign: "middle" }}
                          >
                            FY{pnlYearView} total
                          </th>
                        </tr>
                        <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "2px solid #CBD5E1", color: "#475569" }}>
                          <th style={{ textAlign: "left", padding: "5px 12px", fontSize: "11px", fontWeight: 600, color: "#64748B", position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 2 }}>
                            Period basis
                          </th>
                          {pnlMonthlySummary.cols.map((c) => {
                            const isActual = c.isHist;
                            return (
                              <th key={`mode-${c.monthKey}`} style={{ textAlign: "right", padding: "4px 6px", whiteSpace: "nowrap" }}>
                                <select
                                  aria-label={`Period basis for ${c.shortLabel}`}
                                  value={isActual ? "Actual" : "Forecast"}
                                  disabled={pnlYearView === 2}
                                  onChange={(e) => {
                                    const wantActual = e.target.value === "Actual";
                                    if (wantActual !== isActual) {
                                      handleToggleMonth(c.monthKey);
                                    }
                                  }}
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: "5px",
                                    border: `1px solid ${isActual ? "#A7F3D0" : "#BFDBFE"}`,
                                    backgroundColor: isActual ? "#ECFDF5" : "#EFF6FF",
                                    color: isActual ? "#047857" : "#1D4ED8",
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    cursor: pnlYearView === 2 ? "not-allowed" : "pointer",
                                  }}
                                >
                                  <option value="Actual">Actual</option>
                                  <option value="Forecast">Forecast</option>
                                </select>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {renderPnlRow("Revenue", "revenue", { bold: true, bg: "#F8FAFC" })}
                        {renderPnlRow("Salaries — delivery (CoS)", "salCos", { isNegativeCost: true })}
                        {renderPnlRow("Contractors — delivery (CoS)", "conCos", { isNegativeCost: true })}
                        {renderPnlRow("Dividends in lieu — delivery (CoS)", "divCos", { isNegativeCost: true })}
                        {renderPnlRow("Other cost of sales", "otherCos", { isNegativeCost: true })}
                        {renderPnlRow("Total cost of sales", "totalCos", { bold: true, bg: "#F8FAFC", isNegativeCost: true, borderTop: true })}
                        {renderPnlRow("Gross profit", "grossProfit", { bold: true, bg: "#EFF6FF", color: "#1E40AF", borderTop: true })}
                        {renderPnlRow("Gross margin %", "grossMarginPct", { isMargin: true })}
                        {renderPnlRow("Salaries — non-delivery", "salAdmin", { isNegativeCost: true })}
                        {renderPnlRow("Contractors — non-delivery", "conAdmin", { isNegativeCost: true })}
                        {renderPnlRow("Dividends in lieu — non-delivery", "divAdmin", { isNegativeCost: true })}
                        {renderPnlRow("Other overheads", "otherOh", { isNegativeCost: true })}
                        {renderPnlRow("Depreciation", "depreciation", { isNegativeCost: true })}
                        {renderPnlRow("Total overheads", "totalOverheads", { bold: true, bg: "#F8FAFC", isNegativeCost: true, borderTop: true })}
                        {renderPnlRow("Operating profit", "operatingProfit", { bold: true, bg: "#F8FAFC", borderTop: true })}
                        {renderPnlRow("Non-operating income", "nonOpIncome", { color: "#047857" })}
                        {renderPnlRow("Non-operating expenses", "nonOpExpense", { isNegativeCost: true })}
                        {renderPnlRow("Net profit (pre-tax)", "netProfit", { bold: true, bg: "#ECFDF5", color: "#065F46", borderTop: true })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: "12px", color: "#64748B" }}>
            {checkedMonths.length} historical month(s) and {futureMonths.length} forecast month(s) selected.
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid #CBD5E1",
                backgroundColor: "#FFFFFF",
                color: "#334155",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            {currentStep > 1 && (
              <button
                type="button"
                disabled={saving}
                onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  backgroundColor: "#FFFFFF",
                  color: "#0F172A",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
            )}
            {currentStep < WIZARD_STEPS.length ? (
              <button
                type="button"
                disabled={!data || loading}
                onClick={() => setCurrentStep((s) => Math.min(WIZARD_STEPS.length, s + 1))}
                style={{
                  padding: "8px 18px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: !data || loading ? "#94A3B8" : "#023f98",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: !data || loading ? "not-allowed" : "pointer",
                }}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                style={{
                  padding: "8px 18px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: canSave ? "#047857" : "#94A3B8",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: canSave ? "pointer" : "not-allowed",
                }}
              >
                {saving ? "Saving StarterPL setup..." : "Save StarterPL setup"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 12-month contractor payment history popup */}
      {(() => {
        const hv = historyVendorId
          ? contractors.find((c) => c.id === historyVendorId)
          : null;
        if (!hv) return null;

        const histRows =
          Array.isArray(hv.trailingHistory) && hv.trailingHistory.length > 0
            ? hv.trailingHistory
            : (data?.trailing12MonthKeys || []).map((mk) => ({
                monthKey: mk,
                shortLabel: mk,
                totalNet: Number(hv.trailingMonthlyByKey?.[mk]) || 0,
                txns: [],
              }));
        const activeMonths = histRows.filter((r) => Number(r.totalNet) > 0.005);
        const total12m = round2(histRows.reduce((s, r) => s + (Number(r.totalNet) || 0), 0));
        const activeAvg = activeMonths.length > 0 ? total12m / activeMonths.length : 0;
        const activeAvgRounded = roundToNearest50(activeAvg);

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Last 12 months payments to ${hv.name}`}
            onClick={() => setHistoryVendorId("")}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1100,
              backgroundColor: "rgba(15, 23, 42, 0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "16px",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "92vw",
                maxWidth: "700px",
                maxHeight: "86vh",
                backgroundColor: "#FFFFFF",
                borderRadius: "12px",
                boxShadow: "0 20px 50px rgba(15, 23, 42, 0.28)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "14px 20px",
                  borderBottom: "1px solid #E2E8F0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0F172A" }}>
                    Last 12 months — {hv.name}
                  </h3>
                  <div style={{ fontSize: "12px", color: "#64748B", marginTop: "2px" }}>
                    Paid in {activeMonths.length} of {histRows.length} months · Total {formatMoney(total12m, currency, 2)} · Active avg {formatMoney(activeAvgRounded, currency, 0)}/mo
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setHistoryVendorId("")}
                  aria-label="Close payment history"
                  style={{
                    border: "none",
                    background: "transparent",
                    fontSize: "20px",
                    lineHeight: 1,
                    color: "#64748B",
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: "14px 20px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                      <th style={{ textAlign: "left", padding: "7px 8px", width: "90px" }}>Month</th>
                      <th style={{ textAlign: "right", padding: "7px 8px", width: "110px" }}>Net total</th>
                      <th style={{ textAlign: "left", padding: "7px 8px" }}>Payments / bills</th>
                    </tr>
                  </thead>
                  <tbody>
                    {histRows.map((row) => (
                      <tr key={row.monthKey} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td style={{ padding: "7px 8px", fontWeight: 600, color: "#0F172A", whiteSpace: "nowrap" }}>
                          {row.shortLabel}
                        </td>
                        <td
                          style={{
                            padding: "7px 8px",
                            textAlign: "right",
                            fontWeight: Number(row.totalNet) > 0.005 ? 700 : 400,
                            color: Number(row.totalNet) > 0.005 ? "#0F172A" : "#94A3B8",
                          }}
                        >
                          {Number(row.totalNet) > 0.005 ? formatMoney(row.totalNet, currency, 2) : "—"}
                        </td>
                        <td style={{ padding: "7px 8px", color: "#475569" }}>
                          {row.txns && row.txns.length > 0 ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                              {row.txns.map((t, idx) => (
                                <div key={t.id || idx} style={{ fontSize: "11px" }}>
                                  <strong>{formatMoney(t.amountNet, currency, 2)}</strong> · {t.source} ({t.recDate})
                                  {t.description ? ` — ${t.description}` : ""}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span style={{ color: "#94A3B8", fontSize: "11px" }}>No payments</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                style={{
                  padding: "12px 20px",
                  borderTop: "1px solid #E2E8F0",
                  backgroundColor: "#F8FAFC",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: "11px", color: "#64748B" }}>
                  Pattern detected: <strong>{hv.pattern || "none"}</strong>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {activeAvgRounded > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyVendorBulkForecast(hv.id, activeAvgRounded);
                        setHistoryVendorId("");
                      }}
                      style={{
                        padding: "7px 12px",
                        borderRadius: "7px",
                        border: "1px solid #023f98",
                        backgroundColor: "#EFF6FF",
                        color: "#023f98",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      Set all future months to {formatMoney(activeAvgRounded, currency, 0)}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setHistoryVendorId("")}
                    style={{
                      padding: "7px 14px",
                      borderRadius: "7px",
                      border: "1px solid #CBD5E1",
                      backgroundColor: "#FFFFFF",
                      color: "#334155",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
