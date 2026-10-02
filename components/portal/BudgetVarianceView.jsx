import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function BudgetVarianceView({
  clientName,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [viewMode, setViewMode] = useState("ytd"); // 'month' | 'ytd' | 'fy'
  const [userMonthIdx, setUserMonthIdx] = useState(null);
  const [selectedYearIdx, setSelectedYearIdx] = useState(0);

  const budgetData = data;
  const years = budgetData?.years || [];
  const currentYear = years[selectedYearIdx] || years[0];
  const months = useMemo(() => currentYear?.months || [], [currentYear]);

  // Default to previous calendar month
  const defaultMonthIdx = useMemo(() => {
    if (!months || months.length === 0) return 0;
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let prevIdx = -1;
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      const mLabel = typeof m === "object" && m !== null ? m.label : m;
      const match = String(mLabel).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
      if (match) {
        const monthsMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const monthNum = monthsMap[match[1].toLowerCase()];
        let yr = parseInt(match[2], 10);
        if (yr < 100) yr += 2000;
        const d = new Date(yr, monthNum, 1);
        if (d.getTime() < currMonthStart) {
          prevIdx = i;
        }
      }
    }
    return prevIdx !== -1 ? prevIdx : 0;
  }, [months]);

  const selectedMonthIdx = userMonthIdx !== null ? userMonthIdx : defaultMonthIdx;

  const parseNum = (val) => {
    if (typeof val === "number") return val;
    if (!val || val === "—") return 0;
    const clean = String(val).replace(/[£,]/g, "").trim();
    if (clean.includes("%")) return parseFloat(clean) / 100;
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString("en-GB")}`;
  };

  const formatPct = (val) => `${Math.round((val || 0) * 100)}%`;

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

  // Determine limit of displayed months
  const displayedMonthCount = viewMode === "month" ? 1 : viewMode === "ytd" ? selectedMonthIdx + 1 : 12;
  const displayedMonths = months.slice(0, displayedMonthCount);

  // Compute variance rows
  const computedRows = useMemo(() => {
    if (!currentYear?.rows) return [];

    return currentYear.rows
      .filter((r) => {
        const isBlank = (!r.label || r.label.toLowerCase() === "hide") && !r.total;
        return !isBlank;
      })
      .map((r) => {
        const label = String(r.label || "").trim();
        const isHeader = ["income", "revenue", "costs of sale", "cost of sales", "overheads"].includes(label.toLowerCase());
        const isPercentageRow = label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");

        if (isHeader) {
          return { label, isHeader, isPercentageRow };
        }

        const monthlyActuals = [];
        for (let m = 0; m < displayedMonthCount; m++) {
          monthlyActuals.push(parseNum(r.actualValues?.[m]));
        }

        let actualTotal = 0;
        let budgetTotal = 0;

        if (viewMode === "month") {
          actualTotal = parseNum(r.actualValues?.[selectedMonthIdx]);
          budgetTotal = parseNum(r.values?.[selectedMonthIdx]);
        } else if (viewMode === "ytd") {
          for (let m = 0; m <= selectedMonthIdx; m++) {
            actualTotal += parseNum(r.actualValues?.[m]);
            budgetTotal += parseNum(r.values?.[m]);
          }
        } else {
          actualTotal = parseNum(r.actualTotal);
          budgetTotal = parseNum(r.total);
        }

        const isCost =
          label.toLowerCase().includes("cost") ||
          label.toLowerCase().includes("overhead") ||
          label.toLowerCase().includes("expense") ||
          label.toLowerCase().includes("salaries");

        const diff = isCost ? budgetTotal - actualTotal : actualTotal - budgetTotal;
        const diffAmount = actualTotal - budgetTotal;
        const pct = budgetTotal !== 0 ? (diff / Math.abs(budgetTotal)) : 0;
        const isFavorable = diff >= 0;

        return {
          label,
          isHeader: false,
          isPercentageRow,
          monthlyActuals,
          actualTotal,
          budgetTotal,
          diff,
          diffAmount,
          pct,
          isCost,
          isFavorable,
        };
      });
  }, [currentYear, viewMode, selectedMonthIdx, displayedMonthCount]);

  if (isLoading && !budgetData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading Budget Variance for {clientName}...
        </p>
      </div>
    );
  }

  if (error && !budgetData) {
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

  if (budgetData && !budgetData.hasBudget) {
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
        <div style={{ fontSize: "36px", marginBottom: "1rem" }}>📊</div>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "1.25rem", fontWeight: 700, color: "#1e293b" }}>
          No Budget Configured
        </h3>
        <p style={{ margin: 0, color: "#64748b", fontSize: "0.95rem", maxWidth: "480px", marginInline: "auto" }}>
          There is no <strong>Budget</strong> sheet currently set up for <strong>{clientName}</strong>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%", fontFamily: "'Kumbh Sans', sans-serif" }}>
      {/* Action Bar */}
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
            Budget variance analysis
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
            {viewMode === "month"
              ? `${typeof months[selectedMonthIdx] === "object" ? months[selectedMonthIdx]?.label : months[selectedMonthIdx] || "Month"}`
              : viewMode === "ytd"
              ? `YTD Through to ${typeof months[selectedMonthIdx] === "object" ? months[selectedMonthIdx]?.label : months[selectedMonthIdx] || "Month"}`
              : "Full FY"}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {/* Mode Switcher */}
          <div
            style={{
              display: "flex",
              background: "#f1f5f9",
              padding: "2px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
            }}
          >
            {[
              { id: "month", label: "Monthly" },
              { id: "ytd", label: "YTD" },
              { id: "fy", label: "Full FY" },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setViewMode(m.id)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  border: "none",
                  fontSize: "12px",
                  fontWeight: viewMode === m.id ? 700 : 500,
                  cursor: "pointer",
                  background: viewMode === m.id ? "#0047AB" : "transparent",
                  color: viewMode === m.id ? "#ffffff" : "#475569",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Month Dropdown (for Monthly and YTD) */}
          {viewMode !== "fy" && months.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>
                {viewMode === "ytd" ? "Through to:" : "Month:"}
              </span>
              <select
                value={selectedMonthIdx}
                onChange={(e) => setUserMonthIdx(parseInt(e.target.value, 10))}
                style={selectStyle}
              >
                {months.map((m, idx) => {
                  const mLabel = typeof m === "object" && m !== null ? m.label : m;
                  return (
                    <option key={idx} value={idx}>
                      {mLabel} (M{idx + 1})
                    </option>
                  );
                })}
              </select>
            </div>
          )}

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

      {/* Main Budget Variance Table (max-content width matching original app) */}
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
            {/* Row 1: Headers */}
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
                {/* Empty header */}
              </th>

              {/* Monthly Actual Columns (in YTD or FY view) */}
              {viewMode !== "month" &&
                displayedMonths.map((m, idx) => {
                  const mLabel = typeof m === "object" && m !== null ? m.label : m;
                  return (
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
                      {mLabel}
                    </th>
                  );
                })}

              {/* Total/Period Actual */}
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "right",
                  fontWeight: 800,
                  fontSize: "12px",
                  width: "110px",
                  minWidth: "110px",
                }}
              >
                {viewMode === "month" ? "Actual" : viewMode === "ytd" ? "YTD Actual" : "FY Actual"}
              </th>

              {/* Budget Column */}
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "right",
                  fontWeight: 700,
                  fontStyle: "italic",
                  fontSize: "12px",
                  width: "110px",
                  minWidth: "110px",
                }}
              >
                {viewMode === "month" ? "Budget" : viewMode === "ytd" ? "YTD Budget" : "FY Budget"}
              </th>

              {/* Variance (£) */}
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "right",
                  fontWeight: 700,
                  fontStyle: "italic",
                  fontSize: "12px",
                  width: "87px",
                  minWidth: "87px",
                }}
              >
                Var (£)
              </th>

              {/* Variance (%) */}
              <th
                style={{
                  padding: "6px 8px",
                  textAlign: "right",
                  fontWeight: 700,
                  fontStyle: "italic",
                  fontSize: "12px",
                  width: "87px",
                  minWidth: "87px",
                }}
              >
                Var %
              </th>
            </tr>

            {/* Row 2: Status row (Actual / Forecast) for multi-month views */}
            {viewMode !== "month" && (
              <tr style={{ background: "#efefef", borderBottom: "1px solid #ffffff", fontSize: "10.5px" }}>
                <td
                  style={{
                    padding: "3px 8px",
                    position: "sticky",
                    left: 0,
                    background: "#efefef",
                    zIndex: 2,
                  }}
                />
                {displayedMonths.map((m, idx) => {
                  const raw = typeof m === "object" && m !== null ? m.status || "Actual" : "Actual";
                  const text = String(raw).toLowerCase() === "forecast" ? "Forecast" : "Actual";
                  return (
                    <td
                      key={idx}
                      style={{
                        padding: "3px 4px",
                        textAlign: "right",
                        color: "#666666",
                        fontStyle: "italic",
                        background: "#efefef",
                      }}
                    >
                      {text}
                    </td>
                  );
                })}
                <td style={{ background: "#efefef" }} />
                <td style={{ background: "#efefef" }} />
                <td style={{ background: "#efefef" }} />
                <td style={{ background: "#efefef" }} />
              </tr>
            )}
          </thead>

          <tbody>
            {computedRows.map((row, rIdx) => {
              if (row.isHeader) {
                return (
                  <tr key={rIdx} style={{ background: "#efefef", borderBottom: "1px solid #ffffff" }}>
                    <td
                      colSpan={viewMode === "month" ? 5 : displayedMonthCount + 5}
                      style={{
                        padding: "6px 8px",
                        fontWeight: 700,
                        color: "#0047AB",
                        fontSize: "11px",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        background: "#efefef",
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                      }}
                    >
                      {row.label}
                    </td>
                  </tr>
                );
              }

              const rowStyle = getRowStyle(row.label);
              const isPct = row.isPercentageRow;
              const varColor = row.diff === 0 ? "#0047AB" : row.isFavorable ? "#166534" : "#991b1b";
              const varBg = row.diff === 0 ? "#efefef" : row.isFavorable ? "#d9ead3" : "#f4cccc";

              return (
                <tr
                  key={rIdx}
                  style={{
                    borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #ffffff",
                    background: rowStyle.bg,
                    fontWeight: rowStyle.bold ? 700 : 400,
                  }}
                >
                  {/* Sticky Line Item */}
                  <td
                    style={{
                      padding: "5px 8px",
                      color: rowStyle.color,
                      fontWeight: rowStyle.bold ? 700 : 500,
                      fontStyle: isPct ? "italic" : "normal",
                      position: "sticky",
                      left: 0,
                      background: rowStyle.bg,
                      zIndex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={row.label}
                  >
                    {row.label}
                  </td>

                  {/* Monthly Actual Values (in YTD/FY mode) */}
                  {viewMode !== "month" &&
                    row.monthlyActuals?.map((val, mIdx) => (
                      <td
                        key={mIdx}
                        style={{
                          padding: "4px 4px",
                          textAlign: "right",
                          fontSize: "11px",
                          color: rowStyle.isMajor ? "#ffffff" : rowStyle.color,
                          fontStyle: isPct ? "italic" : "normal",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {isPct ? formatPct(val) : formatMoney(val)}
                      </td>
                    ))}

                  {/* Period Actual */}
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: rowStyle.bold ? 800 : 600,
                      color: rowStyle.isMajor ? "#ffffff" : "#0047AB",
                      fontStyle: isPct ? "italic" : "normal",
                      fontSize: "11.5px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isPct ? formatPct(row.actualTotal) : formatMoney(row.actualTotal)}
                  </td>

                  {/* Period Budget */}
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: 600,
                      color: rowStyle.isMajor ? "rgba(255,255,255,0.9)" : "#0047AB",
                      fontStyle: "italic",
                      fontSize: "11.5px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isPct ? formatPct(row.budgetTotal) : formatMoney(row.budgetTotal)}
                  </td>

                  {/* Var (£) */}
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontStyle: "italic",
                      fontSize: "11.5px",
                      background: rowStyle.isMajor ? "transparent" : varBg,
                      color: rowStyle.isMajor ? "#ffffff" : varColor,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isPct ? formatPct(row.diffAmount) : formatMoney(row.diffAmount)}
                  </td>

                  {/* Var (%) */}
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontStyle: "italic",
                      fontSize: "11.5px",
                      background: rowStyle.isMajor ? "transparent" : varBg,
                      color: rowStyle.isMajor ? "#ffffff" : varColor,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatPct(row.pct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
