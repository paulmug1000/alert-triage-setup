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
  const defaultYearIdx = useMemo(() => {
    if (allFYData?.currentYearIdx !== undefined && allFYData.currentYearIdx > 0) {
      return Math.max(0, allFYData.currentYearIdx - 1);
    }
    if (data?.currentYearIdx !== undefined) {
      return data.currentYearIdx;
    }
    return 1;
  }, [allFYData?.currentYearIdx, data?.currentYearIdx]);

  const [userYearIdx, setUserYearIdx] = useState(null);
  const selectedYearIdx = userYearIdx !== null ? userYearIdx : defaultYearIdx;

  const isRevMode = useMemo(() => {
    if (keyData?.outgoingsMeta?.mode) {
      return !keyData.outgoingsMeta.mode.toLowerCase().includes("income");
    }
    const allLabels = (allFYData?.years?.[0]?.rows || []).map((r) => String(r.label || "").toLowerCase());
    return !allLabels.some((l) => l.includes("confirmed income") || l.includes("total income"));
  }, [keyData, allFYData]);

  const rawVals = data?.rawVals || [];
  const mathVals = data?.mathVals || rawVals;

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
    const t = allFYData?.thresholds || keyData?.thresholds || [];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
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
          Please wait - loading
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
    tableRows.push({ type: "section", label, height: 22 });
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
      fontSize: isBigTotal ? 13 : (isMargin ? 11.5 : 11.5),
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

  const handleDownloadCSV = () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const yearLabel = activeFyLabel.replace(/\s+/g, "_");
    const exportRows = [];
    exportRows.push([`Budget overview: ${activeFyLabel}`]);
    exportRows.push([]);
    exportRows.push(["Metric", ...monthHeaders, "", "Total"]);
    tableRows.forEach((r) => {
      if (r.type === "section") {
        exportRows.push([r.label]);
      } else if (r.type !== "spacer") {
        const rowVals = Array.from({ length: 12 }).map((_, mIdx) => {
          const val = r.data[mIdx];
          return r.isCurrency ? formatMoney(val) : formatPct(val);
        });
        const totalVal = r.isCurrency ? formatMoney(r.data[12]) : formatPct(r.data[12]);
        exportRows.push([r.label, ...rowVals, "", totalVal]);
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
    link.setAttribute("download", `Pulse_Budget_Overview_${yearLabel}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
              fontWeight: 700,
              color: "#0047AB",
              background: "rgba(0, 71, 171, 0.08)",
              padding: "2px 8px",
              borderRadius: "4px",
            }}
          >
            {activeFyLabel}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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

      {/* Main Budget Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        {selectedYearIdx > 0 && (
          <button
            type="button"
            className="fy-nav-arrow-left"
            onClick={() => setUserYearIdx(Math.max(0, selectedYearIdx - 1))}
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
          className="fy-table-scroll-wrapper"
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
                width: "100%",
                minWidth: "940px",
                tableLayout: "fixed",
                borderCollapse: "separate",
                borderSpacing: 0,
                fontSize: "11.5px",
                fontFamily: "'Kumbh Sans', sans-serif",
              }}
            >
              <thead>
                <tr style={{ background: "#0000ff", color: "#ffffff", height: "31px" }}>
                  <th
                    style={{
                      padding: "6px 10px",
                      textAlign: "left",
                      fontWeight: 700,
                      width: "12%",
                      minWidth: "140px",
                      position: "sticky",
                      left: 0,
                      background: "#0000ff",
                      zIndex: 2,
                      fontSize: "13px",
                    }}
                  >
                    {/* Empty top-left cell */}
                  </th>
                  {monthHeaders.map((mLabel, idx) => (
                    <th
                      key={idx}
                      style={{
                        padding: "6px 2px",
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: "12px",
                        width: "6.7%",
                        background: "#0000ff",
                      }}
                    >
                      {mLabel}
                    </th>
                  ))}
                  {/* Gap Column */}
                  <th
                    style={{
                      width: "1.0%",
                      background: "#0000ff",
                      padding: 0,
                    }}
                  />
                  {/* Total Column */}
                  <th
                    style={{
                      padding: "6px 8px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "13px",
                      width: "6.6%",
                      minWidth: "75px",
                      background: "#0000ff",
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
                          padding: "2px 8px",
                          paddingLeft: "8px",
                          textAlign: "left",
                          fontWeight: 700,
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
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
                const fontSize = isBigTotal ? 13 : r.fontSize;

                const borderBottom = isBigTotal ? "2px solid #cbd5e1" : "1px solid #ffffff";

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
                        padding: "2px 8px",
                        paddingLeft: isBigTotal ? "8px" : "16px",
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
                        cellColor = "#0047AB";
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

                    {/* Gap cell connecting seamlessly with major row color */}
                    <td
                      style={{
                        width: "1.8%",
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
                        totalColor = "#0047AB";
                      }

                      return (
                        <td
                          style={{
                            padding: "2px 8px",
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

      {selectedYearIdx < 2 && (
        <button
          type="button"
          className="fy-nav-arrow-right"
          onClick={() => setUserYearIdx(Math.min(2, selectedYearIdx + 1))}
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

    <style jsx>{`
      @media (max-width: 1024px) {
        .fy-nav-arrow-left {
          left: 2px !important;
          font-size: 2.2rem !important;
        }
        .fy-nav-arrow-right {
          right: 2px !important;
          font-size: 2.2rem !important;
        }
        .fy-table-scroll-wrapper {
          margin: 0 24px !important;
          width: calc(100% - 48px) !important;
        }
      }
    `}</style>
  </div>
  );
}
