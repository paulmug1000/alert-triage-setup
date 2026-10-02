import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function BudgetVarianceView({
  clientName,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [viewMode, setViewMode] = useState("month"); // 'month' | 'ytd' | 'fy'
  const [selectedMonthIdx, setSelectedMonthIdx] = useState(0); // 0 to 11
  const [selectedYearIdx, setSelectedYearIdx] = useState(0);

  const budgetData = data;
  const years = budgetData?.years || [];
  const currentYear = years[selectedYearIdx] || years[0];
  const months = currentYear?.months || [];

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "" || val === "—") return "";
    if (typeof val === "number") {
      return (val < 0 ? "-" : "") + "£" + Math.abs(Math.round(val)).toLocaleString("en-GB");
    }
    const num = parseFloat(String(val).replace(/[£,]/g, ""));
    return isNaN(num) ? String(val) : (num < 0 ? "-" : "") + "£" + Math.abs(Math.round(num)).toLocaleString("en-GB");
  };

  const parseNum = (val) => {
    if (typeof val === "number") return val;
    return parseFloat(String(val || "0").replace(/[£,]/g, "")) || 0;
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
    if (["income", "costs of sale", "overheads"].includes(l)) {
      return { bg: "#f1f5f9", color: "#0047AB", bold: true, isHeader: true };
    }
    return { bg: "#ffffff", color: "#334155", bold: false, isMajor: false };
  };

  // Variance rows computation
  const varianceRows = useMemo(() => {
    if (!currentYear?.rows) return [];

    return currentYear.rows
      .filter((r) => {
        const isBlank = (!r.label || r.label.toLowerCase() === "hide") && !r.total;
        return !isBlank;
      })
      .map((r) => {
        const label = String(r.label || "").trim();
        const isHeader = ["income", "costs of sale", "overheads"].includes(label.toLowerCase());

        let actual = 0;
        let budget = 0;

        if (!isHeader) {
          if (viewMode === "month") {
            actual = parseNum(r.actualValues?.[selectedMonthIdx]);
            budget = parseNum(r.values?.[selectedMonthIdx]);
          } else if (viewMode === "ytd") {
            for (let m = 0; m <= selectedMonthIdx; m++) {
              actual += parseNum(r.actualValues?.[m]);
              budget += parseNum(r.values?.[m]);
            }
          } else {
            actual = parseNum(r.actualTotal);
            budget = parseNum(r.total);
          }
        }

        const diff = actual - budget;
        const pct = budget !== 0 ? Math.round((diff / Math.abs(budget)) * 100) : 0;

        const isCost =
          label.toLowerCase().includes("cost") ||
          label.toLowerCase().includes("overhead") ||
          label.toLowerCase().includes("expense") ||
          label.toLowerCase().includes("salaries");

        const isFavorable = isCost ? diff <= 0 : diff >= 0;

        return {
          label,
          isHeader,
          actual,
          budget,
          diff,
          pct,
          isCost,
          isFavorable,
        };
      });
  }, [currentYear, viewMode, selectedMonthIdx]);

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
              ? `YTD Through ${typeof months[selectedMonthIdx] === "object" ? months[selectedMonthIdx]?.label : months[selectedMonthIdx] || "Month"}`
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
                {viewMode === "ytd" ? "Through:" : "Month:"}
              </span>
              <select
                value={selectedMonthIdx}
                onChange={(e) => setSelectedMonthIdx(parseInt(e.target.value, 10))}
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

      {/* Main Table (Fitting desktop width) */}
      <div
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
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "left",
                    fontWeight: 700,
                    width: "36%",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 2,
                  }}
                >
                  {/* Empty top-left cell */}
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, width: "16%" }}>
                  Actual
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, width: "16%" }}>
                  Budget
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, width: "16%" }}>
                  Variance (£)
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, width: "16%" }}>
                  Variance (%)
                </th>
              </tr>
            </thead>

            <tbody>
              {varianceRows.map((row, rIdx) => {
                if (!row.label) {
                  return (
                    <tr key={rIdx} style={{ height: "4px", background: "#f8fafc" }}>
                      <td colSpan={5} style={{ padding: 0 }} />
                    </tr>
                  );
                }

                const rowStyle = getRowStyle(row.label);
                const isHeader = row.isHeader;

                if (isHeader) {
                  return (
                    <tr key={rIdx} style={{ background: "#f1f5f9" }}>
                      <td
                        colSpan={5}
                        style={{
                          padding: "6px 8px",
                          fontWeight: 700,
                          color: "#0047AB",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                        }}
                      >
                        {row.label}
                      </td>
                    </tr>
                  );
                }

                const varColor = row.diff === 0 ? "#64748b" : row.isFavorable ? "#166534" : "#991b1b";
                const varBg = row.diff === 0 ? "transparent" : row.isFavorable ? "#dcfce7" : "#fee2e2";

                return (
                  <tr
                    key={rIdx}
                    style={{
                      borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                      background: rowStyle.bg,
                      fontWeight: rowStyle.bold ? 700 : 400,
                    }}
                  >
                    <td
                      style={{
                        padding: "5px 8px",
                        color: rowStyle.color,
                        fontWeight: rowStyle.bold ? 700 : 500,
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

                    <td
                      style={{
                        padding: "5px 8px",
                        textAlign: "right",
                        color: rowStyle.isMajor ? "#ffffff" : "#0f172a",
                        fontWeight: rowStyle.bold ? 700 : 500,
                      }}
                    >
                      {formatGBP(row.actual)}
                    </td>

                    <td
                      style={{
                        padding: "5px 8px",
                        textAlign: "right",
                        color: rowStyle.isMajor ? "rgba(255,255,255,0.9)" : "#64748b",
                      }}
                    >
                      {formatGBP(row.budget)}
                    </td>

                    <td
                      style={{
                        padding: "5px 8px",
                        textAlign: "right",
                        fontWeight: 700,
                        color: rowStyle.isMajor ? "#ffffff" : varColor,
                      }}
                    >
                      <span
                        style={{
                          padding: rowStyle.isMajor ? "0" : "1px 6px",
                          borderRadius: "4px",
                          background: rowStyle.isMajor ? "transparent" : varBg,
                        }}
                      >
                        {formatGBP(row.diff)}
                      </span>
                    </td>

                    <td
                      style={{
                        padding: "5px 8px",
                        textAlign: "right",
                        fontWeight: 700,
                        color: rowStyle.isMajor ? "#ffffff" : varColor,
                      }}
                    >
                      <span
                        style={{
                          padding: rowStyle.isMajor ? "0" : "1px 6px",
                          borderRadius: "4px",
                          background: rowStyle.isMajor ? "transparent" : varBg,
                        }}
                      >
                        {row.pct > 0 ? `+${row.pct}%` : `${row.pct}%`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
