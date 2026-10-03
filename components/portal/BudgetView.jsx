import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function BudgetView({
  clientName,
  data,
  allFYData,
  keyData,
  isLoading,
  error,
  onRefresh,
}) {
  const [selectedYearIdx, setSelectedYearIdx] = useState(data?.currentYearIdx || 0);

  const isRevMode = useMemo(() => {
    if (keyData?.outgoingsMeta?.mode) {
      return !keyData.outgoingsMeta.mode.toLowerCase().includes("income");
    }
    const allLabels = (allFYData?.years?.[0]?.rows || []).map((r) => String(r.label || "").toLowerCase());
    return !allLabels.some((l) => l.includes("confirmed income") || l.includes("total income"));
  }, [keyData, allFYData]);

  const rawVals = data?.rawVals || [];
  const mathVals = data?.mathVals || rawVals;

  // Year blocks: Year 1 = cols 6..17, Year 2 = 21..32, Year 3 = 36..47
  const blkStart = selectedYearIdx === 0 ? 6 : (selectedYearIdx === 1 ? 21 : 36);

  const getRowData = (rawRowIdx) => {
    if (rawRowIdx === null || !rawVals[rawRowIdx]) return new Array(13).fill(0);
    const row = [];
    let total = 0;
    for (let m = 0; m < 12; m++) {
      let val = parseFloat(mathVals?.[rawRowIdx]?.[blkStart + m]);
      if (isNaN(val)) {
        val = parseFloat(String(rawVals?.[rawRowIdx]?.[blkStart + m] || "").replace(/[£$,%]/g, "")) || 0;
      }
      row.push(val);
      total += val;
    }
    row.push(total); // 13th item is Total
    return row;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString("en-GB")}`;
  };

  const formatPct = (val) => `${Math.round((val || 0) * 100)}%`;

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

  if (isLoading && (!data || rawVals.length === 0)) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading Budget Overview for {clientName}...
        </p>
      </div>
    );
  }

  if (error && (!data || rawVals.length === 0)) {
    return (
      <div
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          padding: "1.5rem",
          color: "#991b1b",
          margin: "1rem 0",
        }}
      >
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load budget data</h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>{error}</p>
        <button
          onClick={onRefresh}
          style={{
            padding: "6px 14px",
            background: "#dc2626",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (data && !data.hasBudget) {
    return (
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          padding: "3rem 2rem",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          border: "1px solid #e2e8f0",
          textAlign: "center",
          fontFamily: "'Kumbh Sans', sans-serif",
        }}
      >
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📋</div>
        <h3 style={{ color: "#0047AB", fontWeight: 700, margin: "0 0 8px 0" }}>
          No Budget Configured
        </h3>
        <p style={{ color: "#64748b", maxWidth: "460px", margin: "0 auto" }}>
          This client does not have budget tracking enabled or the budget tab is empty.
        </p>
      </div>
    );
  }

  // Row Extraction matching WebApp.html blueprint
  const conf = getRowData(isRevMode ? 4 : 20);
  const pipe = getRowData(isRevMode ? 5 : 21);
  const nb = getRowData(isRevMode ? 6 : 22);

  const staffDel = getRowData(28);
  const dirCosts = isRevMode ? getRowData(29) : new Array(13).fill(0);
  const expDel = getRowData(isRevMode ? 30 : 29);

  const staffNonDel = getRowData(39);
  const expNonDel = getRowData(40);

  const totalRev = conf.map((v, i) => v + pipe[i] + nb[i]);
  const totalCoS = isRevMode
    ? staffDel.map((v, i) => v + dirCosts[i] + expDel[i])
    : staffDel.map((v, i) => v + expDel[i]);
  const gp = totalRev.map((v, i) => v - totalCoS[i]);
  const gpMargin = gp.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));

  const totalOverheads = staffNonDel.map((v, i) => v + expNonDel[i]);
  const overheadsPct = totalOverheads.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));
  const opProfit = gp.map((v, i) => v - totalOverheads[i]);
  const opProfitPct = opProfit.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));
  const staffToIncPct = totalRev.map((v, i) => (totalRev[i] ? (staffDel[i] + staffNonDel[i]) / totalRev[i] : 0));

  const showExtraRows = Boolean(allFYData?.years?.[0]?.rows?.length > 32);

  // Month header labels
  const monthHeaders = [];
  for (let m = 0; m < 12; m++) {
    const rawH = rawVals[0]?.[blkStart + m];
    monthHeaders.push(rawH || `M${m + 1}`);
  }

  // Construct structured rows matching renderViewBudget
  const tableRows = [];

  const addSpacer = (height = 6) => {
    tableRows.push({ type: "spacer", height });
  };

  const addSectionHeader = (label) => {
    tableRows.push({ type: "section", label, height: 20 });
  };

  const addDataRow = (label, dataArr, isCurrency, isBigTotal, isMargin, bg, color, isBold = false) => {
    tableRows.push({
      type: "data",
      label,
      data: dataArr,
      isCurrency,
      isBigTotal,
      isMargin,
      bg: bg || "#efefef",
      color: color || "#0047AB",
      isBold: isBigTotal || isBold,
      height: isBigTotal ? 31 : (isMargin ? 17 : 20),
      fontSize: isBigTotal ? 14 : (isMargin ? 9 : 10),
    });
  };

  addSpacer(15);
  addSectionHeader(isRevMode ? "Revenue" : "Income");
  addDataRow(isRevMode ? "Confirmed revenue" : "Confirmed income", conf, true, false, false, "#efefef", "#0047AB");
  addDataRow(isRevMode ? "Pipeline revenue" : "Pipeline income", pipe, true, false, false, "#efefef", "#0047AB");
  addDataRow(isRevMode ? "New business to find revenue" : "New business to find income", nb, true, false, false, "#efefef", "#0047AB");
  addSpacer(6);
  addDataRow(isRevMode ? "Total revenue" : "Total income", totalRev, true, true, false, "#9900ff", "#ffffff");
  addSpacer(20);

  addSectionHeader("Costs of sale");
  addDataRow("Staff costs - delivery", staffDel, true, false, false, "#efefef", "#0047AB");
  if (isRevMode) {
    addDataRow("Direct costs", dirCosts, true, false, false, "#efefef", "#0047AB");
  }
  addDataRow("Other expenses - delivery", expDel, true, false, false, "#efefef", "#0047AB");
  addSpacer(4);
  addDataRow("Total costs of sale", totalCoS, true, false, false, "#efefef", "#0047AB", true);
  addSpacer(12);
  addDataRow("Gross profit", gp, true, true, false, "#e69138", "#ffffff");
  addSpacer(10);
  addDataRow("Gross profit margin %", gpMargin, false, false, true, "#efefef", "#0047AB");
  addSpacer(16);

  addSectionHeader("Overheads");
  addDataRow("Staff costs - non-delivery", staffNonDel, true, false, false, "#efefef", "#0047AB");
  addDataRow("Other expenses - non-delivery", expNonDel, true, false, false, "#efefef", "#0047AB");
  addSpacer(20);
  addDataRow("Total overheads", totalOverheads, true, true, false, "#45818e", "#ffffff");
  addSpacer(12);
  addDataRow(isRevMode ? "Overheads as % of revenue" : "Overheads as % of income", overheadsPct, false, false, true, "#efefef", "#0047AB");
  addSpacer(20);

  addDataRow("Operating profit", opProfit, true, true, false, "#1155cc", "#ffffff");
  addSpacer(12);
  addDataRow("Operating profit %", opProfitPct, false, false, true, "#efefef", "#0047AB");

  if (showExtraRows) {
    addSpacer(12);
    addDataRow(isRevMode ? "Staff costs to revenue %" : "Staff costs to income %", staffToIncPct, false, false, true, "#efefef", "#0047AB");
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

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        padding: "0.5rem 0 3rem 0",
      }}
    >
      {/* Action Bar Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2
            style={{
              fontSize: "1.4rem",
              fontWeight: 700,
              color: "#0047AB",
              margin: 0,
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
          >
            Budget overview
          </h2>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "#64748b",
              background: "#f1f5f9",
              padding: "2px 8px",
              borderRadius: "4px",
            }}
          >
            {selectedYearIdx === 0 ? "Year 1" : selectedYearIdx === 1 ? "Year 2" : "Year 3"}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Year:</span>
            <select
              value={selectedYearIdx}
              onChange={(e) => setSelectedYearIdx(parseInt(e.target.value, 10))}
              style={selectStyle}
            >
              <option value={0}>Year 1</option>
              <option value={1}>Year 2</option>
              <option value={2}>Year 3</option>
            </select>
          </div>

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
        </div>
      </div>

      {/* Main Budget Table matching WebApp.html blueprint */}
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
                  {/* Empty top-left cell */}
                </th>
                {monthHeaders.map((mLabel, idx) => (
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
                {/* 22px Gap Column */}
                <th
                  style={{
                    width: "22px",
                    minWidth: "22px",
                    background: "#0047AB",
                    padding: 0,
                  }}
                />
                {/* 110px Total Column */}
                <th
                  style={{
                    padding: "6px 12px",
                    textAlign: "right",
                    fontWeight: 700,
                    fontSize: "14px",
                    width: "110px",
                    minWidth: "110px",
                    background: "#0047AB",
                  }}
                >
                  Total
                </th>
              </tr>
            </thead>

            <tbody>
              {tableRows.map((r, rIdx) => {
                if (r.type === "spacer") {
                  return (
                    <tr key={rIdx} style={{ height: `${r.height}px`, background: "#efefef" }}>
                      <td colSpan={15} style={{ padding: 0, border: "none", background: "#efefef" }} />
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
                      {Array.from({ length: 14 }).map((_, cIdx) => (
                        <td key={cIdx} style={{ padding: 0, background: "#efefef" }} />
                      ))}
                    </tr>
                  );
                }

                // Data Row
                const isBigTotal = r.isBigTotal;
                const rowBg = r.bg;
                const rowColor = r.color;
                const isBold = r.isBold;
                const isMargin = r.isMargin;
                const rowHeight = r.height;
                const fontSize = r.fontSize;

                const borderBottom = isBigTotal ? "none" : "1px solid #ffffff";

                return (
                  <tr
                    key={rIdx}
                    style={{
                      height: `${rowHeight}px`,
                      background: rowBg,
                      borderBottom,
                    }}
                  >
                    {/* Line item label (Col A) */}
                    <td
                      style={{
                        padding: "2px 12px",
                        textAlign: "left",
                        color: rowColor,
                        fontWeight: isBold ? 700 : 400,
                        fontStyle: isMargin ? "italic" : "normal",
                        fontSize: `${fontSize}px`,
                        position: "sticky",
                        left: 0,
                        background: rowBg,
                        zIndex: 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.label}
                    </td>

                    {/* 12 Month values */}
                    {Array.from({ length: 12 }).map((_, mIdx) => {
                      const val = r.data[mIdx];
                      let cellBg = rowBg;
                      let cellColor = rowColor;
                      if (isMargin) {
                        cellBg = getMarginColor(r.label, val);
                        cellColor = "#000000";
                      }

                      return (
                        <td
                          key={mIdx}
                          style={{
                            padding: "2px 4px",
                            textAlign: "right",
                            background: cellBg,
                            color: cellColor,
                            fontWeight: isBold ? 700 : 400,
                            fontStyle: isMargin ? "italic" : "normal",
                            fontSize: `${fontSize}px`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.isCurrency ? formatMoney(val) : formatPct(val)}
                        </td>
                      );
                    })}

                    {/* Gap cell (22px) connecting seamlessly with major row color */}
                    <td
                      style={{
                        width: "22px",
                        minWidth: "22px",
                        background: rowBg,
                        padding: 0,
                      }}
                    />

                    {/* 13th Total cell */}
                    {(() => {
                      const totalVal = r.data[12];
                      let totalBg = rowBg;
                      let totalColor = rowColor;
                      if (isMargin) {
                        totalBg = getMarginColor(r.label, totalVal);
                        totalColor = "#000000";
                      }

                      return (
                        <td
                          style={{
                            padding: "2px 12px",
                            textAlign: "right",
                            background: totalBg,
                            color: totalColor,
                            fontWeight: isBold ? 700 : 600,
                            fontStyle: isMargin ? "italic" : "normal",
                            fontSize: `${fontSize}px`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.isCurrency ? formatMoney(totalVal) : formatPct(totalVal)}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
