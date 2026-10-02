import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData } from "../../services/deepDiveHelper";

export default function MonthView({
  clientName,
  payload,
  keyData,
  isLoading,
  onRefresh,
  error
}) {
  const [activePopover, setActivePopover] = useState(null);
  const [activePeriod, setActivePeriod] = useState("curr"); // 'curr' | 'prev' | 'next'

  if (!payload) {
    if (error) {
      return (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            padding: "3rem 2rem",
            border: "1px solid #fee2e2",
            maxWidth: "600px",
            margin: "2rem auto",
            textAlign: "center"
          }}
        >
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>⚠️</div>
          <h3 style={{ margin: "0 0 8px 0", color: "#991b1b", fontSize: "1.2rem", fontWeight: 700 }}>
            Unable to Load Client Data
          </h3>
          <p style={{ margin: "0 0 1.25rem 0", color: "#64748b", fontSize: "14px" }}>
            {error}
          </p>
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
              cursor: "pointer"
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return (
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          padding: "5rem 2rem",
          maxWidth: "600px",
          margin: "2rem auto",
          textAlign: "center"
        }}
      >
        <Spinner size={32} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#0047AB", fontWeight: 500, fontSize: "15px" }}>
          Please wait - data loading
        </p>
      </div>
    );
  }

  const activeMonthData = payload?.months?.[activePeriod] || (activePeriod === "curr" ? payload?.currMonth : null) || payload?.currMonth;
  const currMonth = activeMonthData;
  const chartData = payload?.chartData;
  const thresholds = activeMonthData?.thresholds || payload?.currMonth?.thresholds || [0.5, 0.45, 0, 0, 0, 0.309, 0.2, 0, 0, 0, 0.15, 0.05];
  const headerSummaryText = activeMonthData?.headerText || "";

  const monthPeriod = activeMonthData?.monthPeriod || "Current Month";

  const getMonthIndexFromPeriod = (periodStr) => {
    if (!periodStr) return 0;
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const lower = periodStr.toLowerCase();
    for (let i = 0; i < months.length; i++) {
      if (lower.includes(months[i])) return i;
    }
    return 0;
  };

  const handleCellClick = (e, rowLabel, val) => {
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "£0" || val === "—") return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mIdx = getMonthIndexFromPeriod(monthPeriod);
    const ddData = buildDeepDiveData({
      ddType,
      periodLabel: monthPeriod,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: 1,
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

  // Helper for CSV export matching original
  const handleExportCsv = () => {
    if (!currMonth?.tableRows) return;
    const cleanRows = currMonth.tableRows
      .filter((r) => r.label && r.label.toLowerCase() !== "hide")
      .map((r) => [r.label, r.value]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      ["Line Item,Amount (" + monthPeriod + ")", ...cleanRows.map((e) => `"${e[0]}","${e[1]}"`)].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Pulse_${monthPeriod.replace(/\s+/g, "_")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Calculate threshold background color for percentage cells
  const getThresholdBg = (rowIndex, valueStr) => {
    if (!valueStr || !valueStr.includes("%")) return null;
    const num = parseFloat(valueStr.replace(/[%£,]/g, "")) / 100;
    if (isNaN(num)) return null;

    const parseT = (idx, def) => {
      const v = thresholds?.[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    if (rowIndex === 19) {
      // Gross profit margin %
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (num < z43) return "#f4cccc";
      if (num <= z42) return "#fce5cd";
      return "#d9ead3";
    }

    if (rowIndex === 27) {
      // Overheads as %
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.20);
      if (num > z47) return "#f4cccc";
      if (num >= z48) return "#d9ead3";
      return "#fce5cd";
    }

    if (rowIndex === 31) {
      // Operating profit %
      const z52 = parseT(10, 0.145);
      const z53 = parseT(11, 0.05);
      if (num < z53) return "#f4cccc";
      if (num <= z52) return "#fce5cd";
      return "#d9ead3";
    }

    if (rowIndex === 33) {
      // Staff ratio
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (num < z59) return "#fce5cd";
      if (num <= z58) return "#d9ead3";
      if (num <= z57) return "#fce5cd";
      return "#f4cccc";
    }

    return null;
  };

  return (
    <div
      style={{
        width: "100%",
        margin: "0 auto",
        padding: "0.5rem 0 3rem 0",
        display: "flex",
        flexDirection: "column",
        gap: "1rem"
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
        onClose={() => setActivePopover(null)}
      />

      {/* Action Bar (Standardized Top Right Controls as per original app) */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "0 4px"
        }}
      >
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh data"
          style={{
            background: "transparent",
            border: "none",
            cursor: isLoading ? "wait" : "pointer",
            padding: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#0047AB",
            borderRadius: "50%",
            transition: "all 0.2s ease"
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "rgba(0, 71, 171, 0.1)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
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
              animation: isLoading ? "spin 1s linear infinite" : "none"
            }}
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>

        <button
          type="button"
          onClick={handleExportCsv}
          title="Download CSV"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#0047AB",
            borderRadius: "50%",
            transition: "all 0.2s ease"
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "rgba(0, 71, 171, 0.1)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
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
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {/* Centered Executive Summary Section */}
      {headerSummaryText && (
        <div
          style={{
            maxWidth: "600px",
            margin: "0.25rem auto 1.5rem auto",
            textAlign: "center",
            color: "#0047AB",
            fontSize: "1.05rem",
            fontWeight: 500,
            lineHeight: 1.45,
            padding: "0 1rem",
            whiteSpace: "pre-wrap",
          }}
          dangerouslySetInnerHTML={{
            __html: headerSummaryText
              .replace(/([£$€¥]\d[\d,.]*)/g, "<strong style='font-weight: 700;'>$1</strong>")
              .replace(/\n/g, "<br>")
          }}
        />
      )}

      {/* Main Blueprint Table with Navigation Arrows either side */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          position: "relative",
          margin: "0 auto",
          width: "100%",
        }}
      >
        <div style={{ position: "relative", display: "inline-block" }}>
          {/* Left Arrow (Visible for curr and next) */}
          {(activePeriod === "curr" || activePeriod === "next") && (
            <button
              type="button"
              onClick={() => setActivePeriod((p) => (p === "curr" ? "prev" : "curr"))}
              style={{
                position: "absolute",
                left: "-55px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: "#a2c4c9",
                fontSize: "3.5rem",
                lineHeight: 1,
                cursor: "pointer",
                padding: "8px",
                zIndex: 10,
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#0047AB"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#a2c4c9"; }}
              title="Previous Month"
            >
              ‹
            </button>
          )}

          <table
            style={{
              width: "410px",
              borderCollapse: "separate",
              borderSpacing: 0,
              background: "#efefef",
              borderRadius: "8px",
              overflow: "hidden",
              border: "1px solid #e5e7eb",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              fontFamily: "'Kumbh Sans', sans-serif"
            }}
          >
            <colgroup>
              <col style={{ width: "290px" }} />
              <col style={{ width: "120px" }} />
            </colgroup>
            <tbody>
              {(currMonth?.tableRows || currMonth?.rows || []).map((row, i) => {
                const label = String(row.label || "").trim();
                const value = String(row.value || "").trim();
                const isHide = label.toLowerCase() === "hide";

                // Exact row styling based on WebApp.html blueprint engine
                const spacers = [6, 7, 9, 14, 16, 18, 20, 24, 26, 28, 30, 32];
                const isSpacer = spacers.includes(i) || (!label && !value);

                let bgColor = "#efefef";
                let textColor = "#000000";
                let isBold = false;
                let isItalic = false;
                let fontSize = 12;
                let rowHeight = 22;

                if (isSpacer) {
                  bgColor = "#efefef";
                  textColor = "#efefef";
                  rowHeight = 6;
                  fontSize = 2;
                } else if (i === 0) {
                  // Header (e.g. Revenue & Current Month)
                  bgColor = "#0000ff";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 31;
                } else if (i === 1) {
                  isItalic = true;
                  fontSize = 11;
                  textColor = "#666666";
                } else if (i === 2) {
                  isBold = true;
                  fontSize = 13;
                } else if (i === 8) {
                  // Total Income / Revenue
                  bgColor = "#9900ff";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 31;
                } else if (i === 10) {
                  isBold = true;
                  fontSize = 13;
                } else if (i === 15) {
                  isBold = true;
                  fontSize = 12;
                } else if (i === 17) {
                  // Gross Profit
                  bgColor = "#e69138";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 13;
                  rowHeight = 31;
                } else if (i === 19) {
                  isItalic = true;
                  fontSize = 11;
                } else if (i === 21) {
                  isBold = true;
                  fontSize = 13;
                } else if (i === 25) {
                  // Total Overheads
                  bgColor = "#45818e";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 13;
                  rowHeight = 31;
                } else if (i === 27) {
                  isItalic = true;
                  fontSize = 11;
                } else if (i === 29) {
                  // Operating Profit
                  bgColor = "#1155cc";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 15;
                  rowHeight = 31;
                } else if (i === 31 || i === 33) {
                  isItalic = true;
                  fontSize = 11;
                }

                // Dynamic KPI threshold background for the value column
                const threshBg = getThresholdBg(i, value);
                const cellBg = threshBg || bgColor;

                // Deep dive clickability
                const ddType = !isSpacer && !isHide ? getDeepDiveType(label) : null;
                const isClickable = Boolean(ddType && value && value !== "£0" && value !== "—" && value !== "");

                let displayVal = value;
                if (i === 1 && typeof value === "string") {
                  if (value.toUpperCase() === "ACTUAL") displayVal = "Actual";
                  else if (value.toUpperCase() === "FORECAST") displayVal = "Forecast";
                }

                if (isSpacer) {
                  return (
                    <tr key={i} style={{ height: `${rowHeight}px`, background: "#efefef" }}>
                      <td colSpan={2} style={{ padding: 0, border: "none", background: "#efefef" }} />
                    </tr>
                  );
                }

                if (isHide) {
                  return null;
                }

                return (
                  <tr
                    key={i}
                    style={{
                      height: `${rowHeight}px`,
                      background: bgColor,
                      borderBottom: "1px solid #ffffff"
                    }}
                  >
                    {/* Column A: Line Item */}
                    <td
                      style={{
                        padding: "4px 16px",
                        textAlign: "left",
                        color: textColor,
                        fontWeight: isBold ? 700 : 400,
                        fontStyle: isItalic ? "italic" : "normal",
                        fontSize: `${fontSize}px`,
                      }}
                    >
                      {label}
                    </td>

                    {/* Column B: Amount */}
                    <td
                      onClick={(e) => isClickable && handleCellClick(e, label, value)}
                      style={{
                        padding: "4px 16px",
                        textAlign: "right",
                        background: cellBg,
                        color: threshBg ? "#000000" : textColor,
                        fontWeight: isBold ? 700 : 400,
                        fontStyle: isItalic ? "italic" : "normal",
                        fontSize: `${fontSize}px`,
                        cursor: isClickable ? "pointer" : "default",
                        textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                        textUnderlineOffset: isClickable ? "3px" : "initial",
                        transition: "background-color 0.15s ease",
                        width: "120px",
                      }}
                      onMouseEnter={(e) => {
                        if (isClickable) e.currentTarget.style.filter = "brightness(0.95)";
                      }}
                      onMouseLeave={(e) => {
                        if (isClickable) e.currentTarget.style.filter = "none";
                      }}
                    >
                      {displayVal || ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Right Arrow (Visible for curr and prev) */}
          {(activePeriod === "curr" || activePeriod === "prev") && (
            <button
              type="button"
              onClick={() => setActivePeriod((p) => (p === "curr" ? "next" : "curr"))}
              style={{
                position: "absolute",
                right: "-55px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: "#a2c4c9",
                fontSize: "3.5rem",
                lineHeight: 1,
                cursor: "pointer",
                padding: "8px",
                zIndex: 10,
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#0047AB"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#a2c4c9"; }}
              title="Next Month"
            >
              ›
            </button>
          )}
        </div>
      </div>

      {/* 12-Month Performance Trend Line Chart (matching original app size & title) */}
      {activePeriod === "curr" && chartData?.showChart && chartData?.months?.length > 0 && (
        <div
          style={{
            maxWidth: "410px",
            margin: "1.5rem auto 0 auto",
            width: "100%",
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            padding: "1rem",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)"
          }}
        >
          <div style={{ marginBottom: "0.75rem", textAlign: "center" }}>
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "#0047AB", fontFamily: "'Kumbh Sans', sans-serif" }}>
              Last 12 months
            </h3>
          </div>

          {/* Responsive SVG Line Chart */}
          <HomeLineChart
            months={chartData.months}
            revenue={chartData.revenue || []}
            grossProfit={chartData.grossProfit || []}
            operatingProfit={chartData.operatingProfit || []}
          />
        </div>
      )}
    </div>
  );
}

// Clean, smooth SVG Line Chart mirroring Chart.js
function HomeLineChart({ months = [], revenue = [], grossProfit = [], operatingProfit = [] }) {
  const width = 410;
  const height = 205;
  const padding = { top: 15, right: 15, bottom: 25, left: 62 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const allVals = [...revenue, ...grossProfit, ...operatingProfit].filter((v) => typeof v === "number" && !isNaN(v));
  const rawMax = Math.max(...allVals, 10000);
  const rawMin = Math.min(...allVals, 0);

  // Calculate sensible, whole-number interval (e.g. £10,000, £20,000, £50,000)
  const targetTicks = 4;
  const span = Math.max(rawMax - (rawMin < 0 ? rawMin : 0), 10000);
  const roughStep = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceFactor = 1;
  if (residual > 7) niceFactor = 10;
  else if (residual > 3) niceFactor = 5;
  else if (residual > 1.5) niceFactor = 2;
  else niceFactor = 1;
  const step = Math.max(niceFactor * magnitude, 1000);

  const minTick = rawMin < 0 ? Math.floor(rawMin / step) * step : 0;
  const maxTick = Math.max(Math.ceil(rawMax / step) * step, minTick + step * targetTicks);

  const yTicks = [];
  for (let val = minTick; val <= maxTick; val += step) {
    yTicks.push(val);
  }

  const chartMin = minTick;
  const chartMax = maxTick;
  const range = chartMax - chartMin || 1;

  const getX = (idx) => padding.left + (idx / Math.max(months.length - 1, 1)) * chartW;
  const getY = (val) => padding.top + chartH - ((val - chartMin) / range) * chartH;

  // Build SVG path strings with smooth curves (bezier)
  const buildSmoothPath = (data) => {
    if (!data || data.length === 0) return "";
    let d = `M ${getX(0)} ${getY(data[0])}`;
    for (let i = 0; i < data.length - 1; i++) {
      const x0 = getX(i);
      const y0 = getY(data[i]);
      const x1 = getX(i + 1);
      const y1 = getY(data[i + 1]);
      const mx = (x0 + x1) / 2;
      d += ` C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`;
    }
    return d;
  };

  const revPath = buildSmoothPath(revenue);
  const gpPath = buildSmoothPath(grossProfit);
  const opPath = buildSmoothPath(operatingProfit);

  const formatShortMoney = (n) => {
    if (n === 0) return "£0";
    const abs = Math.abs(n);
    const formatted = "£" + Math.round(abs).toLocaleString("en-GB");
    return n < 0 ? `-${formatted}` : formatted;
  };

  return (
    <div style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {/* Y Grid lines */}
        {yTicks.map((tick, i) => {
          const y = getY(tick);
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="#f1f5f9"
                strokeWidth="1"
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="#64748b"
                fontFamily="'Kumbh Sans', sans-serif"
              >
                {formatShortMoney(tick)}
              </text>
            </g>
          );
        })}

        {/* X Ticks (Month labels) */}
        {months.map((m, i) => {
          const x = getX(i);
          const shortMonth = String(m).split(" ")[0]; // e.g. "Oct"
          return (
            <text
              key={i}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize="9"
              fill="#64748b"
              fontFamily="'Kumbh Sans', sans-serif"
            >
              {shortMonth}
            </text>
          );
        })}

        {/* Revenue line */}
        <path
          d={revPath}
          fill="none"
          stroke="#9900ff"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Gross Profit line */}
        <path
          d={gpPath}
          fill="none"
          stroke="#e69138"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Operating Profit line */}
        <path
          d={opPath}
          fill="none"
          stroke="#1155cc"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Dots on points */}
        {revenue.map((val, i) => (
          <circle key={`r-${i}`} cx={getX(i)} cy={getY(val)} r="2" fill="#9900ff" />
        ))}
        {grossProfit.map((val, i) => (
          <circle key={`gp-${i}`} cx={getX(i)} cy={getY(val)} r="2" fill="#e69138" />
        ))}
        {operatingProfit.map((val, i) => (
          <circle key={`op-${i}`} cx={getX(i)} cy={getY(val)} r="2" fill="#1155cc" />
        ))}
      </svg>

      {/* Chart Legend */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "16px",
          marginTop: "6px",
          fontSize: "9.5px",
          fontFamily: "'Kumbh Sans', sans-serif"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#9900ff", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>Revenue</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#e69138", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>Gross Profit</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#1155cc", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>Operating Profit</span>
        </div>
      </div>
    </div>
  );
}
