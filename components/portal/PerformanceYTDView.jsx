import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData } from "../../services/deepDiveHelper";

export default function PerformanceYTDView({
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
  const activeYearIdx = selectedYearIdx !== null ? selectedYearIdx : (data?.currentYearIdx !== undefined ? data.currentYearIdx : (years.length > 1 ? 1 : 0));
  const activeYear = years[activeYearIdx];

  // Determine previous calendar month cutoff
  const defaultMonthCutoff = useMemo(() => {
    if (!activeYear || !activeYear.headerMonths) return 6;
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let prevCalMonthIdx = -1;
    for (let i = 0; i < activeYear.headerMonths.length; i++) {
      const match = String(activeYear.headerMonths[i]).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
      if (match) {
        const monthsMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const m = monthsMap[match[1].toLowerCase()];
        let yr = parseInt(match[2], 10);
        if (yr < 100) yr += 2000;
        const d = new Date(yr, m, 1);
        if (d.getTime() < currMonthStart) {
          prevCalMonthIdx = i;
        }
      }
    }
    if (prevCalMonthIdx !== -1) {
      return prevCalMonthIdx + 1; // 1-based count of months up to and including prev calendar month
    }
    return 1;
  }, [activeYear]);

  const [userEndMonthIdx, setUserEndMonthIdx] = useState(null);
  const endMonthIdx = userEndMonthIdx !== null ? userEndMonthIdx : defaultMonthCutoff;

  // Parse numerical money string (e.g. "£45,270" -> 45270)
  const parseNum = (val) => {
    if (typeof val === "number") return val;
    if (!val) return 0;
    const clean = String(val).replace(/[£,]/g, "").trim();
    if (clean.includes("%")) return parseFloat(clean) / 100;
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString()}`;
  };

  const formatPct = (val) => {
    if (!val || isNaN(val) || Math.abs(val) > 10) return "0%";
    return `${Math.round(val * 100)}%`;
  };

  // Margin threshold badge styling
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
      return { bg: "#efefef", color: "#0047AB", bold: true, isHeader: true };
    }
    return { bg: "#efefef", color: "#0047AB", bold: false, isMajor: false };
  };

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
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
          Loading {clientName} YTD performance...
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
          Unable to Load YTD Performance
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
        <p style={{ color: "#64748b" }}>No YTD data available.</p>
      </div>
    );
  }

  // Active month range: index 0 to endMonthIdx - 1
  const displayedMonths = activeYear.headerMonths ? activeYear.headerMonths.slice(0, endMonthIdx) : [];
  const cutoffLabel = displayedMonths[displayedMonths.length - 1] || "Current";

  // Calculate YTD row totals
  const ytdRows = (activeYear.rows || []).map((row) => {
    const label = row.label;
    const isPct = label.includes("%") || label.toLowerCase().includes("ratio");
    const monthVals = (row.monthlyValues || []).slice(0, endMonthIdx);

    let ytdTotalVal = 0;
    if (!isPct) {
      ytdTotalVal = monthVals.reduce((acc, v) => acc + parseNum(v), 0);
    }

    return {
      ...row,
      monthVals,
      ytdTotalVal,
      isPct,
    };
  });

  // Precise row finder matching exact label or prefix
  const findYtdRow = (pArr) =>
    ytdRows.find((r) => {
      const l = String(r.label || "").toLowerCase().trim();
      return pArr.some((p) => {
        const target = p.toLowerCase().trim();
        return l === target || l.startsWith(target);
      });
    });

  const ytdRevRow = findYtdRow(["total income", "total revenue", "total turnover", "revenue", "income"]);
  const ytdGpRow = findYtdRow(["gross profit"]);
  const ytdOverheadsRow = findYtdRow(["total overheads", "overheads"]);
  const ytdOpRow = findYtdRow(["operating profit"]);
  const ytdStaffDelRow = findYtdRow(["staff costs - delivery", "delivery staff"]);
  const ytdStaffNonDelRow = findYtdRow(["staff costs - non-delivery", "overhead staff"]);

  const ytdRevTotal = (ytdRevRow && ytdRevRow.ytdTotalVal > 0) ? ytdRevRow.ytdTotalVal : 0;
  const ytdGpTotal = ytdGpRow?.ytdTotalVal || 0;
  const ytdOverheadsTotal = ytdOverheadsRow?.ytdTotalVal || 0;
  const ytdOpTotal = ytdOpRow?.ytdTotalVal || 0;
  const ytdStaffTotal = (ytdStaffDelRow?.ytdTotalVal || 0) + (ytdStaffNonDelRow?.ytdTotalVal || 0);

  const ytdGpMarginPct = ytdRevTotal > 0 ? ytdGpTotal / ytdRevTotal : 0;
  const ytdOverheadsPct = ytdRevTotal > 0 ? ytdOverheadsTotal / ytdRevTotal : 0;
  const ytdOpMarginPct = ytdRevTotal > 0 ? ytdOpTotal / ytdRevTotal : 0;
  const ytdStaffRatioPct = ytdRevTotal > 0 ? ytdStaffTotal / ytdRevTotal : 0;

  const fyRevTarget = parseNum(ytdRevRow?.totalVal) || (ytdRevTotal > 0 ? ytdRevTotal : 1);
  const fyProgressPct = Math.min(100, Math.round((ytdRevTotal / fyRevTarget) * 100));

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

  // Fixed column widths fitting 100% desktop width
  const totalMonths = Math.max(1, displayedMonths.length);
  const monthColPct = (58 / totalMonths).toFixed(2);

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

      {/* Action Bar (Top header with Year Navigator, Cutoff Month Dropdown & Refresh) */}
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
            YTD performance
          </h2>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "10px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            Month 1 to {cutoffLabel}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {/* Year selector */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Year:</span>
            <select
              value={activeYearIdx}
              onChange={(e) => setSelectedYearIdx(parseInt(e.target.value, 10))}
              style={selectStyle}
            >
              {years.map((y, idx) => (
                <option key={y.id} value={idx}>
                  {y.fyLabel || y.displayTitle} {idx === data?.currentYearIdx ? "(Current)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Month Cutoff selector */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Through to:</span>
            <select
              value={endMonthIdx}
              onChange={(e) => setUserEndMonthIdx(parseInt(e.target.value, 10))}
              style={selectStyle}
            >
              {(activeYear.headerMonths || []).map((m, idx) => (
                <option key={idx} value={idx + 1}>
                  {m} (M{idx + 1})
                </option>
              ))}
            </select>
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

      {/* YTD Cumulative Table (Fitting desktop width) */}
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
            width: "max-content",
            borderCollapse: "separate",
            borderSpacing: 0,
            fontSize: "12px",
            fontFamily: "'Kumbh Sans', sans-serif",
          }}
        >
          <thead>
            {/* Header Row: Line item, displayed months, YTD Total */}
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
                  width: "220px",
                  minWidth: "220px",
                }}
              >
                {/* Empty header, NO Line item label */}
              </th>
              {displayedMonths.map((m, idx) => (
                <th
                  key={idx}
                  style={{
                    padding: "6px 4px",
                    textAlign: "right",
                    fontWeight: 700,
                    fontSize: "11.5px",
                    width: "87px",
                    minWidth: "87px",
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
                  width: "110px",
                  minWidth: "110px",
                }}
              >
                YTD Total
              </th>
            </tr>

            {/* Status row: Actual / Forecast markers */}
            <tr style={{ background: "#efefef", borderBottom: "1px solid #ffffff", fontSize: "10.5px" }}>
              <td
                style={{
                  padding: "3px 8px",
                  position: "sticky",
                  left: 0,
                  background: "#efefef",
                  zIndex: 2,
                }}
              >
                {/* Empty cell, NO Status label */}
              </td>
              {displayedMonths.map((_, idx) => {
                const st = (activeYear.statusValues || activeYear.monthStatuses || [])[idx] || "";
                const raw = String(st).trim();
                const text = raw.toLowerCase() === "actual" ? "Actual" : raw.toLowerCase() === "forecast" ? "Forecast" : raw;
                return (
                  <td key={idx} style={{ padding: "3px 4px", textAlign: "right", color: "#666666", fontStyle: "italic", background: "#efefef" }}>
                    {text}
                  </td>
                );
              })}
              <td style={{ padding: "3px 8px", textAlign: "right", background: "#efefef" }}></td>
            </tr>
          </thead>

          <tbody>
            {ytdRows.map((row, rIdx) => {
              if (rIdx < 2) return null;

              const label = String(row.label || "").trim();
              if (label.toLowerCase() === "hide" || (!label && !row.totalVal)) {
                return (
                  <tr key={rIdx} style={{ height: "6px", background: "#efefef" }}>
                    <td colSpan={displayedMonths.length + 2} style={{ padding: 0, background: "#efefef" }} />
                  </tr>
                );
              }

              const rowStyle = getRowStyle(label);
              const isPercentageRow = row.isPct || label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");

              // YTD Total formatted string
              let ytdDisplay = "";
              if (row.isPct) {
                if (label.toLowerCase().includes("gross profit margin")) ytdDisplay = formatPct(ytdGpMarginPct);
                else if (label.toLowerCase().includes("overheads as %")) ytdDisplay = formatPct(ytdOverheadsPct);
                else if (label.toLowerCase().includes("operating profit %")) ytdDisplay = formatPct(ytdOpMarginPct);
                else ytdDisplay = row.monthVals[row.monthVals.length - 1] || "";
              } else {
                ytdDisplay = formatMoney(row.ytdTotalVal);
              }

              return (
                <tr
                  key={rIdx}
                  style={{
                    borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #ffffff",
                    background: rowStyle.bg,
                    fontWeight: rowStyle.bold ? 700 : 400,
                  }}
                >
                  <td
                    style={{
                      padding: "4px 8px",
                      color: rowStyle.color,
                      fontSize: rowStyle.isMajor ? "13px" : rowStyle.isHeader ? "11px" : "11.5px",
                      textTransform: rowStyle.isHeader ? "uppercase" : "none",
                      letterSpacing: rowStyle.isHeader ? "0.5px" : "normal",
                      paddingLeft: !rowStyle.isHeader && !rowStyle.isMajor ? "16px" : "8px",
                      fontStyle: isPercentageRow ? "italic" : "normal",
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

                  {/* Monthly Value Columns */}
                  {row.monthVals.map((val, mIdx) => {
                    const mBadge = isPercentageRow ? getMarginBadgeStyle(label, val) : null;
                    const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                    const isClickable = Boolean(ddType && val && val !== "£0" && val !== "—" && val !== "");
                    const monthLabel = activeYear.headerMonths?.[mIdx] || `Month ${mIdx + 1}`;
                    const displayVal = val === "—" ? "" : val || "";

                    return (
                      <td
                        key={mIdx}
                        onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
                        style={{
                          padding: "4px 4px",
                          textAlign: "right",
                          color: rowStyle.isMajor ? "#ffffff" : mBadge ? mBadge.color : rowStyle.color,
                          fontStyle: isPercentageRow ? "italic" : "normal",
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

                  {/* YTD Total Column */}
                  {(() => {
                    const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                    const isClickable = Boolean(ddType && ytdDisplay && ytdDisplay !== "£0" && ytdDisplay !== "—" && ytdDisplay !== "");
                    const ytdBadge = isPercentageRow ? getMarginBadgeStyle(label, ytdDisplay) : null;

                    return (
                      <td
                        onClick={(e) => isClickable && handleCellClick(e, label, ytdDisplay, -1, `YTD Through ${cutoffLabel}`)}
                        style={{
                          padding: "4px 8px",
                          textAlign: "right",
                          color: rowStyle.isMajor ? "#ffffff" : ytdBadge ? ytdBadge.color : "#0047AB",
                          fontStyle: isPercentageRow ? "italic" : "normal",
                          fontSize: rowStyle.isMajor ? "13px" : "11.5px",
                          fontWeight: rowStyle.isMajor ? 800 : 700,
                          background: ytdBadge ? ytdBadge.bg : (rowStyle.isMajor ? "transparent" : rowStyle.bg),
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
                        {ytdDisplay}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* YTD Key Summary Cards (Positioned UNDERNEATH the table) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1rem",
          marginTop: "3rem",
        }}
      >
        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>YTD Revenue</span>
            <span style={{ ...badgeStyle, background: "#e0f2fe", color: "#0369a1" }}>
              {fyProgressPct}% of FY
            </span>
          </div>
          <div style={kpiValueStyle}>{formatMoney(ytdRevTotal)}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            FY Target: {ytdRevRow?.totalVal || "£0"}
          </span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>YTD Gross Profit</span>
            <span style={{ ...badgeStyle, background: "#dcfce7", color: "#166534" }}>
              {formatPct(ytdGpMarginPct)}
            </span>
          </div>
          <div style={{ ...kpiValueStyle, color: "#166534" }}>{formatMoney(ytdGpTotal)}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            FY Target: {ytdGpRow?.totalVal || "£0"}
          </span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>YTD Overheads</span>
            <span style={{ ...badgeStyle, background: "#fef3c7", color: "#b45309" }}>
              {formatPct(ytdOverheadsPct)}
            </span>
          </div>
          <div style={{ ...kpiValueStyle, color: "#b45309" }}>{formatMoney(ytdOverheadsTotal)}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            FY Budget: {ytdOverheadsRow?.totalVal || "£0"}
          </span>
        </div>

        <div style={kpiCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={kpiLabelStyle}>YTD Operating Profit</span>
            <span style={{ ...badgeStyle, background: "#f0fdf4", color: "#166534" }}>
              {formatPct(ytdOpMarginPct)}
            </span>
          </div>
          <div style={{ ...kpiValueStyle, color: "#0047AB" }}>{formatMoney(ytdOpTotal)}</div>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            FY Target: {ytdOpRow?.totalVal || "£0"}
          </span>
        </div>
      </div>
    </div>
  );
}

const selectStyle = {
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  padding: "4px 8px",
  fontSize: "12px",
  fontWeight: 600,
  color: "#0f172a",
  background: "#ffffff",
  cursor: "pointer",
};

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
