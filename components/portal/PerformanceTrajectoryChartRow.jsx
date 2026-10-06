import React, { useState, useId } from "react";
import { formatMoney, getCurrencySymbol, getThousandsSeparator } from "../../services/deepDiveHelper";

/**
 * PerformanceTrajectoryChartRow
 * 
 * Performance trajectory chart sitting beneath the performance table.
 * Visualises Revenue/Income (Purple), Gross Profit (Amber), and Operating Profit (Cobalt Blue).
 * 
 * Key Architectural Alignment:
 * - Shares the exact column geometry of the table above (19% / 240px left, 73.2% / N*96px month zone, 7.8% / 110px right).
 * - Data points sit at (i + 0.5) * colWidth, aligning perfectly with the middle of each month column in the table above.
 * - Sits below the table with generous white space (3x previous spacing), without an obvious card border.
 * - Solid lines for Actual months and dashed lines for Forecast months.
 * - Vertical dividing line sitting directly ON the last "Actual" month, labelled with "ACTUAL" (left) and "FORECAST" (right).
 * - Month labels displayed along the X-axis directly beneath each month's data point.
 * - Clean Y-axis scale in the left column matching horizontal gridlines.
 * - Centered legend placed underneath the chart.
 * - Interactive hover guideline & tooltip showing exact figures.
 */
export default function PerformanceTrajectoryChartRow({
  months = [],
  statuses = [],
  revenue = [],
  grossProfit = [],
  operatingProfit = [],
  revenueLabel = "Revenue",
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  layout = "fy", // "fy" (percentage widths) or "ytd" (fixed pixel widths)
  scrollRef = null,
  onScroll = null,
}) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const reactId = useId().replace(/:/g, "_");

  if (!months || months.length === 0) return null;

  // Geometry configuration
  const colSvgW = layout === "fy" ? 100 : 96;
  const svgW = months.length * colSvgW;
  const svgH = 260;
  const paddingTop = 28;
  const paddingBottom = 34;
  const chartH = svgH - paddingTop - paddingBottom;

  // Calculate Last Actual Month Index
  let lastActualIdx = -1;
  for (let i = 0; i < months.length; i++) {
    const st = String(statuses[i] || "").trim().toLowerCase();
    if (st === "actual") {
      lastActualIdx = i;
    }
  }

  // If statuses array is empty or lacks actual markers, default all to actual
  if (statuses.length === 0 || !statuses.some((s) => String(s).trim().toLowerCase() === "actual")) {
    lastActualIdx = months.length - 1;
  }

  // Min / Max calculation with sensible whole-number Y scale ticks
  const allVals = [...revenue, ...grossProfit, ...operatingProfit].filter(
    (v) => typeof v === "number" && !isNaN(v)
  );
  const rawMax = Math.max(...allVals, 10000);
  const rawMin = Math.min(...allVals, 0);

  const targetTicks = 4;
  const span = Math.max(rawMax - (rawMin < 0 ? rawMin : 0), 10000);
  const roughStep = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceFactor = 1;
  if (residual > 7) niceFactor = 10;
  else if (residual > 3.5) niceFactor = 5;
  else if (residual > 1.8) niceFactor = 2;
  else niceFactor = 1;
  const step = Math.max(niceFactor * magnitude, 1000);

  const minTick = rawMin < 0 ? Math.floor(rawMin / step) * step : 0;
  const maxTick = Math.max(Math.ceil(rawMax / step) * step, minTick + step * targetTicks);

  const yTicks = [];
  for (let val = minTick; val <= maxTick + step * 0.01; val += step) {
    yTicks.push(val);
  }

  const chartMin = minTick;
  const chartMax = maxTick;
  const range = chartMax - chartMin || 1;

  const getX = (i) => (i + 0.5) * colSvgW;
  const getY = (val) => paddingTop + chartH - ((val - chartMin) / range) * chartH;

  const currencySymbol = getCurrencySymbol(propCurrencySymbol);
  const thousandsSeparator = getThousandsSeparator(propThousandsSeparator);

  // Formatters
  const formatShortMoney = (n) => {
    if (n === 0) return `${currencySymbol}0`;
    const abs = Math.abs(n);
    if (abs >= 1000000) return `${n < 0 ? "-" : ""}${currencySymbol}${(abs / 1000000).toFixed(1)}m`;
    if (abs >= 1000) return `${n < 0 ? "-" : ""}${currencySymbol}${Math.round(abs / 1000)}k`;
    return `${n < 0 ? "-" : ""}${currencySymbol}${Math.round(abs)}`;
  };

  const formatFullMoney = (n) => {
    return formatMoney(n, 0, currencySymbol, thousandsSeparator);
  };

  // Build Bézier path string
  const buildSmoothSegment = (pts) => {
    if (!pts || pts.length === 0) return "";
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const mx = (p0.x + p1.x) / 2;
      d += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  const buildAreaPath = (linePath, firstPt, lastPt) => {
    if (!linePath || !firstPt || !lastPt) return "";
    const bottomY = getY(Math.max(0, chartMin));
    return `${linePath} L ${lastPt.x} ${bottomY} L ${firstPt.x} ${bottomY} Z`;
  };

  // Series points
  const revPts = revenue.map((val, i) => ({ x: getX(i), y: getY(val), val, idx: i }));
  const gpPts = grossProfit.map((val, i) => ({ x: getX(i), y: getY(val), val, idx: i }));
  const opPts = operatingProfit.map((val, i) => ({ x: getX(i), y: getY(val), val, idx: i }));

  // Gradient area paths
  const fullRevPath = buildSmoothSegment(revPts);
  const fullGpPath = buildSmoothSegment(gpPts);
  const fullOpPath = buildSmoothSegment(opPts);

  const revArea = buildAreaPath(fullRevPath, revPts[0], revPts[revPts.length - 1]);
  const gpArea = buildAreaPath(fullGpPath, gpPts[0], gpPts[gpPts.length - 1]);
  const opArea = buildAreaPath(fullOpPath, opPts[0], opPts[opPts.length - 1]);

  // Actual vs Forecast Line Paths
  const getLineSegments = (pts) => {
    if (pts.length === 0) return { actual: "", forecast: "" };
    if (lastActualIdx < 0) {
      return { actual: "", forecast: buildSmoothSegment(pts) };
    }
    if (lastActualIdx >= pts.length - 1) {
      return { actual: buildSmoothSegment(pts), forecast: "" };
    }
    // Mixed: Actual from 0..lastActualIdx, Forecast from lastActualIdx..end
    const actualSegment = buildSmoothSegment(pts.slice(0, lastActualIdx + 1));
    const forecastSegment = buildSmoothSegment(pts.slice(lastActualIdx, pts.length));
    return { actual: actualSegment, forecast: forecastSegment };
  };

  const revSegments = getLineSegments(revPts);
  const gpSegments = getLineSegments(gpPts);
  const opSegments = getLineSegments(opPts);

  // Transition divider coordinate: sits directly ON the last actual month column
  const hasDivider = lastActualIdx >= 0 && lastActualIdx < months.length - 1;
  const xDiv = getX(lastActualIdx);

  // Mouse move handler for column tooltip & guide
  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const colW = rect.width / Math.max(1, months.length);
    const idx = Math.floor(relX / colW);
    if (idx >= 0 && idx < months.length) {
      setHoveredIdx(idx);
    }
  };

  const handleMouseLeave = () => setHoveredIdx(null);

  // Active hover data
  const hoveredMonth = hoveredIdx !== null ? months[hoveredIdx] : null;
  const hoveredIsActual = hoveredIdx !== null ? hoveredIdx <= lastActualIdx : true;
  const hoveredRev = hoveredIdx !== null ? revenue[hoveredIdx] : null;
  const hoveredGp = hoveredIdx !== null ? grossProfit[hoveredIdx] : null;
  const hoveredOp = hoveredIdx !== null ? operatingProfit[hoveredIdx] : null;

  return (
    <div
      className="fy-chart-scroll-wrapper"
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        width: layout === "fy" ? "100%" : "fit-content",
        maxWidth: "100%",
        marginTop: "38px",
        background: "transparent",
        border: "none",
        borderLeft: "1px solid transparent",
        borderRight: "1px solid transparent",
        boxSizing: "border-box",
        boxShadow: "none",
        overflowX: "auto",
      }}
    >
      <table
        style={{
          width: layout === "fy" ? "100%" : "max-content",
          minWidth: layout === "fy" ? "980px" : undefined,
          tableLayout: "fixed",
          borderCollapse: "separate",
          borderSpacing: 0,
          border: "none",
          background: "transparent",
        }}
      >
        <colgroup>
          <col
            style={{
              ...(layout === "fy"
                ? { width: "19%", minWidth: "19%" }
                : { width: "240px", minWidth: "240px", maxWidth: "240px" }),
            }}
          />
          {months.map((_, idx) => (
            <col
              key={idx}
              style={{
                ...(layout === "fy"
                  ? { width: "6.1%", minWidth: "6.1%" }
                  : { width: "96px", minWidth: "96px", maxWidth: "96px" }),
              }}
            />
          ))}
          <col
            style={{
              ...(layout === "fy"
                ? { width: "7.8%", minWidth: "7.8%" }
                : { width: "110px", minWidth: "110px", maxWidth: "110px" }),
            }}
          />
        </colgroup>
        <tbody>
          <tr>
            {/* Left Column: Y-Axis Ticks (width: 19% on FY, 240px on YTD), clean without box border */}
            <td
              style={{
                padding: 0,
                verticalAlign: "top",
                border: "none",
                position: "sticky",
                left: 0,
                zIndex: 3,
                background: "#ffffff",
                ...(layout === "fy"
                  ? { width: "19%", minWidth: "19%" }
                  : { width: "240px", minWidth: "240px", maxWidth: "240px" }),
              }}
            >
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  height: `${svgH}px`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: "70px",
                    pointerEvents: "none",
                  }}
                >
                  <svg width="70" height={svgH} style={{ display: "block" }}>
                    {yTicks.map((tick, i) => (
                      <text
                        key={i}
                        x="62"
                        y={getY(tick) + 3.5}
                        textAnchor="end"
                        fontSize="10"
                        fontWeight={tick === 0 ? "700" : "500"}
                        fill={tick === 0 ? "#1e293b" : "#64748b"}
                        fontFamily="'Kumbh Sans', sans-serif"
                      >
                        {formatShortMoney(tick)}
                      </text>
                    ))}
                  </svg>
                </div>
              </div>
            </td>

            {/* Center Month Zone: colSpan={months.length} (width: 73.2% on FY, N*96px on YTD), no borders */}
            <td
              colSpan={months.length}
              style={{
                padding: 0,
                verticalAlign: "top",
                border: "none",
                background: "transparent",
                width: layout === "fy" ? "73.2%" : `${months.length * 96}px`,
                minWidth: layout === "fy" ? "73.2%" : `${months.length * 96}px`,
              }}
            >
              <div
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
                style={{
                  position: "relative",
                  width: "100%",
                  cursor: "crosshair",
                }}
              >
                <svg
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  preserveAspectRatio="none"
                  style={{
                    width: layout === "fy" ? "100%" : `${svgW}px`,
                    height: `${svgH}px`,
                    display: "block",
                  }}
                >
                  <defs>
                    <linearGradient id={`${reactId}_revGrad`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#9900ff" stopOpacity="0.22" />
                      <stop offset="100%" stopColor="#9900ff" stopOpacity="0.0" />
                    </linearGradient>
                    <linearGradient id={`${reactId}_gpGrad`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e69138" stopOpacity="0.20" />
                      <stop offset="100%" stopColor="#e69138" stopOpacity="0.0" />
                    </linearGradient>
                    <linearGradient id={`${reactId}_opGrad`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1155cc" stopOpacity="0.22" />
                      <stop offset="100%" stopColor="#1155cc" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal Gridlines */}
                  {yTicks.map((tick, i) => {
                    const y = getY(tick);
                    const isZero = tick === 0;
                    return (
                      <line
                        key={i}
                        x1="0"
                        y1={y}
                        x2={svgW}
                        y2={y}
                        stroke={isZero ? "#94a3b8" : "#f1f5f9"}
                        strokeWidth={isZero ? "1.5" : "1"}
                        strokeDasharray={isZero ? "4 3" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}

                  {/* Glowing Gradient Area Fills */}
                  {revArea && <path d={revArea} fill={`url(#${reactId}_revGrad)`} />}
                  {gpArea && <path d={gpArea} fill={`url(#${reactId}_gpGrad)`} />}
                  {opArea && <path d={opArea} fill={`url(#${reactId}_opGrad)`} />}

                  {/* Actual / Forecast Vertical Divider sitting directly ON the last actual month */}
                  {hasDivider && (
                    <g className="actual-forecast-divider">
                      <line
                        x1={xDiv}
                        y1={paddingTop - 6}
                        x2={xDiv}
                        y2={paddingTop + chartH}
                        stroke="#0047AB"
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                        opacity="0.6"
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* Actual pill label on left of line */}
                      <rect
                        x={xDiv - 52}
                        y={paddingTop - 22}
                        width="46"
                        height="17"
                        rx="3"
                        fill="#f8fafc"
                        stroke="#e2e8f0"
                        strokeWidth="1"
                      />
                      <text
                        x={xDiv - 29}
                        y={paddingTop - 10}
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="#64748b"
                        fontFamily="'Kumbh Sans', sans-serif"
                        letterSpacing="0.4px"
                      >
                        ACTUAL
                      </text>
                      {/* Forecast pill label on right of line */}
                      <rect
                        x={xDiv + 6}
                        y={paddingTop - 22}
                        width="58"
                        height="17"
                        rx="3"
                        fill="rgba(0, 71, 171, 0.08)"
                        stroke="rgba(0, 71, 171, 0.2)"
                        strokeWidth="1"
                      />
                      <text
                        x={xDiv + 35}
                        y={paddingTop - 10}
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="#0047AB"
                        fontFamily="'Kumbh Sans', sans-serif"
                        letterSpacing="0.4px"
                      >
                        FORECAST
                      </text>
                    </g>
                  )}

                  {/* Active Hover Column Guideline */}
                  {hoveredIdx !== null && (
                    <line
                      x1={getX(hoveredIdx)}
                      y1={paddingTop - 6}
                      x2={getX(hoveredIdx)}
                      y2={paddingTop + chartH + 6}
                      stroke="#0047AB"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                      opacity="0.45"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}

                  {/* Revenue Curves: Solid for Actuals, Dashed for Forecast */}
                  {revSegments.actual && (
                    <path
                      d={revSegments.actual}
                      fill="none"
                      stroke="#9900ff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {revSegments.forecast && (
                    <path
                      d={revSegments.forecast}
                      fill="none"
                      stroke="#9900ff"
                      strokeWidth="2.5"
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}

                  {/* Gross Profit Curves: Solid for Actuals, Dashed for Forecast */}
                  {gpSegments.actual && (
                    <path
                      d={gpSegments.actual}
                      fill="none"
                      stroke="#e69138"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {gpSegments.forecast && (
                    <path
                      d={gpSegments.forecast}
                      fill="none"
                      stroke="#e69138"
                      strokeWidth="2.5"
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}

                  {/* Operating Profit Curves: Solid for Actuals, Dashed for Forecast */}
                  {opSegments.actual && (
                    <path
                      d={opSegments.actual}
                      fill="none"
                      stroke="#1155cc"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {opSegments.forecast && (
                    <path
                      d={opSegments.forecast}
                      fill="none"
                      stroke="#1155cc"
                      strokeWidth="2.5"
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}

                  {/* Data Dots */}
                  {revPts.map((pt, i) => {
                    const isAct = i <= lastActualIdx;
                    const isHov = i === hoveredIdx;
                    return (
                      <g key={`r-dot-${i}`}>
                        {isHov && <circle cx={pt.x} cy={pt.y} r="8" fill="#9900ff" opacity="0.2" />}
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={isHov ? 4.8 : 3.8}
                          fill={isAct ? "#9900ff" : "#ffffff"}
                          stroke="#9900ff"
                          strokeWidth={isAct ? "2" : "2"}
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>{`${months[i]}: ${revenueLabel} ${formatShortMoney(pt.val)}`}</title>
                        </circle>
                      </g>
                    );
                  })}

                  {gpPts.map((pt, i) => {
                    const isAct = i <= lastActualIdx;
                    const isHov = i === hoveredIdx;
                    return (
                      <g key={`gp-dot-${i}`}>
                        {isHov && <circle cx={pt.x} cy={pt.y} r="8" fill="#e69138" opacity="0.2" />}
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={isHov ? 4.8 : 3.8}
                          fill={isAct ? "#e69138" : "#ffffff"}
                          stroke="#e69138"
                          strokeWidth={isAct ? "2" : "2"}
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>{`${months[i]}: Gross profit ${formatShortMoney(pt.val)}`}</title>
                        </circle>
                      </g>
                    );
                  })}

                  {opPts.map((pt, i) => {
                    const isAct = i <= lastActualIdx;
                    const isHov = i === hoveredIdx;
                    return (
                      <g key={`op-dot-${i}`}>
                        {isHov && <circle cx={pt.x} cy={pt.y} r="8" fill="#1155cc" opacity="0.2" />}
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={isHov ? 4.8 : 3.8}
                          fill={isAct ? "#1155cc" : "#ffffff"}
                          stroke="#1155cc"
                          strokeWidth={isAct ? "2" : "2"}
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>{`${months[i]}: Operating profit ${formatShortMoney(pt.val)}`}</title>
                        </circle>
                      </g>
                    );
                  })}

                  {/* X-Axis Baseline */}
                  <line
                    x1="0"
                    y1={paddingTop + chartH}
                    x2={svgW}
                    y2={paddingTop + chartH}
                    stroke="#e2e8f0"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* X-Axis Month Labels directly centered under each data point */}
                  {months.map((m, i) => {
                    const x = getX(i);
                    const isAct = i <= lastActualIdx;
                    const monthText = String(m || "").trim();
                    return (
                      <text
                        key={`x-lbl-${i}`}
                        x={x}
                        y={paddingTop + chartH + 18}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight={isAct ? "600" : "500"}
                        fill={isAct ? "#1e293b" : "#64748b"}
                        fontFamily="'Kumbh Sans', sans-serif"
                      >
                        {monthText}
                      </text>
                    );
                  })}
                </svg>

                {/* Interactive Tooltip Card */}
                {hoveredIdx !== null && (
                  <div
                    style={{
                      position: "absolute",
                      top: "14px",
                      left: `${((hoveredIdx + 0.5) / months.length) * 100}%`,
                      transform:
                        hoveredIdx === 0
                          ? "translateX(-15%)"
                          : hoveredIdx === months.length - 1
                          ? "translateX(-85%)"
                          : "translateX(-50%)",
                      background: "rgba(255, 255, 255, 0.98)",
                      backdropFilter: "blur(8px)",
                      border: "1px solid #cbd5e1",
                      borderRadius: "8px",
                      padding: "8px 12px",
                      boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.12), 0 8px 10px -6px rgba(0, 0, 0, 0.06)",
                      pointerEvents: "none",
                      zIndex: 10,
                      whiteSpace: "nowrap",
                      fontSize: "11px",
                      fontFamily: "'Kumbh Sans', sans-serif",
                      minWidth: "160px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "10px",
                        borderBottom: "1px solid #e2e8f0",
                        paddingBottom: "5px",
                        marginBottom: "6px",
                      }}
                    >
                      <span style={{ fontWeight: 700, color: "#0f172a", fontSize: "12px" }}>
                        {hoveredMonth}
                      </span>
                      <span
                        style={{
                          fontSize: "9.5px",
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: "4px",
                          background: hoveredIsActual ? "#f4f7fa" : "rgba(0, 71, 171, 0.08)",
                          color: hoveredIsActual ? "#64748b" : "#0047AB",
                          fontStyle: hoveredIsActual ? "normal" : "italic",
                        }}
                      >
                        {hoveredIsActual ? "Actual" : "Forecast"}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#9900ff" }} />
                          <span style={{ color: "#475569" }}>{revenueLabel}:</span>
                        </div>
                        <span style={{ fontWeight: 700, color: "#9900ff", fontVariantNumeric: "tabular-nums" }}>
                          {formatFullMoney(hoveredRev)}
                        </span>
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#e69138" }} />
                          <span style={{ color: "#475569" }}>Gross profit:</span>
                        </div>
                        <span style={{ fontWeight: 700, color: "#e69138", fontVariantNumeric: "tabular-nums" }}>
                          {formatFullMoney(hoveredGp)}
                        </span>
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#1155cc" }} />
                          <span style={{ color: "#475569" }}>Operating profit:</span>
                        </div>
                        <span style={{ fontWeight: 700, color: "#1155cc", fontVariantNumeric: "tabular-nums" }}>
                          {formatFullMoney(hoveredOp)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Centered Legend Underneath the Chart */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "20px",
                  padding: "12px 14px 14px 14px",
                  fontSize: "11px",
                  fontFamily: "'Kumbh Sans', sans-serif",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span
                    style={{
                      width: "9px",
                      height: "9px",
                      borderRadius: "50%",
                      background: "#9900ff",
                      display: "inline-block",
                    }}
                  />
                  <span style={{ color: "#334155", fontWeight: 600 }}>{revenueLabel}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span
                    style={{
                      width: "9px",
                      height: "9px",
                      borderRadius: "50%",
                      background: "#e69138",
                      display: "inline-block",
                    }}
                  />
                  <span style={{ color: "#334155", fontWeight: 600 }}>Gross profit</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span
                    style={{
                      width: "9px",
                      height: "9px",
                      borderRadius: "50%",
                      background: "#1155cc",
                      display: "inline-block",
                    }}
                  />
                  <span style={{ color: "#334155", fontWeight: 600 }}>Operating profit</span>
                </div>
                <span style={{ width: "1px", height: "12px", background: "#cbd5e1" }} />
                <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#64748b", fontSize: "10.5px" }}>
                  <span
                    style={{
                      width: "16px",
                      height: "2.5px",
                      background: "#64748b",
                      borderRadius: "2px",
                      display: "inline-block",
                    }}
                  />
                  <span>Solid = Actual</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#64748b", fontSize: "10.5px" }}>
                  <span
                    style={{
                      width: "16px",
                      height: "0px",
                      borderTop: "2.5px dashed #64748b",
                      display: "inline-block",
                    }}
                  />
                  <span>Dashed = Forecast</span>
                </div>
              </div>
            </td>

            {/* Right Total Spacer: (width: 7.8% on FY, 110px on YTD), no borders */}
            <td
              style={{
                padding: 0,
                border: "none",
                background: "transparent",
                ...(layout === "fy"
                  ? { width: "7.8%", minWidth: "7.8%" }
                  : { width: "110px", minWidth: "110px", maxWidth: "110px" }),
              }}
            />
          </tr>
        </tbody>
      </table>
      <style jsx>{`
        @media (orientation: landscape) and (max-width: 1024px) {
          .fy-chart-scroll-wrapper {
            margin: 38px 0 0 0 !important;
            width: ${layout === "fy" ? "100%" : "fit-content"} !important;
            max-width: 100% !important;
          }
        }
        @media (max-width: 768px) and (orientation: portrait) {
          .fy-chart-scroll-wrapper {
            margin: 38px 24px 0 24px !important;
            width: calc(100% - 48px) !important;
            max-width: calc(100% - 48px) !important;
          }
        }
      `}</style>
    </div>
  );
}
