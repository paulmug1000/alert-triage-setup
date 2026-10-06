import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData, DeepDiveEngine, formatMoney, formatCurrencyString } from "../../services/deepDiveHelper";

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function MonthView({
  clientName,
  payload,
  keyData,
  performanceData,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  onRefresh,
  error,
  isSenior = false,
}) {
  const currencySymbol = propCurrencySymbol || payload?.clientInfo?.currencySymbol || payload?.currencySymbol || "£";
  const thousandsSeparator = propThousandsSeparator || payload?.clientInfo?.thousandsSeparator || payload?.thousandsSeparator || ",";
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
          Please wait - loading
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
    const l = String(rowLabel || "").toLowerCase();
    if (l.includes("total overheads") || l.includes("overheads as %") || l.includes("overheads %")) return;
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "£0" || val === `${currencySymbol}0` || val === "0" || val === "—") return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mIdx = getMonthIndexFromPeriod(monthPeriod);
    const parsedTargetDate = DeepDiveEngine.parseHeaderDate(monthPeriod);
    const isIncomeMode =
      String(keyData?.outgoingsMeta?.mode || "").toLowerCase() === "income" ||
      Boolean(currMonth?.tableRows?.some((r) => r.label && String(r.label).toLowerCase().includes("confirmed income")));

    const ddData = buildDeepDiveData({
      ddType,
      periodLabel: monthPeriod,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: 1,
      targetDate: parsedTargetDate,
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

  // Helper for CSV export matching original
  const handleExportCsv = () => {
    if (!currMonth?.tableRows) return;
    const cleanRows = currMonth.tableRows
      .filter((r) => r.label && r.label.toLowerCase() !== "hide")
      .map((r) => [r.label, formatCurrencyString(r.value, null, currencySymbol, thousandsSeparator)]);
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
  // Calculate threshold background color for percentage cells
  const getThresholdBg = (rowIndex, labelStr, valueStr) => {
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

    const l = String(labelStr || "").toLowerCase().trim();

    if (rowIndex === 19 || l.includes("gross profit margin")) {
      // Gross profit margin %
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (num < z43) return "#f4cccc";
      if (num <= z42) return "#fce5cd";
      return "#d9ead3";
    }

    if (rowIndex === 27 || l.includes("overheads as %") || l.includes("overheads %")) {
      // Overheads as %
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.20);
      if (num > z47) return "#f4cccc";
      if (num >= z48) return "#d9ead3";
      return "#fce5cd";
    }

    if (rowIndex === 31 || l.includes("operating profit %")) {
      // Operating profit %
      const z52 = parseT(10, 0.145);
      const z53 = parseT(11, 0.05);
      if (num < z53) return "#f4cccc";
      if (num <= z52) return "#fce5cd";
      return "#d9ead3";
    }

    if (rowIndex === 33 || l.includes("staff costs to") || l.includes("staff ratio")) {
      // Staff ratio / Staff costs to revenue/income %
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

  const isRevMode =
    String(keyData?.outgoingsMeta?.mode || "").toLowerCase() !== "income" &&
    !currMonth?.tableRows?.some((r) => r.label && String(r.label).toLowerCase().includes("confirmed income"));
  const primaryLabel = isRevMode ? "Revenue" : "Income";

  // Build timeline and compute At A Glance metrics + sparklines
  const glanceMetrics = computeGlanceMetrics({
    performanceData,
    chartData,
    activeMonthData,
    monthPeriod,
    currencySymbol,
    thousandsSeparator,
  });

  const glanceMonthHeading = (() => {
    if (!monthPeriod) return "AT A GLANCE";
    const d = DeepDiveEngine.parseHeaderDate(monthPeriod);
    if (d && !isNaN(d.getTime())) {
      const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const yy = String(d.getFullYear()).slice(-2);
      return `AT A GLANCE: ${months[d.getMonth()]} ${yy}`;
    }
    return `AT A GLANCE: ${String(monthPeriod).toUpperCase().trim()}`;
  })();

  return (
    <div
      className="home-view-container"
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
        sections={activePopover?.sections}
        currencySymbol={currencySymbol}
        thousandsSeparator={thousandsSeparator}
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

      {/* 2-Column Responsive Workspace Grid */}
      <div className="home-workspace-grid">
        {/* Left Column: Executive Summary + Monthly Blueprint Table */}
        <div className="home-col-left">
          {/* Executive Summary Box (Ice-blue tint) */}
          {headerSummaryText && (
            <div
              className="home-executive-summary-box"
              style={{
                width: "410px",
                maxWidth: "410px",
                boxSizing: "border-box",
                background: "#f0f5fc",
                border: "1px solid #d0e1f9",
                borderLeft: "4px solid #0047AB",
                borderRadius: "8px",
                padding: "18px 22px",
                boxShadow: "0 1px 4px rgba(0, 71, 171, 0.06)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                className="home-exec-title"
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  letterSpacing: "0.8px",
                  color: "#0047AB",
                  textTransform: "uppercase",
                  fontFamily: "'Kumbh Sans', sans-serif",
                  marginBottom: "4px",
                }}
              >
                Executive Summary
              </div>
              <div
                className="home-exec-body"
                style={{
                  color: "#0f294a",
                  fontSize: "19.25px",
                  fontWeight: 500,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  fontFamily: "'Kumbh Sans', sans-serif",
                }}
                dangerouslySetInnerHTML={{
                  __html: escapeHtml(headerSummaryText)
                    .replace(/([£$€¥]\s*\d[\d,]*(?:\.\d+)?)/g, "<strong style='font-weight: 700; color: #0047AB; font-size: 1.2em;'>$1</strong>")
                    .replace(/\n/g, "<br />"),
                }}
              />
            </div>
          )}

          {/* Main Blueprint Table with Navigation Arrows either side */}
          <div
            className="home-table-container"
            style={{
              display: "flex",
              justifyContent: "flex-start",
              alignItems: "center",
              position: "relative",
              margin: 0,
              width: "410px",
            }}
          >
            <div className="month-table-wrapper" style={{ position: "relative", display: "inline-block", width: "410px" }}>
          {/* Left Arrow (Visible for curr and next) */}
          {(activePeriod === "curr" || activePeriod === "next") && (
            <button
              type="button"
              className="month-nav-arrow-left"
              onClick={() => setActivePeriod((p) => (p === "next" ? "curr" : "prev"))}
              style={{
                position: "absolute",
                left: "-42px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: "#a2c4c9",
                fontSize: "2.8rem",
                fontWeight: "bold",
                lineHeight: 1,
                cursor: "pointer",
                padding: 0,
                zIndex: 10,
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#0047AB"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#a2c4c9"; }}
              title="Previous Month"
            >
              ‹
            </button>
          )}

          <table
            className="month-blueprint-table"
            style={{
              width: "410px",
              borderCollapse: "separate",
              borderSpacing: 0,
              background: "#ffffff",
              borderRadius: "8px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              fontFamily: "'Kumbh Sans', sans-serif"
            }}
          >
            <colgroup>
              <col className="month-col-label" style={{ width: "290px" }} />
              <col className="month-col-val" style={{ width: "120px" }} />
            </colgroup>
            <tbody>
              {(currMonth?.tableRows || currMonth?.rows || []).map((row, i) => {
                const label = String(row.label || "").trim();
                const value = String(row.value || "").trim();
                const isHide = label.toLowerCase() === "hide";

                // Spacers
                const spacers = [6, 7, 9, 14, 16, 18, 20, 24, 26, 28, 30, 32];
                const isSpacer = spacers.includes(i) || (!label && !value);

                const normLabel = label.toLowerCase().trim();
                const isSectionHeader =
                  ["revenue", "income", "costs of sale", "cost of sales", "overheads"].includes(normLabel) ||
                  i === 2 ||
                  i === 10 ||
                  i === 21;

                const isTotalRevenue = normLabel === "total revenue" || normLabel === "total income" || i === 8;
                const isGrossProfit = normLabel === "gross profit" || i === 17;
                const isTotalOverheads = normLabel === "total overheads" || i === 25;
                const isOpProfit = normLabel === "operating profit" || i === 29;
                const isTotalCosts = normLabel === "total costs of sale" || normLabel === "total cost of sales" || i === 15;
                const isPercentage = normLabel.includes("%") || normLabel.includes("margin") || normLabel.includes("ratio") || [19, 27, 31, 33].includes(i);
                const isMajor = isTotalRevenue || isGrossProfit || isTotalOverheads || isOpProfit;

                // KPI margin row accent bars
                let marginAccentBar = null;
                if (i === 19 || normLabel.includes("gross profit margin") || normLabel.includes("gross profit %")) {
                  marginAccentBar = "#e69138";
                } else if (i === 27 || normLabel.includes("overheads as %") || normLabel.includes("overheads %")) {
                  marginAccentBar = "#45818e";
                } else if (i === 31 || normLabel.includes("operating profit %")) {
                  marginAccentBar = "#1155cc";
                } else if (i === 33 || normLabel.includes("staff ratio") || normLabel.includes("staff costs to")) {
                  marginAccentBar = "#64748b";
                }

                let bgColor = "#ffffff";
                let textColor = "#0047AB";
                let isBold = false;
                let isItalic = false;
                let fontSize = isPercentage ? 11 : 11.5;
                let rowHeight = isMajor ? 32 : isPercentage ? 21 : 24;

                // Detect 18px gap between Operating profit % and Staff ratio
                const isOpToStaffGap = i === 32;

                if (isSpacer) {
                  const spacerHeight = isOpToStaffGap ? 18 : 6;
                  return (
                    <tr key={i} style={{ height: `${spacerHeight}px`, lineHeight: 0 }}>
                      <td style={{ padding: 0, border: "none", background: "#ffffff" }} />
                      <td style={{ padding: 0, border: "none", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }} />
                    </tr>
                  );
                }

                if (isHide) {
                  return null;
                }

                if (i === 0) {
                  // Top Header (Current Month)
                  bgColor = "#0047AB";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 13;
                  rowHeight = 31;
                } else if (i === 1) {
                  // Status (Forecast vs Actual)
                  isItalic = true;
                  fontSize = 10.5;
                  textColor = "#666666";
                  bgColor = "#ffffff";
                } else if (isSectionHeader) {
                  bgColor = "#ffffff";
                  textColor = "#0047AB";
                  isBold = true;
                  fontSize = 11;
                  rowHeight = 24;
                } else if (isTotalRevenue) {
                  bgColor = "#9900ff";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 32;
                } else if (isTotalCosts) {
                  bgColor = "#ffffff";
                  textColor = "#0047AB";
                  isBold = true;
                  fontSize = 11.5;
                  rowHeight = 24;
                } else if (isGrossProfit) {
                  bgColor = "#e69138";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 32;
                } else if (isTotalOverheads) {
                  bgColor = "#45818e";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 32;
                } else if (isOpProfit) {
                  bgColor = "#1155cc";
                  textColor = "#ffffff";
                  isBold = true;
                  fontSize = 14;
                  rowHeight = 32;
                } else if (isPercentage) {
                  bgColor = "#ffffff";
                  textColor = "#0047AB";
                  isItalic = true;
                  fontSize = 11;
                }

                // Dynamic KPI threshold badge for the value column
                const threshBg = isPercentage ? getThresholdBg(i, label, value) : null;

                // Deep dive clickability
                const isBlockedRow =
                  isTotalOverheads ||
                  normLabel.includes("overheads as %") ||
                  normLabel.includes("overheads %");
                const ddType = !isSpacer && !isHide && !isBlockedRow && !isSectionHeader ? getDeepDiveType(label) : null;
                const isClickable = Boolean(ddType && value && value !== "£0" && value !== `${currencySymbol}0` && value !== "0" && value !== "—" && value !== "");

                let displayVal = value;
                if (i === 1 && typeof value === "string") {
                  if (value.toUpperCase() === "ACTUAL") displayVal = "Actual";
                  else if (value.toUpperCase() === "FORECAST") displayVal = "Forecast";
                } else if (!isSectionHeader) {
                  displayVal = formatCurrencyString(value, null, currencySymbol, thousandsSeparator);
                }

                return (
                  <tr
                    key={i}
                    style={{
                      height: `${rowHeight}px`,
                      background: (isMajor || i === 0) ? bgColor : "#ffffff",
                      borderBottom: i === 0 ? "none" : i === 1 ? "1px solid #cbd5e1" : isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                    }}
                  >
                    {/* Column A: Line Item */}
                    <td
                      style={{
                        padding: i === 0 ? "6px 12px" : isSectionHeader ? "5px 8px" : isPercentage ? "2px 8px" : "4px 8px",
                        paddingLeft: isPercentage
                          ? "20px"
                          : isSectionHeader
                          ? "8px"
                          : (isMajor || i === 0)
                          ? "12px"
                          : "16px",
                        textAlign: "left",
                        color: (isMajor || i === 0) ? "#ffffff" : textColor,
                        fontWeight: isBold ? 700 : 400,
                        fontStyle: isItalic ? "italic" : "normal",
                        fontSize: `${fontSize}px`,
                        textTransform: isSectionHeader ? "uppercase" : "none",
                        letterSpacing: isSectionHeader ? "0.5px" : "normal",
                        borderLeft: isPercentage && marginAccentBar ? `4px solid ${marginAccentBar}` : "none",
                        background: (isMajor || i === 0) ? bgColor : "#ffffff",
                        borderBottom: i === 0 ? "none" : i === 1 ? "1px solid #cbd5e1" : isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                      }}
                    >
                      {i === 0 ? (label || "") : isSectionHeader ? label.toUpperCase() : label}
                    </td>

                    {/* Column B: Amount (Shaded like Total column with continuous dividing line) */}
                    <td
                      onClick={(e) => isClickable && handleCellClick(e, label, value)}
                      style={{
                        padding: i === 0 ? "6px 16px" : isPercentage ? "1px 6px" : "4px 16px",
                        textAlign: "right",
                        background: (isMajor || i === 0) ? bgColor : "rgba(0, 71, 171, 0.04)",
                        borderLeft: "1px solid #cbd5e1",
                        borderBottom: i === 0 ? "none" : i === 1 ? "1px solid #cbd5e1" : isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                        color: (isMajor || i === 0) ? "#ffffff" : i === 1 ? "#64748b" : "#0047AB",
                        fontWeight: isBold ? 700 : 400,
                        fontStyle: isItalic ? "italic" : "normal",
                        fontSize: `${fontSize}px`,
                        cursor: isClickable ? "pointer" : "default",
                        textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                        textUnderlineOffset: isClickable ? "3px" : "initial",
                        width: "120px",
                        fontVariantNumeric: "tabular-nums",
                      }}
                      onMouseEnter={(e) => {
                        if (isClickable) e.currentTarget.style.filter = "brightness(0.95)";
                      }}
                      onMouseLeave={(e) => {
                        if (isClickable) e.currentTarget.style.filter = "none";
                      }}
                    >
                      {isPercentage && threshBg ? (
                        <div
                          style={{
                            display: "inline-block",
                            padding: "1.5px 8px",
                            borderRadius: "4px",
                            background: threshBg,
                            color: "#0047AB",
                            border: "1.5px solid rgba(0, 71, 171, 0.04)",
                            fontStyle: "italic",
                            fontWeight: 700,
                            boxSizing: "border-box",
                          }}
                        >
                          {displayVal || ""}
                        </div>
                      ) : (
                        isSectionHeader ? "" : displayVal || ""
                      )}
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
              className="month-nav-arrow-right"
              onClick={() => setActivePeriod((p) => (p === "prev" ? "curr" : "next"))}
              style={{
                position: "absolute",
                right: "-42px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: "none",
                color: "#a2c4c9",
                fontSize: "2.8rem",
                fontWeight: "bold",
                lineHeight: 1,
                cursor: "pointer",
                padding: 0,
                zIndex: 10,
                transition: "color 0.2s",
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
    </div>

    {/* Right Column: "At a glance" + "Last 12 months" Chart */}
    <div className="home-col-right">
      {/* "At a glance" Card */}
      <div
        className="home-glance-card"
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
          padding: "20px 24px",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
        }}
      >
        <div
          style={{
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.8px",
            textTransform: "uppercase",
            color: "#64748b",
            marginBottom: "18px",
            fontFamily: "'Kumbh Sans', sans-serif",
          }}
        >
          {glanceMonthHeading}
        </div>

        <div className="glance-grid">
          {/* Column 1: Income / Revenue */}
          <div className="glance-col-revenue" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <h4 style={{ margin: "0 0 4px 0", color: "#0047AB", fontSize: "16px", fontWeight: 700, fontFamily: "'Kumbh Sans', sans-serif" }}>
                {primaryLabel}
              </h4>
              <div style={{ fontSize: "19px", fontWeight: 700, color: "#0f172a", letterSpacing: "-0.5px", fontFamily: "'Kumbh Sans', sans-serif" }}>
                {glanceMetrics.revDisplay}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              {glanceMetrics.revMoM !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.revMoM >= 0}
                  valueText={`${glanceMetrics.revMoM >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.revMoM))}%`}
                  periodText="pr. month"
                />
              )}
              {glanceMetrics.revYoY !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.revYoY >= 0}
                  valueText={`${glanceMetrics.revYoY >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.revYoY))}%`}
                  periodText="pr. year"
                />
              )}
            </div>

            <Sparkline data={glanceMetrics.revSeries} id="rev-spark" />
          </div>

          {/* Column 2: Gross profit */}
          <div className="glance-col-gp" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <h4 style={{ margin: "0 0 4px 0", color: "#0047AB", fontSize: "16px", fontWeight: 700, fontFamily: "'Kumbh Sans', sans-serif" }}>
                Gross profit
              </h4>
              <div style={{ fontSize: "19px", fontWeight: 700, color: "#0f172a", letterSpacing: "-0.5px", fontFamily: "'Kumbh Sans', sans-serif" }}>
                {glanceMetrics.gpDisplay}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              {glanceMetrics.gpMoM !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.gpMoM >= 0}
                  valueText={`${glanceMetrics.gpMoM >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.gpMoM))}%`}
                  periodText="pr. month"
                />
              )}
              {glanceMetrics.gpYoY !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.gpYoY >= 0}
                  valueText={`${glanceMetrics.gpYoY >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.gpYoY))}%`}
                  periodText="pr. year"
                />
              )}
            </div>

            <Sparkline data={glanceMetrics.gpSeries} id="gp-spark" />

            {/* Margin Section */}
            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "17px", fontWeight: 700, color: "#0f172a", fontFamily: "'Kumbh Sans', sans-serif" }}>
                {glanceMetrics.gpMarginDisplay}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {glanceMetrics.prevMonthPoint && (
                  <DeltaRow
                    isPositive={glanceMetrics.currentPoint.gpMargin >= glanceMetrics.prevMonthPoint.gpMargin}
                    valueText={`from ${Math.round(glanceMetrics.prevMonthPoint.gpMargin * 100)}%`}
                    periodText="prev month"
                  />
                )}
                {glanceMetrics.prevYearPoint && (
                  <DeltaRow
                    isPositive={glanceMetrics.currentPoint.gpMargin >= glanceMetrics.prevYearPoint.gpMargin}
                    valueText={`from ${Math.round(glanceMetrics.prevYearPoint.gpMargin * 100)}%`}
                    periodText="prev year"
                  />
                )}
              </div>

              <Sparkline data={glanceMetrics.gpMarginSeries} id="gp-margin-spark" />
            </div>
          </div>

          {/* Column 3: Operating profit */}
          <div className="glance-col-op" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <h4 style={{ margin: "0 0 4px 0", color: "#0047AB", fontSize: "16px", fontWeight: 700, fontFamily: "'Kumbh Sans', sans-serif" }}>
                Operating profit
              </h4>
              <div style={{ fontSize: "19px", fontWeight: 700, color: "#0f172a", letterSpacing: "-0.5px", fontFamily: "'Kumbh Sans', sans-serif" }}>
                {glanceMetrics.opDisplay}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
              {glanceMetrics.opMoM !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.opMoM >= 0}
                  valueText={`${glanceMetrics.opMoM >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.opMoM))}%`}
                  periodText="pr. month"
                />
              )}
              {glanceMetrics.opYoY !== null && (
                <DeltaRow
                  isPositive={glanceMetrics.opYoY >= 0}
                  valueText={`${glanceMetrics.opYoY >= 0 ? "" : "-"}${Math.round(Math.abs(glanceMetrics.opYoY))}%`}
                  periodText="pr. year"
                />
              )}
            </div>

            <Sparkline data={glanceMetrics.opSeries} id="op-spark" />

            {/* Margin Section */}
            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "17px", fontWeight: 700, color: "#0f172a", fontFamily: "'Kumbh Sans', sans-serif" }}>
                {glanceMetrics.opMarginDisplay}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {glanceMetrics.prevMonthPoint && (
                  <DeltaRow
                    isPositive={glanceMetrics.currentPoint.opMargin >= glanceMetrics.prevMonthPoint.opMargin}
                    valueText={`from ${Math.round(glanceMetrics.prevMonthPoint.opMargin * 100)}%`}
                    periodText="prev month"
                  />
                )}
                {glanceMetrics.prevYearPoint && (
                  <DeltaRow
                    isPositive={glanceMetrics.currentPoint.opMargin >= glanceMetrics.prevYearPoint.opMargin}
                    valueText={`from ${Math.round(glanceMetrics.prevYearPoint.opMargin * 100)}%`}
                    periodText="prev year"
                  />
                )}
              </div>

              <Sparkline data={glanceMetrics.opMarginSeries} id="op-margin-spark" />
            </div>
          </div>
        </div>
      </div>

      {/* "Last 12 months" Performance Chart Card */}
      {chartData?.showChart && chartData?.months?.length > 0 && (
        <div
          className="home-chart-card"
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            padding: "20px 24px",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            display: "flex",
            flexDirection: "column",
            flex: "1 1 0%",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
              color: "#64748b",
              marginBottom: "18px",
              textAlign: "left",
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
          >
            Last 12 months
          </div>

          <HomeLineChart
            months={chartData.months}
            revenue={chartData.revenue || []}
            grossProfit={chartData.grossProfit || []}
            operatingProfit={chartData.operatingProfit || []}
            showTrendlines={chartData.showTrendlines}
            label1={chartData.label1 || primaryLabel}
            label2={chartData.label2 || "Gross profit"}
            label3={chartData.label3 || "Operating profit"}
            currencySymbol={currencySymbol}
            thousandsSeparator={thousandsSeparator}
          />
        </div>
      )}
    </div>
  </div>

  <style jsx>{`
    .home-workspace-grid {
      display: grid;
      grid-template-columns: 410px 1fr;
      column-gap: 72px;
      row-gap: 24px;
      align-items: stretch;
      width: 100%;
      max-width: 1440px;
      margin: 0;
    }
    .home-col-left {
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 410px;
      max-width: 410px;
    }
    .home-col-right {
      display: flex;
      flex-direction: column;
      gap: 20px;
      width: 100%;
      min-width: 0;
      min-height: 0;
      height: 100%;
    }
    .home-chart-card {
      flex: 1 1 0%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .glance-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    :global(.home-chart-axis-label) {
      font-size: 15.3px;
    }
    :global(.home-chart-legend) {
      font-size: 11.4px;
    }

    @media (max-width: 1080px) {
      :global(.home-view-container) {
        padding: 0.5rem 0.5rem 3rem 0.5rem !important;
      }
      .home-workspace-grid {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .home-col-left {
        width: 100% !important;
        max-width: 100% !important;
      }
      .home-col-left,
      .home-col-right {
        display: contents;
      }
      .home-executive-summary-box {
        order: 1 !important;
        width: 100% !important;
        max-width: 100% !important;
      }
      .home-table-container {
        order: 2 !important;
        width: 100% !important;
        display: flex !important;
        justify-content: center !important;
        margin: 0 auto !important;
      }
      .home-glance-card {
        order: 3 !important;
      }
      .home-chart-card {
        order: 4 !important;
        flex: none !important;
        height: auto !important;
        min-height: 340px !important;
      }
      :global(.home-chart-svg-wrap) {
        height: 260px !important;
        min-height: 240px !important;
      }
      .month-table-wrapper {
        width: auto !important;
        margin: 0 auto !important;
        display: flex !important;
        justify-content: center !important;
      }
    }

    @media (max-width: 768px) {
      :global(.home-chart-legend) {
        font-size: 9.5px !important;
      }
    }

    @media (max-width: 768px) and (orientation: portrait) {
      :global(.home-chart-axis-label) {
        font-size: 21.6px !important;
      }
    }

    @media (max-width: 640px) {
      .home-exec-title {
        font-size: 10.8px !important;
      }
      .home-exec-body {
        font-size: 17.3px !important;
      }
      .glance-grid {
        grid-template-columns: 1fr 1fr !important;
        gap: 16px !important;
      }
      .glance-col-revenue {
        grid-column: 1 / -1 !important;
        padding-bottom: 12px;
        border-bottom: 1px solid #f1f5f9;
      }
      .home-table-container {
        justify-content: center !important;
      }
      .month-table-wrapper {
        width: auto !important;
        margin: 0 auto !important;
      }
    }

    @media (max-width: 500px) {
      .month-blueprint-table {
        width: 312px !important;
      }
      .month-col-label {
        width: 216px !important;
      }
      .month-col-val {
        width: 96px !important;
      }
      .month-nav-arrow-left {
        left: -28px !important;
        font-size: 2.5rem !important;
        padding: 8px 2px !important;
      }
      .month-nav-arrow-right {
        right: -28px !important;
        font-size: 2.5rem !important;
        padding: 8px 2px !important;
      }
    }
  `}</style>
</div>
);
}

// Lightweight, responsive SVG Sparkline with soft gradient fill
function Sparkline({ data = [], width = 140, height = 36, color = "#0047AB", id = "spark" }) {
  if (!data || data.length === 0) return null;
  const paddingX = 4;
  const paddingY = 4;
  const innerW = width - paddingX * 2;
  const innerH = height - paddingY * 2;

  const safeData = data.length === 1 ? [data[0], data[0]] : data;
  const minVal = Math.min(...safeData);
  const maxVal = Math.max(...safeData);
  const span = maxVal - minVal || 1;

  const points = safeData.map((val, idx) => {
    const x = paddingX + (idx / (safeData.length - 1)) * innerW;
    const y = paddingY + innerH - ((val - minVal) / span) * innerH;
    return { x, y, val };
  });

  let linePath = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const mx = (p0.x + p1.x) / 2;
    linePath += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
  }

  const baselineY = height;
  const firstP = points[0];
  const lastP = points[points.length - 1];
  const areaPath = `${linePath} L ${lastP.x} ${baselineY} L ${firstP.x} ${baselineY} Z`;

  const gradId = `spark-grad-${id}`;

  return (
    <div style={{ width: "100%", maxWidth: `${width}px`, height: `${height}px`, display: "flex", alignItems: "center" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "100%", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={lastP.x}
          cy={lastP.y}
          r="3"
          fill={color}
          stroke="#ffffff"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

// Delta Row with up/down arrows and period label
function DeltaRow({ isPositive, valueText, periodText }) {
  const arrow = isPositive ? "▲" : "▼";
  const color = isPositive ? "#16a34a" : "#dc2626";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        fontFamily: "'Kumbh Sans', sans-serif",
        lineHeight: 1.35,
      }}
    >
      <span style={{ color, fontWeight: 700, fontSize: "10px" }}>{arrow}</span>
      <span style={{ color, fontWeight: 600 }}>{valueText}</span>
      <span style={{ color: "#64748b", fontWeight: 400, fontSize: "11px", marginLeft: "4px" }}>
        {periodText}
      </span>
    </div>
  );
}

// Clean, smooth SVG Line Chart mirroring Chart.js
function HomeLineChart({
  months: rawMonths = [],
  revenue: rawRevenue = [],
  grossProfit: rawGrossProfit = [],
  operatingProfit: rawOperatingProfit = [],
  showTrendlines = false,
  label1 = "Revenue",
  label2 = "Gross profit",
  label3 = "Operating profit",
  currencySymbol = "£",
  thousandsSeparator = ",",
}) {
  // Trim leading months where revenue is zero so chart starts at first active revenue month
  const firstNonZeroRevIdx = rawRevenue.findIndex((v) => Math.abs(Number(v) || 0) > 0);
  const startIdx = firstNonZeroRevIdx > 0 ? firstNonZeroRevIdx : 0;
  const months = rawMonths.slice(startIdx);
  const revenue = rawRevenue.slice(startIdx);
  const grossProfit = rawGrossProfit.slice(startIdx);
  const operatingProfit = rawOperatingProfit.slice(startIdx);

  const width = 850;
  const height = 380;
  const padding = { top: 20, right: 30, bottom: 35, left: 75 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Calculate linear regression trendlines mirroring original Pulse WebApp
  const calculateTrendline = (data) => {
    if (!data || data.length < 2) return [];
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const val = Number(data[i]) || 0;
      sumX += i;
      sumY += val;
      sumXY += i * val;
      sumX2 += i * i;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return data.map(() => 0);

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    return data.map((_, i) => slope * i + intercept);
  };

  const revTrend = showTrendlines && months.length > 1 ? calculateTrendline(revenue) : [];
  const gpTrend = showTrendlines && months.length > 1 ? calculateTrendline(grossProfit) : [];
  const opTrend = showTrendlines && months.length > 1 ? calculateTrendline(operatingProfit) : [];

  const trendVals = showTrendlines
    ? [...revTrend, ...gpTrend, ...opTrend].filter((v) => typeof v === "number" && !isNaN(v))
    : [];

  const allVals = [...revenue, ...grossProfit, ...operatingProfit, ...trendVals].filter(
    (v) => typeof v === "number" && !isNaN(v)
  );
  const rawMax = Math.max(...allVals, 10000);
  const rawMin = Math.min(...allVals, 0);

  // Calculate sensible, whole-number interval (e.g. £10,000, £20,000, £50,000)
  const targetTicks = 5;
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

  const buildAreaPath = (linePath, firstIdx, lastIdx) => {
    if (!linePath) return "";
    const startX = getX(firstIdx);
    const endX = getX(lastIdx);
    const bottomY = getY(chartMin);
    return `${linePath} L ${endX} ${bottomY} L ${startX} ${bottomY} Z`;
  };

  const revPath = buildSmoothPath(revenue);
  const gpPath = buildSmoothPath(grossProfit);
  const opPath = buildSmoothPath(operatingProfit);

  const revArea = buildAreaPath(revPath, 0, months.length - 1);
  const gpArea = buildAreaPath(gpPath, 0, months.length - 1);
  const opArea = buildAreaPath(opPath, 0, months.length - 1);

  const formatShortMoney = (n) => {
    if (n === 0) return `${currencySymbol}0`;
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1000000) {
      const formattedM = (abs / 1000000).toFixed(1).replace(".", thousandsSeparator === "." ? "," : ".");
      return `${sign}${currencySymbol}${formattedM}m`;
    }
    if (abs >= 1000) {
      const kVal = Math.round(abs / 1000).toString().replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
      return `${sign}${currencySymbol}${kVal}k`;
    }
    return `${sign}${currencySymbol}${Math.round(abs)}`;
  };

  return (
    <div style={{ width: "100%", flex: "1 1 auto", minHeight: "260px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div className="home-chart-svg-wrap" style={{ position: "relative", width: "100%", flex: "1 1 auto", minHeight: "240px", height: "260px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            maxHeight: "440px",
            margin: "auto",
            display: "block"
          }}
        >
        <defs>
          <linearGradient id="v2RevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9900ff" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#9900ff" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="v2GpGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e69138" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#e69138" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="v2OpGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1155cc" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1155cc" stopOpacity="0.0" />
          </linearGradient>
        </defs>

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
                stroke={tick === 0 ? "#94a3b8" : "#f1f5f9"}
                strokeWidth={tick === 0 ? "1.5" : "1"}
              />
              <text
                className="home-chart-axis-label"
                x={padding.left - 8}
                y={y + 6}
                textAnchor="end"
                fontSize="15.3"
                fill="#64748b"
                fontFamily="'Kumbh Sans', sans-serif"
              >
                {formatShortMoney(tick)}
              </text>
            </g>
          );
        })}

        {/* Area Gradient Glows under lines */}
        {revArea && <path d={revArea} fill="url(#v2RevGrad)" />}
        {gpArea && <path d={gpArea} fill="url(#v2GpGrad)" />}
        {opArea && <path d={opArea} fill="url(#v2OpGrad)" />}

        {/* X Ticks (Month labels) */}
        {months.map((m, i) => {
          const x = getX(i);
          const shortMonth = String(m).split(" ")[0]; // e.g. "Oct"
          return (
            <text
              key={i}
              className="home-chart-axis-label"
              x={x}
              y={height - 10}
              textAnchor="middle"
              fontSize="15.3"
              fill="#64748b"
              fontFamily="'Kumbh Sans', sans-serif"
            >
              {shortMonth}
            </text>
          );
        })}

        {/* Trendlines (linear regression, dashed lines matching series colors) */}
        {showTrendlines && months.length > 1 && (
          <g className="chart-trendlines">
            {revTrend.length > 0 && (
              <line
                x1={getX(0)}
                y1={getY(revTrend[0])}
                x2={getX(months.length - 1)}
                y2={getY(revTrend[months.length - 1])}
                stroke="#9900ff"
                strokeWidth="1.5"
                strokeDasharray="5 5"
                strokeLinecap="round"
                opacity="0.85"
              >
                <title>{label1} Trend</title>
              </line>
            )}
            {gpTrend.length > 0 && (
              <line
                x1={getX(0)}
                y1={getY(gpTrend[0])}
                x2={getX(months.length - 1)}
                y2={getY(gpTrend[months.length - 1])}
                stroke="#e69138"
                strokeWidth="1.5"
                strokeDasharray="5 5"
                strokeLinecap="round"
                opacity="0.85"
              >
                <title>{label2} Trend</title>
              </line>
            )}
            {opTrend.length > 0 && (
              <line
                x1={getX(0)}
                y1={getY(opTrend[0])}
                x2={getX(months.length - 1)}
                y2={getY(opTrend[months.length - 1])}
                stroke="#1155cc"
                strokeWidth="1.5"
                strokeDasharray="5 5"
                strokeLinecap="round"
                opacity="0.85"
              >
                <title>{label3} Trend</title>
              </line>
            )}
          </g>
        )}

        {/* Revenue line */}
        <path
          d={revPath}
          fill="none"
          stroke="#9900ff"
          strokeWidth="2.2"
          strokeLinecap="round"
        />

        {/* Gross Profit line */}
        <path
          d={gpPath}
          fill="none"
          stroke="#e69138"
          strokeWidth="2.2"
          strokeLinecap="round"
        />

        {/* Operating Profit line */}
        <path
          d={opPath}
          fill="none"
          stroke="#1155cc"
          strokeWidth="2.2"
          strokeLinecap="round"
        />

        {/* Dots on points */}
        {revenue.map((val, i) => (
          <circle key={`r-${i}`} cx={getX(i)} cy={getY(val)} r="3" fill="#9900ff" stroke="#ffffff" strokeWidth="1.5">
            <title>{`${months[i] ? months[i] + ': ' : ''}${label1} ${formatMoney(val, 0, currencySymbol, thousandsSeparator)}`}</title>
          </circle>
        ))}
        {grossProfit.map((val, i) => (
          <circle key={`gp-${i}`} cx={getX(i)} cy={getY(val)} r="3" fill="#e69138" stroke="#ffffff" strokeWidth="1.5">
            <title>{`${months[i] ? months[i] + ': ' : ''}${label2} ${formatMoney(val, 0, currencySymbol, thousandsSeparator)}`}</title>
          </circle>
        ))}
        {operatingProfit.map((val, i) => (
          <circle key={`op-${i}`} cx={getX(i)} cy={getY(val)} r="3" fill="#1155cc" stroke="#ffffff" strokeWidth="1.5">
            <title>{`${months[i] ? months[i] + ': ' : ''}${label3} ${formatMoney(val, 0, currencySymbol, thousandsSeparator)}`}</title>
          </circle>
        ))}
        </svg>
      </div>

      {/* Chart Legend */}
      <div
        className="home-chart-legend"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: "16px",
          marginTop: "6px",
          fontFamily: "'Kumbh Sans', sans-serif",
          flexWrap: "wrap"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#9900ff", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>{label1}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#e69138", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>{label2}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#1155cc", display: "inline-block" }} />
          <span style={{ color: "#334155", fontWeight: 500 }}>{label3}</span>
        </div>
        {showTrendlines && (
          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ display: "inline-block", width: "14px", height: "0px", borderTop: "2px dashed #64748b" }} />
            <span style={{ color: "#64748b", fontWeight: 500 }}>Trendlines</span>
          </div>
        )}
      </div>

      <style jsx>{`
        :global(.home-chart-axis-label) {
          font-size: 15.3px;
        }
        :global(.home-chart-legend) {
          font-size: 11.4px;
        }
        @media (max-width: 768px) {
          :global(.home-chart-legend) {
            font-size: 9.5px !important;
          }
        }
        @media (max-width: 768px) and (orientation: portrait) {
          :global(.home-chart-axis-label) {
            font-size: 21.6px !important;
          }
        }
      `}</style>
    </div>
  );
}

// Compute At A Glance metrics + multi-year sparklines
function computeGlanceMetrics({
  performanceData,
  chartData,
  activeMonthData,
  monthPeriod,
  currencySymbol = "£",
  thousandsSeparator = ",",
}) {
  const parseNum = (val) => {
    if (typeof val === "number" && !isNaN(val)) return val;
    if (!val) return 0;
    const clean = String(val).replace(/[£$€,\s%]/g, "").trim();
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  // Flatten years into a continuous timeline starting from Year 0 Month 0
  const timeline = [];
  if (performanceData?.years && performanceData.years.length > 0) {
    performanceData.years.forEach((yr, yIdx) => {
      const months = yr.headerMonths || [];
      const revRow =
        yr.rows?.find((r) => /total revenue|total income/i.test(r.label)) ||
        yr.rows?.find((r) => /^revenue|^income/i.test(r.label));
      const gpRow = yr.rows?.find((r) => /gross profit/i.test(r.label) && !/margin|%/i.test(r.label));
      const opRow = yr.rows?.find((r) => /operating profit/i.test(r.label) && !/margin|%/i.test(r.label));
      const gpMargRow = yr.rows?.find((r) => /gross profit margin|gross profit %/i.test(r.label));
      const opMargRow = yr.rows?.find((r) => /operating profit %|operating profit margin/i.test(r.label));

      for (let m = 0; m < months.length; m++) {
        const mStr = months[m];
        const d = DeepDiveEngine.parseHeaderDate(mStr);
        const rev =
          typeof revRow?.monthlyMath?.[m] === "number"
            ? revRow.monthlyMath[m]
            : parseNum(revRow?.monthlyValues?.[m]);
        const gp =
          typeof gpRow?.monthlyMath?.[m] === "number"
            ? gpRow.monthlyMath[m]
            : parseNum(gpRow?.monthlyValues?.[m]);
        const op =
          typeof opRow?.monthlyMath?.[m] === "number"
            ? opRow.monthlyMath[m]
            : parseNum(opRow?.monthlyValues?.[m]);

        let gpMargin = 0;
        if (typeof gpMargRow?.monthlyMath?.[m] === "number") {
          gpMargin = gpMargRow.monthlyMath[m] > 1 ? gpMargRow.monthlyMath[m] / 100 : gpMargRow.monthlyMath[m];
        } else if (gpMargRow?.monthlyValues?.[m]) {
          const p = parseNum(gpMargRow.monthlyValues[m]);
          gpMargin = p > 1 || String(gpMargRow.monthlyValues[m]).includes("%") ? p / 100 : p;
        } else if (rev) {
          gpMargin = gp / rev;
        }

        let opMargin = 0;
        if (typeof opMargRow?.monthlyMath?.[m] === "number") {
          opMargin = opMargRow.monthlyMath[m] > 1 ? opMargRow.monthlyMath[m] / 100 : opMargRow.monthlyMath[m];
        } else if (opMargRow?.monthlyValues?.[m]) {
          const p = parseNum(opMargRow.monthlyValues[m]);
          opMargin = p > 1 || String(opMargRow.monthlyValues[m]).includes("%") ? p / 100 : p;
        } else if (rev) {
          opMargin = op / rev;
        }

        timeline.push({
          yIdx,
          mIdx: m,
          monthStr: mStr,
          date: d,
          rev,
          gp,
          op,
          gpMargin,
          opMargin,
        });
      }
    });
  }

  // Fallback to chartData if performanceData is not loaded
  if (timeline.length === 0 && chartData?.months && chartData.months.length > 0) {
    chartData.months.forEach((mStr, idx) => {
      const rev = chartData.revenue?.[idx] || 0;
      const gp = chartData.grossProfit?.[idx] || 0;
      const op = chartData.operatingProfit?.[idx] || 0;
      const d = DeepDiveEngine.parseHeaderDate(mStr);
      timeline.push({
        yIdx: 0,
        mIdx: idx,
        monthStr: mStr,
        date: d,
        rev,
        gp,
        op,
        gpMargin: rev ? gp / rev : 0,
        opMargin: rev ? op / rev : 0,
      });
    });
  }

  // Identify target index in timeline corresponding to monthPeriod
  let targetIdx = -1;
  const targetDate = DeepDiveEngine.parseHeaderDate(monthPeriod);
  if (targetDate && timeline.length > 0) {
    targetIdx = timeline.findIndex(
      (p) =>
        p.date &&
        p.date.getFullYear() === targetDate.getFullYear() &&
        p.date.getMonth() === targetDate.getMonth()
    );
  }

  if (targetIdx === -1 && monthPeriod && timeline.length > 0) {
    const cleanPeriod = monthPeriod.toLowerCase().replace(/\s+/g, "");
    targetIdx = timeline.findIndex(
      (p) => p.monthStr && p.monthStr.toLowerCase().replace(/\s+/g, "").includes(cleanPeriod)
    );
  }

  if (targetIdx === -1 && timeline.length > 0) {
    const baseYear = performanceData?.currentYearIdx !== undefined ? performanceData.currentYearIdx : 1;
    const mIdx = monthPeriod ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].findIndex((m) => monthPeriod.toLowerCase().includes(m)) : 0;
    const candidateIdx = baseYear * 12 + Math.max(0, mIdx);
    targetIdx = Math.min(Math.max(0, candidateIdx), timeline.length - 1);
  }

  if (targetIdx === -1) {
    targetIdx = Math.max(0, timeline.length - 1);
  }

  const currentPoint = timeline[targetIdx] || { rev: 0, gp: 0, op: 0, gpMargin: 0, opMargin: 0 };
  const prevMonthPoint = targetIdx > 0 ? timeline[targetIdx - 1] : null;
  const prevYearPoint = targetIdx >= 12 ? timeline[targetIdx - 12] : null;

  // Multi-year sparkline series up to current viewed month
  // Trim leading months where revenue is zero so ALL charts start at the first month with non-zero revenue
  const fullSlice = timeline.slice(0, targetIdx + 1);
  const firstNonZeroRevIdx = fullSlice.findIndex((p) => {
    const rev = typeof p.rev === "number" ? p.rev : parseFloat(String(p.rev || 0).replace(/[£$€,\s]/g, "")) || 0;
    return Math.abs(rev) > 0;
  });
  const startIdx = firstNonZeroRevIdx !== -1 ? firstNonZeroRevIdx : 0;
  const sparklineSlice = fullSlice.slice(startIdx);

  const revSeries = sparklineSlice.map((p) => p.rev);
  const gpSeries = sparklineSlice.map((p) => p.gp);
  const opSeries = sparklineSlice.map((p) => p.op);
  const gpMarginSeries = sparklineSlice.map((p) => p.gpMargin * 100);
  const opMarginSeries = sparklineSlice.map((p) => p.opMargin * 100);

  // Read active month display values from table rows
  const tableRows = activeMonthData?.tableRows || activeMonthData?.rows || [];
  const findRow = (matcher) => {
    const found = tableRows.find((r) => r.label && matcher(String(r.label).toLowerCase().trim()));
    return found ? String(found.value || "").trim() : "";
  };

  const formatGlanceVal = (val, fallbackNum) => {
    if (val && String(val).trim()) {
      return formatCurrencyString(val, 0, currencySymbol, thousandsSeparator);
    }
    return formatMoney(fallbackNum, 0, currencySymbol, thousandsSeparator);
  };

  const revDisplay = formatGlanceVal(
    findRow((l) => l === "total revenue" || l === "total income") ||
    findRow((l) => l.startsWith("revenue") || l.startsWith("income")),
    currentPoint.rev
  );

  const gpDisplay = formatGlanceVal(
    findRow((l) => l === "gross profit"),
    currentPoint.gp
  );

  const gpMarginDisplay =
    findRow((l) => l.includes("gross profit margin") || l.includes("gross profit %")) ||
    `${Math.round(currentPoint.gpMargin * 100)}%`;

  const opDisplay = formatGlanceVal(
    findRow((l) => l === "operating profit"),
    currentPoint.op
  );

  const opMarginDisplay =
    findRow((l) => l.includes("operating profit %") || l.includes("operating profit margin")) ||
    `${Math.round(currentPoint.opMargin * 100)}%`;

  const calcDelta = (curr, prev) => {
    if (prev === null || prev === undefined || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  return {
    revDisplay,
    gpDisplay,
    gpMarginDisplay,
    opDisplay,
    opMarginDisplay,
    currentPoint,
    prevMonthPoint,
    prevYearPoint,
    revMoM: prevMonthPoint ? calcDelta(currentPoint.rev, prevMonthPoint.rev) : null,
    revYoY: prevYearPoint ? calcDelta(currentPoint.rev, prevYearPoint.rev) : null,
    gpMoM: prevMonthPoint ? calcDelta(currentPoint.gp, prevMonthPoint.gp) : null,
    gpYoY: prevYearPoint ? calcDelta(currentPoint.gp, prevYearPoint.gp) : null,
    opMoM: prevMonthPoint ? calcDelta(currentPoint.op, prevMonthPoint.op) : null,
    opYoY: prevYearPoint ? calcDelta(currentPoint.op, prevYearPoint.op) : null,
    revSeries,
    gpSeries,
    opSeries,
    gpMarginSeries,
    opMarginSeries,
  };
}
