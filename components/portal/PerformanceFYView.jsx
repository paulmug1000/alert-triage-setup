import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData, DeepDiveEngine } from "../../services/deepDiveHelper";

export default function PerformanceFYView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const years = data?.years || [];
  const [selectedYearIdx, setSelectedYearIdx] = useState(null);
  const [activePopover, setActivePopover] = useState(null);

  // Default to currentYearIdx from data or fallback to 1 (Year 1)
  const defaultYearIdx = data?.currentYearIdx !== undefined ? data.currentYearIdx : (years.length > 1 ? 1 : 0);
  const activeYearIdx = selectedYearIdx !== null ? Math.min(Math.max(0, selectedYearIdx), Math.max(0, years.length - 1)) : defaultYearIdx;
  const activeYear = years[activeYearIdx];

  if (isLoading && !data) {
    return (
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          padding: "5rem 2rem",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          border: "1px solid #e2e8f0",
          textAlign: "center",
        }}
      >
        <Spinner size={32} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#0047AB", fontWeight: 500, fontSize: "15px" }}>
          Please wait - loading
        </p>
      </div>
    );
  }

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
    return (
      <div style={{ background: "#ffffff", borderRadius: "8px", padding: "4rem", textAlign: "center" }}>
        <p style={{ color: "#64748b" }}>No financial year data found for this client.</p>
      </div>
    );
  }

  // Extract key summary KPI metrics from the active year's rows
  const findRow = (prefixArr) => {
    return activeYear.rows?.find((r) => {
      if (!r.label || !r.totalVal) return false;
      const lbl = r.label.toLowerCase();
      return prefixArr.some((p) => lbl.includes(p.toLowerCase()));
    });
  };

  const totalRevRow = findRow(["total income", "total revenue", "income"]);
  const grossProfitRow = findRow(["gross profit"]);
  const gpMarginRow = findRow(["gross profit margin"]);
  const overheadsRow = findRow(["total overheads", "overheads"]);
  const overheadsPctRow = findRow(["overheads as %"]);
  const opProfitRow = findRow(["operating profit"]);
  const opMarginRow = findRow(["operating profit %"]);

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
      const low = parseT(6, 0.20);
      if (num <= low) return { bg: "#d9ead3", color: "#0047AB" };
      if (num <= high) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
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
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "£0" || val === "—" || val === "") return;

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
    });
  };

  const handleDownloadCSV = () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const fyName = (activeYear?.fyLabel || activeYear?.displayTitle || "FY").replace(/\s+/g, "_");
    const exportRows = [];
    exportRows.push([`Performance: ${activeYear?.fyLabel || activeYear?.displayTitle}`]);
    exportRows.push([]);
    exportRows.push(["Metric", ...(activeYear?.headerMonths || []), "", "Total"]);
    tableRows.forEach((r) => {
      if (r.type === "section") {
        exportRows.push([r.label]);
      } else if (r.type !== "spacer") {
        const rowVals = (r.monthValues || []).map((v) => v.formatted);
        exportRows.push([r.label, ...rowVals, "", r.totalValue?.formatted || ""]);
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
    link.setAttribute("download", `Pulse_Performance_${fyName}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
        onClose={() => setActivePopover(null)}
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
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh data"
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

                // Spacer rows (Clean white for label column, exact continuous shading for month & total columns)
                if (!label || label.toLowerCase() === "hide") {
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
                      const isClickable = Boolean(ddType && val && val !== "£0" && val !== "—" && val !== "");
                      const monthLabel = activeYear.headerMonths?.[mIdx] || `Month ${mIdx + 1}`;
                      const displayVal = val === "—" ? "" : val || "";
                      const st = String((activeYear.statusValues || activeYear.monthStatuses || [])[mIdx] || "").trim().toLowerCase();
                      const isAct = st === "actual";
                      const colBg = isAct ? "#f4f7fa" : "#ffffff";

                      // If major row: solid band, transparent cell
                      if (rowStyle.isMajor) {
                        return (
                          <td
                            key={mIdx}
                            onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
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
                      return (
                        <td
                          key={mIdx}
                          onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
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
                      const isClickable = Boolean(ddType && totalVal && totalVal !== "£0" && totalVal !== "—" && totalVal !== "");
                      const displayTotal = totalVal === "—" ? "" : totalVal || "";
                      const totalColBg = "rgba(0, 71, 171, 0.04)";

                      if (rowStyle.isMajor) {
                        return (
                          <td
                            onClick={(e) =>
                              isClickable &&
                              handleCellClick(e, label, totalVal, -1, `${activeYear.fyLabel} Total`)
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

                      return (
                        <td
                          onClick={(e) =>
                            isClickable &&
                            handleCellClick(e, label, totalVal, -1, `${activeYear.fyLabel} Total`)
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

      <style jsx>{`
        @media (orientation: landscape) and (max-width: 1024px) {
          .fy-table-scroll-wrapper {
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
          .fy-table-scroll-wrapper {
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
