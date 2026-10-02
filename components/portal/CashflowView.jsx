import React, { useState } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData } from "../../services/deepDiveHelper";

export default function CashflowView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
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
          Loading {clientName} cashflow forecast...
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
    const matching = rows.filter((r) => {
      if (rowIndices.includes(r.rowIndex)) return true;
      const l = (r.label || "").toLowerCase();
      return labelPatterns.some((p) => l.includes(p.toLowerCase()));
    });

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
  const exclOpening = getValues(exclRows, ["opening balance"], [3]);
  const exclNet = getValues(exclRows, ["net cash movement"], [31]);
  const exclClosing = getValues(exclRows, ["closing balance"], [33]);

  const exclDetails = [
    { label: "Confirmed cash incoming", values: getValues(exclRows, ["confirmed cash"], [5]), ddType: "cashConfInflow" },
    { label: "Salaries", values: getValues(exclRows, ["salaries", "delivery salaries"], [7, 8]), ddType: "cashSalaries" },
    { label: "Dividends as salary", values: getValues(exclRows, ["dividends as salary"], [9, 10]), ddType: "cashDividends" },
    { label: "Contractors", values: getValues(exclRows, ["contractors"], [11, 12]), ddType: "cashContractors" },
    { label: "Direct costs", values: getValues(exclRows, ["direct costs"], [13, 14]), ddType: "cashDirCosts" },
    { label: "Other expenses", values: getValues(exclRows, ["other expenses"], [15, 16]), ddType: "cashOutgoings" },
    { label: "Corporation tax", values: getValues(exclRows, ["corporation tax"], [18, 19]), ddType: null },
    { label: "VAT", values: getValues(exclRows, ["vat"], [20, 21]), ddType: null },
    { label: "Non-operating income", values: getValues(exclRows, ["non-operating income"], [23, 24]), ddType: null },
    { label: "Non-operating expenses", values: getValues(exclRows, ["non-operating exp"], [25, 26]), ddType: null },
    { label: "Other cash movements", values: getValues(exclRows, ["other cash"], [28, 29]), ddType: null },
  ];

  const inclOpening = getValues(inclRows, ["opening balance"], [44]);
  const inclNet = getValues(inclRows, ["net cash movement"], [73]);
  const inclClosing = getValues(inclRows, ["closing balance"], [75]);

  const inclDetails = [
    { label: "Confirmed cash incoming", values: getValues(inclRows, ["confirmed cash"], [46]), ddType: "cashConfInflow" },
    { label: "Pipeline cash incoming", values: getValues(inclRows, ["pipeline cash"], [47]), ddType: "cashPipeInflow" },
    { label: "Salaries", values: getValues(inclRows, ["salaries", "delivery salaries"], [49, 50]), ddType: "cashSalaries" },
    { label: "Dividends as salary", values: getValues(inclRows, ["dividends as salary"], [51, 52]), ddType: "cashDividends" },
    { label: "Contractors", values: getValues(inclRows, ["contractors"], [53, 54]), ddType: "cashContractors" },
    { label: "Direct costs", values: getValues(inclRows, ["direct costs"], [55, 56]), ddType: "cashDirCosts" },
    { label: "Other expenses", values: getValues(inclRows, ["other expenses"], [57, 58]), ddType: "cashOutgoings" },
    { label: "Corporation tax", values: getValues(inclRows, ["corporation tax"], [60, 61]), ddType: null },
    { label: "VAT", values: getValues(inclRows, ["vat"], [62, 63]), ddType: null },
    { label: "Non-operating income", values: getValues(inclRows, ["non-operating income"], [65, 66]), ddType: null },
    { label: "Non-operating expenses", values: getValues(inclRows, ["non-operating exp"], [67, 68]), ddType: null },
    { label: "Other cash movements", values: getValues(inclRows, ["other cash"], [70, 71]), ddType: null },
  ];

  const isRowEmpty = (vals) => vals.every((v) => Math.abs(parseMoney(v)) < 0.01);

  // Line chart numbers
  const exclClosingNums = exclClosing.map(parseMoney);
  const inclClosingNums = inclClosing.map(parseMoney);

  const allNums = [...exclClosingNums, ...inclClosingNums];
  const maxVal = Math.max(...allNums, 1000);
  const minVal = Math.min(...allNums, 0);
  const range = maxVal - minVal || 1;

  // Chart coordinates
  const svgWidth = 700;
  const svgHeight = 260;
  const padLeft = 70;
  const padRight = 30;
  const padTop = 30;
  const padBottom = 40;

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
        onClose={() => setActivePopover(null)}
      />

      {/* Action Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          maxWidth: "75%",
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

      {/* Main Cashflow Table Container (Matching WebApp.html 75% max width on desktop) */}
      <div style={{ maxWidth: "75%", width: "100%" }}>
        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          }}
        >
          <div style={{ overflowX: "auto", width: "100%" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                fontSize: "13px",
                fontFamily: "'Kumbh Sans', sans-serif",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      background: "#3C78D8",
                      color: "#ffffff",
                      padding: "10px 14px",
                      textAlign: "left",
                      position: "sticky",
                      left: 0,
                      zIndex: 20,
                      fontWeight: 700,
                      width: "30%",
                      borderBottom: "1px solid #e2e8f0",
                    }}
                  />
                  {rollingMonths.map((m, idx) => (
                    <th
                      key={idx}
                      style={{
                        background: "#3C78D8",
                        color: "#ffffff",
                        padding: "10px 12px",
                        textAlign: "right",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                        borderBottom: "1px solid #e2e8f0",
                        width: "10%",
                      }}
                    >
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {/* 1. EXCLUDING PIPELINE SECTION */}
                <tr style={{ background: "#e2e8f0" }}>
                  <td
                    colSpan={rollingMonths.length + 1}
                    style={{
                      background: "#e2e8f0",
                      fontWeight: 700,
                      color: "#0f172a",
                      padding: "10px 14px",
                      fontSize: "12px",
                      letterSpacing: "0.3px",
                    }}
                  >
                    Excluding pipeline
                  </td>
                </tr>

                {/* Opening balance */}
                <tr style={{ background: "#efefef", borderBottom: "1px solid #e2e8f0" }}>
                  <td style={{ ...stickyColStyle, background: "#efefef" }}>Opening balance</td>
                  {exclOpening.map((val, idx) => (
                    <td key={idx} style={{ ...dataCellStyle, background: "#efefef" }}>
                      {val}
                    </td>
                  ))}
                </tr>

                {/* Net cash movement accordion */}
                <tr
                  onClick={() => setExclOpen((prev) => !prev)}
                  style={{
                    cursor: "pointer",
                    background: "#f1f5f9",
                    borderTop: "1px solid #cbd5e1",
                    borderBottom: "2px solid #cbd5e1",
                  }}
                >
                  <td
                    style={{
                      ...stickyColStyle,
                      background: "#f1f5f9",
                      fontWeight: 700,
                      color: "#0047AB",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        transition: "transform 0.2s ease",
                        marginRight: "6px",
                        fontSize: "0.8em",
                        color: "#0047AB",
                        transform: exclOpen ? "rotate(90deg)" : "rotate(0deg)",
                      }}
                    >
                      ▶
                    </span>
                    Net cash movement
                  </td>
                  {exclNet.map((val, idx) => (
                    <td
                      key={idx}
                      style={{
                        ...dataCellStyle,
                        fontWeight: 600,
                        background: "#f1f5f9",
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
                      <tr key={dIdx} style={{ background: "#efefef", borderBottom: "1px solid #e2e8f0" }}>
                        <td
                          style={{
                            ...stickyColStyle,
                            background: "#efefef",
                            paddingLeft: "30px",
                            color: "#334155",
                            fontSize: "12.5px",
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
                                background: "#efefef",
                                color: isClickable ? "#0047AB" : "#475569",
                                fontSize: "12px",
                                cursor: isClickable ? "pointer" : "default",
                                textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                                textUnderlineOffset: isClickable ? "2px" : "initial",
                              }}
                              onMouseEnter={(e) => {
                                if (isClickable) e.currentTarget.style.backgroundColor = "#e2e8f0";
                              }}
                              onMouseLeave={(e) => {
                                if (isClickable) e.currentTarget.style.backgroundColor = "#efefef";
                              }}
                            >
                              {val}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                {/* Closing balance */}
                <tr style={{ background: "#f1f5f9", borderTop: "2px solid #94a3b8" }}>
                  <td
                    style={{
                      ...stickyColStyle,
                      background: "#f1f5f9",
                      fontWeight: 800,
                      color: "#0047AB",
                      borderTop: "2px solid #94a3b8",
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
                        background: "#f1f5f9",
                        borderTop: "2px solid #94a3b8",
                      }}
                    >
                      {val}
                    </td>
                  ))}
                </tr>

                {/* White spacer row */}
                <tr style={{ height: "20px", background: "#ffffff" }}>
                  <td colSpan={rollingMonths.length + 1} style={{ border: "none", background: "#ffffff" }} />
                </tr>

                {/* 2. INCLUDING PIPELINE SECTION */}
                <tr style={{ background: "#e2e8f0" }}>
                  <td
                    colSpan={rollingMonths.length + 1}
                    style={{
                      background: "#e2e8f0",
                      fontWeight: 700,
                      color: "#0f172a",
                      padding: "10px 14px",
                      fontSize: "12px",
                      letterSpacing: "0.3px",
                      borderTop: "2px solid #cbd5e1",
                    }}
                  >
                    Including pipeline
                  </td>
                </tr>

                {/* Opening balance */}
                <tr style={{ background: "#efefef", borderBottom: "1px solid #e2e8f0" }}>
                  <td style={{ ...stickyColStyle, background: "#efefef" }}>Opening balance</td>
                  {inclOpening.map((val, idx) => (
                    <td key={idx} style={{ ...dataCellStyle, background: "#efefef" }}>
                      {val}
                    </td>
                  ))}
                </tr>

                {/* Net cash movement accordion */}
                <tr
                  onClick={() => setInclOpen((prev) => !prev)}
                  style={{
                    cursor: "pointer",
                    background: "#f1f5f9",
                    borderTop: "1px solid #cbd5e1",
                    borderBottom: "2px solid #cbd5e1",
                  }}
                >
                  <td
                    style={{
                      ...stickyColStyle,
                      background: "#f1f5f9",
                      fontWeight: 700,
                      color: "#0047AB",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        transition: "transform 0.2s ease",
                        marginRight: "6px",
                        fontSize: "0.8em",
                        color: "#0047AB",
                        transform: inclOpen ? "rotate(90deg)" : "rotate(0deg)",
                      }}
                    >
                      ▶
                    </span>
                    Net cash movement
                  </td>
                  {inclNet.map((val, idx) => (
                    <td
                      key={idx}
                      style={{
                        ...dataCellStyle,
                        fontWeight: 600,
                        background: "#f1f5f9",
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
                      <tr key={dIdx} style={{ background: "#efefef", borderBottom: "1px solid #e2e8f0" }}>
                        <td
                          style={{
                            ...stickyColStyle,
                            background: "#efefef",
                            paddingLeft: "30px",
                            color: "#334155",
                            fontSize: "12.5px",
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
                                background: "#efefef",
                                color: isClickable ? "#0047AB" : "#475569",
                                fontSize: "12px",
                                cursor: isClickable ? "pointer" : "default",
                                textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                                textUnderlineOffset: isClickable ? "2px" : "initial",
                              }}
                              onMouseEnter={(e) => {
                                if (isClickable) e.currentTarget.style.backgroundColor = "#e2e8f0";
                              }}
                              onMouseLeave={(e) => {
                                if (isClickable) e.currentTarget.style.backgroundColor = "#efefef";
                              }}
                            >
                              {val}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                {/* Closing balance */}
                <tr style={{ background: "#f1f5f9", borderTop: "2px solid #94a3b8" }}>
                  <td
                    style={{
                      ...stickyColStyle,
                      background: "#f1f5f9",
                      fontWeight: 800,
                      color: "#0047AB",
                      borderTop: "2px solid #94a3b8",
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
                        background: "#f1f5f9",
                        borderTop: "2px solid #94a3b8",
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

        {/* Closing Balance Trajectory Line Chart (Positioned at bottom of page) */}
        <div
          style={{
            marginTop: "2rem",
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            padding: "1.25rem 1.5rem",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          }}
        >
          {/* Chart Header & Legend */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              marginBottom: "1rem",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
              Closing Balance Forecast
            </span>

            {/* Legend */}
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: "18px",
                    height: "3px",
                    borderTop: "2.5px dashed #8B5CF6",
                  }}
                />
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#8B5CF6" }}>
                  Excluding pipeline
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: "18px",
                    height: "3px",
                    borderTop: "2.5px dashed #F59E0B",
                  }}
                />
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#F59E0B" }}>
                  Including pipeline
                </span>
              </div>
            </div>
          </div>

          {/* SVG Line Chart */}
          <div style={{ width: "100%", position: "relative" }}>
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              style={{ width: "100%", height: "auto", display: "block" }}
            >
              {/* Horizontal Gridlines & Y-axis labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                const yVal = minVal + ratio * range;
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
                      x={padLeft - 10}
                      y={yPos + 4}
                      textAnchor="end"
                      fontSize="10"
                      fill="#94a3b8"
                      fontFamily="'Kumbh Sans', sans-serif"
                    >
                      £{Math.round(yVal / 1000)}k
                    </text>
                  </g>
                );
              })}

              {/* Zero baseline if in range */}
              {minVal < 0 && maxVal > 0 && (
                <line
                  x1={padLeft}
                  y1={getY(0)}
                  x2={svgWidth - padRight}
                  y2={getY(0)}
                  stroke="#cbd5e1"
                  strokeWidth="1.5"
                  strokeDasharray="2,2"
                />
              )}

              {/* X-axis Month Labels */}
              {rollingMonths.map((m, idx) => (
                <text
                  key={idx}
                  x={getX(idx)}
                  y={svgHeight - 12}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="#64748b"
                  fontFamily="'Kumbh Sans', sans-serif"
                >
                  {m}
                </text>
              ))}

              {/* Excluding Pipeline Line (Purple Dashed) */}
              <path
                d={exclPath}
                fill="none"
                stroke="#8B5CF6"
                strokeWidth="2"
                strokeDasharray="5,5"
              />

              {/* Including Pipeline Line (Orange Dashed) */}
              <path
                d={inclPath}
                fill="none"
                stroke="#F59E0B"
                strokeWidth="2"
                strokeDasharray="5,5"
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
                      r="4"
                      fill="#8B5CF6"
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      style={{ cursor: "pointer" }}
                      onMouseEnter={() => setHoveredPoint({ idx, month: rollingMonths[idx], exVal, inVal, cx, cyEx })}
                      onMouseLeave={() => setHoveredPoint(null)}
                    />
                    {/* Including circle */}
                    <circle
                      cx={cx}
                      cy={cyIn}
                      r="4"
                      fill="#F59E0B"
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      style={{ cursor: "pointer" }}
                      onMouseEnter={() => setHoveredPoint({ idx, month: rollingMonths[idx], exVal, inVal, cx, cyIn })}
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
                  top: `${(hoveredPoint.cyEx / svgHeight) * 100}%`,
                  transform: "translate(-50%, -115%)",
                  background: "#0f172a",
                  color: "#ffffff",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  pointerEvents: "none",
                  boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                  zIndex: 10,
                  whiteSpace: "nowrap",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: "3px" }}>{hoveredPoint.month}</div>
                <div style={{ color: "#c4b5fd" }}>Excl: {formatMoney(hoveredPoint.exVal)}</div>
                <div style={{ color: "#fde68a" }}>Incl: {formatMoney(hoveredPoint.inVal)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const stickyColStyle = {
  padding: "9px 14px",
  textAlign: "left",
  position: "sticky",
  left: 0,
  background: "#efefef",
  zIndex: 5,
  fontWeight: 500,
  color: "#0f172a",
  borderRight: "2px solid #cbd5e1",
  whiteSpace: "nowrap",
};

const dataCellStyle = {
  padding: "9px 12px",
  textAlign: "right",
  color: "#0047AB",
  whiteSpace: "nowrap",
};
