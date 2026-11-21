import React, { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "../Spinner";
import {
  computeBudgetEmployeeCostPm,
  parseStarterPlDate,
} from "../../utils/starterPlCalc";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(raw) {
  if (raw === "" || raw === null || raw === undefined) return 0;
  const parsed = parseFloat(String(raw).replace(/[£$€,\s]/g, ""));
  return Number.isFinite(parsed) ? round2(parsed) : 0;
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

export default function CreateBudgetModal({
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

  const [revenueRows, setRevenueRows] = useState({ confirmed: {}, pipeline: {}, nbToFind: {} });
  const [directCostRows, setDirectCostRows] = useState({ confirmed: {}, pipeline: {}, nbToFind: {} });
  const [salaryRows, setSalaryRows] = useState([]);
  const [dividendRow, setDividendRow] = useState({ name: "Div in lieu of salary", deliveryPct: 0, monthlyValues: {} });
  const [contractorRows, setContractorRows] = useState([]);
  const [makingUpCosPct, setMakingUpCosPct] = useState("0");
  const [expenseRows, setExpenseRows] = useState([]);

  const loadReqIdRef = useRef(0);
  const abortRef = useRef(null);

  const hydrate = (payload) => {
    setData(payload);
    setRevenueRows({
      confirmed: { ...(payload?.revenueRows?.confirmed || {}) },
      pipeline: { ...(payload?.revenueRows?.pipeline || {}) },
      nbToFind: { ...(payload?.revenueRows?.nbToFind || {}) },
    });
    setDirectCostRows({
      confirmed: { ...(payload?.directCostRows?.confirmed || {}) },
      pipeline: { ...(payload?.directCostRows?.pipeline || {}) },
      nbToFind: { ...(payload?.directCostRows?.nbToFind || {}) },
    });
    setSalaryRows(
      (payload?.salaryRows || []).map((s) => ({
        ...s,
        monthlyValues: { ...(s.monthlyValues || {}) },
      }))
    );
    setDividendRow({
      name: payload?.dividendRow?.name || "Div in lieu of salary",
      deliveryPct: payload?.dividendRow?.deliveryPct ?? 0,
      monthlyValues: { ...(payload?.dividendRow?.monthlyValues || {}) },
    });
    setContractorRows(
      (payload?.contractorRows || []).map((c) => ({
        ...c,
        monthlyValues: { ...(c.monthlyValues || {}) },
      }))
    );
    setMakingUpCosPct(String(payload?.makingUpCosPct ?? 0));
    setExpenseRows(
      (payload?.expenseRows || []).map((e) => ({
        ...e,
        monthlyValues: { ...(e.monthlyValues || {}) },
      }))
    );
  };

  const loadSeededBudget = async () => {
    if (!clientName) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++loadReqIdRef.current;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "load_seeded_budget",
          clientName,
          masterSheetId,
        }),
      });
      const json = await res.json();
      if (reqId !== loadReqIdRef.current) return;
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to load budget setup data." });
      } else {
        hydrate(json);
      }
    } catch (err) {
      if (err?.name === "AbortError" || reqId !== loadReqIdRef.current) return;
      setFeedback({ type: "error", message: err?.message || "Failed to load budget setup data." });
    } finally {
      if (reqId === loadReqIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !clientName) return;
    loadSeededBudget();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, masterSheetId]);

  const currency = data?.currency || "GBP";
  const fy1Months = useMemo(() => data?.fy1Months || [], [data]);
  const histSet = useMemo(() => new Set(data?.historicalMonthKeys || []), [data]);
  const isIncomeMode = Boolean(data?.isIncomeMode);
  const directCostsAreContractors = !isIncomeMode && data?.directCostsMode === "Contractors";
  const formulaParams = useMemo(() => data?.budgetFormulaParams || {}, [data]);

  // Compute effective cell values for Salary rows (actual for historical, Equiv-salary formula for future)
  const effectiveSalaryGrid = useMemo(() => {
    return salaryRows.map((emp) => {
      const costPm = computeBudgetEmployeeCostPm(emp.equivSalary, formulaParams);
      const sD = parseStarterPlDate(emp.startDate);
      const eD = parseStarterPlDate(emp.endDate);
      const sYm = sD ? sD.getFullYear() * 12 + sD.getMonth() : -Infinity;
      const eYm = eD ? eD.getFullYear() * 12 + eD.getMonth() : Infinity;

      const byMonth = {};
      for (const m of fy1Months) {
        if (histSet.has(m.monthKey)) {
          byMonth[m.monthKey] = round2(parseNum(emp.monthlyValues?.[m.monthKey]));
        } else {
          const mD = parseStarterPlDate(`${m.monthKey}-01`);
          const mYm = mD ? mD.getFullYear() * 12 + mD.getMonth() : 0;
          byMonth[m.monthKey] = emp.equivSalary > 0 && mYm >= sYm && mYm <= eYm ? costPm : 0;
        }
      }
      return { id: emp.id, costPm, byMonth };
    });
  }, [salaryRows, formulaParams, fy1Months, histSet]);

  // Live Budget P&L summary matching Client!Budget rows 10..49
  const budgetSummary = useMemo(() => {
    const mucRatio = Math.max(0, parseNum(makingUpCosPct)) / 100;
    const byMonth = {};

    for (const m of fy1Months) {
      const mk = m.monthKey;
      const revTotal = round2(
        parseNum(revenueRows.confirmed[mk]) +
        parseNum(revenueRows.pipeline[mk]) +
        parseNum(revenueRows.nbToFind[mk])
      );
      const dcTotal = round2(
        parseNum(directCostRows.confirmed[mk]) +
        parseNum(directCostRows.pipeline[mk]) +
        parseNum(directCostRows.nbToFind[mk])
      );
      const netIncome = round2(revTotal - dcTotal);
      const effectiveRevenue = isIncomeMode ? netIncome : revTotal;

      let salDel = 0;
      let salAdmin = 0;
      salaryRows.forEach((emp, idx) => {
        const delRatio = Math.max(0, Math.min(100, parseNum(emp.deliveryPct))) / 100;
        const v = effectiveSalaryGrid[idx]?.byMonth?.[mk] || 0;
        salDel += v * delRatio;
        salAdmin += v * (1 - delRatio);
      });

      const divVal = parseNum(dividendRow.monthlyValues?.[mk]);
      const divDelRatio = Math.max(0, Math.min(100, parseNum(dividendRow.deliveryPct))) / 100;
      const divDel = divVal * divDelRatio;
      const divAdmin = divVal * (1 - divDelRatio);

      let conDel = 0;
      let conAdmin = 0;
      contractorRows.forEach((c) => {
        const delRatio = Math.max(0, Math.min(100, parseNum(c.deliveryPct ?? 100))) / 100;
        const v = parseNum(c.monthlyValues?.[mk]);
        conDel += v * delRatio;
        conAdmin += v * (1 - delRatio);
      });

      let expDel = 0;
      let expAdmin = 0;
      expenseRows.forEach((ex) => {
        const delRatio = Math.max(0, Math.min(100, parseNum(ex.deliveryPct))) / 100;
        const v = parseNum(ex.monthlyValues?.[mk]);
        expDel += v * delRatio;
        expAdmin += v * (1 - delRatio);
      });

      const directInCos = directCostsAreContractors ? dcTotal : 0;
      const makingUpCosBase =
        effectiveRevenue * mucRatio - dcTotal - salDel - divDel - conDel;
      const makingUpCos = round2(Math.max(0, makingUpCosBase));

      const totalStaffCos = round2(salDel + divDel + conDel + makingUpCos + directInCos);
      const totalOtherCos = round2(expDel + (!isIncomeMode && !directCostsAreContractors ? dcTotal : 0));
      const totalCos = round2(totalStaffCos + totalOtherCos);
      const grossProfit = round2(effectiveRevenue - totalCos);
      const grossMarginPct = effectiveRevenue > 0.01 ? round2((grossProfit / effectiveRevenue) * 100) : null;

      const totalStaffOh = round2(salAdmin + divAdmin + conAdmin);
      const totalOtherOh = round2(expAdmin);
      const totalOverheads = round2(totalStaffOh + totalOtherOh);
      const operatingProfit = round2(grossProfit - totalOverheads);
      const opMarginPct = effectiveRevenue > 0.01 ? round2((operatingProfit / effectiveRevenue) * 100) : null;

      byMonth[mk] = {
        revTotal,
        dcTotal,
        effectiveRevenue,
        totalStaffCos,
        totalOtherCos,
        totalCos,
        grossProfit,
        grossMarginPct,
        makingUpCos,
        totalStaffOh,
        totalOtherOh,
        totalOverheads,
        operatingProfit,
        opMarginPct,
      };
    }

    const sumKey = (k) => round2(fy1Months.reduce((s, m) => s + (byMonth[m.monthKey]?.[k] || 0), 0));
    const totals = {
      revTotal: sumKey("revTotal"),
      dcTotal: sumKey("dcTotal"),
      effectiveRevenue: sumKey("effectiveRevenue"),
      totalStaffCos: sumKey("totalStaffCos"),
      totalOtherCos: sumKey("totalOtherCos"),
      totalCos: sumKey("totalCos"),
      grossProfit: sumKey("grossProfit"),
      totalOverheads: sumKey("totalOverheads"),
      operatingProfit: sumKey("operatingProfit"),
    };
    totals.grossMarginPct = totals.effectiveRevenue > 0.01 ? round2((totals.grossProfit / totals.effectiveRevenue) * 100) : null;
    totals.opMarginPct = totals.effectiveRevenue > 0.01 ? round2((totals.operatingProfit / totals.effectiveRevenue) * 100) : null;

    return { byMonth, totals };
  }, [
    fy1Months,
    revenueRows,
    directCostRows,
    salaryRows,
    effectiveSalaryGrid,
    dividendRow,
    contractorRows,
    expenseRows,
    makingUpCosPct,
    isIncomeMode,
    directCostsAreContractors,
  ]);

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_budget",
          clientName,
          masterSheetId,
          fy1Months,
          historicalMonthKeys: data.historicalMonthKeys || [],
          revenueRows,
          directCostRows,
          salaryRows,
          dividendRow,
          contractorRows,
          makingUpCosPct: parseNum(makingUpCosPct),
          expenseRows,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save budget." });
      } else {
        setFeedback({ type: "success", message: "Budget saved successfully." });
        if (typeof onCompleted === "function") onCompleted(json);
        onClose();
      }
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to save budget." });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const canSave = Boolean(data && !loading && !saving);
  const rowTotal = (obj) => round2(fy1Months.reduce((s, m) => s + parseNum(obj?.[m.monthKey]), 0));

  const renderMonthInput = (val, onChange, { isHist = false, highlight = false } = {}) => (
    <input
      type="number"
      step="1"
      value={val ?? 0}
      onChange={(e) => onChange(parseNum(e.target.value))}
      style={{
        width: "76px",
        textAlign: "right",
        padding: "3px 5px",
        borderRadius: "4px",
        border: `1px solid ${isHist ? "#CBD5E1" : "#93C5FD"}`,
        backgroundColor: highlight ? "#F0FDF4" : "#FFFFFF",
        fontSize: "11px",
      }}
    />
  );

  const renderPercentInput = (val, onChange, { width = "44px", borderColor = "#CBD5E1", bold = false } = {}) => (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${borderColor}`,
        borderRadius: "4px",
        backgroundColor: "#FFFFFF",
        paddingRight: "4px",
      }}
    >
      <input
        type="number"
        min="0"
        max="100"
        step="1"
        value={val}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width,
          textAlign: "right",
          padding: "3px 2px 3px 4px",
          border: "none",
          outline: "none",
          backgroundColor: "transparent",
          fontSize: "11px",
          fontWeight: bold ? 600 : 400,
        }}
      />
      <span style={{ fontSize: "11px", color: "#64748B", fontWeight: 600, userSelect: "none" }}>%</span>
    </div>
  );

  const stickyHeaderThBase = {
    position: "sticky",
    top: 0,
    zIndex: 4,
    backgroundColor: "#F8FAFC",
    boxShadow: "inset 0 -2px 0 #CBD5E1",
  };

  const renderSectionHeader = (title, colSpan) => (
    <tr style={{ backgroundColor: "#E2E8F0", color: "#0F172A", fontWeight: 700, fontSize: "12px" }}>
      <td
        colSpan={5}
        style={{ padding: "6px 10px", position: "sticky", left: 0, backgroundColor: "#E2E8F0", zIndex: 2 }}
      >
        {title}
      </td>
      <td colSpan={Math.max(1, colSpan - 5)} style={{ padding: "6px 10px" }} />
    </tr>
  );

  const renderSummaryRow = (label, key, { bold = false, bg = "#F8FAFC", isPct = false, color = "#0F172A", borderTop = false } = {}) => (
    <tr
      style={{
        backgroundColor: bg,
        fontWeight: bold ? 700 : 600,
        color,
        borderTop: borderTop ? "2px solid #CBD5E1" : "1px solid #E2E8F0",
      }}
    >
      <td
        colSpan={5}
        style={{
          padding: "6px 10px",
          position: "sticky",
          left: 0,
          backgroundColor: bg,
          zIndex: 2,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </td>
      {fy1Months.map((m) => {
        const v = budgetSummary.byMonth[m.monthKey]?.[key];
        return (
          <td key={m.monthKey} style={{ textAlign: "right", padding: "6px 8px", whiteSpace: "nowrap" }}>
            {isPct ? (v === null || v === undefined ? "—" : `${v.toFixed(1)}%`) : formatMoney(v || 0, currency, 0)}
          </td>
        );
      })}
      <td style={{ textAlign: "right", padding: "6px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 700 }}>
        {isPct
          ? budgetSummary.totals[key] === null || budgetSummary.totals[key] === undefined
            ? "—"
            : `${budgetSummary.totals[key].toFixed(1)}%`
          : formatMoney(budgetSummary.totals[key] || 0, currency, 0)}
      </td>
    </tr>
  );

  const totalCols = 5 + fy1Months.length + 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create budget"
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
          maxWidth: "1560px",
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
            padding: "14px 24px",
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
              Create budget — {clientName}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
              Pre-populated from Confirmed + Pipeline + NB to find revenue, Staff salaries (actuals for historical months, formula for future), Dividends, Contractors, and Other expenses. Edit any cell before saving.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={loadSeededBudget}
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
              {loading ? "Refreshing..." : "Refresh from setup data"}
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

        {/* Feedback */}
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

        {/* Scrollable Body */}
        <div style={{ padding: "0 20px 14px", overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
          {loading && !data ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 0", gap: "12px" }}>
              <Spinner size="md" />
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                Building FY1 budget grid from setup figures...
              </div>
            </div>
          ) : data ? (
            <>
              <div
                style={{
                  border: "1px solid #E2E8F0",
                  borderRadius: "8px",
                  width: "fit-content",
                  minWidth: "100%",
                  marginTop: "14px",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "2px solid #CBD5E1", color: "#475569" }}>
                      <th
                        style={{
                          ...stickyHeaderThBase,
                          left: 0,
                          zIndex: 5,
                          textAlign: "left",
                          padding: "8px 10px",
                          minWidth: "220px",
                        }}
                      >
                        Budget line item
                      </th>
                      <th style={{ ...stickyHeaderThBase, textAlign: "right", padding: "8px 6px", minWidth: "92px" }}>
                        Salary / target
                      </th>
                      <th style={{ ...stickyHeaderThBase, textAlign: "left", padding: "8px 6px", minWidth: "82px" }}>
                        Start date
                      </th>
                      <th style={{ ...stickyHeaderThBase, textAlign: "left", padding: "8px 6px", minWidth: "82px" }}>
                        End date
                      </th>
                      <th style={{ ...stickyHeaderThBase, textAlign: "right", padding: "8px 6px", minWidth: "70px" }}>
                        Del %
                      </th>
                      {fy1Months.map((m) => (
                        <th
                          key={m.monthKey}
                          style={{
                            ...stickyHeaderThBase,
                            textAlign: "right",
                            padding: "6px 8px",
                            minWidth: "86px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.shortLabel}
                          <div style={{ fontSize: "10px", fontWeight: 600, color: m.isHistorical ? "#047857" : "#3B82F6" }}>
                            {m.isHistorical ? "Actual" : "Forecast"}
                          </div>
                        </th>
                      ))}
                      <th
                        style={{
                          ...stickyHeaderThBase,
                          textAlign: "right",
                          padding: "8px 10px",
                          minWidth: "96px",
                          backgroundColor: "#EFF6FF",
                          color: "#1E40AF",
                          borderLeft: "2px solid #CBD5E1",
                        }}
                      >
                        FY1 total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* REVENUE */}
                    {renderSectionHeader("Revenue", totalCols)}
                    {[
                      { key: "confirmed", label: "Confirmed revenue" },
                      { key: "pipeline", label: "Pipeline revenue" },
                      { key: "nbToFind", label: "New business to find revenue" },
                    ].map((rDef) => (
                      <tr key={rDef.key} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td colSpan={5} style={{ padding: "5px 10px", fontWeight: 600, position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                          {rDef.label}
                        </td>
                        {fy1Months.map((m) => (
                          <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                            {renderMonthInput(
                              revenueRows[rDef.key]?.[m.monthKey] ?? 0,
                              (val) =>
                                setRevenueRows((prev) => ({
                                  ...prev,
                                  [rDef.key]: { ...(prev[rDef.key] || {}), [m.monthKey]: val },
                                })),
                              { isHist: m.isHistorical }
                            )}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                          {formatMoney(rowTotal(revenueRows[rDef.key]), currency, 0)}
                        </td>
                      </tr>
                    ))}
                    {renderSummaryRow("Total revenue", "revTotal", { bold: true, bg: "#F8FAFC" })}

                    {/* DIRECT COSTS */}
                    {renderSectionHeader("Direct costs", totalCols)}
                    {[
                      { key: "confirmed", label: "Confirmed direct costs" },
                      { key: "pipeline", label: "Pipeline direct costs" },
                      { key: "nbToFind", label: "NB to find direct costs" },
                    ].map((dDef) => (
                      <tr key={dDef.key} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td colSpan={5} style={{ padding: "5px 10px", fontWeight: 600, position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                          {dDef.label}
                        </td>
                        {fy1Months.map((m) => (
                          <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                            {renderMonthInput(
                              directCostRows[dDef.key]?.[m.monthKey] ?? 0,
                              (val) =>
                                setDirectCostRows((prev) => ({
                                  ...prev,
                                  [dDef.key]: { ...(prev[dDef.key] || {}), [m.monthKey]: val },
                                })),
                              { isHist: m.isHistorical }
                            )}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                          {formatMoney(rowTotal(directCostRows[dDef.key]), currency, 0)}
                        </td>
                      </tr>
                    ))}
                    {renderSummaryRow("Total direct costs", "dcTotal", { bold: true, bg: "#F8FAFC" })}

                    {/* LIVE P&L SUMMARY SNAPSHOT */}
                    {renderSummaryRow("Gross profit", "grossProfit", { bold: true, bg: "#EFF6FF", color: "#1E40AF", borderTop: true })}
                    {renderSummaryRow("Gross profit margin %", "grossMarginPct", { isPct: true, bg: "#FFFFFF", color: "#475569" })}
                    {renderSummaryRow("Total overheads", "totalOverheads", { bold: true, bg: "#F8FAFC" })}
                    {renderSummaryRow("Operating profit", "operatingProfit", { bold: true, bg: "#ECFDF5", color: "#065F46", borderTop: true })}
                    {renderSummaryRow("Operating profit %", "opMarginPct", { isPct: true, bg: "#ECFDF5", color: "#047857" })}

                    {/* SALARIES */}
                    <tr style={{ backgroundColor: "#E2E8F0", color: "#0F172A", fontWeight: 700, fontSize: "12px" }}>
                      <td colSpan={5} style={{ padding: "6px 10px", position: "sticky", left: 0, backgroundColor: "#E2E8F0", zIndex: 2 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Salaries ({salaryRows.length}) — actuals for historical, formula for future</span>
                          <button
                            type="button"
                            onClick={() =>
                              setSalaryRows((prev) => [
                                ...prev,
                                {
                                  id: `bud-sal-new-${Date.now()}`,
                                  name: "New employee",
                                  equivSalary: 0,
                                  startDate: data.startDateFormatted || "",
                                  endDate: "",
                                  deliveryPct: 0,
                                  monthlyValues: Object.fromEntries(fy1Months.map((m) => [m.monthKey, 0])),
                                },
                              ])
                            }
                            style={{
                              padding: "2px 8px",
                              borderRadius: "5px",
                              border: "1px solid #023f98",
                              backgroundColor: "#FFFFFF",
                              color: "#023f98",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            + Add employee
                          </button>
                        </div>
                      </td>
                      <td colSpan={fy1Months.length + 1} style={{ padding: "6px 10px" }} />
                    </tr>
                    {salaryRows.map((emp, eIdx) => {
                      const effRow = effectiveSalaryGrid[eIdx]?.byMonth || {};
                      const empTot = round2(fy1Months.reduce((s, m) => s + (effRow[m.monthKey] || 0), 0));
                      return (
                        <tr key={emp.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "4px 10px", position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                            <input
                              type="text"
                              value={emp.name}
                              onChange={(e) =>
                                setSalaryRows((prev) =>
                                  prev.map((x) => (x.id === emp.id ? { ...x, name: e.target.value } : x))
                                )
                              }
                              style={{ width: "100%", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", fontWeight: 600 }}
                            />
                          </td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>
                            <input
                              type="number"
                              value={emp.equivSalary ?? 0}
                              onChange={(e) =>
                                setSalaryRows((prev) =>
                                  prev.map((x) => (x.id === emp.id ? { ...x, equivSalary: parseNum(e.target.value) } : x))
                                )
                              }
                              style={{ width: "84px", textAlign: "right", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: 600 }}
                            />
                          </td>
                          <td style={{ padding: "4px 6px" }}>
                            <input
                              type="text"
                              value={emp.startDate || ""}
                              onChange={(e) =>
                                setSalaryRows((prev) =>
                                  prev.map((x) => (x.id === emp.id ? { ...x, startDate: e.target.value } : x))
                                )
                              }
                              style={{ width: "74px", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px" }}
                            />
                          </td>
                          <td style={{ padding: "4px 6px" }}>
                            <input
                              type="text"
                              placeholder="Ongoing"
                              value={emp.endDate || ""}
                              onChange={(e) =>
                                setSalaryRows((prev) =>
                                  prev.map((x) => (x.id === emp.id ? { ...x, endDate: e.target.value } : x))
                                )
                              }
                              style={{ width: "74px", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px" }}
                            />
                          </td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>
                            {renderPercentInput(emp.deliveryPct ?? 0, (raw) =>
                              setSalaryRows((prev) =>
                                prev.map((x) =>
                                  x.id === emp.id
                                    ? { ...x, deliveryPct: Math.max(0, Math.min(100, parseNum(raw))) }
                                    : x
                                )
                              )
                            )}
                          </td>
                          {fy1Months.map((m) => (
                            <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                              {m.isHistorical ? (
                                renderMonthInput(
                                  emp.monthlyValues?.[m.monthKey] ?? 0,
                                  (val) =>
                                    setSalaryRows((prev) =>
                                      prev.map((x) =>
                                        x.id === emp.id
                                          ? { ...x, monthlyValues: { ...(x.monthlyValues || {}), [m.monthKey]: val } }
                                          : x
                                      )
                                    ),
                                  { isHist: true }
                                )
                              ) : (
                                <span style={{ color: "#334155", fontSize: "11px" }}>
                                  {formatMoney(effRow[m.monthKey] || 0, currency, 0)}
                                </span>
                              )}
                            </td>
                          ))}
                          <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                            {formatMoney(empTot, currency, 0)}
                          </td>
                        </tr>
                      );
                    })}

                    {/* DIVIDENDS */}
                    {renderSectionHeader("Dividends in lieu of salary", totalCols)}
                    <tr style={{ borderBottom: "1px solid #F1F5F9" }}>
                      <td colSpan={4} style={{ padding: "5px 10px", fontWeight: 600, position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                        {dividendRow.name || "Div in lieu of salary"}
                      </td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>
                        {renderPercentInput(dividendRow.deliveryPct ?? 0, (raw) =>
                          setDividendRow((prev) => ({
                            ...prev,
                            deliveryPct: Math.max(0, Math.min(100, parseNum(raw))),
                          }))
                        )}
                      </td>
                      {fy1Months.map((m) => (
                        <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                          {renderMonthInput(
                            dividendRow.monthlyValues?.[m.monthKey] ?? 0,
                            (val) =>
                              setDividendRow((prev) => ({
                                ...prev,
                                monthlyValues: { ...(prev.monthlyValues || {}), [m.monthKey]: val },
                              })),
                            { isHist: m.isHistorical }
                          )}
                        </td>
                      ))}
                      <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                        {formatMoney(rowTotal(dividendRow.monthlyValues), currency, 0)}
                      </td>
                    </tr>

                    {/* CONTRACTORS + MAKING UP COS */}
                    <tr style={{ backgroundColor: "#E2E8F0", color: "#0F172A", fontWeight: 700, fontSize: "12px" }}>
                      <td colSpan={5} style={{ padding: "6px 10px", position: "sticky", left: 0, backgroundColor: "#E2E8F0", zIndex: 2 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                          <span>Contractors ({contractorRows.length} / 14)</span>
                          {contractorRows.length < 14 && (
                            <button
                              type="button"
                              onClick={() =>
                                setContractorRows((prev) => [
                                  ...prev,
                                  {
                                    id: `bud-con-new-${Date.now()}`,
                                    name: "New contractor",
                                    deliveryPct: 100,
                                    monthlyValues: Object.fromEntries(fy1Months.map((m) => [m.monthKey, 0])),
                                  },
                                ])
                              }
                              style={{
                                padding: "2px 8px",
                                borderRadius: "5px",
                                border: "1px solid #023f98",
                                backgroundColor: "#FFFFFF",
                                color: "#023f98",
                                fontSize: "11px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              + Add contractor
                            </button>
                          )}
                        </div>
                      </td>
                      <td colSpan={fy1Months.length + 1} style={{ padding: "6px 10px" }} />
                    </tr>
                    {contractorRows.map((c) => (
                      <tr key={c.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td colSpan={4} style={{ padding: "4px 10px", position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                          <input
                            type="text"
                            value={c.name}
                            onChange={(e) =>
                              setContractorRows((prev) =>
                                prev.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x))
                              )
                            }
                            style={{ width: "100%", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", fontWeight: 600 }}
                          />
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "right" }}>
                          {renderPercentInput(c.deliveryPct ?? 100, (raw) =>
                            setContractorRows((prev) =>
                              prev.map((x) =>
                                x.id === c.id
                                  ? { ...x, deliveryPct: Math.max(0, Math.min(100, parseNum(raw))) }
                                  : x
                              )
                            )
                          )}
                        </td>
                        {fy1Months.map((m) => (
                          <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                            {renderMonthInput(
                              c.monthlyValues?.[m.monthKey] ?? 0,
                              (val) =>
                                setContractorRows((prev) =>
                                  prev.map((x) =>
                                    x.id === c.id
                                      ? { ...x, monthlyValues: { ...(x.monthlyValues || {}), [m.monthKey]: val } }
                                      : x
                                  )
                                ),
                              { isHist: m.isHistorical }
                            )}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                          {formatMoney(rowTotal(c.monthlyValues), currency, 0)}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                      <td style={{ padding: "5px 10px", fontWeight: 600, position: "sticky", left: 0, backgroundColor: "#F8FAFC", zIndex: 1 }}>
                        Making up CoS (target %)
                      </td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>
                        {renderPercentInput(makingUpCosPct, setMakingUpCosPct, {
                          width: "48px",
                          borderColor: "#93C5FD",
                          bold: true,
                        })}
                      </td>
                      <td colSpan={3} />
                      {fy1Months.map((m) => (
                        <td key={m.monthKey} style={{ textAlign: "right", padding: "5px 8px", color: "#64748B" }}>
                          {formatMoney(budgetSummary.byMonth[m.monthKey]?.makingUpCos || 0, currency, 0)}
                        </td>
                      ))}
                      <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", color: "#64748B", fontWeight: 600 }}>
                        {formatMoney(
                          round2(fy1Months.reduce((s, m) => s + (budgetSummary.byMonth[m.monthKey]?.makingUpCos || 0), 0)),
                          currency,
                          0
                        )}
                      </td>
                    </tr>

                    {/* OTHER EXPENSES */}
                    <tr style={{ backgroundColor: "#E2E8F0", color: "#0F172A", fontWeight: 700, fontSize: "12px" }}>
                      <td colSpan={5} style={{ padding: "6px 10px", position: "sticky", left: 0, backgroundColor: "#E2E8F0", zIndex: 2 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                          <span>Other expenses ({expenseRows.length})</span>
                          <button
                            type="button"
                            onClick={() =>
                              setExpenseRows((prev) => [
                                ...prev,
                                {
                                  id: `bud-exp-new-${Date.now()}`,
                                  name: "New expense category",
                                  deliveryPct: 0,
                                  monthlyValues: Object.fromEntries(fy1Months.map((m) => [m.monthKey, 0])),
                                },
                              ])
                            }
                            style={{
                              padding: "2px 8px",
                              borderRadius: "5px",
                              border: "1px solid #023f98",
                              backgroundColor: "#FFFFFF",
                              color: "#023f98",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            + Add expense category
                          </button>
                        </div>
                      </td>
                      <td colSpan={fy1Months.length + 1} style={{ padding: "6px 10px" }} />
                    </tr>
                    {expenseRows.map((ex) => (
                      <tr key={ex.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td colSpan={4} style={{ padding: "4px 10px", position: "sticky", left: 0, backgroundColor: "#FFFFFF", zIndex: 1 }}>
                          <input
                            type="text"
                            value={ex.name}
                            onChange={(e) =>
                              setExpenseRows((prev) =>
                                prev.map((x) => (x.id === ex.id ? { ...x, name: e.target.value } : x))
                              )
                            }
                            style={{ width: "100%", padding: "3px 5px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", fontWeight: 600 }}
                          />
                        </td>
                        <td style={{ padding: "4px 6px", textAlign: "right" }}>
                          {renderPercentInput(ex.deliveryPct ?? 0, (raw) =>
                            setExpenseRows((prev) =>
                              prev.map((x) =>
                                x.id === ex.id
                                  ? { ...x, deliveryPct: Math.max(0, Math.min(100, parseNum(raw))) }
                                  : x
                              )
                            )
                          )}
                        </td>
                        {fy1Months.map((m) => (
                          <td key={m.monthKey} style={{ padding: "4px 6px", textAlign: "right" }}>
                            {renderMonthInput(
                              ex.monthlyValues?.[m.monthKey] ?? 0,
                              (val) =>
                                setExpenseRows((prev) =>
                                  prev.map((x) =>
                                    x.id === ex.id
                                      ? { ...x, monthlyValues: { ...(x.monthlyValues || {}), [m.monthKey]: val } }
                                      : x
                                  )
                                ),
                              { isHist: m.isHistorical }
                            )}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", padding: "5px 10px", borderLeft: "2px solid #CBD5E1", fontWeight: 600 }}>
                          {formatMoney(rowTotal(ex.monthlyValues), currency, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 24px",
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
            {salaryRows.length} salary row(s) · {contractorRows.length} contractor(s) · {expenseRows.length} expense line(s) · FY1 Revenue {formatMoney(budgetSummary.totals.revTotal, currency, 0)} · Operating profit {formatMoney(budgetSummary.totals.operatingProfit, currency, 0)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
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
              {saving ? "Saving budget..." : "Save budget"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
