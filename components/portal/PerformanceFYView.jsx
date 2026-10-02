import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData } from "../../services/deepDiveHelper";

export default function PerformanceFYView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
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
          Please wait - just crunching your numbers
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
    if (!valStr || !valStr.includes("%")) return null;
    const num = parseFloat(valStr.replace(/%/g, "")) / 100;
    if (isNaN(num)) return null;

    const t = data?.thresholds || [];
    if (label.toLowerCase().includes("gross profit margin")) {
      const high = parseFloat(t[0]) || 0.495;
      const low = parseFloat(t[1]) || 0.445;
      if (num >= high) return { bg: "#d9ead3", color: "#166534" };
      if (num >= low) return { bg: "#fce5cd", color: "#b45309" };
      return { bg: "#f4cccc", color: "#991b1b" };
    }
    if (label.toLowerCase().includes("overheads as %")) {
      const high = parseFloat(t[5]) || 0.309;
      const low = parseFloat(t[6]) || 0.20;
      if (num <= low) return { bg: "#d9ead3", color: "#166534" };
      if (num <= high) return { bg: "#fce5cd", color: "#b45309" };
      return { bg: "#f4cccc", color: "#991b1b" };
    }
    if (label.toLowerCase().includes("operating profit %")) {
      const high = parseFloat(t[10]) || 0.15;
      const low = parseFloat(t[11]) || 0.05;
      if (num >= high) return { bg: "#d9ead3", color: "#166534" };
      if (num >= low) return { bg: "#fce5cd", color: "#b45309" };
      return { bg: "#f4cccc", color: "#991b1b" };
    }
    return null;
  };

  const getRowStyle = (label) => {
    const l = String(label || "").toLowerCase().trim();
    if (l === "total income" || l === "total revenue") {
      return { bg: "#0000ff", color: "#ffffff", bold: true, isMajor: true };
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
      return { bg: "#f1f5f9", color: "#0047AB", bold: true, isHeader: true };
    }
    return { bg: "#ffffff", color: "#334155", bold: false, isMajor: false };
  };

  const handleCellClick = (e, rowLabel, val, mIdx, periodLabel) => {
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "£0" || val === "—" || val === "") return;

    const rect = e.currentTarget.getBoundingClientRect();
    const ddData = buildDeepDiveData({
      ddType,
      periodLabel,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: activeYearIdx,
      keyData,
    });

    setActivePopover({
      isOpen: true,
      targetRect: rect,
      title: ddData.title,
      period: ddData.period,
      total: ddData.total,
      items: ddData.items,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%" }}>
      {/* Deep Dive Popover */}
      <DeepDivePopover
        isOpen={Boolean(activePopover?.isOpen)}
        targetRect={activePopover?.targetRect}
        title={activePopover?.title}
        period={activePopover?.period}
        total={activePopover?.total}
        items={activePopover?.items || []}
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
        </div>

        {/* Year Navigator Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "2px",
            }}
          >
            <button
              type="button"
              disabled={activeYearIdx === 0}
              onClick={() => setSelectedYearIdx((prev) => Math.max(0, prev - 1))}
              style={{
                border: "none",
                background: "transparent",
                color: activeYearIdx === 0 ? "#cbd5e1" : "#0047AB",
                padding: "4px 10px",
                fontSize: "12px",
                fontWeight: 700,
                cursor: activeYearIdx === 0 ? "not-allowed" : "pointer",
                borderRadius: "4px",
              }}
              title="View Previous Year"
            >
              ◀ Prev FY
            </button>

            <select
              value={activeYearIdx}
              onChange={(e) => setSelectedYearIdx(parseInt(e.target.value, 10))}
              style={{
                border: "none",
                background: "#ffffff",
                padding: "4px 8px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#0f172a",
                cursor: "pointer",
                borderRadius: "4px",
              }}
            >
              {years.map((y, idx) => (
                <option key={y.id} value={idx}>
                  {y.displayTitle} {idx === data?.currentYearIdx ? "(Current)" : ""}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={activeYearIdx === years.length - 1}
              onClick={() => setSelectedYearIdx((prev) => Math.min(years.length - 1, prev + 1))}
              style={{
                border: "none",
                background: "transparent",
                color: activeYearIdx === years.length - 1 ? "#cbd5e1" : "#0047AB",
                padding: "4px 10px",
                fontSize: "12px",
                fontWeight: 700,
                cursor: activeYearIdx === years.length - 1 ? "not-allowed" : "pointer",
                borderRadius: "4px",
              }}
              title="View Next Year"
            >
              Next FY ▶
            </button>
          </div>

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
        </div>
      </div>

      {/* Main 12-Month Performance Table (Sized to fit desktop width) */}
      <div
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
          style={{
            width: "100%",
            borderCollapse: "separate",
            borderSpacing: 0,
            tableLayout: "fixed",
            fontSize: "12px",
            fontFamily: "'Kumbh Sans', sans-serif",
          }}
        >
          <thead>
            {/* Row 1: Month Names & FY Total Header */}
            <tr style={{ background: "#0047AB", color: "#ffffff" }}>
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "left",
                  fontWeight: 700,
                  fontSize: "12px",
                  position: "sticky",
                  left: 0,
                  background: "#0047AB",
                  zIndex: 2,
                  width: "22%",
                }}
              >
                {/* No header in top-left cell */}
              </th>
              {activeYear.headerMonths?.map((m, idx) => (
                <th
                  key={idx}
                  style={{
                    padding: "6px 4px",
                    textAlign: "right",
                    fontWeight: 700,
                    fontSize: "11.5px",
                    width: "5.8%",
                  }}
                >
                  {m}
                </th>
              ))}
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "right",
                  fontWeight: 800,
                  fontSize: "12px",
                  background: "#0047AB",
                  width: "8.4%",
                }}
              >
                {activeYear.totalColHeader}
              </th>
            </tr>

            {/* Row 2: Status row (Actual vs Forecast) with NO column header */}
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "10px" }}>
              <td
                style={{
                  padding: "3px 8px",
                  fontWeight: 600,
                  color: "#64748b",
                  position: "sticky",
                  left: 0,
                  background: "#f8fafc",
                  zIndex: 2,
                }}
              >
                {/* Empty cell, NO Status label */}
              </td>
              {(activeYear.statusValues || activeYear.monthStatuses || []).map((st, idx) => {
                const isAct = String(st).toLowerCase() === "actual";
                return (
                  <td key={idx} style={{ padding: "3px 4px", textAlign: "right" }}>
                    <span
                      style={{
                        padding: "1px 4px",
                        borderRadius: "4px",
                        fontSize: "9px",
                        fontWeight: 700,
                        background: isAct ? "#dcfce7" : "#e0f2fe",
                        color: isAct ? "#166534" : "#0369a1",
                        textTransform: "uppercase",
                      }}
                    >
                      {st || ""}
                    </span>
                  </td>
                );
              })}
              <td style={{ padding: "3px 8px", textAlign: "right", color: "#64748b", fontWeight: 700 }}>
              </td>
            </tr>
          </thead>

          <tbody>
            {activeYear.rows?.map((row, rIdx) => {
              const label = row.label;
              const totalVal = row.totalVal;

              // Hide rows
              if (!label || label.toLowerCase() === "hide") {
                return (
                  <tr key={rIdx} style={{ height: "4px", background: "#f8fafc" }}>
                    <td colSpan={14} style={{ padding: 0 }} />
                  </tr>
                );
              }

              const rowStyle = getRowStyle(label);
              const isPercentageRow = label.includes("%") || label.toLowerCase().includes("ratio");
              const totalBadge = isPercentageRow ? getMarginBadgeStyle(label, totalVal) : null;

              return (
                <tr
                  key={rIdx}
                  style={{
                    borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                    background: rowStyle.bg,
                    fontWeight: rowStyle.bold ? 700 : 400,
                  }}
                >
                  {/* Sticky Line Item Column */}
                  <td
                    style={{
                      padding: rowStyle.isHeader ? "4px 8px" : "4px 8px",
                      color: rowStyle.color,
                      fontSize: rowStyle.isMajor ? "13px" : rowStyle.isHeader ? "11px" : "11.5px",
                      textTransform: rowStyle.isHeader ? "uppercase" : "none",
                      letterSpacing: rowStyle.isHeader ? "0.5px" : "normal",
                      paddingLeft: !rowStyle.isHeader && !rowStyle.isMajor ? "16px" : "8px",
                      position: "sticky",
                      left: 0,
                      background: rowStyle.bg,
                      zIndex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
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

                    // Cells that are empty or have "—" are displayed as empty string
                    const displayVal = val === "—" ? "" : val || "";

                    return (
                      <td
                        key={mIdx}
                        onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
                        style={{
                          padding: "4px 4px",
                          textAlign: "right",
                          color: rowStyle.isMajor ? "#ffffff" : "#334155",
                          fontSize: "11px",
                          background: mBadge ? mBadge.bg : "transparent",
                          cursor: isClickable ? "pointer" : "default",
                          textDecoration: isClickable ? "underline dashed #94a3b8 1px" : "none",
                          textUnderlineOffset: isClickable ? "2px" : "initial",
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                        }}
                        onMouseLeave={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "none";
                        }}
                      >
                        {displayVal}
                      </td>
                    );
                  })}

                  {/* FY Total Column */}
                  {(() => {
                    const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                    const isClickable = Boolean(ddType && totalVal && totalVal !== "£0" && totalVal !== "—" && totalVal !== "");
                    const displayTotal = totalVal === "—" ? "" : totalVal || "";

                    return (
                      <td
                        onClick={(e) => isClickable && handleCellClick(e, label, totalVal, -1, `${activeYear.fyLabel} Total`)}
                        style={{
                          padding: "4px 8px",
                          textAlign: "right",
                          color: rowStyle.isMajor ? "#ffffff" : "#0047AB",
                          fontSize: rowStyle.isMajor ? "13px" : "11.5px",
                          fontWeight: rowStyle.isMajor ? 800 : 700,
                          background: totalBadge ? totalBadge.bg : (rowStyle.isMajor ? "transparent" : "rgba(0, 71, 171, 0.04)"),
                          cursor: isClickable ? "pointer" : "default",
                          textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                          textUnderlineOffset: isClickable ? "2px" : "initial",
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                        }}
                        onMouseLeave={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "none";
                        }}
                      >
                        {displayTotal}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Financial Year Summary 4 KPI Boxes (MOVED TO UNDERNEATH THE TABLE) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1rem",
          marginTop: "3rem",
        }}
      >
        <div style={kpiCardStyle}>
          <span style={kpiLabelStyle}>FY Revenue</span>
          <div style={kpiValueStyle}>{totalRevRow?.totalVal || "£0"}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>Full Year Target / Total</span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>Gross Profit</span>
            {gpMarginRow?.totalVal && (
              <span style={{ ...badgeStyle, background: "#dcfce7", color: "#166534" }}>
                {gpMarginRow.totalVal}
              </span>
            )}
          </div>
          <div style={{ ...kpiValueStyle, color: "#166534" }}>{grossProfitRow?.totalVal || "£0"}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>After Delivery Costs</span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>Total Overheads</span>
            {overheadsPctRow?.totalVal && (
              <span style={{ ...badgeStyle, background: "#fef3c7", color: "#b45309" }}>
                {overheadsPctRow.totalVal}
              </span>
            )}
          </div>
          <div style={{ ...kpiValueStyle, color: "#b45309" }}>{overheadsRow?.totalVal || "£0"}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>Non-Delivery & Operations</span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>Operating Profit</span>
            {opMarginRow?.totalVal && (
              <span style={{ ...badgeStyle, background: "#f0fdf4", color: "#166534" }}>
                {opMarginRow.totalVal}
              </span>
            )}
          </div>
          <div style={{ ...kpiValueStyle, color: "#0047AB" }}>{opProfitRow?.totalVal || "£0"}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>Net Trading Result</span>
        </div>
      </div>
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
