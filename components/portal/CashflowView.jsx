import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData, DeepDiveEngine } from "../../services/deepDiveHelper";

export default function CashflowView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const [exclOpen, setExclOpen] = useState(false);
  const [inclOpen, setInclOpen] = useState(false);
  const [activePopover, setActivePopover] = useState(null);
  const [hoveredPoint, setHoveredPoint] = useState(null);

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
          Unable to Load Cashflow Data
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

  if (!data) {
    return (
      <div style={{ background: "#ffffff", borderRadius: "8px", padding: "4rem", textAlign: "center" }}>
        <p style={{ color: "#64748b" }}>No cashflow data available.</p>
      </div>
    );
  }

  const rollingMonths = data.rollingMonths || [];
  const exclRows = data.excludingPipeline || [];
  const inclRows = data.includingPipeline || [];

  const parseMoney = (val) => {
    if (typeof val === "number") return val;
    if (!val) return 0;
    const clean = String(val).replace(/[£,]/g, "").trim();
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString()}`;
  };

  // Helper to extract or sum values across matching rows
  const getValues = (rows, labelPatterns, rowIndices = []) => {
    let matching = [];

    // Prioritize explicit row indices to avoid accidental double-counting of auxiliary rows
    if (rowIndices && rowIndices.length > 0) {
      matching = rows.filter((r) => rowIndices.includes(r.rowIndex));
    }

    // Fallback: match by label if row index was not found in dataset
    if (matching.length === 0) {
      matching = rows.filter((r) => {
        const l = (r.label || "").toLowerCase().trim();
        return labelPatterns.some((p) => {
          const pat = p.toLowerCase().trim();
          if (l === pat) return true;
          // Crucial: avoid matching "actual closing balance" when searching for "closing balance"
          if (pat === "closing balance" && l.includes("actual")) return false;
          return l.includes(pat);
        });
      });
    }

    if (matching.length === 0) return Array(rollingMonths.length).fill("£0");

    return rollingMonths.map((_, mIdx) => {
      let sum = 0;
      matching.forEach((r) => {
        sum += parseMoney(r.rollingValues?.[mIdx]);
      });
      return formatMoney(sum);
    });
  };

  // Deep dive cell click
  const handleCellClick = (e, rowLabel, val, mIdx, ddType) => {
    if (!ddType || !val || val === "£0" || val === "—") return;

    const monthLabel = rollingMonths[mIdx] || `Month ${mIdx + 1}`;
    const rect = e.currentTarget.getBoundingClientRect();
    const parsedTargetDate = DeepDiveEngine.parseHeaderDate(rollingMonths[mIdx]) || new Date();

    const ddData = buildDeepDiveData({
      ddType,
      periodLabel: monthLabel,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: 1,
      targetDate: parsedTargetDate,
      keyData,
      isRestricted: isSenior,
    });

    setActivePopover({
      isOpen: true,
      targetRect: rect,
      title: ddData.title,
      period: ddData.period,
      total: ddData.total,
      items: ddData.items,
      sections: ddData.sections,
    });
  };

  // CSV export function
  const handleDownloadCsv = () => {
    const headers = ["Category / Line Item", ...rollingMonths];
    const csvRows = [headers.join(",")];

    const addCsvRow = (label, vals) => {
      const cleanLabel = `"${label.replace(/"/g, '""')}"`;
      const cleanVals = vals.map((v) => `"${String(v).replace(/"/g, '""')}"`);
      csvRows.push([cleanLabel, ...cleanVals].join(","));
    };

    // Excluding pipeline
    csvRows.push('"Excluding pipeline"');
    addCsvRow("Opening balance", exclOpening);
    addCsvRow("Net cash movement", exclNet);
    exclDetails.forEach((d) => {
      if (!isRowEmpty(d.values)) addCsvRow(`  ${d.label}`, d.values);
    });
    addCsvRow("Closing balance", exclClosing);

    // Spacer
    csvRows.push('""');

    // Including pipeline
    csvRows.push('"Including pipeline"');
    addCsvRow("Opening balance", inclOpening);
    addCsvRow("Net cash movement", inclNet);
    inclDetails.forEach((d) => {
      if (!isRowEmpty(d.values)) addCsvRow(`  ${d.label}`, d.values);
    });
    addCsvRow("Closing balance", inclClosing);

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStr = new Date().toISOString().split("T")[0];
    link.setAttribute("href", url);
    link.setAttribute("download", `Pulse_Cashflow_Forecast_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Row data definitions matching WebApp.html exactly
  const exclOpening = getValues(exclRows, ["opening balance"], [4]);
  const exclNet = getValues(exclRows, ["net cash movement"], [32]);
  const rawExclClosing = getValues(exclRows, ["closing balance"], [34]);

  const inclOpening = getValues(inclRows, ["opening balance"], [45]);
  const inclNet = getValues(inclRows, ["net cash movement"], [74]);
  const rawInclClosing = getValues(inclRows, ["closing balance"], [76]);

  // Actual closing balance check for the first month (previous calendar month)
  // Per business rule: if actual closing balance exists in Row 36 for month 0, it overrides the calculated closing balance for month 0
  const actualClosingRow = exclRows.find((r) => r.rowIndex === 36 || (r.label || "").toLowerCase().includes("actual closing"));

  const applyActualClosing = (closingVals) => {
    if (!actualClosingRow?.rollingValues || closingVals.length === 0) return closingVals;
    const actual0 = actualClosingRow.rollingValues[0];
    if (actual0 && actual0 !== "£0" && actual0 !== "—" && Math.abs(parseMoney(actual0)) > 0.01) {
      const updated = [...closingVals];
      updated[0] = formatMoney(parseMoney(actual0));
      return updated;
    }
    return closingVals;
  };

  const exclClosing = applyActualClosing(rawExclClosing);
  const inclClosing = applyActualClosing(rawInclClosing);

  const exclDetails = [
    { label: "Confirmed cash incoming", values: getValues(exclRows, ["confirmed cash incoming"], [6]), ddType: "cashConfInflow" },
    {
      label: "Salaries",
      values: isSenior
        ? getValues(exclRows, ["salaries outgoing", "salaries adjustment", "dividends as salary outgoing", "dividends as salary adjustment"], [8, 9, 10, 11])
        : getValues(exclRows, ["salaries outgoing", "salaries adjustment"], [8, 9]),
      ddType: "cashSalaries"
    },
    ...(!isSenior
      ? [{ label: "Dividends as salary", values: getValues(exclRows, ["dividends as salary outgoing", "dividends as salary adjustment"], [10, 11]), ddType: "cashDividends" }]
      : []),
    { label: "Contractors", values: getValues(exclRows, ["contractors outgoing", "contractors adjustment"], [12, 13]), ddType: "cashContractors" },
    { label: "Direct costs", values: getValues(exclRows, ["direct costs outgoing", "direct costs adjustment"], [14, 15]), ddType: "cashDirCosts" },
    { label: "Other expenses", values: getValues(exclRows, ["other expenses outgoing", "other expenses adjustment"], [16, 17]), ddType: "cashOutgoings" },
    { label: "Corporation tax", values: getValues(exclRows, ["corporation tax"], [19, 20]), ddType: "taxCash" },
    { label: "VAT", values: getValues(exclRows, ["vat"], [21, 22]), ddType: "vatCash" },
    { label: "Non-operating income", values: getValues(exclRows, ["non-operating income"], [24, 25]), ddType: "nonOpIncCash" },
    { label: "Non-operating expenses", values: getValues(exclRows, ["non-operating expenses"], [26, 27]), ddType: "nonOpExpCash" },
    { label: "Other cash movements", values: getValues(exclRows, ["other cash movements", "other adjustments"], [29, 30]), ddType: "otherMoveCash" },
  ];

  const inclDetails = [
    { label: "Confirmed cash incoming", values: getValues(inclRows, ["confirmed cash incoming"], [47]), ddType: "cashConfInflow" },
    { label: "Pipeline cash incoming", values: getValues(inclRows, ["pipeline cash incoming"], [48]), ddType: "cashPipeInflow" },
    {
      label: "Salaries",
      values: isSenior
        ? getValues(inclRows, ["salaries outgoing", "salaries adjustment", "dividends as salary outgoing", "dividends as salary adjustment"], [50, 51, 52, 53])
        : getValues(inclRows, ["salaries outgoing", "salaries adjustment"], [50, 51]),
      ddType: "cashSalaries"
    },
    ...(!isSenior
      ? [{ label: "Dividends as salary", values: getValues(inclRows, ["dividends as salary outgoing", "dividends as salary adjustment"], [52, 53]), ddType: "cashDividends" }]
      : []),
    { label: "Contractors", values: getValues(inclRows, ["contractors outgoing", "contractors adjustment"], [54, 55]), ddType: "cashContractors" },
    { label: "Direct costs", values: getValues(inclRows, ["direct costs outgoing", "direct costs adjustment"], [56, 57]), ddType: "cashDirCosts" },
    { label: "Other expenses", values: getValues(inclRows, ["other expenses outgoing", "other expenses adjustment"], [58, 59]), ddType: "cashOutgoings" },
    { label: "Corporation tax", values: getValues(inclRows, ["corporation tax"], [61, 62]), ddType: "taxCash" },
    { label: "VAT", values: getValues(inclRows, ["vat"], [63, 64]), ddType: "vatCash" },
    { label: "Non-operating income", values: getValues(inclRows, ["non-operating income"], [66, 67]), ddType: "nonOpIncCash" },
    { label: "Non-operating expenses", values: getValues(inclRows, ["non-operating expenses"], [68, 69]), ddType: "nonOpExpCash" },
    { label: "Other cash movements", values: getValues(inclRows, ["other cash movements", "other adjustments"], [71, 72]), ddType: "otherMoveCash" },
  ];

  const isRowEmpty = (vals) => vals.every((v) => Math.abs(parseMoney(v)) < 0.01);

  // Line chart numbers
  const exclClosingNums = exclClosing.map(parseMoney);
  const inclClosingNums = inclClosing.map(parseMoney);

  const allNums = [...exclClosingNums, ...inclClosingNums];
  const rawMax = Math.max(...allNums, 10000);
  const rawMin = Math.min(...allNums, 0);

  const span = Math.max(rawMax - (rawMin < 0 ? rawMin : 0), 10000);
  const targetTicks = 5;
  const roughStep = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceFactor = 1;
  if (residual > 5) niceFactor = 10;
  else if (residual > 2) niceFactor = 5;
  else if (residual > 1) niceFactor = 2;
  const niceStep = niceFactor * magnitude;
  const minVal = Math.floor(rawMin / niceStep) * niceStep;
  const maxVal = Math.ceil(rawMax / niceStep) * niceStep;
  const range = maxVal - minVal || 1;

  const yTicks = [];
  for (let t = minVal; t <= maxVal + niceStep * 0.5; t += niceStep) {
    yTicks.push(t);
  }

  // Chart coordinates
  const svgWidth = 720;
  const svgHeight = 440;
  const padLeft = 52;
  const padRight = 36;
  const padTop = 20;
  const padBottom = 44;

  const getX = (idx) => padLeft + (idx / Math.max(1, rollingMonths.length - 1)) * (svgWidth - padLeft - padRight);
  const getY = (val) => padTop + (1 - (val - minVal) / range) * (svgHeight - padTop - padBottom);

  const makeSmoothPath = (nums) => {
    const points = nums.map((val, idx) => ({ x: getX(idx), y: getY(val) }));
    if (!points || points.length === 0) return "";
    if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

    let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = i > 0 ? points[i - 1] : points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i < points.length - 2 ? points[i + 2] : p2;

      // Tension 0.4 (Catmull-Rom to Cubic Bezier)
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return path;
  };

  const exclPath = makeSmoothPath(exclClosingNums);
  const inclPath = makeSmoothPath(inclClosingNums);

  const buildAreaPath = (linePath, count) => {
    if (!linePath || count < 2) return "";
    const xFirst = getX(0);
    const xLast = getX(count - 1);
    const yBottom = svgHeight - padBottom;
    return `${linePath} L ${xLast.toFixed(1)} ${yBottom.toFixed(1)} L ${xFirst.toFixed(1)} ${yBottom.toFixed(1)} Z`;
  };

  const exclArea = buildAreaPath(exclPath, rollingMonths.length);
  const inclArea = buildAreaPath(inclPath, rollingMonths.length);

  const formatShortMoney = (n) => {
    if (n === 0) return "£0";
    const abs = Math.abs(n);
    if (abs >= 1000000) return `${n < 0 ? "-" : ""}£${(abs / 1000000).toFixed(1)}m`;
    if (abs >= 1000) return `${n < 0 ? "-" : ""}£${Math.round(abs / 1000)}k`;
    return `${n < 0 ? "-" : ""}£${Math.round(abs)}`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", width: "100%", fontFamily: "'Kumbh Sans', sans-serif" }}>
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

      {/* Action Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          width: "100%",
          padding: "0.25rem 0",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
          Cashflow forecast
        </h2>

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
            onClick={handleDownloadCsv}
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

      {/* 2-Column Responsive Cashflow Workspace Grid */}
      <div className="cashflow-workspace-grid">
        {/* Left Column: Cashflow Table */}
        <div className="cashflow-col-left">
          <div
            className="cashflow-table-card"
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            <div style={{ overflowX: "auto", width: "100%" }}>
              <table
                className="cashflow-main-table"
                style={{
                  width: "max-content",
                  tableLayout: "fixed",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  fontSize: "13px",
                  fontFamily: "'Kumbh Sans', sans-serif",
                }}
              >
                <colgroup>
                  <col style={{ width: "190px", minWidth: "190px", maxWidth: "190px" }} />
                  {rollingMonths.map((_, idx) => (
                    <col key={idx} style={{ width: "68px", minWidth: "68px" }} />
                  ))}
                </colgroup>
                <thead>
                  <tr style={{ background: "#0047AB", color: "#ffffff", height: "44px" }}>
                    <th
                      style={{
                        background: "#0047AB",
                        color: "#ffffff",
                        padding: "12px 10px",
                        textAlign: "left",
                        position: "sticky",
                        left: 0,
                        zIndex: 20,
                        fontWeight: 700,
                        width: "190px",
                        minWidth: "190px",
                        maxWidth: "190px",
                        boxSizing: "border-box",
                        borderBottom: "1px solid #0047AB",
                        borderRight: "2px solid rgba(255, 255, 255, 0.2)",
                      }}
                    />
                    {rollingMonths.map((m, idx) => (
                      <th
                        key={idx}
                        style={{
                          background: "#0047AB",
                          color: "#ffffff",
                          padding: "12px 6px",
                          textAlign: "right",
                          fontWeight: 700,
                          fontSize: "12px",
                          whiteSpace: "nowrap",
                          borderBottom: "1px solid #0047AB",
                          width: "68px",
                          minWidth: "68px",
                          boxSizing: "border-box",
                        }}
                      >
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {/* 1. EXCLUDING PIPELINE SECTION */}
                  <tr style={{ background: "#f0f5fc", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1", height: "42px" }}>
                    <td
                      colSpan={rollingMonths.length + 1}
                      style={{
                        background: "#f0f5fc",
                        fontWeight: 700,
                        color: "#0047AB",
                        padding: "11px 16px",
                        fontSize: "11px",
                        letterSpacing: "0.8px",
                        textTransform: "uppercase",
                        fontFamily: "'Kumbh Sans', sans-serif",
                      }}
                    >
                      <span style={{ position: "sticky", left: "14px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#9900ff" }} />
                        Excluding pipeline
                      </span>
                    </td>
                  </tr>

                  {/* Opening balance */}
                  <tr style={{ background: "#ffffff", borderBottom: "1px solid #f1f5f9", height: "42px" }}>
                    <td style={{ ...stickyColStyle, background: "#ffffff", color: "#334155" }}>Opening balance</td>
                    {exclOpening.map((val, idx) => (
                      <td key={idx} style={{ ...dataCellStyle, color: "#334155", background: "#ffffff" }}>
                        {val}
                      </td>
                    ))}
                  </tr>

                  {/* Net cash movement accordion */}
                  <tr
                    onClick={() => setExclOpen((prev) => !prev)}
                    style={{
                      cursor: "pointer",
                      background: "#f8fafc",
                      borderTop: "1px solid #e2e8f0",
                      borderBottom: "1px solid #e2e8f0",
                      height: "44px",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f1f5f9")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#f8fafc")}
                  >
                    <td
                      style={{
                        ...stickyColStyle,
                        background: "inherit",
                        fontWeight: 700,
                        color: "#0047AB",
                      }}
                    >
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 10 10"
                        style={{
                          display: "inline-block",
                          marginRight: "8px",
                          verticalAlign: "middle",
                          transition: "transform 0.2s ease",
                          transform: exclOpen ? "rotate(90deg)" : "rotate(0deg)",
                          transformOrigin: "center center",
                        }}
                      >
                        <polygon points="1.5,1 8.5,5 1.5,9" fill="#0047AB" />
                      </svg>
                      Net cash movement
                    </td>
                    {exclNet.map((val, idx) => (
                      <td
                        key={idx}
                        style={{
                          ...dataCellStyle,
                          fontWeight: 600,
                          background: "inherit",
                        }}
                      >
                        {val}
                      </td>
                    ))}
                  </tr>

                  {/* Sub-rows when open */}
                  {exclOpen &&
                    exclDetails.map((detail, dIdx) => {
                      if (isRowEmpty(detail.values)) return null;

                      return (
                        <tr
                          key={dIdx}
                          style={{ background: "#ffffff", borderBottom: "1px solid #f1f5f9" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#fafcff")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#ffffff")}
                        >
                          <td
                            style={{
                              ...stickyColStyle,
                              background: "inherit",
                              paddingLeft: "34px",
                              color: "#475569",
                              fontSize: "12px",
                              fontWeight: 400,
                            }}
                          >
                            {detail.label}
                          </td>
                          {detail.values.map((val, mIdx) => {
                            const isClickable = Boolean(detail.ddType && val && val !== "£0" && val !== "—");

                            return (
                              <td
                                key={mIdx}
                                onClick={(e) => isClickable && handleCellClick(e, detail.label, val, mIdx, detail.ddType)}
                                style={{
                                  ...dataCellStyle,
                                  background: "inherit",
                                  color: isClickable ? "#0047AB" : "#475569",
                                  fontSize: "12px",
                                  cursor: isClickable ? "pointer" : "default",
                                  textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                                  textUnderlineOffset: isClickable ? "2px" : "initial",
                                }}
                              >
                                {val}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}

                  {/* Closing balance (Milestone row) */}
                  <tr style={{ background: "rgba(0, 71, 171, 0.04)", borderTop: "2px solid #cbd5e1", borderBottom: "2px solid #cbd5e1", height: "46px" }}>
                    <td
                      style={{
                        ...stickyColStyle,
                        background: "rgba(0, 71, 171, 0.04)",
                        fontWeight: 800,
                        color: "#0047AB",
                        fontSize: "13.5px",
                        borderTop: "2px solid #cbd5e1",
                        borderBottom: "2px solid #cbd5e1",
                        padding: "13px 14px",
                      }}
                    >
                      Closing balance
                    </td>
                    {exclClosing.map((val, idx) => (
                      <td
                        key={idx}
                        style={{
                          ...dataCellStyle,
                          fontWeight: 800,
                          color: "#0047AB",
                          fontSize: "13.5px",
                          background: "rgba(0, 71, 171, 0.04)",
                          borderTop: "2px solid #cbd5e1",
                          borderBottom: "2px solid #cbd5e1",
                          padding: "13px 12px",
                        }}
                      >
                        {val}
                      </td>
                    ))}
                  </tr>

                  {/* Generous 3x spacer row between scenarios */}
                  <tr style={{ height: "54px", background: "#ffffff" }}>
                    <td colSpan={rollingMonths.length + 1} style={{ height: "54px", border: "none", background: "#ffffff" }} />
                  </tr>

                  {/* 2. INCLUDING PIPELINE SECTION */}
                  <tr style={{ background: "#f0f5fc", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1", height: "42px" }}>
                    <td
                      colSpan={rollingMonths.length + 1}
                      style={{
                        background: "#f0f5fc",
                        fontWeight: 700,
                        color: "#0047AB",
                        padding: "11px 16px",
                        fontSize: "11px",
                        letterSpacing: "0.8px",
                        textTransform: "uppercase",
                        fontFamily: "'Kumbh Sans', sans-serif",
                      }}
                    >
                      <span style={{ position: "sticky", left: "14px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#e69138" }} />
                        Including pipeline
                      </span>
                    </td>
                  </tr>

                  {/* Opening balance */}
                  <tr style={{ background: "#ffffff", borderBottom: "1px solid #f1f5f9", height: "42px" }}>
                    <td style={{ ...stickyColStyle, background: "#ffffff", color: "#334155" }}>Opening balance</td>
                    {inclOpening.map((val, idx) => (
                      <td key={idx} style={{ ...dataCellStyle, color: "#334155", background: "#ffffff" }}>
                        {val}
                      </td>
                    ))}
                  </tr>

                  {/* Net cash movement accordion */}
                  <tr
                    onClick={() => setInclOpen((prev) => !prev)}
                    style={{
                      cursor: "pointer",
                      background: "#f8fafc",
                      borderTop: "1px solid #e2e8f0",
                      borderBottom: "1px solid #e2e8f0",
                      height: "44px",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f1f5f9")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#f8fafc")}
                  >
                    <td
                      style={{
                        ...stickyColStyle,
                        background: "inherit",
                        fontWeight: 700,
                        color: "#0047AB",
                      }}
                    >
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 10 10"
                        style={{
                          display: "inline-block",
                          marginRight: "8px",
                          verticalAlign: "middle",
                          transition: "transform 0.2s ease",
                          transform: inclOpen ? "rotate(90deg)" : "rotate(0deg)",
                          transformOrigin: "center center",
                        }}
                      >
                        <polygon points="1.5,1 8.5,5 1.5,9" fill="#0047AB" />
                      </svg>
                      Net cash movement
                    </td>
                    {inclNet.map((val, idx) => (
                      <td
                        key={idx}
                        style={{
                          ...dataCellStyle,
                          fontWeight: 600,
                          background: "inherit",
                        }}
                      >
                        {val}
                      </td>
                    ))}
                  </tr>

                  {/* Sub-rows when open */}
                  {inclOpen &&
                    inclDetails.map((detail, dIdx) => {
                      if (isRowEmpty(detail.values)) return null;

                      return (
                        <tr
                          key={dIdx}
                          style={{ background: "#ffffff", borderBottom: "1px solid #f1f5f9" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#fafcff")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#ffffff")}
                        >
                          <td
                            style={{
                              ...stickyColStyle,
                              background: "inherit",
                              paddingLeft: "34px",
                              color: "#334155",
                              fontSize: "12px",
                              fontWeight: 400,
                            }}
                          >
                            {detail.label}
                          </td>
                          {detail.values.map((val, mIdx) => {
                            const isClickable = Boolean(detail.ddType && val && val !== "£0" && val !== "—");

                            return (
                              <td
                                key={mIdx}
                                onClick={(e) => isClickable && handleCellClick(e, detail.label, val, mIdx, detail.ddType)}
                                style={{
                                  ...dataCellStyle,
                                  background: "inherit",
                                  color: isClickable ? "#0047AB" : "#475569",
                                  fontSize: "12px",
                                  cursor: isClickable ? "pointer" : "default",
                                  textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                                  textUnderlineOffset: isClickable ? "2px" : "initial",
                                }}
                              >
                                {val}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}

                  {/* Closing balance (Milestone row) */}
                  <tr style={{ background: "rgba(0, 71, 171, 0.04)", borderTop: "2px solid #cbd5e1", borderBottom: "2px solid #cbd5e1", height: "46px" }}>
                    <td
                      style={{
                        ...stickyColStyle,
                        background: "rgba(0, 71, 171, 0.04)",
                        fontWeight: 800,
                        color: "#0047AB",
                        fontSize: "13.5px",
                        borderTop: "2px solid #cbd5e1",
                        borderBottom: "2px solid #cbd5e1",
                        padding: "13px 14px",
                      }}
                    >
                      Closing balance
                    </td>
                    {inclClosing.map((val, idx) => (
                      <td
                        key={idx}
                        style={{
                          ...dataCellStyle,
                          fontWeight: 800,
                          color: "#0047AB",
                          fontSize: "13.5px",
                          background: "rgba(0, 71, 171, 0.04)",
                          borderTop: "2px solid #cbd5e1",
                          borderBottom: "2px solid #cbd5e1",
                          padding: "13px 12px",
                        }}
                      >
                        {val}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Chart */}
        {data?.showChart !== false && (
          <div className="cashflow-col-right">
            <div
              className="cashflow-chart-card"
              style={{
                background: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
                padding: "16px 20px",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
                display: "flex",
                flexDirection: "column",
                boxSizing: "border-box",
                justifyContent: "space-between",
              }}
            >
              {/* Chart Header & Legend */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                  marginBottom: "10px",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    letterSpacing: "0.8px",
                    textTransform: "uppercase",
                    color: "#64748b",
                    fontFamily: "'Kumbh Sans', sans-serif",
                  }}
                >
                  CASHFLOW TRAJECTORY
                </div>

                {/* Legend - Both Lines Solid */}
                <div style={{ display: "flex", alignItems: "center", gap: "18px", fontSize: "11px", fontFamily: "'Kumbh Sans', sans-serif" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: "16px",
                        height: "3px",
                        background: "#9900ff",
                        borderRadius: "2px",
                      }}
                    />
                    <span style={{ fontWeight: 600, color: "#334155" }}>
                      Excluding pipeline
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: "16px",
                        height: "3px",
                        background: "#e69138",
                        borderRadius: "2px",
                      }}
                    />
                    <span style={{ fontWeight: 600, color: "#334155" }}>
                      Including pipeline
                    </span>
                  </div>
                </div>
              </div>

              {/* SVG Line Chart */}
              <div style={{ width: "100%", flex: 1, minHeight: 0, position: "relative" }}>
                <svg
                  viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                  style={{ width: "100%", height: "100%", display: "block" }}
                >
                  <defs>
                    <linearGradient id="cfExclGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#9900ff" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#9900ff" stopOpacity="0.0" />
                    </linearGradient>
                    <linearGradient id="cfInclGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e69138" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="#e69138" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal Gridlines & Y-axis labels (Aligned left with heading, 16px font) */}
                  {yTicks.map((yVal, idx) => {
                    const yPos = getY(yVal);
                    return (
                      <g key={idx}>
                        <line
                          x1={padLeft}
                          y1={yPos}
                          x2={svgWidth - padRight}
                          y2={yPos}
                          stroke="#f1f5f9"
                          strokeWidth="1"
                        />
                        <text
                          x={0}
                          y={yPos + 5}
                          textAnchor="start"
                          fontSize="16"
                          fontWeight="600"
                          fill="#64748b"
                          fontFamily="'Kumbh Sans', sans-serif"
                        >
                          {formatShortMoney(yVal)}
                        </text>
                      </g>
                    );
                  })}

                  {/* Zero baseline if in range */}
                  {minVal <= 0 && maxVal >= 0 && (
                    <line
                      x1={padLeft}
                      y1={getY(0)}
                      x2={svgWidth - padRight}
                      y2={getY(0)}
                      stroke="#cbd5e1"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                    />
                  )}

                  {/* Area Gradient Glows under curves */}
                  {exclArea && <path d={exclArea} fill="url(#cfExclGrad)" />}
                  {inclArea && <path d={inclArea} fill="url(#cfInclGrad)" />}

                  {/* X-axis Month Labels (16px font, padded right to prevent cutoff) */}
                  {rollingMonths.map((m, idx) => (
                    <text
                      key={idx}
                      x={getX(idx)}
                      y={svgHeight - 12}
                      textAnchor="middle"
                      fontSize="16"
                      fontWeight="600"
                      fill="#64748b"
                      fontFamily="'Kumbh Sans', sans-serif"
                    >
                      {m}
                    </text>
                  ))}

                  {/* Trajectory Lines - Both Solid */}
                  {/* Excluding Pipeline Line (Purple Solid) */}
                  <path
                    d={exclPath}
                    fill="none"
                    stroke="#9900ff"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />

                  {/* Including Pipeline Line (Amber Solid) */}
                  <path
                    d={inclPath}
                    fill="none"
                    stroke="#e69138"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />

                  {/* Data Points */}
                  {rollingMonths.map((_, idx) => {
                    const exVal = exclClosingNums[idx];
                    const inVal = inclClosingNums[idx];
                    const cx = getX(idx);
                    const cyEx = getY(exVal);
                    const cyIn = getY(inVal);

                    return (
                      <g key={idx}>
                        {/* Excluding circle */}
                        <circle
                          cx={cx}
                          cy={cyEx}
                          r="4.5"
                          fill="#9900ff"
                          stroke="#ffffff"
                          strokeWidth="2"
                          style={{ cursor: "pointer" }}
                          onMouseEnter={() => setHoveredPoint({ idx, month: rollingMonths[idx], exVal, inVal, cx, cy: cyEx })}
                          onMouseLeave={() => setHoveredPoint(null)}
                        />
                        {/* Including circle */}
                        <circle
                          cx={cx}
                          cy={cyIn}
                          r="4.5"
                          fill="#e69138"
                          stroke="#ffffff"
                          strokeWidth="2"
                          style={{ cursor: "pointer" }}
                          onMouseEnter={() => setHoveredPoint({ idx, month: rollingMonths[idx], exVal, inVal, cx, cy: cyIn })}
                          onMouseLeave={() => setHoveredPoint(null)}
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* Tooltip on point hover */}
                {hoveredPoint && (
                  <div
                    style={{
                      position: "absolute",
                      left: `${(hoveredPoint.cx / svgWidth) * 100}%`,
                      top: `${(hoveredPoint.cy / svgHeight) * 100}%`,
                      transform: "translate(-50%, -120%)",
                      background: "#0f172a",
                      color: "#ffffff",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "11px",
                      pointerEvents: "none",
                      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                      zIndex: 10,
                      whiteSpace: "nowrap",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                      fontFamily: "'Kumbh Sans', sans-serif",
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "#e2e8f0", borderBottom: "1px solid rgba(255, 255, 255, 0.15)", paddingBottom: "2px" }}>
                      {hoveredPoint.month}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#d8b4fe" }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#9900ff" }} />
                      <span>Excl: <strong>{formatMoney(hoveredPoint.exVal)}</strong></span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#fde68a" }}>
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#e69138" }} />
                      <span>Incl: <strong>{formatMoney(hoveredPoint.inVal)}</strong></span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .cashflow-workspace-grid {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          column-gap: 28px;
          row-gap: 24px;
          align-items: start;
          width: 100%;
          box-sizing: border-box;
        }
        .cashflow-col-left {
          display: flex;
          flex-direction: column;
          width: fit-content;
          max-width: 100%;
          min-width: 0;
        }
        .cashflow-col-right {
          display: flex;
          flex-direction: column;
          width: 100%;
          min-width: 0;
          align-self: start;
        }
        .cashflow-chart-card {
          height: 448px;
          min-height: 448px;
          max-height: 448px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        @media (max-width: 1150px) {
          .cashflow-workspace-grid {
            display: flex;
            flex-direction: column;
            gap: 24px;
          }
          .cashflow-col-left {
            width: 100%;
          }
          .cashflow-col-right {
            height: auto !important;
          }
          .cashflow-chart-card {
            height: 420px !important;
            min-height: 420px !important;
            max-height: none !important;
          }
        }
      `}</style>
    </div>
  );
}

const stickyColStyle = {
  padding: "11px 10px",
  textAlign: "left",
  position: "sticky",
  left: 0,
  background: "#ffffff",
  zIndex: 5,
  fontWeight: 500,
  color: "#0f172a",
  borderRight: "2px solid #cbd5e1",
  whiteSpace: "nowrap",
  width: "190px",
  minWidth: "190px",
  maxWidth: "190px",
  boxSizing: "border-box",
};

const dataCellStyle = {
  padding: "11px 6px",
  textAlign: "right",
  color: "#0047AB",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  boxSizing: "border-box",
};
