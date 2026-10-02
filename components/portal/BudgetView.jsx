import React, { useState } from "react";
import Spinner from "../Spinner";

export default function BudgetView({
  clientName,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [selectedYearIdx, setSelectedYearIdx] = useState(0);

  const budgetData = data;
  const years = budgetData?.years || [];
  const currentYear = years[selectedYearIdx] || years[0];

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "" || val === "—") return "";
    if (typeof val === "number") {
      return (val < 0 ? "-" : "") + "£" + Math.abs(Math.round(val)).toLocaleString("en-GB");
    }
    const num = parseFloat(String(val).replace(/[£,]/g, ""));
    return isNaN(num) ? String(val) : (num < 0 ? "-" : "") + "£" + Math.abs(Math.round(num)).toLocaleString("en-GB");
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

  if (isLoading && !budgetData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading Budget Overview for {clientName}...
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
          There is no <strong>Budget</strong> sheet currently set up for <strong>{clientName}</strong>. Once configured in the client sheet, budget projections will appear here automatically.
        </p>
      </div>
    );
  }

  const months = currentYear?.months || [];

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
            Budget overview
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
            {currentYear?.label || "Annual Budget"}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {years.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Year:</span>
              <select
                value={selectedYearIdx}
                onChange={(e) => setSelectedYearIdx(parseInt(e.target.value, 10))}
                style={{
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "4px 8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#0f172a",
                  background: "#ffffff",
                  cursor: "pointer",
                }}
              >
                {years.map((yr, idx) => (
                  <option key={yr.id || idx} value={idx}>
                    {yr.label || `Year ${idx + 1}`}
                  </option>
                ))}
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

      {/* Main Budget Table (Fitting desktop width) */}
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
              width: "max-content",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "left",
                    fontWeight: 700,
                    width: "220px",
                    minWidth: "220px",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                  }}
                >
                  {/* Empty top-left cell */}
                </th>
                {months.map((m, idx) => (
                  <th
                    key={idx}
                    style={{
                      padding: "6px 4px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "11px",
                      width: "87px",
                      minWidth: "87px",
                    }}
                  >
                    {typeof m === "object" && m !== null ? m.label || "" : m}
                  </th>
                ))}
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    fontWeight: 800,
                    width: "110px",
                    minWidth: "110px",
                    background: "#0047AB",
                  }}
                >
                  FY Budget
                </th>
              </tr>
            </thead>

            <tbody>
              {(currentYear?.rows || []).map((row, rIdx) => {
                const label = String(row.label || "").trim();
                if (!label || label.toLowerCase() === "hide") {
                  return (
                    <tr key={rIdx} style={{ height: "6px", background: "#efefef" }}>
                      <td colSpan={months.length + 2} style={{ padding: 0, background: "#efefef" }} />
                    </tr>
                  );
                }

                const rowStyle = getRowStyle(label);
                const isPercentageRow = label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");
                const displayTotal = row.total === "—" ? "" : row.total || "";

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
                        padding: "5px 8px",
                        color: rowStyle.color,
                        fontWeight: rowStyle.bold ? 700 : 500,
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

                    {(row.values || []).map((val, mIdx) => {
                      const displayVal = val === "—" ? "" : val || "";

                      return (
                        <td
                          key={mIdx}
                          style={{
                            padding: "4px 4px",
                            textAlign: "right",
                            fontSize: "11px",
                            color: rowStyle.isMajor ? "#ffffff" : rowStyle.color,
                            fontStyle: isPercentageRow ? "italic" : "normal",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {displayVal}
                        </td>
                      );
                    })}

                    <td
                      style={{
                        padding: "5px 8px",
                        textAlign: "right",
                        fontWeight: 800,
                        color: rowStyle.isMajor ? "#ffffff" : "#0047AB",
                        fontStyle: isPercentageRow ? "italic" : "normal",
                        fontSize: "11.5px",
                        background: rowStyle.bg,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayTotal}
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
