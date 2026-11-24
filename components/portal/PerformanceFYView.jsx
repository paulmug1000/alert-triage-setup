import React, { useState, useRef, useEffect } from "react";
import { PerformanceSkeleton } from "../Skeleton";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData, DeepDiveEngine, parseMoney, formatMoney as universalFormatMoney, formatCurrencyString, isNBToFindLabel, hasNBToFindInPerformance } from "../../services/deepDiveHelper";
import PerformanceTrajectoryChartRow from "./PerformanceTrajectoryChartRow";
import { downloadCsv } from "../../utils/helpers";
import PulseNoteTrigger from "./PulseNoteTrigger";
import { usePulseNotes } from "../../contexts/PulseNotesContext";
import { buildScreenNoteKey } from "../../utils/pulseNotesKeys";

export default function PerformanceFYView({
  clientName,
  data,
  keyData,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const years = data?.years || [];
  const [selectedYearIdx, setSelectedYearIdx] = useState(null);
  const [activePopover, setActivePopover] = useState(null);
  const { openNotes, getEntitySummary } = usePulseNotes();

  useEffect(() => {
    if (activePopover?.isOpen && activePopover._clickParams && keyData) {
      const p = activePopover._clickParams;
      if (p.isSummaryPeriod) {
        const ddData = buildSummaryPeriodDeepDive({
          summaryKey: p.summaryKey,
          rowLabel: p.rowLabel,
          periodLabel: p.periodLabel,
          startIdx: p.startIdx,
          spanCount: p.spanCount,
          cellVal: p.cellVal,
        });
        setActivePopover((prev) => prev ? {
          ...prev,
          title: ddData.title,
          period: ddData.period,
          total: ddData.total,
          items: ddData.items || [],
          sections: ddData.sections || null,
          isLoading: false,
        } : null);
        return;
      }
      const ddData = buildDeepDiveData({
        ddType: p.ddType,
        periodLabel: p.periodLabel,
        monthIndex: p.mIdx,
        cellValue: p.val,
        yearIndex: p.activeYearIdx,
        targetDate: p.targetDate,
        keyData,
        isIncomeMode: p.isIncomeMode,
        isRestricted: isSenior,
      });
      setActivePopover((prev) => prev ? {
        ...prev,
        title: ddData.title,
        period: ddData.period,
        total: ddData.total,
        items: ddData.items || [],
        sections: ddData.sections || null,
        isLoading: false,
      } : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyData]);

  // Default to currentYearIdx from data or fallback to 1 (Year 1)
  const defaultYearIdx = data?.currentYearIdx !== undefined ? data.currentYearIdx : (years.length > 1 ? 1 : 0);
  const activeYearIdx = selectedYearIdx !== null ? Math.min(Math.max(0, selectedYearIdx), Math.max(0, years.length - 1)) : defaultYearIdx;
  const activeYear = years[activeYearIdx];
  const showNBToFind = hasNBToFindInPerformance(data) !== false;

  const isYear0 = Boolean(
    activeYear?.id === "hist" ||
    activeYear?.id === "year0" ||
    activeYear?.yearIndex === 0 ||
    String(activeYear?.name || "").toLowerCase().includes("historical") ||
    String(activeYear?.name || "").toLowerCase().includes("year 0") ||
    String(activeYear?.fyLabel || "").toLowerCase().includes("year 0") ||
    (activeYearIdx === 0 && (!activeYear?.yearIndex || activeYear.yearIndex === 0) && activeYear?.id !== "year1")
  );

  // Close active popover whenever switching financial years
  useEffect(() => {
    setActivePopover(null);
  }, [activeYearIdx]);

  const tableScrollRef = useRef(null);
  const chartScrollRef = useRef(null);
  const quartersScrollRef = useRef(null);
  const halvesScrollRef = useRef(null);
  const isSyncingScrollRef = useRef(false);

  const syncHorizontalScroll = (sourceRef) => {
    if (isSyncingScrollRef.current || !sourceRef?.current) return;
    isSyncingScrollRef.current = true;
    const nextLeft = sourceRef.current.scrollLeft;
    [tableScrollRef, chartScrollRef, quartersScrollRef, halvesScrollRef].forEach((ref) => {
      if (ref !== sourceRef && ref.current) {
        ref.current.scrollLeft = nextLeft;
      }
    });
    isSyncingScrollRef.current = false;
  };

  if (error && !data) {
    return (
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          padding: "3.5rem 2rem",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          border: "1px solid #fee2e2",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "36px", marginBottom: "12px" }}>⚠️</div>
        <h3 style={{ margin: "0 0 8px 0", color: "#991b1b", fontSize: "1.2rem", fontWeight: 700 }}>
          Unable to Load Performance Data
        </h3>
        <p style={{ margin: "0 0 1.25rem 0", color: "#64748b", fontSize: "14px" }}>{error}</p>
        <button
          type="button"
          onClick={onRefresh}
          style={{
            background: "#0047AB",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "0.6rem 1.25rem",
            fontSize: "14px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (!activeYear) {
    if (isLoading || !data) {
      return <PerformanceSkeleton />;
    }
    return (
      <div style={{ background: "#ffffff", borderRadius: "8px", padding: "4rem", textAlign: "center" }}>
        <p style={{ color: "#64748b" }}>No financial year data found for this client.</p>
      </div>
    );
  }

  // Extract key summary KPI metrics from the active year's rows
  const findRow = (prefixArr) => {
    // 1. Exact match in priority order
    for (const prefix of prefixArr) {
      const p = prefix.toLowerCase().trim();
      const exact = activeYear.rows?.find((r) => {
        if (!r.label || !r.totalVal) return false;
        return String(r.label).toLowerCase().trim() === p;
      });
      if (exact) return exact;
    }

    // 2. StartsWith match in priority order
    for (const prefix of prefixArr) {
      const p = prefix.toLowerCase().trim();
      const starts = activeYear.rows?.find((r) => {
        if (!r.label || !r.totalVal) return false;
        const lbl = String(r.label).toLowerCase().trim();
        if (p === "income" || p === "revenue" || p === "turnover") {
          if (lbl.includes("confirmed") || lbl.includes("pipeline")) return false;
        }
        return lbl.startsWith(p);
      });
      if (starts) return starts;
    }

    // 3. Substring match in priority order
    for (const prefix of prefixArr) {
      const p = prefix.toLowerCase().trim();
      const includesMatch = activeYear.rows?.find((r) => {
        if (!r.label || !r.totalVal) return false;
        const lbl = String(r.label).toLowerCase().trim();
        if (p === "income" || p === "revenue" || p === "turnover") {
          if (lbl.includes("confirmed") || lbl.includes("pipeline")) return false;
        }
        return lbl.includes(p);
      });
      if (includesMatch) return includesMatch;
    }

    return null;
  };

  const currencySymbol = propCurrencySymbol || keyData?.currencySymbol || "£";
  const thousandsSeparator = propThousandsSeparator || keyData?.thousandsSeparator || ",";

  // Parse numerical money string (e.g. "£45,270" -> 45270, "(£12,000)" -> -12000)
  const parseNum = (val) => {
    return parseMoney(val);
  };

  // Strictly target Total Income / Total Revenue, never Confirmed or Pipeline
  const totalRevRow =
    activeYear.rows?.find((r) => {
      const l = String(r.label || "").toLowerCase().trim();
      return l === "total income" || l === "total revenue" || l === "total turnover";
    }) ||
    activeYear.rows?.find((r) => {
      const l = String(r.label || "").toLowerCase().trim();
      return l.startsWith("total income") || l.startsWith("total revenue") || l.startsWith("total turnover");
    }) ||
    activeYear.rows?.find((r) => {
      const l = String(r.label || "").toLowerCase().trim();
      return (l === "income" || l === "revenue" || l === "turnover") && !l.includes("confirmed") && !l.includes("pipeline");
    }) ||
    findRow(["total income", "total revenue", "total turnover", "income", "revenue"]);

  const totalCosRow =
    activeYear.rows?.find((r) => {
      const l = String(r.label || "").toLowerCase().trim();
      return l === "total costs of sale" || l === "total cost of sales";
    }) || findRow(["total costs of sale", "total cost of sales"]);
  const grossProfitRow = activeYear.rows?.find((r) => {
    const l = String(r.label || "").toLowerCase().trim();
    return l === "gross profit";
  });
  const gpMarginRow = findRow(["gross profit margin"]);
  const overheadsRow = findRow(["total overheads", "overheads"]);
  const overheadsPctRow = findRow(["overheads as %"]);
  const opProfitRow = activeYear.rows?.find((r) => {
    const l = String(r.label || "").toLowerCase().trim();
    return l === "operating profit";
  });
  const opMarginRow = findRow(["operating profit %"]);
  const staffRatioRow = activeYear.rows?.find((r) => {
    const l = String(r.label || "").toLowerCase().trim();
    return l.includes("staff costs to") || l.includes("staff ratio");
  });
  const staffDelRow = activeYear.rows?.find((r) => {
    const l = String(r.label || "").toLowerCase().trim();
    return l.includes("staff costs - delivery") || l.includes("delivery staff");
  });
  const staffNonDelRow = activeYear.rows?.find((r) => {
    const l = String(r.label || "").toLowerCase().trim();
    return l.includes("staff costs - non-delivery") || l.includes("non-delivery staff");
  });

  // Trajectory chart values
  const chartRevVals =
    (totalRevRow?.monthlyMath || []).length > 0 && totalRevRow.monthlyMath.some((v) => typeof v === "number")
      ? totalRevRow.monthlyMath.map((m, idx) => (typeof m === "number" && !isNaN(m) ? m : parseNum(totalRevRow?.monthlyValues?.[idx])))
      : (totalRevRow?.monthlyValues || []).map(parseNum);
  const chartGpVals =
    (grossProfitRow?.monthlyMath || []).length > 0 && grossProfitRow.monthlyMath.some((v) => typeof v === "number")
      ? grossProfitRow.monthlyMath.map((m, idx) => (typeof m === "number" && !isNaN(m) ? m : parseNum(grossProfitRow?.monthlyValues?.[idx])))
      : (grossProfitRow?.monthlyValues || []).map(parseNum);
  const chartOpVals =
    (opProfitRow?.monthlyMath || []).length > 0 && opProfitRow.monthlyMath.some((v) => typeof v === "number")
      ? opProfitRow.monthlyMath.map((m, idx) => (typeof m === "number" && !isNaN(m) ? m : parseNum(opProfitRow?.monthlyValues?.[idx])))
      : (opProfitRow?.monthlyValues || []).map(parseNum);

  const isIncomeMode =
    String(keyData?.outgoingsMeta?.mode || "").toLowerCase() === "income" ||
    Boolean(totalRevRow?.label && String(totalRevRow.label).toLowerCase().includes("income")) ||
    Boolean(activeYear?.rows?.some((r) => r.label && String(r.label).toLowerCase().includes("confirmed income")));
  const revenueLabel = isIncomeMode ? "Income" : "Revenue";

  // Threshold margin styling
  const getMarginBadgeStyle = (label, valStr) => {
    if (!valStr || !String(valStr).includes("%")) return null;
    const num = parseFloat(String(valStr).replace(/%/g, "")) / 100;
    if (isNaN(num)) return null;

    const t = data?.thresholds || [];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    const l = String(label || "").toLowerCase();

    if (l.includes("gross profit margin")) {
      const high = parseT(0, 0.495);
      const low = parseT(1, 0.445);
      if (num >= high) return { bg: "#d9ead3", color: "#0047AB" };
      if (num >= low) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      const high = parseT(5, 0.309);
      const low = parseT(6, 0);
      if (num > high) return { bg: "#f4cccc", color: "#0047AB" };
      if (num >= low) return { bg: "#d9ead3", color: "#0047AB" };
      return { bg: "#fce5cd", color: "#0047AB" };
    }
    if (l.includes("operating profit %") || l.includes("operating profit margin")) {
      const high = parseT(10, 0.145);
      const low = parseT(11, 0.05);
      if (num >= high) return { bg: "#d9ead3", color: "#0047AB" };
      if (num >= low) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    if (l.includes("staff costs to") || l.includes("staff ratio")) {
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (num < z59) return { bg: "#fce5cd", color: "#0047AB" };
      if (num <= z58) return { bg: "#d9ead3", color: "#0047AB" };
      if (num <= z57) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    return null;
  };

  const getRowStyle = (label) => {
    const l = String(label || "").toLowerCase().trim();
    if (l === "total income" || l === "total revenue") {
      return { bg: "#9900ff", color: "#ffffff", bold: true, isMajor: true };
    }
    if (l === "gross profit") {
      return { bg: "#e69138", color: "#ffffff", bold: true, isMajor: true };
    }
    if (l === "total overheads") {
      return { bg: "#45818e", color: "#ffffff", bold: true, isMajor: true };
    }
    if (l === "operating profit") {
      return { bg: "#1155cc", color: "#ffffff", bold: true, isMajor: true };
    }
    if (["income", "revenue", "costs of sale", "cost of sales", "overheads"].includes(l)) {
      return { bg: "#ffffff", color: "#0047AB", bold: true, isHeader: true };
    }
    if (l.includes("gross profit margin") || l.includes("gross profit %")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#e69138" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#45818e" };
    }
    if (l.includes("operating profit %") || l.includes("operating profit margin")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#1155cc" };
    }
    if (l.includes("staff costs to") || l.includes("staff ratio")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#64748b" };
    }
    if (l.includes("margin") || l.includes("ratio") || l.includes("%")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: null };
    }
    return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false };
  };

  const handleCellClick = (e, rowLabel, val, mIdx, periodLabel) => {
    if (isYear0) return;
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "—" || val === "" || Math.abs(parseMoney(val)) < 0.001) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const isFYTotal = mIdx === -1;
    const firstMonthStr = activeYear?.headerMonths?.[0] || "Apr 25";
    const fyStartDate = DeepDiveEngine.parseHeaderDate(firstMonthStr) || new Date(2025, 3, 1);

    let targetDate = null;
    if (isFYTotal) {
      targetDate = fyStartDate;
    } else {
      const monthStr = activeYear?.headerMonths?.[mIdx];
      targetDate = monthStr ? DeepDiveEngine.parseHeaderDate(monthStr) : null;
      if (!targetDate) {
        targetDate = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + mIdx, 1);
      }
    }

    const isIncomeMode =
      String(keyData?.outgoingsMeta?.mode || "").toLowerCase() === "income" ||
      Boolean(activeYear?.rows?.some((r) => r.label && String(r.label).toLowerCase().includes("confirmed income")));

    const isDataLoading = !keyData || isLoading;

    const ddData = buildDeepDiveData({
      ddType,
      periodLabel,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: activeYearIdx,
      targetDate,
      keyData,
      isIncomeMode,
      isRestricted: isSenior,
    });

    setActivePopover({
      isOpen: true,
      targetRect: rect,
      title: ddData.title,
      period: ddData.period,
      total: ddData.total,
      items: ddData.items || [],
      sections: ddData.sections || null,
      isLoading: isDataLoading,
      _clickParams: { ddType, periodLabel, mIdx, val, activeYearIdx, targetDate, isIncomeMode, rect },
    });
  };


  const getMonthMathVal = (row, mIdx) => {
    if (!row) return 0;
    const rawMath = row.monthlyMath?.[mIdx];
    if (typeof rawMath === "number" && Number.isFinite(rawMath)) return rawMath;
    return parseNum(row.monthlyValues?.[mIdx]);
  };

  const sumPeriod = (row, startIdx, endIdx) => {
    if (!row) return 0;
    let total = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      total += getMonthMathVal(row, i);
    }
    return total;
  };

  const formatMonthRange = (startStr, endStr) => {
    const s = String(startStr || "").trim();
    const e = String(endStr || "").trim();
    if (!s || !e) return s || e || "";
    const m1 = s.match(/^([A-Za-z]{3})[\s\-]+(\d{2,4})$/);
    const m2 = e.match(/^([A-Za-z]{3})[\s\-]+(\d{2,4})$/);
    if (m1 && m2 && m1[2] === m2[2]) {
      return `${m1[1]}–${m2[1]} ${m1[2]}`;
    }
    return `${s}–${e}`;
  };

  const getPeriodStatus = (statuses, startIdx, endIdx) => {
    const total = endIdx - startIdx + 1;
    let actualCount = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      if (String(statuses[i] || "").trim().toLowerCase() === "actual") {
        actualCount++;
      }
    }
    if (actualCount === total) {
      return {
        label: "Actual",
        type: "actual",
        colBg: "#f4f7fa",
        color: "#0047AB",
        fontWeight: 600,
        fontStyle: "normal",
        tooltip: "All months actual",
      };
    }
    return {
      label: "Forecast",
      type: "forecast",
      colBg: "#ffffff",
      color: "#64748b",
      fontWeight: 400,
      fontStyle: "italic",
      tooltip: actualCount === 0 ? "All months forecast" : `${actualCount} actual, ${total - actualCount} forecast`,
    };
  };

  const headerMonths = activeYear.headerMonths || [];
  const monthStatuses = activeYear.statusValues || activeYear.monthStatuses || [];
  const hasFull12Months = Array.isArray(headerMonths) && headerMonths.length === 12;

  const buildPeriodDefs = (defs) =>
    defs.map((d) => {
      const rangeLabel = formatMonthRange(headerMonths[d.startIdx], headerMonths[d.endIdx]);
      return {
        ...d,
        rangeLabel,
        fullLabel: rangeLabel ? `${d.label} (${rangeLabel})` : d.label,
        status: getPeriodStatus(monthStatuses, d.startIdx, d.endIdx),
      };
    });

  const quarters = hasFull12Months
    ? buildPeriodDefs([
        { key: "q1", label: "Q1", startIdx: 0, endIdx: 2, span: 3 },
        { key: "q2", label: "Q2", startIdx: 3, endIdx: 5, span: 3 },
        { key: "q3", label: "Q3", startIdx: 6, endIdx: 8, span: 3 },
        { key: "q4", label: "Q4", startIdx: 9, endIdx: 11, span: 3 },
      ])
    : [];

  const halves = hasFull12Months
    ? buildPeriodDefs([
        { key: "h1", label: "H1", startIdx: 0, endIdx: 5, span: 6 },
        { key: "h2", label: "H2", startIdx: 6, endIdx: 11, span: 6 },
      ])
    : [];

  const coreSummaryRowDefs = [
    totalRevRow ? { key: "totalRev", row: totalRevRow, kind: "currency", isMajor: true } : null,
    totalCosRow ? { key: "totalCos", row: totalCosRow, kind: "currency", isMajor: false } : null,
    grossProfitRow ? { key: "gpGap", kind: "spacer", height: 10 } : null,
    grossProfitRow ? { key: "grossProfit", row: grossProfitRow, kind: "currency", isMajor: true } : null,
    gpMarginRow && grossProfitRow ? { key: "gpMargin", row: gpMarginRow, kind: "percent", numeratorRow: grossProfitRow } : null,
    overheadsRow ? { key: "ovhGap", kind: "spacer", height: 10 } : null,
    overheadsRow ? { key: "totalOverheads", row: overheadsRow, kind: "currency", isMajor: true } : null,
    overheadsPctRow && overheadsRow ? { key: "overheadsPct", row: overheadsPctRow, kind: "percent", numeratorRow: overheadsRow } : null,
    opProfitRow ? { key: "opGap", kind: "spacer", height: 10 } : null,
    opProfitRow ? { key: "opProfit", row: opProfitRow, kind: "currency", isMajor: true } : null,
    opMarginRow && opProfitRow ? { key: "opMargin", row: opMarginRow, kind: "percent", numeratorRow: opProfitRow } : null,
    ...(staffRatioRow
      ? [
          { key: "staffGap", kind: "spacer", height: 14 },
          { key: "staffRatio", row: staffRatioRow, kind: "staffPercent" },
        ]
      : []),
  ].filter(Boolean);

  const summaryRowDefs =
    coreSummaryRowDefs.length > 0
      ? [
          { key: "topGap", kind: "spacer", height: 8 },
          ...coreSummaryRowDefs,
          { key: "bottomGap", kind: "spacer", height: 6 },
        ]
      : [];

  const isStaffRowRedacted = (row, startIdx, endIdx) => {
    if (isSenior) return true;
    if (row?.totalVal === "—" || staffDelRow?.totalVal === "—" || staffNonDelRow?.totalVal === "—") {
      return true;
    }
    for (let i = startIdx; i <= endIdx; i++) {
      if (
        row?.monthlyValues?.[i] === "—" ||
        staffDelRow?.monthlyValues?.[i] === "—" ||
        staffNonDelRow?.monthlyValues?.[i] === "—"
      ) {
        return true;
      }
    }
    return false;
  };

  const computeSummaryCell = (def, startIdx, endIdx) => {
    if (def.kind === "currency") {
      const numericVal = sumPeriod(def.row, startIdx, endIdx);
      const displayVal = universalFormatMoney(numericVal, 0, currencySymbol, thousandsSeparator);
      return {
        displayVal,
        numericVal,
        badge: null,
        isClickable: def.key !== "opProfit" && Math.abs(numericVal) >= 0.001,
      };
    }

    if (def.kind === "staffPercent") {
      if (isStaffRowRedacted(def.row, startIdx, endIdx)) {
        return { displayVal: "", numericVal: null, badge: null, isClickable: false };
      }
      const rev = sumPeriod(totalRevRow, startIdx, endIdx);
      if (Math.abs(rev) < 0.001) {
        return { displayVal: "", numericVal: null, badge: null, isClickable: false };
      }
      const staffSum = sumPeriod(staffDelRow, startIdx, endIdx) + sumPeriod(staffNonDelRow, startIdx, endIdx);
      const displayVal = `${Math.round((staffSum / rev) * 100)}%`;
      return {
        displayVal,
        numericVal: staffSum / rev,
        badge: getMarginBadgeStyle(def.row.label, displayVal),
        isClickable: false,
      };
    }

    // Percentage row (GP margin %, Overheads %, Operating profit %)
    const rev = sumPeriod(totalRevRow, startIdx, endIdx);
    if (Math.abs(rev) < 0.001) {
      return { displayVal: "", numericVal: null, badge: null, isClickable: false };
    }
    const num = sumPeriod(def.numeratorRow, startIdx, endIdx);
    const displayVal = `${Math.round((num / rev) * 100)}%`;
    return {
      displayVal,
      numericVal: num / rev,
      badge: getMarginBadgeStyle(def.row.label, displayVal),
      isClickable: false,
    };
  };

  const getSectionSubRows = (startHeaderLabels, stopRow) => {
    const rows = activeYear.rows || [];
    const headerSet = new Set(startHeaderLabels.map((h) => h.toLowerCase().trim()));
    let inSection = false;
    const subRows = [];
    for (const r of rows) {
      const lbl = String(r?.label || "").trim();
      const lower = lbl.toLowerCase();
      if (!inSection) {
        if (headerSet.has(lower)) {
          inSection = true;
        }
        continue;
      }
      if (stopRow && (r === stopRow || lower === String(stopRow.label || "").toLowerCase().trim())) {
        break;
      }
      if (!lbl || lower === "hide") continue;
      const rs = getRowStyle(lbl);
      if (rs.isHeader || rs.isMajor || rs.isMarginRow) continue;
      subRows.push(r);
    }
    return subRows;
  };

  const buildSummaryPeriodDeepDive = ({ summaryKey, rowLabel, periodLabel, startIdx, spanCount, cellVal }) => {
    const firstMonthStr = headerMonths[0] || "Apr 25";
    const fyStartDate = DeepDiveEngine.parseHeaderDate(firstMonthStr) || new Date(2025, 3, 1);
    const startMonthStr = headerMonths[startIdx];
    let targetDate = startMonthStr ? DeepDiveEngine.parseHeaderDate(startMonthStr) : null;
    if (!targetDate) {
      targetDate = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + startIdx, 1);
    }

    const summaryRowMap = {
      totalRev: totalRevRow,
      totalCos: totalCosRow,
      grossProfit: grossProfitRow,
      totalOverheads: overheadsRow,
      opProfit: opProfitRow,
    };
    const summaryRowObj = summaryRowMap[summaryKey];

    const monthlyBreakdownItems = [];
    for (let m = startIdx; m < startIdx + spanCount; m++) {
      const val = getMonthMathVal(summaryRowObj, m);
      const stRaw = String(monthStatuses[m] || "").trim().toLowerCase();
      let detail = stRaw === "actual" ? "Actual" : "Forecast";
      if (summaryKey === "grossProfit" || summaryKey === "opProfit") {
        const revM = getMonthMathVal(totalRevRow, m);
        if (Math.abs(revM) >= 0.001) {
          detail += ` • ${Math.round((val / revM) * 100)}% margin`;
        }
      }
      monthlyBreakdownItems.push({
        name: headerMonths[m] || `Month ${m + 1}`,
        detail,
        amount: val,
      });
    }

    const monthlySection = {
      key: "monthly_breakdown",
      title: "Monthly breakdown",
      amount: sumPeriod(summaryRowObj, startIdx, startIdx + spanCount - 1),
      isAccordion: true,
      items: monthlyBreakdownItems,
    };

    const buildConstituentSection = (subRow) => {
      const subVal = sumPeriod(subRow, startIdx, startIdx + spanCount - 1);
      if (Math.abs(subVal) < 0.005) return null;

      if (!isYear0 && keyData) {
        const ddType = getDeepDiveType(subRow.label);
        if (ddType) {
          const dd = buildDeepDiveData({
            ddType,
            periodLabel,
            monthIndex: startIdx,
            cellValue: subVal,
            yearIndex: activeYearIdx,
            targetDate,
            aggregateCount: spanCount,
            keyData,
            isIncomeMode,
            isRestricted: isSenior,
          });
          let items = Array.isArray(dd.items) ? dd.items : [];
          if (items.length === 0 && Array.isArray(dd.sections) && dd.sections.length > 0) {
            const flattened = [];
            dd.sections.forEach((sec) => {
              if (Array.isArray(sec.items) && sec.items.length > 0) {
                sec.items.forEach((it) => {
                  flattened.push({
                    ...it,
                    detail: it.detail ? `${sec.title} • ${it.detail}` : sec.title,
                  });
                });
              } else if (sec.title) {
                flattened.push({
                  name: sec.title,
                  amount: sec.amount || 0,
                });
              }
            });
            items = flattened;
          }
          return {
            key: subRow.label,
            title: subRow.label,
            amount: subVal,
            isAccordion: true,
            items,
          };
        }
      }

      return {
        key: subRow.label,
        title: subRow.label,
        amount: subVal,
        isAccordion: false,
      };
    };

    let sections = null;
    let items = [];

    if (summaryKey === "totalRev") {
      const subSections = getSectionSubRows(["income", "revenue", "turnover"], totalRevRow)
        .map(buildConstituentSection)
        .filter(Boolean);
      sections = [...subSections, monthlySection];
    } else if (summaryKey === "totalCos") {
      if (isSenior) {
        sections = null;
        items = monthlyBreakdownItems;
      } else {
        const subSections = getSectionSubRows(["costs of sale", "cost of sales"], totalCosRow)
          .map(buildConstituentSection)
          .filter(Boolean);
        sections = [...subSections, monthlySection];
      }
    } else if (summaryKey === "grossProfit") {
      const revSum = sumPeriod(totalRevRow, startIdx, startIdx + spanCount - 1);
      const cosSum = sumPeriod(totalCosRow, startIdx, startIdx + spanCount - 1);
      sections = [
        {
          key: "gp_rev",
          title: totalRevRow?.label || `Total ${revenueLabel.toLowerCase()}`,
          amount: revSum,
          isAccordion: false,
        },
        {
          key: "gp_cos",
          title: `Less: ${totalCosRow?.label || "Total costs of sale"}`,
          amount: -cosSum,
          isAccordion: false,
        },
        monthlySection,
      ];
    } else if (summaryKey === "totalOverheads") {
      if (isSenior) {
        sections = null;
        items = monthlyBreakdownItems;
      } else {
        const subSections = getSectionSubRows(["overheads"], overheadsRow)
          .map(buildConstituentSection)
          .filter(Boolean);
        sections = [...subSections, monthlySection];
      }
    }

    return {
      title: `${rowLabel} (${periodLabel})`,
      period: periodLabel,
      total: cellVal,
      items,
      sections,
    };
  };

  const handleSummaryCellClick = (e, summaryKey, rowLabel, cellVal, startIdx, spanCount, periodLabel) => {
    if (summaryKey === "opProfit") return;
    if (cellVal === null || cellVal === undefined || cellVal === "" || cellVal === "—" || Math.abs(parseMoney(cellVal)) < 0.001) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const ddData = buildSummaryPeriodDeepDive({
      summaryKey,
      rowLabel,
      periodLabel,
      startIdx,
      spanCount,
      cellVal,
    });
    const isDataLoading = !isYear0 && (!keyData || isLoading);
    setActivePopover({
      isOpen: true,
      targetRect: rect,
      title: ddData.title,
      period: ddData.period,
      total: ddData.total,
      items: ddData.items || [],
      sections: ddData.sections || null,
      isLoading: isDataLoading,
      _clickParams: {
        isSummaryPeriod: true,
        summaryKey,
        rowLabel,
        periodLabel,
        startIdx,
        spanCount,
        cellVal,
      },
    });
  };

  const handleDownloadCSV = () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const fyName = (activeYear?.fyLabel || activeYear?.displayTitle || "FY").replace(/\s+/g, "_");
    const exportRows = [];
    exportRows.push([`Performance: ${activeYear?.fyLabel || activeYear?.displayTitle}`]);
    exportRows.push([]);
    exportRows.push(["Metric", ...(activeYear?.headerMonths || []), "", "Total"]);
    (activeYear?.rows || []).forEach((r) => {
      const lbl = String(r.label || "").trim();
      if (!lbl || lbl.toLowerCase() === "hide" || (!showNBToFind && isNBToFindLabel(lbl))) return;
      const rowStyle = getRowStyle(lbl);
      if (rowStyle.isHeader) {
        exportRows.push([lbl]);
      } else {
        exportRows.push([lbl, ...(r.monthlyValues || []), "", r.totalVal || ""]);
      }
    });

    if (hasFull12Months && summaryRowDefs.length > 0) {
      const appendSummaryCsvSection = (sectionTitle, periods) => {
        exportRows.push([]);
        exportRows.push([sectionTitle]);
        exportRows.push(["Metric", ...periods.map((p) => p.fullLabel)]);
        exportRows.push(["Status", ...periods.map((p) => p.status.label)]);
        summaryRowDefs.forEach((def) => {
          if (def.kind === "spacer") return;
          const vals = periods.map((p) => computeSummaryCell(def, p.startIdx, p.endIdx).displayVal);
          exportRows.push([def.row.label, ...vals]);
        });
      };
      appendSummaryCsvSection("Quarters", quarters);
      appendSummaryCsvSection("Halves", halves);
    }

    downloadCsv(`Pulse_Performance_${fyName}_${dateStr}.csv`, exportRows);
  };

  const renderPeriodSummaryTable = ({ title, periods, scrollRef, wrapperClassName }) => {
    if (!hasFull12Months || !periods || periods.length === 0 || summaryRowDefs.length === 0) {
      return null;
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0047AB" }}>
          {title}
        </h3>
        <div
          className={wrapperClassName}
          ref={scrollRef}
          onScroll={() => syncHorizontalScroll(scrollRef)}
          style={{
            background: "transparent",
            overflowX: "auto",
            width: "100%",
          }}
        >
          <div style={{ width: "100%", minWidth: "980px" }}>
            <div
              style={{
                width: "92.2%",
                background: "#ffffff",
                borderRadius: "8px",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
                border: "1px solid #e2e8f0",
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  tableLayout: "fixed",
                  fontSize: "12px",
                  fontFamily: "'Kumbh Sans', sans-serif",
                  background: "#ffffff",
                }}
              >
                <colgroup>
                  <col style={{ width: "20.6074%", minWidth: "20.6074%" }} />
                  {headerMonths.map((_, idx) => (
                    <col key={idx} style={{ width: "6.61605%", minWidth: "6.61605%" }} />
                  ))}
                </colgroup>
                <thead>
                  <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        fontWeight: 700,
                        fontSize: "12px",
                        position: "sticky",
                        left: 0,
                        background: "#0047AB",
                        zIndex: 3,
                        width: "20.6074%",
                      }}
                    />
                    {periods.map((p) => (
                      <th
                        key={p.key}
                        colSpan={p.span}
                        style={{
                          padding: "8px 10px",
                          textAlign: "center",
                          fontWeight: 700,
                          fontSize: "11.5px",
                          borderLeft: "1px solid rgba(255, 255, 255, 0.18)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span>{p.label}</span>
                        {p.rangeLabel && (
                          <span
                            style={{
                              marginLeft: "5px",
                              fontSize: "10.5px",
                              fontWeight: 500,
                              color: "rgba(255, 255, 255, 0.82)",
                            }}
                          >
                            {p.rangeLabel}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>

                  <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", fontSize: "10.5px" }}>
                    <td
                      style={{
                        padding: "5px 10px",
                        position: "sticky",
                        left: 0,
                        background: "#ffffff",
                        zIndex: 3,
                        borderBottom: "1px solid #e2e8f0",
                      }}
                    />
                    {periods.map((p) => (
                      <td
                        key={p.key}
                        colSpan={p.span}
                        title={p.status.tooltip}
                        style={{
                          padding: "5px 10px",
                          textAlign: "center",
                          color: p.status.color,
                          fontWeight: p.status.fontWeight,
                          fontStyle: p.status.fontStyle,
                          background: p.status.colBg,
                          borderLeft: "1px solid #e2e8f0",
                          borderBottom: "1px solid #e2e8f0",
                        }}
                      >
                        {p.status.label}
                      </td>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {summaryRowDefs.map((def) => {
                    if (def.kind === "spacer") {
                      return (
                        <tr key={def.key} style={{ height: `${def.height || 10}px`, lineHeight: 0 }}>
                          <td
                            style={{
                              padding: 0,
                              background: "#ffffff",
                              position: "sticky",
                              left: 0,
                              zIndex: 2,
                              border: "none",
                            }}
                          />
                          {periods.map((p) => (
                            <td
                              key={p.key}
                              colSpan={p.span}
                              style={{
                                padding: 0,
                                background: "#ffffff",
                                border: "none",
                                borderLeft: "1px solid #f1f5f9",
                              }}
                            />
                          ))}
                        </tr>
                      );
                    }

                    const label = def.row.label;
                    const rowStyle = getRowStyle(label);
                    const isPctRow = def.kind === "percent" || def.kind === "staffPercent";
                    const isMarginRow = Boolean(rowStyle.isMarginRow);
                    const isMajor = Boolean(def.isMajor && rowStyle.isMajor);
                    const rowHeight = isMajor ? "34px" : isMarginRow ? "28px" : "30px";

                    return (
                      <tr
                        key={def.key}
                        style={{
                          height: rowHeight,
                          borderBottom: isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                          background: isMajor ? rowStyle.bg : "#ffffff",
                          fontWeight: isMajor || !isPctRow ? 700 : 400,
                        }}
                      >
                        <td
                          style={{
                            padding: isMarginRow ? "4px 10px" : "6px 10px",
                            color: isMajor ? "#ffffff" : rowStyle.color,
                            fontSize: isMajor ? "13px" : isMarginRow ? "11px" : "12px",
                            fontWeight: isMajor ? 700 : isMarginRow ? 400 : 600,
                            paddingLeft: isMarginRow ? "20px" : "10px",
                            fontStyle: isPctRow ? "italic" : "normal",
                            position: "sticky",
                            left: 0,
                            background: isMajor ? rowStyle.bg : "#ffffff",
                            borderLeft: isMarginRow && rowStyle.accentBar ? `4px solid ${rowStyle.accentBar}` : "none",
                            zIndex: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                          }}
                          title={label}
                        >
                          {label}
                        </td>

                        {periods.map((p) => {
                          const cell = computeSummaryCell(def, p.startIdx, p.endIdx);
                          const colBg = p.status.colBg;

                          if (isMajor) {
                            return (
                              <td
                                key={p.key}
                                colSpan={p.span}
                                onClick={(e) =>
                                  cell.isClickable &&
                                  handleSummaryCellClick(e, def.key, label, cell.numericVal, p.startIdx, p.span, p.fullLabel)
                                }
                                style={{
                                  padding: "6px 10px",
                                  textAlign: "center",
                                  color: "#ffffff",
                                  fontSize: "13px",
                                  fontWeight: 700,
                                  background: "transparent",
                                  borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                                  cursor: cell.isClickable ? "pointer" : "default",
                                  textDecoration: cell.isClickable ? "underline dashed rgba(255,255,255,0.6) 1px" : "none",
                                  textUnderlineOffset: "2px",
                                  whiteSpace: "nowrap",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                {cell.displayVal}
                              </td>
                            );
                          }

                          if (isMarginRow) {
                            return (
                              <td
                                key={p.key}
                                colSpan={p.span}
                                style={{
                                  padding: "4px 10px",
                                  background: colBg,
                                  borderLeft: "1px solid #e2e8f0",
                                  textAlign: "center",
                                  height: "28px",
                                }}
                              >
                                <div
                                  style={{
                                    display: "inline-block",
                                    minWidth: "54px",
                                    padding: "2px 12px",
                                    borderRadius: "4px",
                                    background: cell.badge ? cell.badge.bg : "transparent",
                                    color: cell.badge ? cell.badge.color : "#0047AB",
                                    fontStyle: "italic",
                                    fontSize: "11px",
                                    fontWeight: cell.badge ? 700 : 400,
                                    fontVariantNumeric: "tabular-nums",
                                    boxSizing: "border-box",
                                    textAlign: "center",
                                  }}
                                >
                                  {cell.displayVal}
                                </div>
                              </td>
                            );
                          }

                          return (
                            <td
                              key={p.key}
                              colSpan={p.span}
                              onClick={(e) =>
                                cell.isClickable &&
                                handleSummaryCellClick(e, def.key, label, cell.numericVal, p.startIdx, p.span, p.fullLabel)
                              }
                              style={{
                                padding: "6px 10px",
                                textAlign: "center",
                                color: rowStyle.color,
                                fontSize: "11.5px",
                                fontWeight: 600,
                                background: colBg,
                                borderLeft: "1px solid #e2e8f0",
                                cursor: cell.isClickable ? "pointer" : "default",
                                textDecoration: cell.isClickable ? "underline dashed #94a3b8 1px" : "none",
                                textUnderlineOffset: "2px",
                                whiteSpace: "nowrap",
                                fontVariantNumeric: "tabular-nums",
                                transition: "background-color 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                if (cell.isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                              }}
                              onMouseLeave={(e) => {
                                if (cell.isClickable) e.currentTarget.style.filter = "none";
                              }}
                            >
                              {cell.displayVal}
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
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        width: "100%",
        fontFamily: "'Kumbh Sans', sans-serif",
      }}
    >
      {/* Deep Dive Popover */}
      <DeepDivePopover
        isOpen={Boolean(activePopover?.isOpen)}
        targetRect={activePopover?.targetRect}
        title={activePopover?.title}
        period={activePopover?.period}
        total={activePopover?.total}
        items={activePopover?.items || []}
        sections={activePopover?.sections}
        currencySymbol={currencySymbol}
        thousandsSeparator={thousandsSeparator}
        onClose={() => setActivePopover(null)}
        isLoading={Boolean(!keyData || isLoading || activePopover?.isLoading)}
      />

      {/* Action Bar (Top header with Year Navigator & Refresh) */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          padding: "0.25rem 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
            Financial year performance
          </h2>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "#0047AB",
              background: "rgba(0, 71, 171, 0.08)",
              padding: "2px 8px",
              borderRadius: "4px",
            }}
          >
            {activeYear?.fyLabel || activeYear?.displayTitle}
          </span>
        </div>

        {/* Action Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {(() => {
            const fyStr = activeYear?.fyLabel || activeYear?.displayTitle || "Current year";
            const noteKey = buildScreenNoteKey("performance", fyStr);
            const noteSum = getEntitySummary(noteKey);
            return (
              <PulseNoteTrigger
                variant="toolbar"
                count={noteSum?.count || 0}
                openNotifyCount={noteSum?.openNotifyCount || 0}
                unreadReplyCount={noteSum?.unreadReplyCount || 0}
                latestSnippet={noteSum?.latestSnippet || ""}
                onClick={() =>
                  openNotes({
                    scopeType: "screen",
                    entityType: "performance",
                    entityKey: noteKey,
                    entityLabel: `Performance — ${fyStr}`,
                    drawerTitle: "Performance notes",
                    contextMeta: { fyLabel: fyStr, subView: "dashboard" },
                  })
                }
              />
            );
          })()}
          <button
            type="button"
            className="refresh-btn no-click-spinner"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh data"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: isLoading ? "spin 1s linear infinite" : "none",
              }}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleDownloadCSV}
            title="Download CSV"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main 12-Month Performance Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        {activeYearIdx > 0 && (
          <button
            type="button"
            className="fy-nav-arrow-left"
            onClick={() => setSelectedYearIdx(Math.max(0, activeYearIdx - 1))}
            title="Previous Year"
            style={{
              position: "absolute",
              left: "-42px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              color: "#a2c4c9",
              border: "none",
              fontSize: "2.8rem",
              fontWeight: "bold",
              cursor: "pointer",
              padding: "0",
              zIndex: 10,
              lineHeight: 1,
              userSelect: "none",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#8fb5bb")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#a2c4c9")}
          >
            ‹
          </button>
        )}

        {/* Scrollable Table Container */}
        <div
          className="fy-table-scroll-wrapper"
          ref={tableScrollRef}
          onScroll={() => syncHorizontalScroll(tableScrollRef)}
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            border: "1px solid #e2e8f0",
            overflowX: "auto",
            width: "100%",
          }}
        >
          <table
            className="fy-main-table"
            style={{
              width: "100%",
              minWidth: "980px",
              borderCollapse: "separate",
              borderSpacing: 0,
              tableLayout: "fixed",
              fontSize: "12px",
              fontFamily: "'Kumbh Sans', sans-serif",
              background: "#ffffff",
            }}
          >
            <colgroup>
              <col style={{ width: "19%", minWidth: "19%" }} />
              {activeYear.headerMonths?.map((_, idx) => (
                <col key={idx} style={{ width: "6.1%", minWidth: "6.1%" }} />
              ))}
              <col style={{ width: "7.8%", minWidth: "7.8%" }} />
            </colgroup>
            <thead>
              {/* Row 1: Month Names & FY Total Header (Signature Cobalt Blue #0047AB) */}
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th
                  style={{
                    padding: "7px 10px",
                    textAlign: "left",
                    fontWeight: 700,
                    fontSize: "12px",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 3,
                    width: "19%",
                  }}
                >
                  {/* Empty top-left cell */}
                </th>
                {activeYear.headerMonths?.map((m, idx) => (
                  <th
                    key={idx}
                    style={{
                      padding: "7px 4px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "11.5px",
                      width: "6.1%",
                    }}
                  >
                    {m}
                  </th>
                ))}
                <th
                  style={{
                    padding: "7px 10px",
                    textAlign: "right",
                    fontWeight: 800,
                    fontSize: "12px",
                    background: "#0047AB",
                    width: "7.8%",
                    borderLeft: "1px solid #cbd5e1",
                  }}
                >
                  {activeYear.totalColHeader || "Total"}
                </th>
              </tr>

              {/* Row 2: Status row (Actual vs Forecast) - Distinct Shading for Actuals vs Forecast */}
              <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", fontSize: "10.5px" }}>
                <td
                  style={{
                    padding: "4px 10px",
                    position: "sticky",
                    left: 0,
                    background: "#ffffff",
                    zIndex: 3,
                    borderBottom: "1px solid #e2e8f0",
                  }}
                >
                  {/* Empty cell, NO Status label */}
                </td>
                {(activeYear.statusValues || activeYear.monthStatuses || []).map((st, idx) => {
                  const raw = String(st || "").trim();
                  const isAct = raw.toLowerCase() === "actual";
                  const text = isAct ? "Actual" : "Forecast";
                  const colBg = isAct ? "#f4f7fa" : "#ffffff";
                  return (
                    <td
                      key={idx}
                      style={{
                        padding: "4px 4px",
                        textAlign: "right",
                        color: isAct ? "#0047AB" : "#64748b",
                        fontWeight: isAct ? 600 : 400,
                        fontStyle: isAct ? "normal" : "italic",
                        background: colBg,
                        borderBottom: "1px solid #e2e8f0",
                      }}
                    >
                      {text}
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: "4px 10px",
                    textAlign: "right",
                    background: "rgba(0, 71, 171, 0.04)",
                    borderLeft: "1px solid #cbd5e1",
                    borderBottom: "1px solid #e2e8f0",
                  }}
                >
                  {/* Empty cell under Total with consistent Total column shading */}
                </td>
              </tr>
            </thead>

            <tbody>
              {activeYear.rows?.map((row, rIdx) => {
                const label = row.label;
                const totalVal = row.totalVal;

                // Detect if this spacer is the gap between Operating Profit % and Staff costs ratio
                let prevLbl = "";
                for (let k = rIdx - 1; k >= 0; k--) {
                  if (activeYear.rows[k]?.label && activeYear.rows[k].label.toLowerCase() !== "hide") {
                    prevLbl = activeYear.rows[k].label.toLowerCase();
                    break;
                  }
                }
                let nextLbl = "";
                for (let k = rIdx + 1; k < activeYear.rows.length; k++) {
                  if (activeYear.rows[k]?.label && activeYear.rows[k].label.toLowerCase() !== "hide") {
                    nextLbl = activeYear.rows[k].label.toLowerCase();
                    break;
                  }
                }
                const isOpToStaffGap =
                  (prevLbl.includes("operating profit %") || prevLbl.includes("operating profit margin")) &&
                  (nextLbl.includes("staff costs to") || nextLbl.includes("staff ratio"));

                if ((label && label.toLowerCase() === "hide") || (!showNBToFind && isNBToFindLabel(label))) {
                  return null;
                }

                // Spacer rows (Clean white for label column, exact continuous shading for month & total columns)
                if (!label) {
                  const spacerHeight = isOpToStaffGap ? 18 : 6;
                  return (
                    <tr key={rIdx} style={{ height: `${spacerHeight}px`, lineHeight: 0 }}>
                      <td
                        style={{
                          padding: 0,
                          background: "#ffffff",
                          position: "sticky",
                          left: 0,
                          zIndex: 2,
                          border: "none",
                        }}
                      />
                      {activeYear.headerMonths?.map((_, mIdx) => {
                        const st = String((activeYear.statusValues || activeYear.monthStatuses || [])[mIdx] || "").trim().toLowerCase();
                        const isAct = st === "actual";
                        return (
                          <td
                            key={mIdx}
                            style={{
                              padding: 0,
                              background: isAct ? "#f4f7fa" : "#ffffff",
                              border: "none",
                            }}
                          />
                        );
                      })}
                      <td
                        style={{
                          padding: 0,
                          background: "rgba(0, 71, 171, 0.04)",
                          border: "none",
                          borderLeft: "1px solid #cbd5e1",
                        }}
                      />
                    </tr>
                  );
                }

                const rowStyle = getRowStyle(label);
                const isPercentageRow =
                  label.includes("%") ||
                  label.toLowerCase().includes("ratio") ||
                  label.toLowerCase().includes("margin");
                const totalBadge = isPercentageRow ? getMarginBadgeStyle(label, totalVal) : null;
                const isMarginRow = Boolean(rowStyle.isMarginRow);

                // Row height: narrower for KPI margin rows (21px) vs regular (25px) vs major (32px)
                const rowHeight = rowStyle.isMajor ? "32px" : isMarginRow ? "21px" : "25px";
                const fontSize = rowStyle.isMajor ? "13px" : isMarginRow ? "11px" : rowStyle.isHeader ? "11px" : "11.5px";

                return (
                  <tr
                    key={rIdx}
                    style={{
                      height: rowHeight,
                      borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                      background: rowStyle.isMajor ? rowStyle.bg : "#ffffff",
                      fontWeight: rowStyle.bold ? 700 : 400,
                    }}
                  >
                    {/* Sticky Line Item Column */}
                    <td
                      style={{
                        padding: rowStyle.isHeader ? "5px 10px" : isMarginRow ? "2px 10px" : "4.5px 10px",
                        color: rowStyle.isMajor ? "#ffffff" : rowStyle.color,
                        fontSize: fontSize,
                        textTransform: rowStyle.isHeader ? "uppercase" : "none",
                        letterSpacing: rowStyle.isHeader ? "0.6px" : "normal",
                        paddingLeft: isMarginRow
                          ? "20px"
                          : !rowStyle.isHeader && !rowStyle.isMajor
                            ? "16px"
                            : "10px",
                        fontStyle: isPercentageRow ? "italic" : "normal",
                        position: "sticky",
                        left: 0,
                        background: rowStyle.isMajor ? rowStyle.bg : "#ffffff",
                        borderLeft: isMarginRow && rowStyle.accentBar ? `4px solid ${rowStyle.accentBar}` : "none",
                        zIndex: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                      }}
                      title={label}
                    >
                      {label}
                    </td>

                    {/* 12 Monthly Value Columns */}
                    {row.monthlyValues?.map((val, mIdx) => {
                      const mBadge = isPercentageRow ? getMarginBadgeStyle(label, val) : null;
                      const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                      const isClickable = !isYear0 && Boolean(ddType && val && val !== "—" && val !== "" && Math.abs(parseMoney(val)) >= 0.001);
                      const monthLabel = activeYear.headerMonths?.[mIdx] || `Month ${mIdx + 1}`;
                      const displayVal = val === "—" ? "" : formatCurrencyString(val, null, currencySymbol, thousandsSeparator);
                      const st = String((activeYear.statusValues || activeYear.monthStatuses || [])[mIdx] || "").trim().toLowerCase();
                      const isAct = st === "actual";
                      const colBg = isAct ? "#f4f7fa" : "#ffffff";

                      // If major row: solid band, transparent cell
                      if (rowStyle.isMajor) {
                        const cellMathVal = typeof row.monthlyMath?.[mIdx] === "number" ? row.monthlyMath[mIdx] : val;
                        return (
                          <td
                            key={mIdx}
                            onClick={(e) => isClickable && handleCellClick(e, label, cellMathVal, mIdx, monthLabel)}
                            style={{
                              padding: "4.5px 4px",
                              textAlign: "right",
                              color: "#ffffff",
                              fontSize: "13px",
                              fontWeight: 700,
                              background: "transparent",
                              cursor: isClickable ? "pointer" : "default",
                              textDecoration: isClickable ? "underline dashed rgba(255,255,255,0.6) 1px" : "none",
                              textUnderlineOffset: "2px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {displayVal}
                          </td>
                        );
                      }

                      // If KPI margin row: narrower, with column-colored border buffer
                      if (isMarginRow) {
                        return (
                          <td
                            key={mIdx}
                            style={{
                              padding: "1px 2px",
                              background: colBg,
                              textAlign: "right",
                              height: "21px",
                            }}
                          >
                            <div
                              style={{
                                display: "inline-block",
                                width: "100%",
                                padding: "1.5px 3px",
                                borderRadius: "4px",
                                background: mBadge ? mBadge.bg : "transparent",
                                color: mBadge ? mBadge.color : "#0047AB",
                                border: mBadge ? `1.5px solid ${colBg}` : "none",
                                fontStyle: "italic",
                                fontSize: "11px",
                                fontWeight: mBadge ? 700 : 400,
                                fontVariantNumeric: "tabular-nums",
                                boxSizing: "border-box",
                              }}
                            >
                              {displayVal}
                            </div>
                          </td>
                        );
                      }

                      // Regular data row
                      const cellMathVal = typeof row.monthlyMath?.[mIdx] === "number" ? row.monthlyMath[mIdx] : val;
                      return (
                        <td
                          key={mIdx}
                          onClick={(e) => isClickable && handleCellClick(e, label, cellMathVal, mIdx, monthLabel)}
                          style={{
                            padding: "4.5px 4px",
                            textAlign: "right",
                            color: rowStyle.color,
                            fontSize: "11.5px",
                            fontWeight: rowStyle.bold ? 700 : 400,
                            background: colBg,
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed #94a3b8 1px" : "none",
                            textUnderlineOffset: "2px",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                            transition: "background-color 0.15s ease",
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "none";
                          }}
                        >
                          {rowStyle.isHeader ? "" : displayVal}
                        </td>
                      );
                    })}

                    {/* FY Total Column (Continuous unbroken Total column shading) */}
                    {(() => {
                      const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                      const isClickable = !isYear0 && Boolean(ddType && totalVal && totalVal !== "—" && totalVal !== "" && Math.abs(parseMoney(totalVal)) >= 0.001);
                      const displayTotal = totalVal === "—" ? "" : formatCurrencyString(totalVal, null, currencySymbol, thousandsSeparator);
                      const totalColBg = "rgba(0, 71, 171, 0.04)";

                      if (rowStyle.isMajor) {
                        const totalCellMathVal = typeof row.totalMath === "number" ? row.totalMath : totalVal;
                        return (
                          <td
                            onClick={(e) =>
                              isClickable &&
                              handleCellClick(e, label, totalCellMathVal, -1, `${activeYear.fyLabel} Total`)
                            }
                            style={{
                              padding: "4.5px 10px",
                              textAlign: "right",
                              color: "#ffffff",
                              fontSize: "13px",
                              fontWeight: 800,
                              background: "transparent",
                              borderLeft: "1px solid #cbd5e1",
                              cursor: isClickable ? "pointer" : "default",
                              textDecoration: isClickable ? "underline dashed rgba(255,255,255,0.6) 1px" : "none",
                              textUnderlineOffset: "2px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {displayTotal}
                          </td>
                        );
                      }

                      if (isMarginRow) {
                        return (
                          <td
                            style={{
                              padding: "1px 2px",
                              background: totalColBg,
                              borderLeft: "1px solid #cbd5e1",
                              textAlign: "right",
                              height: "21px",
                            }}
                          >
                            <div
                              style={{
                                display: "inline-block",
                                width: "100%",
                                padding: "1.5px 6px",
                                borderRadius: "4px",
                                background: totalBadge ? totalBadge.bg : "transparent",
                                color: totalBadge ? totalBadge.color : "#0047AB",
                                border: totalBadge ? `1.5px solid ${totalColBg}` : "none",
                                fontStyle: "italic",
                                fontSize: "11px",
                                fontWeight: 700,
                                fontVariantNumeric: "tabular-nums",
                                boxSizing: "border-box",
                              }}
                            >
                              {displayTotal}
                            </div>
                          </td>
                        );
                      }

                      const totalCellMathVal = typeof row.totalMath === "number" ? row.totalMath : totalVal;
                      return (
                        <td
                          onClick={(e) =>
                            isClickable &&
                            handleCellClick(e, label, totalCellMathVal, -1, `${activeYear.fyLabel} Total`)
                          }
                          style={{
                            padding: "4.5px 10px",
                            textAlign: "right",
                            color: "#0047AB",
                            fontStyle: isPercentageRow ? "italic" : "normal",
                            fontSize: "11.5px",
                            fontWeight: 700,
                            background: totalColBg,
                            borderLeft: "1px solid #cbd5e1",
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                            textUnderlineOffset: "2px",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                            transition: "background-color 0.15s ease",
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "none";
                          }}
                        >
                          {rowStyle.isHeader ? "" : displayTotal}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {activeYearIdx < years.length - 1 && (
          <button
            type="button"
            className="fy-nav-arrow-right"
            onClick={() => setSelectedYearIdx(Math.min(years.length - 1, activeYearIdx + 1))}
            title="Next Year"
            style={{
              position: "absolute",
              right: "-42px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              color: "#a2c4c9",
              border: "none",
              fontSize: "2.8rem",
              fontWeight: "bold",
              cursor: "pointer",
              padding: "0",
              zIndex: 10,
              lineHeight: 1,
              userSelect: "none",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#8fb5bb")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#a2c4c9")}
          >
            ›
          </button>
        )}
      </div>

      {/* Performance Trajectory Chart sitting below the table with 3x white space */}
      <PerformanceTrajectoryChartRow
        months={activeYear.headerMonths || []}
        statuses={activeYear.statusValues || activeYear.monthStatuses || []}
        revenue={chartRevVals}
        grossProfit={chartGpVals}
        operatingProfit={chartOpVals}
        revenueLabel={revenueLabel}
        currencySymbol={currencySymbol}
        thousandsSeparator={thousandsSeparator}
        layout="fy"
        scrollRef={chartScrollRef}
        onScroll={() => syncHorizontalScroll(chartScrollRef)}
      />

      {hasFull12Months && summaryRowDefs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem", marginTop: "0.75rem" }}>
          {renderPeriodSummaryTable({
            title: "Quarters",
            periods: quarters,
            scrollRef: quartersScrollRef,
            wrapperClassName: "fy-quarters-scroll-wrapper",
          })}
          {renderPeriodSummaryTable({
            title: "Halves",
            periods: halves,
            scrollRef: halvesScrollRef,
            wrapperClassName: "fy-halves-scroll-wrapper",
          })}
        </div>
      )}

      <style jsx>{`
        @media (orientation: landscape) and (max-width: 1024px) {
          .fy-table-scroll-wrapper,
          .fy-quarters-scroll-wrapper,
          .fy-halves-scroll-wrapper,
          :global(.fy-chart-scroll-wrapper) {
            margin: 0 !important;
            width: 100% !important;
          }
          .fy-nav-arrow-left {
            left: -32px !important;
            font-size: 2.4rem !important;
          }
          .fy-nav-arrow-right {
            right: -32px !important;
            font-size: 2.4rem !important;
          }
        }
        @media (max-width: 768px) and (orientation: portrait) {
          .fy-nav-arrow-left {
            left: 2px !important;
            font-size: 2.2rem !important;
          }
          .fy-nav-arrow-right {
            right: 2px !important;
            font-size: 2.2rem !important;
          }
          .fy-table-scroll-wrapper,
          .fy-quarters-scroll-wrapper,
          .fy-halves-scroll-wrapper,
          :global(.fy-chart-scroll-wrapper) {
            margin: 0 24px !important;
            width: calc(100% - 48px) !important;
          }
        }
      `}</style>
    </div>
  );
}

const kpiCardStyle = {
  background: "#ffffff",
  borderRadius: "8px",
  padding: "1rem 1.25rem",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
  border: "1px solid #e2e8f0",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const kpiLabelStyle = {
  fontSize: "11px",
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const badgeStyle = {
  fontSize: "10px",
  fontWeight: 700,
  padding: "1px 6px",
  borderRadius: "10px",
};

const kpiValueStyle = {
  fontSize: "1.5rem",
  fontWeight: 800,
  color: "#0047AB",
  letterSpacing: "-0.5px",
  lineHeight: "1.2",
  margin: "2px 0",
};
