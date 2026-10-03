import React, { useState, useMemo, useEffect } from "react";
import Spinner from "../Spinner";
import { DeepDiveEngine, buildDeepDiveData, getDeepDiveType, parseMoney, formatMoney } from "../../services/deepDiveHelper";

export default function PerformanceBreakdownView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const years = useMemo(() => data?.years || [], [data?.years]);

  // Flatten all months from years into a single chronological list with FY totals
  const periodOptions = useMemo(() => {
    const list = [];
    years.forEach((yr, yIdx) => {
      const months = yr.headerMonths || [];
      months.forEach((mStr, mIdx) => {
        // Parse date for comparison
        let parsedDate = null;
        const match = String(mStr).match(/([a-zA-Z]{3,})\s*[\-\s]?\s*(\d{2,4})/);
        if (match) {
          const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
          const m = monthMap[match[1].toLowerCase().substring(0, 3)];
          let y = parseInt(match[2], 10);
          if (y < 100) y += 2000;
          if (m !== undefined && !isNaN(y)) {
            parsedDate = new Date(y, m, 1);
          }
        }
        list.push({
          key: `m_${yIdx}_${mIdx}`,
          label: mStr,
          yearIdx: yIdx,
          monthIdx: mIdx,
          isFY: false,
          date: parsedDate,
        });
      });

      // Add FY Total at the end of each financial year
      const fyLabel = yr.fyLabel || `FY${String(yr.displayTitle || "").replace(/[^0-9]/g, "")}`;
      list.push({
        key: `fy_${yIdx}`,
        label: `${fyLabel} total`,
        yearIdx: yIdx,
        monthIdx: -1,
        isFY: true,
        date: null,
      });
    });
    return list;
  }, [years]);

  // Determine initial period: closest to current date (excluding FY total)
  const defaultPeriodKey = useMemo(() => {
    if (periodOptions.length === 0) return "";
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let closestKey = "";
    let closestDiff = Infinity;

    for (const opt of periodOptions) {
      if (opt.date && !opt.isFY) {
        const diff = Math.abs(opt.date.getTime() - currMonthStart);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestKey = opt.key;
        }
      }
    }
    return closestKey || periodOptions[0]?.key || "";
  }, [periodOptions]);

  const [selectedPeriodKey, setSelectedPeriodKey] = useState("");
  const [breakdownType, setBreakdownType] = useState("confRev");
  const [openAccordions, setOpenAccordions] = useState({});

  useEffect(() => {
    setOpenAccordions({});
  }, [selectedPeriodKey, breakdownType]);

  const toggleAccordion = (key) => {
    setOpenAccordions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  useEffect(() => {
    if (defaultPeriodKey && (!selectedPeriodKey || !periodOptions.some((p) => p.key === selectedPeriodKey))) {
      setSelectedPeriodKey(defaultPeriodKey);
    }
  }, [defaultPeriodKey, selectedPeriodKey, periodOptions]);

  const activePeriod = periodOptions.find((p) => p.key === selectedPeriodKey) || periodOptions[0] || null;

  const isIncomeMode = useMemo(() => {
    // Check if client sheet uses income instead of revenue in headers/labels
    const allLabels = (years[0]?.rows || []).map((r) => String(r.label || "").toLowerCase());
    return allLabels.some((l) => l.includes("confirmed income") || l.includes("total income"));
  }, [years]);

  useEffect(() => {
    if (isIncomeMode && breakdownType === "dirCosts") {
      setBreakdownType("confRev");
    }
  }, [isIncomeMode, breakdownType]);

  // Build deep dive data based on active period and breakdownType using shared buildDeepDiveData
  const ddData = useMemo(() => {
    if (!activePeriod || !keyData) {
      return { items: [], sections: null, total: "£0" };
    }

    const isFY = activePeriod.isFY;
    const yIdx = activePeriod.yearIdx;
    const activeYearData = years[yIdx];
    const firstMonthStr = activeYearData?.headerMonths?.[0];
    const fyStartDate = DeepDiveEngine.parseHeaderDate(firstMonthStr) || new Date(2025 + yIdx, 3, 1);

    let targetDate = null;
    if (isFY) {
      targetDate = fyStartDate;
    } else {
      const monthStr = activeYearData?.headerMonths?.[activePeriod.monthIdx];
      targetDate = monthStr
        ? DeepDiveEngine.parseHeaderDate(monthStr)
        : (activePeriod.date || new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + activePeriod.monthIdx, 1));
    }

    // Find target row in table matching breakdownType
    const targetRow = (activeYearData?.rows || []).find((r) => {
      const dt = getDeepDiveType(r.label);
      if (dt === breakdownType) return true;
      const l = String(r.label || "").toLowerCase();
      if (breakdownType === "staffDel" && l.includes("staff costs - delivery")) return true;
      if (breakdownType === "staffNonDel" && l.includes("staff costs - non-delivery")) return true;
      return false;
    });

    let cellValue = "£0";
    if (targetRow) {
      cellValue = isFY
        ? (targetRow.totalVal || "£0")
        : (targetRow.monthlyValues?.[activePeriod.monthIdx] || "£0");
    }

    return buildDeepDiveData({
      ddType: breakdownType,
      periodLabel: activePeriod.label,
      monthIndex: isFY ? -1 : activePeriod.monthIdx,
      cellValue,
      yearIndex: yIdx + 1,
      targetDate,
      aggregateCount: isFY ? 12 : 1,
      keyData,
      isIncomeMode,
      isRestricted: isSenior,
    });
  }, [activePeriod, breakdownType, keyData, isIncomeMode, years, isSenior]);

  const hasSections = Array.isArray(ddData?.sections) && ddData.sections.length > 0;
  const sections = ddData?.sections || [];
  const items = ddData?.items || [];

  const totalAmount = useMemo(() => {
    if (Array.isArray(ddData?.sections) && ddData.sections.length > 0) {
      return ddData.sections.reduce((sum, sec) => sum + (sec.amount || 0), 0);
    }
    return (ddData?.items || []).reduce((sum, item) => sum + (item.amount || 0), 0);
  }, [ddData]);

  if (isLoading && !data && !keyData) {
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
          Unable to Load Performance Breakdowns
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

  const handleDownloadCSV = () => {
    let rows = [];
    const metricName =
      breakdownType === "confRev"
        ? isIncomeMode ? "Confirmed income" : "Confirmed revenue"
        : breakdownType === "pipeRev"
        ? isIncomeMode ? "Pipeline income" : "Pipeline revenue"
        : breakdownType === "dirCosts"
        ? "Direct costs"
        : breakdownType === "staffDel"
        ? "Delivery staff costs"
        : breakdownType === "staffNonDel"
        ? "Non-delivery staff costs"
        : breakdownType === "expDel"
        ? "Delivery expenses"
        : "Non-delivery expenses";

    rows.push([`Performance breakdown: ${metricName} - ${activePeriod?.label || ""}`]);
    rows.push([]);

    if (hasSections) {
      rows.push(["Section", "Name / Role", "Details", "Amount"]);
      sections.forEach((sec) => {
        if (sec.items && sec.items.length > 0) {
          rows.push([sec.title, "", "", sec.amount || 0]);
          sec.items.forEach((item) => {
            rows.push(["", item.name || "", item.role || item.detail || "", item.amount || 0]);
          });
        } else {
          rows.push([sec.title, "", "", sec.amount || 0]);
        }
      });
      rows.push([]);
      rows.push(["Total", "", "", totalAmount]);
    } else {
      rows.push(["Client", "Name", "Details", "Amount"]);
      items.forEach((item) => {
        rows.push([
          item.client || item.name || "",
          item.jobName || item.name || "",
          item.detail || "",
          item.amount || 0,
        ]);
      });
      rows.push([]);
      rows.push(["", "", "Total", totalAmount]);
    }

    const csvContent =
      "data:text/csv;charset=utf-8," +
      rows
        .map((e) =>
          e.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute(
      "download",
      `performance_breakdown_${breakdownType}_${activePeriod?.label || "export"}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const dropdownStyle = {
    fontFamily: "'Kumbh Sans', sans-serif",
    border: "1.5px solid #0047AB",
    borderRadius: "8px",
    padding: "0.6rem 0.85rem",
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#0047AB",
    backgroundColor: "#f8fafc",
    cursor: "pointer",
    outline: "none",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", fontFamily: "'Kumbh Sans', sans-serif" }}>
      {/* Top Header Bar matching original app */}
      <div
        className="breakdown-header-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "1.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.85rem", fontWeight: 700, color: "#0047AB" }}>
          Performance breakdowns
        </h1>

        {/* Metric Dropdown */}
        <select
          className="breakdown-select"
          value={breakdownType}
          onChange={(e) => setBreakdownType(e.target.value)}
          style={dropdownStyle}
        >
          <option value="confRev">{isIncomeMode ? "Confirmed income" : "Confirmed revenue"}</option>
          <option value="pipeRev">{isIncomeMode ? "Pipeline income" : "Pipeline revenue"}</option>
          {!isIncomeMode && <option value="dirCosts">Direct costs</option>}
          <option value="staffDel">Delivery staff costs</option>
          <option value="staffNonDel">Non-delivery staff costs</option>
          <option value="expDel">Delivery expenses</option>
          <option value="expNonDel">Non-delivery expenses</option>
        </select>

        {/* Combined Month-Year Dropdown */}
        <select
          className="breakdown-select"
          value={selectedPeriodKey}
          onChange={(e) => setSelectedPeriodKey(e.target.value)}
          style={dropdownStyle}
        >
          {periodOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
        </select>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh data"
            style={{
              background: "transparent",
              border: "none",
              cursor: isLoading ? "wait" : "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
            }}
          >
            {isLoading ? (
              <Spinner size={18} color="#0047AB" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadCSV}
            title="Download CSV"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Breakdown List Container */}
      <div style={{ maxWidth: "800px", width: "100%" }}>
        {/* Right-aligned Total Row */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            paddingBottom: "10px",
            borderBottom: "1px solid #f1f5f9",
            marginBottom: "12px",
          }}
        >
          <span style={{ fontSize: "1.25rem", fontWeight: 700, color: "#0047AB" }}>
            {formatMoney(totalAmount)}
          </span>
        </div>

        {/* Sections or Item Rows */}
        {hasSections ? (
          sections.length === 0 ? (
            <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
              No items in this period.
            </div>
          ) : (
            <div>
              {sections.map((sec, sIdx) => {
                const secKey = sec.key || sIdx;
                const isAccordion = Boolean(sec.isAccordion);
                const isExpanded = Boolean(openAccordions[secKey]);
                const isAdjustment = Boolean(sec.isAdjustment);

                if (isAdjustment) {
                  return (
                    <div
                      key={secKey}
                      style={{
                        border: "1px dashed #cbd5e1",
                        borderRadius: "8px",
                        background: "#f8fafc",
                        marginBottom: "10px",
                        padding: "10px 16px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "14px",
                      }}
                    >
                      <span style={{ color: "#64748b", fontStyle: "italic", fontSize: "13px" }}>{sec.title}</span>
                      <span style={{ fontWeight: 700, color: "#0047AB" }}>{formatMoney(sec.amount)}</span>
                    </div>
                  );
                }

                if (isAccordion) {
                  return (
                    <div
                      key={secKey}
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: "8px",
                        background: "#ffffff",
                        marginBottom: "10px",
                        overflow: "hidden",
                        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)",
                      }}
                    >
                      <div
                        onClick={() => toggleAccordion(secKey)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px 16px",
                          background: "#f8fafc",
                          cursor: "pointer",
                          fontWeight: 600,
                          color: "#0047AB",
                          fontSize: "15px",
                          userSelect: "none",
                          transition: "background 0.15s ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              transition: "transform 0.15s ease",
                              transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                              display: "inline-block",
                            }}
                          >
                            ▼
                          </span>
                          <span>{sec.title}</span>
                        </div>
                        <span style={{ fontWeight: 700 }}>{formatMoney(sec.amount)}</span>
                      </div>

                      {isExpanded && (
                        <div style={{ borderTop: "1px solid #e2e8f0", background: "#ffffff" }}>
                          {(!sec.items || sec.items.length === 0) ? (
                            <div style={{ padding: "12px 18px", color: "#94a3b8", fontSize: "13px", fontStyle: "italic" }}>
                              None in this period
                            </div>
                          ) : (
                            sec.items.map((item, iIdx) => (
                              <div
                                key={iIdx}
                                style={{
                                  padding: "11px 18px 11px 32px",
                                  borderBottom: iIdx === sec.items.length - 1 ? "none" : "1px solid #f1f5f9",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  fontSize: "14px",
                                }}
                              >
                                <div style={{ color: "#1e293b", fontWeight: 500, paddingRight: "10px" }}>
                                  {item.name}{item.role ? ` – ${item.role}` : ""}
                                </div>
                                <div style={{ fontWeight: 600, color: "#0047AB", whiteSpace: "nowrap" }}>
                                  {formatMoney(item.amount)}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                }

                // Flat Section (Dividends as salary, Making up CoS, Profit share)
                return (
                  <div
                    key={secKey}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      background: "#f8fafc",
                      marginBottom: "10px",
                      padding: "12px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontWeight: 600,
                      color: "#0047AB",
                      fontSize: "15px",
                      userSelect: "none",
                      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)",
                    }}
                  >
                    <span>{sec.title}</span>
                    <span style={{ fontWeight: 700 }}>{formatMoney(sec.amount)}</span>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* Render Regular List (Revenue, Expenses, Direct Costs) */
          items.length === 0 ? (
            <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
              No items in this period.
            </div>
          ) : (
            items.map((item, idx) => {
              const isAdjustment =
                item.name === "Manual adjustment" ||
                item.name === "Rounding adjustment" ||
                item.name === "Scenario adjustment" ||
                item.name === "Manual scenario adjustment";

              if (isAdjustment) {
                return (
                  <div
                    key={idx}
                    style={{
                      border: "1px dashed #cbd5e1",
                      borderRadius: "8px",
                      background: "#f8fafc",
                      marginBottom: "8px",
                      padding: "10px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: "14px",
                    }}
                  >
                    <span style={{ color: "#64748b", fontStyle: "italic", fontSize: "13px" }}>{item.name}</span>
                    <span style={{ fontWeight: 700, color: "#0047AB" }}>{formatMoney(item.amount)}</span>
                  </div>
                );
              }

              return (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    padding: "12px 0",
                    borderBottom: "1px solid #f1f5f9",
                  }}
                >
                  <div style={{ paddingRight: "1rem" }}>
                    <div style={{ fontSize: "15px", color: "#0f172a" }}>
                      {item.client ? (
                        <>
                          <strong style={{ fontWeight: 700 }}>{item.client}</strong>
                          {(item.name || item.jobName) && (
                            <span style={{ color: "#334155" }}> – {item.jobName || item.name}</span>
                          )}
                        </>
                      ) : (
                        <strong style={{ fontWeight: 700 }}>{item.name || item.jobName}</strong>
                      )}
                    </div>
                    {item.detail && (
                      <div style={{ fontSize: "13px", color: "#64748b", fontStyle: "italic", marginTop: "3px" }}>
                        {item.detail}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      color: "#0047AB",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatMoney(item.amount)}
                  </div>
                </div>
              );
            })
          )
        )}
      </div>

      <style jsx>{`
        @media (max-width: 640px) {
          .breakdown-header-bar {
            gap: 0.5rem !important;
          }
          .breakdown-select {
            font-size: 0.95rem !important;
            padding: 0.45rem 0.65rem !important;
          }
        }
      `}</style>
    </div>
  );
}
