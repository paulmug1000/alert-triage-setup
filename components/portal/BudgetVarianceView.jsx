import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function BudgetVarianceView({
  clientName,
  data,
  allFYData,
  keyData,
  isLoading,
  error,
  onRefresh,
}) {
  const [viewMode, setViewMode] = useState("ytd"); // 'month' | 'ytd' | 'fy'
  const [userMonthIdx, setUserMonthIdx] = useState(null);
  const [selectedYearIdx, setSelectedYearIdx] = useState(0);

  const rawVals = data?.rawVals || [];
  const mathVals = data?.mathVals || rawVals;

  const years = useMemo(() => allFYData?.years || [], [allFYData?.years]);
  const activeYearIdx = Math.min(Math.max(0, selectedYearIdx + 1), Math.max(0, years.length - 1));
  const activeYear = years[activeYearIdx] || years[0];

  const months = useMemo(() => {
    return activeYear?.headerMonths || [
      "Month 1", "Month 2", "Month 3", "Month 4", "Month 5", "Month 6",
      "Month 7", "Month 8", "Month 9", "Month 10", "Month 11", "Month 12"
    ];
  }, [activeYear?.headerMonths]);

  const activeFyLabel = useMemo(() => {
    const curYearObj = data?.years?.[selectedYearIdx];
    if (curYearObj?.fyLabel) return curYearObj.fyLabel;
    if (curYearObj?.fyTotalLabel) {
      const cleaned = curYearObj.fyTotalLabel.replace(/\s*total/i, "").trim();
      if (cleaned && !cleaned.toLowerCase().includes("fy")) return `FY${cleaned}`;
      if (cleaned) return cleaned;
    }
    const fyFromPerf = allFYData?.years?.[selectedYearIdx + 1]?.fyLabel || allFYData?.years?.[selectedYearIdx]?.fyLabel;
    if (fyFromPerf) return fyFromPerf;
    const fyFromKeyData = keyData?.outgoings?.fyLabels?.[selectedYearIdx + 1];
    if (fyFromKeyData) return fyFromKeyData;
    return selectedYearIdx === 0 ? "FY26" : selectedYearIdx === 1 ? "FY27" : "FY28";
  }, [data, selectedYearIdx, allFYData, keyData]);

  // Default to previous calendar month
  const defaultMonthIdx = useMemo(() => {
    if (!months || months.length === 0) return 0;
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let prevIdx = -1;
    for (let i = 0; i < months.length; i++) {
      const mLabel = months[i];
      const match = String(mLabel).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
      if (match) {
        const monthsMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const monthNum = monthsMap[match[1].toLowerCase()];
        let yr = parseInt(match[2], 10);
        if (yr < 100) yr += 2000;
        const d = new Date(yr, monthNum, 1);
        if (d.getTime() < currMonthStart) {
          prevIdx = i;
        }
      }
    }
    return prevIdx !== -1 ? prevIdx : 0;
  }, [months]);

  const selectedMonthIdx = userMonthIdx !== null ? userMonthIdx : defaultMonthIdx;

  const isRevMode = useMemo(() => {
    if (keyData?.outgoingsMeta?.mode) {
      return !keyData.outgoingsMeta.mode.toLowerCase().includes("income");
    }
    const allLabels = (years[0]?.rows || []).map((r) => String(r.label || "").toLowerCase());
    return !allLabels.some((l) => l.includes("confirmed income") || l.includes("total income"));
  }, [keyData, years]);

  const parseMoney = (val) => {
    if (typeof val === "number") return val;
    if (!val || val === "—") return 0;
    const clean = String(val).replace(/[£,]/g, "").trim();
    if (clean.includes("%")) return parseFloat(clean) / 100;
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString("en-GB")}`;
  };

  const formatPct = (val) => `${Math.round((val || 0) * 100)}%`;

  // Budget metric getter
  const blkStart = selectedYearIdx === 0 ? 6 : (selectedYearIdx === 1 ? 21 : 36);
  const getBud = (rawRowIdx) => {
    if (rawRowIdx === null || !rawVals[rawRowIdx]) return new Array(12).fill(0);
    const row = [];
    for (let m = 0; m < 12; m++) {
      let val = parseFloat(mathVals?.[rawRowIdx]?.[blkStart + m]);
      if (isNaN(val)) {
        val = parseFloat(String(rawVals?.[rawRowIdx]?.[blkStart + m] || "").replace(/[£$,%]/g, "")) || 0;
      }
      row.push(val);
    }
    return row;
  };

  // Actual metric getter from activeYear in performanceData
  const getAct = (labelMatch) => {
    const r = activeYear?.rows?.find((row) =>
      String(row.label || "").toLowerCase().includes(labelMatch.toLowerCase())
    );
    if (!r || !r.monthVals) return new Array(12).fill(0);
    return r.monthVals.map((v) => parseMoney(v));
  };

  const mapMetrics = (arrGet, isBud) => {
    const conf = arrGet(isBud ? (isRevMode ? 4 : 20) : (isRevMode ? "confirmed revenue" : "confirmed income"));
    const pipe = arrGet(isBud ? (isRevMode ? 5 : 21) : (isRevMode ? "pipeline revenue" : "pipeline income"));
    const nb = arrGet(isBud ? (isRevMode ? 6 : 22) : "new business to find");

    const staffDel = arrGet(isBud ? 28 : "staff costs - delivery");
    const dirCosts = isRevMode ? arrGet(isBud ? 29 : "direct costs") : new Array(12).fill(0);
    const expDel = arrGet(isBud ? (isRevMode ? 30 : 29) : "other expenses - delivery");

    const staffNonDel = arrGet(isBud ? 39 : "staff costs - non-delivery");
    const expNonDel = arrGet(isBud ? 40 : "other expenses - non-delivery");

    const totalRev = conf.map((v, i) => v + pipe[i] + nb[i]);
    const totalCoS = isRevMode
      ? staffDel.map((v, i) => v + dirCosts[i] + expDel[i])
      : staffDel.map((v, i) => v + expDel[i]);
    const gp = totalRev.map((v, i) => v - totalCoS[i]);

    const totalOverheads = staffNonDel.map((v, i) => v + expNonDel[i]);
    const opProfit = gp.map((v, i) => v - totalOverheads[i]);

    return {
      conf, pipe, nb, totalRev,
      staffDel, dirCosts, expDel, totalCoS,
      gp,
      staffNonDel, expNonDel, totalOverheads,
      opProfit,
    };
  };

  const budMetrics = mapMetrics(getBud, true);
  const actMetrics = mapMetrics(getAct, false);

  const sumArr = (arr, limit) => arr.slice(0, limit).reduce((a, b) => a + b, 0);

  const getMarginColor = (label, numVal) => {
    const t = keyData?.thresholds || [];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    if (label.includes("Gross profit margin")) {
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (numVal < z43) return "#f4cccc";
      if (numVal <= z42) return "#fce5cd";
      return "#d9ead3";
    }
    if (label.includes("Overheads as %")) {
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.20);
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
    if (label.includes("Staff costs to")) {
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (numVal < z59) return "#fce5cd";
      if (numVal <= z58) return "#d9ead3";
      if (numVal <= z57) return "#fce5cd";
      return "#f4cccc";
    }
    return "#efefef";
  };

  const getVarCells = (actVal, budVal, isCost, isMargin, hideVariance, rowBg) => {
    if (isMargin || hideVariance) {
      return [
        { v: "", bg: rowBg, color: rowBg },
        { v: "", bg: rowBg, color: rowBg },
      ];
    }

    const diffAmount = isCost ? (budVal - actVal) : (actVal - budVal);
    const isGood = diffAmount >= 0;
    const cellBg = isGood ? "#d9ead3" : "#f4cccc";

    if (budVal === 0 && actVal === 0) {
      return [
        { v: formatMoney(0), bg: "#d9ead3", color: "#0047AB" },
        { v: "0%", bg: "#d9ead3", color: "#0047AB" },
      ];
    }
    if (budVal === 0) {
      return [
        { v: formatMoney(diffAmount), bg: cellBg, color: "#cc0000" },
        { v: "!", bg: "#f4cccc", color: "#cc0000" },
      ];
    }

    const pct = diffAmount / Math.abs(budVal);
    return [
      { v: formatMoney(diffAmount), bg: cellBg, color: "#0047AB" },
      { v: `${Math.round(pct * 100)}%`, bg: cellBg, color: "#0047AB" },
    ];
  };

  if (isLoading && (!data || rawVals.length === 0)) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Please wait - loading
        </p>
      </div>
    );
  }

  if (error && (!data || rawVals.length === 0)) {
    return (
      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "1.5rem", color: "#991b1b", margin: "1rem 0" }}>
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load budget data</h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>{error}</p>
        <button onClick={onRefresh} style={{ padding: "6px 14px", background: "#dc2626", color: "#ffffff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>
          Try Again
        </button>
      </div>
    );
  }

  if (data && !data.hasBudget) {
    return (
      <div style={{ background: "#ffffff", borderRadius: "8px", padding: "3rem 2rem", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)", border: "1px solid #e2e8f0", textAlign: "center", fontFamily: "'Kumbh Sans', sans-serif" }}>
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📊</div>
        <h3 style={{ color: "#0047AB", fontWeight: 700, margin: "0 0 8px 0" }}>No Budget Configured</h3>
        <p style={{ color: "#64748b", maxWidth: "460px", margin: "0 auto" }}>This client does not have budget tracking enabled.</p>
      </div>
    );
  }

  const limit = viewMode === "month" ? 1 : viewMode === "ytd" ? selectedMonthIdx + 1 : 12;
  const displayedMonths = viewMode === "month" ? [months[selectedMonthIdx]] : months.slice(0, limit);

  // Build the structured rows matching renderBudgetAnalysis
  const tableRows = [];

  const addSpacer = (height = 6) => {
    tableRows.push({ type: "spacer", height });
  };

  const addSectionHeader = (label) => {
    tableRows.push({ type: "section", label, height: 20 });
  };

  const addDataRow = (label, metricKey, isCurrency, isBigTotal, isMargin, isCost, isBold = false, hideVariance = false) => {
    tableRows.push({
      type: "data",
      label,
      metricKey,
      isCurrency,
      isBigTotal,
      isMargin,
      isCost,
      isBold: isBigTotal || isBold,
      hideVariance,
      bg: isBigTotal ? (label.includes("Total revenue") || label.includes("Total income") ? "#9900ff" : label.includes("Gross") ? "#e69138" : label.includes("overheads") ? "#45818e" : "#1155cc") : "#efefef",
      color: isBigTotal ? "#ffffff" : "#0047AB",
      height: isBigTotal ? 31 : (isMargin ? 17 : 20),
      fontSize: isBigTotal ? 14 : (isMargin ? 9 : 10),
    });
  };

  addSpacer(15);
  addSectionHeader(isRevMode ? "Revenue" : "Income");
  addDataRow(isRevMode ? "Confirmed revenue" : "Confirmed income", "conf", true, false, false, false, false, true);
  addDataRow(isRevMode ? "Pipeline revenue" : "Pipeline income", "pipe", true, false, false, false, false, true);
  addDataRow(isRevMode ? "New business to find revenue" : "New business to find income", "nb", true, false, false, false, false, true);
  addSpacer(6);
  addDataRow(isRevMode ? "Total revenue" : "Total income", "totalRev", true, true, false, false);
  addSpacer(20);

  addSectionHeader("Costs of sale");
  addDataRow("Staff costs - delivery", "staffDel", true, false, false, true);
  if (isRevMode) {
    addDataRow("Direct costs", "dirCosts", true, false, false, true);
  }
  addDataRow("Other expenses - delivery", "expDel", true, false, false, true);
  addSpacer(4);
  addDataRow("Total costs of sale", "totalCoS", true, false, false, true, true);
  addSpacer(12);
  addDataRow("Gross profit", "gp", true, true, false, false);
  addSpacer(10);
  addDataRow("Gross profit margin %", "gpMargin", false, false, true, false);
  addSpacer(16);

  addSectionHeader("Overheads");
  addDataRow("Staff costs - non-delivery", "staffNonDel", true, false, false, true);
  addDataRow("Other expenses - non-delivery", "expNonDel", true, false, false, true);
  addSpacer(20);
  addDataRow("Total overheads", "totalOverheads", true, true, false, true);
  addSpacer(12);
  addDataRow(isRevMode ? "Overheads as % of revenue" : "Overheads as % of income", "overheadsPct", false, false, true, true);
  addSpacer(20);

  addDataRow("Operating profit", "opProfit", true, true, false, false);
  addSpacer(12);
  addDataRow("Operating profit %", "opProfitPct", false, false, true, false);

  const showExtraRows = Boolean(activeYear?.rows?.length > 32);
  if (showExtraRows) {
    addSpacer(12);
    addDataRow(isRevMode ? "Staff costs to revenue %" : "Staff costs to income %", "staffToIncPct", false, false, true, true);
  }

  const selectStyle = {
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    fontSize: "13px",
    color: "#1e293b",
    background: "#ffffff",
    cursor: "pointer",
    outline: "none",
    fontWeight: 600,
    fontFamily: "'Kumbh Sans', sans-serif",
  };

  const handleDownloadCSV = () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const yearLabel = activeFyLabel.replace(/\s+/g, "_");
    const exportRows = [];
    exportRows.push([`Budget variance analysis: ${viewMode.toUpperCase()} - ${activeFyLabel}`]);
    exportRows.push([]);
    if (viewMode === "month") {
      exportRows.push(["Metric", "Actual", "", "Budget", "", "Variance (£)", "Variance (%)"]);
    } else {
      exportRows.push(["Metric", ...displayedMonths.map((m) => `${m} (Act)`), "Act Total", "", "Budget Total", "", "Var (£)", "Var (%)"]);
    }
    tableRows.forEach((r) => {
      if (r.type === "section") {
        exportRows.push([r.label]);
      } else if (r.type !== "spacer") {
        if (viewMode === "month") {
          exportRows.push([r.label, r.data?.[0] || "", "", r.data?.[1] || "", "", r.data?.[2] || "", r.data?.[3] || ""]);
        } else {
          const actVals = (r.actuals || []).map((v) => r.isCurrency ? formatMoney(v) : formatPct(v));
          const actSum = r.isCurrency ? formatMoney(r.actSum) : formatPct(r.actSum);
          const budSum = r.isCurrency ? formatMoney(r.budSum) : formatPct(r.budSum);
          exportRows.push([r.label, ...actVals, actSum, "", budSum, "", r.varPounds || "", r.varPct || ""]);
        }
      }
    });

    const csvContent =
      "data:text/csv;charset=utf-8," +
      exportRows
        .map((e) =>
          e.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Pulse_Budget_Variance_${viewMode}_${yearLabel}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "1rem", padding: "0.5rem 0 3rem 0" }}>
      {/* Action Bar Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ fontSize: "1.4rem", fontWeight: 700, color: "#0047AB", margin: 0, fontFamily: "'Kumbh Sans', sans-serif" }}>
            Budget variance analysis
          </h2>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.08)", padding: "2px 8px", borderRadius: "4px" }}>
            {activeFyLabel}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {/* View Mode Toggle */}
          <div style={{ display: "flex", background: "#f1f5f9", borderRadius: "6px", padding: "2px" }}>
            {["month", "ytd", "fy"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                style={{
                  padding: "4px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  background: viewMode === m ? "#0047AB" : "transparent",
                  color: viewMode === m ? "#ffffff" : "#64748b",
                  textTransform: "uppercase",
                }}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Month selector for 'month' or 'ytd' */}
          {viewMode !== "fy" && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>
                {viewMode === "ytd" ? "Through to:" : "Month:"}
              </span>
              <select
                value={selectedMonthIdx}
                onChange={(e) => setUserMonthIdx(parseInt(e.target.value, 10))}
                style={selectStyle}
              >
                {months.map((m, idx) => (
                  <option key={idx} value={idx}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh budget data"
            style={{
              background: "transparent",
              border: "none",
              cursor: isLoading ? "wait" : "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            {isLoading ? (
              <Spinner size={18} color="#0047AB" />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
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

      {/* Main Budget Variance Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        {selectedYearIdx > 0 && (
          <button
            type="button"
            onClick={() => setSelectedYearIdx((prev) => Math.max(0, prev - 1))}
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

        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            border: "1px solid #e2e8f0",
            overflow: "hidden",
            width: "100%",
          }}
        >
          <div style={{ overflowX: "auto", width: "100%" }}>
            <table
              style={{
                width: "max-content",
                borderCollapse: "separate",
                borderSpacing: 0,
              fontSize: "12px",
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff", height: "31px" }}>
                <th
                  style={{
                    padding: "6px 12px",
                    textAlign: "left",
                    fontWeight: 700,
                    width: "220px",
                    minWidth: "220px",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 2,
                    fontSize: "14px",
                  }}
                >
                  {/* Empty top-left */}
                </th>

                {viewMode === "month" ? (
                  <>
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Actual
                    </th>
                    <th style={{ width: "22px", minWidth: "22px", background: "#0047AB", padding: 0 }} />
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Budget
                    </th>
                    <th style={{ width: "22px", minWidth: "22px", background: "#0047AB", padding: 0 }} />
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Var (£)
                    </th>
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Var %
                    </th>
                  </>
                ) : (
                  <>
                    {displayedMonths.map((mLabel, idx) => (
                      <th
                        key={idx}
                        style={{
                          padding: "6px 4px",
                          textAlign: "right",
                          fontWeight: 700,
                          fontSize: "14px",
                          width: "87px",
                          minWidth: "87px",
                          background: "#0047AB",
                        }}
                      >
                        {mLabel}
                      </th>
                    ))}
                    <th style={{ width: "22px", minWidth: "22px", background: "#0047AB", padding: 0 }} />
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", width: "110px", minWidth: "110px", background: "#0047AB" }}>
                      {viewMode === "ytd" ? "YTD Actual" : "FY Actual"}
                    </th>
                    <th style={{ width: "22px", minWidth: "22px", background: "#0047AB", padding: 0 }} />
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "110px", minWidth: "110px", background: "#0047AB" }}>
                      {viewMode === "ytd" ? "YTD Budget" : "FY Budget"}
                    </th>
                    <th style={{ width: "22px", minWidth: "22px", background: "#0047AB", padding: 0 }} />
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Var (£)
                    </th>
                    <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: "14px", fontStyle: "italic", width: "87px", minWidth: "87px", background: "#0047AB" }}>
                      Var %
                    </th>
                  </>
                )}
              </tr>

              {/* Subheader status row for YTD/FY */}
              {viewMode !== "month" && (
                <tr style={{ background: "#efefef", height: "15px" }}>
                  <td style={{ padding: "2px 12px", background: "#efefef", position: "sticky", left: 0, zIndex: 2 }} />
                  {displayedMonths.map((_, idx) => {
                    const text = activeYear?.statusRow?.[idx] || (idx < 6 ? "Actual" : "Forecast");
                    return (
                      <td key={idx} style={{ padding: "2px 4px", textAlign: "right", color: "#666666", fontStyle: "italic", background: "#efefef", fontSize: "9px" }}>
                        {text}
                      </td>
                    );
                  })}
                  {Array.from({ length: 7 }).map((_, cIdx) => (
                    <td key={cIdx} style={{ padding: 0, background: "#efefef" }} />
                  ))}
                </tr>
              )}
            </thead>

            <tbody>
              {tableRows.map((r, rIdx) => {
                if (r.type === "spacer") {
                  return (
                    <tr key={rIdx} style={{ height: `${r.height}px`, background: "#efefef" }}>
                      <td colSpan={numTotalCols + 1} style={{ padding: 0, border: "none", background: "#efefef" }} />
                    </tr>
                  );
                }

                if (r.type === "section") {
                  return (
                    <tr key={rIdx} style={{ height: `${r.height}px`, background: "#efefef" }}>
                      <td
                        style={{
                          padding: "2px 12px",
                          textAlign: "left",
                          fontWeight: 700,
                          fontSize: "13px",
                          color: "#0047AB",
                          position: "sticky",
                          left: 0,
                          background: "#efefef",
                          zIndex: 1,
                        }}
                      >
                        {r.label}
                      </td>
                      {Array.from({ length: numTotalCols }).map((_, cIdx) => (
                        <td key={cIdx} style={{ padding: 0, background: "#efefef" }} />
                      ))}
                    </tr>
                  );
                }

                // Data row
                const isBigTotal = r.isBigTotal;
                const rowBg = r.bg;
                const rowColor = r.color;
                const isBold = r.isBold;
                const isMargin = r.isMargin;
                const isCost = r.isCost;
                const rowHeight = r.height;
                const fontSize = r.fontSize;
                const borderBottom = isBigTotal ? "none" : "1px solid #ffffff";

                const actArr = actMetrics[r.metricKey] || new Array(12).fill(0);
                const budArr = budMetrics[r.metricKey] || new Array(12).fill(0);

                if (viewMode === "month") {
                  const actV = actArr[selectedMonthIdx] || 0;
                  const budV = budArr[selectedMonthIdx] || 0;

                  let cellBg = rowBg;
                  let cellColor = rowColor;
                  if (isMargin) {
                    cellBg = getMarginColor(r.label, actV);
                    cellColor = "#000000";
                  }

                  const varCells = getVarCells(actV, budV, isCost, isMargin, r.hideVariance, rowBg);

                  return (
                    <tr key={rIdx} style={{ height: `${rowHeight}px`, background: rowBg, borderBottom }}>
                      <td style={{ padding: "2px 12px", textAlign: "left", color: rowColor, fontWeight: isBold ? 700 : 400, fontStyle: isMargin ? "italic" : "normal", fontSize: `${fontSize}px`, position: "sticky", left: 0, background: rowBg, zIndex: 1, whiteSpace: "nowrap" }}>
                        {r.label}
                      </td>
                      <td style={{ padding: "2px 8px", textAlign: "right", background: cellBg, color: cellColor, fontWeight: isBold ? 700 : 400, fontStyle: isMargin ? "italic" : "normal", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                        {r.isCurrency ? formatMoney(actV) : formatPct(actV)}
                      </td>
                      <td style={{ width: "22px", minWidth: "22px", background: rowBg, padding: 0 }} />
                      <td style={{ padding: "2px 8px", textAlign: "right", background: rowBg, color: rowColor, fontWeight: isBold ? 700 : 400, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                        {r.isCurrency ? formatMoney(budV) : formatPct(budV)}
                      </td>
                      <td style={{ width: "22px", minWidth: "22px", background: rowBg, padding: 0 }} />
                      <td style={{ padding: "2px 8px", textAlign: "right", background: varCells[0].bg, color: varCells[0].color, fontWeight: isBold ? 700 : 600, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                        {varCells[0].v}
                      </td>
                      <td style={{ padding: "2px 8px", textAlign: "right", background: varCells[1].bg, color: varCells[1].color, fontWeight: isBold ? 700 : 600, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                        {varCells[1].v}
                      </td>
                    </tr>
                  );
                }

                // YTD or FY Mode
                let actSum = sumArr(actArr, limit);
                let budSum = sumArr(budArr, limit);

                if (isMargin) {
                  if (r.metricKey === "gpMargin") {
                    const actRev = sumArr(actMetrics.totalRev, limit);
                    const budRev = sumArr(budMetrics.totalRev, limit);
                    actSum = actRev ? sumArr(actMetrics.gp, limit) / actRev : 0;
                    budSum = budRev ? sumArr(budMetrics.gp, limit) / budRev : 0;
                  } else if (r.metricKey === "overheadsPct") {
                    const actRev = sumArr(actMetrics.totalRev, limit);
                    const budRev = sumArr(budMetrics.totalRev, limit);
                    actSum = actRev ? sumArr(actMetrics.totalOverheads, limit) / actRev : 0;
                    budSum = budRev ? sumArr(budMetrics.totalOverheads, limit) / budRev : 0;
                  } else if (r.metricKey === "opProfitPct") {
                    const actRev = sumArr(actMetrics.totalRev, limit);
                    const budRev = sumArr(budMetrics.totalRev, limit);
                    actSum = actRev ? sumArr(actMetrics.opProfit, limit) / actRev : 0;
                    budSum = budRev ? sumArr(budMetrics.opProfit, limit) / budRev : 0;
                  } else if (r.metricKey === "staffToIncPct") {
                    const actRev = sumArr(actMetrics.totalRev, limit);
                    const budRev = sumArr(budMetrics.totalRev, limit);
                    actSum = actRev ? (sumArr(actMetrics.staffDel, limit) + sumArr(actMetrics.staffNonDel, limit)) / actRev : 0;
                    budSum = budRev ? (sumArr(budMetrics.staffDel, limit) + sumArr(budMetrics.staffNonDel, limit)) / budRev : 0;
                  }
                }

                const varCells = getVarCells(actSum, budSum, isCost, isMargin, r.hideVariance, rowBg);

                let actTotalBg = rowBg;
                let actTotalColor = rowColor;
                if (isMargin) {
                  actTotalBg = getMarginColor(r.label, actSum);
                  actTotalColor = "#000000";
                }

                return (
                  <tr key={rIdx} style={{ height: `${rowHeight}px`, background: rowBg, borderBottom }}>
                    <td style={{ padding: "2px 12px", textAlign: "left", color: rowColor, fontWeight: isBold ? 700 : 400, fontStyle: isMargin ? "italic" : "normal", fontSize: `${fontSize}px`, position: "sticky", left: 0, background: rowBg, zIndex: 1, whiteSpace: "nowrap" }}>
                      {r.label}
                    </td>

                    {/* Monthly actuals */}
                    {Array.from({ length: limit }).map((_, m) => {
                      const actV = actArr[m] || 0;
                      let cellBg = rowBg;
                      let cellColor = rowColor;
                      if (isMargin) {
                        cellBg = getMarginColor(r.label, actV);
                        cellColor = "#000000";
                      }
                      return (
                        <td key={m} style={{ padding: "2px 4px", textAlign: "right", background: cellBg, color: cellColor, fontWeight: isBold ? 700 : 400, fontStyle: isMargin ? "italic" : "normal", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                          {r.isCurrency ? formatMoney(actV) : formatPct(actV)}
                        </td>
                      );
                    })}

                    {/* 22px Gap */}
                    <td style={{ width: "22px", minWidth: "22px", background: rowBg, padding: 0 }} />

                    {/* Actual Total */}
                    <td style={{ padding: "2px 8px", textAlign: "right", background: actTotalBg, color: actTotalColor, fontWeight: isBold ? 700 : 600, fontStyle: isMargin ? "italic" : "normal", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                      {r.isCurrency ? formatMoney(actSum) : formatPct(actSum)}
                    </td>

                    {/* 22px Gap */}
                    <td style={{ width: "22px", minWidth: "22px", background: rowBg, padding: 0 }} />

                    {/* Budget Total */}
                    <td style={{ padding: "2px 8px", textAlign: "right", background: rowBg, color: rowColor, fontWeight: isBold ? 700 : 400, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                      {r.isCurrency ? formatMoney(budSum) : formatPct(budSum)}
                    </td>

                    {/* 22px Gap */}
                    <td style={{ width: "22px", minWidth: "22px", background: rowBg, padding: 0 }} />

                    {/* Var (£) */}
                    <td style={{ padding: "2px 8px", textAlign: "right", background: varCells[0].bg, color: varCells[0].color, fontWeight: isBold ? 700 : 600, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                      {varCells[0].v}
                    </td>

                    {/* Var (%) */}
                    <td style={{ padding: "2px 8px", textAlign: "right", background: varCells[1].bg, color: varCells[1].color, fontWeight: isBold ? 700 : 600, fontStyle: "italic", fontSize: `${fontSize}px`, whiteSpace: "nowrap" }}>
                      {varCells[1].v}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selectedYearIdx < 2 && (
        <button
          type="button"
          onClick={() => setSelectedYearIdx((prev) => Math.min(2, prev + 1))}
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
  </div>
  );
}
