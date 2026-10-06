import React, { useState, useMemo, useRef } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { getDeepDiveType, buildDeepDiveData, DeepDiveEngine, formatMoney as universalFormatMoney, parseMoney, formatCurrencyString } from "../../services/deepDiveHelper";
import PerformanceTrajectoryChartRow from "./PerformanceTrajectoryChartRow";

export default function PerformanceYTDView({
  clientName,
  data,
  keyData,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const years = data?.years || [];
  const [selectedYearIdx, setSelectedYearIdx] = useState(null);
  const [activePopover, setActivePopover] = useState(null);
  const activeYearIdx = selectedYearIdx !== null ? selectedYearIdx : (data?.currentYearIdx !== undefined ? data.currentYearIdx : (years.length > 1 ? 1 : 0));
  const activeYear = years[activeYearIdx];

  const tableScrollRef = useRef(null);
  const chartScrollRef = useRef(null);
  const isSyncingScrollRef = useRef(false);

  const handleTableScroll = () => {
    if (isSyncingScrollRef.current) return;
    isSyncingScrollRef.current = true;
    if (chartScrollRef.current && tableScrollRef.current) {
      chartScrollRef.current.scrollLeft = tableScrollRef.current.scrollLeft;
    }
    isSyncingScrollRef.current = false;
  };

  const handleChartScroll = () => {
    if (isSyncingScrollRef.current) return;
    isSyncingScrollRef.current = true;
    if (tableScrollRef.current && chartScrollRef.current) {
      tableScrollRef.current.scrollLeft = chartScrollRef.current.scrollLeft;
    }
    isSyncingScrollRef.current = false;
  };

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
  const currencySymbol = propCurrencySymbol || keyData?.currencySymbol || "£";
  const thousandsSeparator = propThousandsSeparator || keyData?.thousandsSeparator || ",";

  const endMonthIdx = userEndMonthIdx !== null ? userEndMonthIdx : defaultMonthCutoff;

  // Parse numerical money string (e.g. "£45,270" -> 45270)
  const parseNum = (val) => {
    if (typeof val === "number") return val;
    if (!val) return 0;
    const str = String(val).trim();
    if (str.includes("%")) {
      const clean = str.replace("%", "").trim();
      return (parseFloat(clean) || 0) / 100;
    }
    return parseMoney(val);
  };

  const formatMoney = (val) => {
    return universalFormatMoney(val, 0, currencySymbol, thousandsSeparator);
  };

  const formatPct = (val) => {
    if (!val || isNaN(val) || Math.abs(val) > 10) return "0%";
    return `${Math.round(val * 100)}%`;
  };

  // Margin threshold badge styling
  const getMarginBadgeStyle = (label, valStr) => {
    if (!valStr || !String(valStr).includes("%")) return null;
    const num = parseFloat(String(valStr).replace(/%/g, "")) / 100;
    if (isNaN(num)) return null;

    const t = data?.thresholds || [];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    const l = String(label || "").toLowerCase();

    if (l.includes("gross profit margin")) {
      const high = parseT(0, 0.495);
      const low = parseT(1, 0.445);
      if (num >= high) return { bg: "#d9ead3", color: "#0047AB" };
      if (num >= low) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      const high = parseT(5, 0.309);
      const low = parseT(6, 0.20);
      if (num <= low) return { bg: "#d9ead3", color: "#0047AB" };
      if (num <= high) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    if (l.includes("operating profit %") || l.includes("operating profit margin")) {
      const high = parseT(10, 0.145);
      const low = parseT(11, 0.05);
      if (num >= high) return { bg: "#d9ead3", color: "#0047AB" };
      if (num >= low) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    if (l.includes("staff costs to") || l.includes("staff ratio")) {
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (num < z59) return { bg: "#fce5cd", color: "#0047AB" };
      if (num <= z58) return { bg: "#d9ead3", color: "#0047AB" };
      if (num <= z57) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#f4cccc", color: "#0047AB" };
    }
    return null;
  };

  const getRowStyle = (label) => {
    const l = String(label || "").toLowerCase().trim();
    if (l === "total income" || l === "total revenue") {
      return { bg: "#9900ff", color: "#ffffff", bold: true, isMajor: true };
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
      return { bg: "#ffffff", color: "#0047AB", bold: true, isHeader: true };
    }
    if (l.includes("gross profit margin") || l.includes("gross profit %")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#e69138" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#45818e" };
    }
    if (l.includes("operating profit %") || l.includes("operating profit margin")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#1155cc" };
    }
    if (l.includes("staff costs to") || l.includes("staff ratio")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: "#64748b" };
    }
    if (l.includes("margin") || l.includes("ratio") || l.includes("%")) {
      return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false, isMarginRow: true, accentBar: null };
    }
    return { bg: "#ffffff", color: "#0047AB", bold: false, isMajor: false };
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

  // Trajectory series extraction
  const chartRevVals = (ytdRevRow?.monthVals || []).map(parseNum);
  const chartGpVals = (ytdGpRow?.monthVals || []).map(parseNum);
  const chartOpVals = (ytdOpRow?.monthVals || []).map(parseNum);

  const ytdGpMarginPct = ytdRevTotal > 0 ? ytdGpTotal / ytdRevTotal : 0;
  const ytdOverheadsPct = ytdRevTotal > 0 ? ytdOverheadsTotal / ytdRevTotal : 0;
  const ytdOpMarginPct = ytdRevTotal > 0 ? ytdOpTotal / ytdRevTotal : 0;
  const ytdStaffRatioPct = ytdRevTotal > 0 ? ytdStaffTotal / ytdRevTotal : 0;

  const fyRevTarget = parseNum(ytdRevRow?.totalVal) || (ytdRevTotal > 0 ? ytdRevTotal : 1);
  const fyProgressPct = Math.min(100, Math.round((ytdRevTotal / fyRevTarget) * 100));

  const handleCellClick = (e, rowLabel, val, mIdx, periodLabel) => {
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "—" || val === "" || Math.abs(parseMoney(val)) < 0.001) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const isYTDTotal = mIdx === -1;
    const firstMonthStr = displayedMonths?.[0] || activeYear?.headerMonths?.[0] || "Apr 25";
    const fyStartDate = DeepDiveEngine.parseHeaderDate(firstMonthStr) || new Date(2025, 3, 1);

    let targetDate = null;
    if (isYTDTotal) {
      targetDate = fyStartDate;
    } else {
      const monthStr = displayedMonths?.[mIdx];
      targetDate = monthStr ? DeepDiveEngine.parseHeaderDate(monthStr) : null;
      if (!targetDate) {
        targetDate = new Date(fyStartDate.getFullYear(), fyStartDate.getMonth() + mIdx, 1);
      }
    }

    const isIncomeMode =
      String(keyData?.outgoingsMeta?.mode || "").toLowerCase() === "income" ||
      Boolean(activeYear?.rows?.some((r) => r.label && String(r.label).toLowerCase().includes("confirmed income")));

    const ddData = buildDeepDiveData({
      ddType,
      periodLabel,
      monthIndex: mIdx,
      cellValue: val,
      yearIndex: activeYearIdx,
      targetDate,
      aggregateCount: isYTDTotal ? (displayedMonths?.length || 12) : 1,
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

  const handleDownloadCSV = () => {
    if (!activeYear) return;
    const fyName = (activeYear.fyLabel || activeYear.displayTitle || "YTD").replace(/[^a-zA-Z0-9_-]/g, "_");
    const dateStr = new Date().toISOString().split("T")[0];

    const header = ["Line Item", ...(displayedMonths || []), "YTD Total"];
    const rowsData = ytdRows.map((r) => [
      r.label || "",
      ...r.monthVals.map((v) => (v === "—" ? "" : v || "")),
      r.isPct ? formatPct(r.ytdTotalVal) : formatMoney(r.ytdTotalVal),
    ]);

    const csvContent =
      "data:text/csv;charset=utf-8," +
      [header, ...rowsData]
        .map((e) =>
          e.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Pulse_Performance_YTD_${fyName}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
        sections={activePopover?.sections}
        currencySymbol={currencySymbol}
        thousandsSeparator={thousandsSeparator}
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
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            {activeYear.fyLabel || activeYear.displayTitle}
          </span>
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

          <button
            type="button"
            onClick={handleDownloadCSV}
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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* YTD Cumulative Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "fit-content", maxWidth: "100%", display: "flex", alignItems: "center" }}>
        {activeYearIdx > 0 && (
          <button
            type="button"
            className="fy-nav-arrow-left"
            onClick={() => setSelectedYearIdx(Math.max(0, activeYearIdx - 1))}
            title="Previous Year"
            style={{
              position: "absolute",
              left: "-42px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              color: "#a2c4c9",
              border: "none",
              fontSize: "2.8rem",
              fontWeight: "bold",
              cursor: "pointer",
              padding: "0",
              zIndex: 10,
              lineHeight: 1,
              userSelect: "none",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#8fb5bb")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#a2c4c9")}
          >
            ‹
          </button>
        )}

        <div
          className="fy-table-scroll-wrapper"
          ref={tableScrollRef}
          onScroll={handleTableScroll}
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            border: "1px solid #e2e8f0",
            overflowX: "auto",
            width: "fit-content",
            maxWidth: "100%",
          }}
        >
        <table
          className="fy-main-table"
          style={{
            width: "max-content",
            tableLayout: "fixed",
            borderCollapse: "separate",
            borderSpacing: 0,
            fontSize: "12px",
            fontFamily: "'Kumbh Sans', sans-serif",
          }}
        >
          <colgroup>
            <col style={{ width: "240px", minWidth: "240px", maxWidth: "240px" }} />
            {displayedMonths.map((_, idx) => (
              <col key={idx} style={{ width: "96px", minWidth: "96px", maxWidth: "96px" }} />
            ))}
            <col style={{ width: "110px", minWidth: "110px", maxWidth: "110px" }} />
          </colgroup>
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
                  zIndex: 3,
                  width: "240px",
                  minWidth: "240px",
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
                    width: "96px",
                    minWidth: "96px",
                  }}
                >
                  {m}
                </th>
              ))}
              <th
                style={{
                  padding: "6px 10px",
                  textAlign: "right",
                  fontWeight: 800,
                  fontSize: "12px",
                  background: "#0047AB",
                  width: "110px",
                  minWidth: "110px",
                  borderLeft: "1px solid #cbd5e1",
                }}
              >
                YTD Total
              </th>
            </tr>

            {/* Status row: Actual / Forecast markers */}
            <tr style={{ background: "#ffffff", borderBottom: "1px solid #cbd5e1", fontSize: "10.5px" }}>
              <td
                style={{
                  padding: "3px 8px",
                  position: "sticky",
                  left: 0,
                  background: "#ffffff",
                  zIndex: 3,
                  border: "none",
                }}
              >
                {/* Empty cell, NO Status label */}
              </td>
              {displayedMonths.map((_, idx) => {
                const st = (activeYear.statusValues || activeYear.monthStatuses || [])[idx] || "";
                const raw = String(st).trim();
                const text = raw.toLowerCase() === "actual" ? "Actual" : raw.toLowerCase() === "forecast" ? "Forecast" : raw;
                const isAct = raw.toLowerCase() === "actual";
                return (
                  <td
                    key={idx}
                    style={{
                      padding: "3px 4px",
                      textAlign: "right",
                      color: "#64748b",
                      fontStyle: "italic",
                      background: isAct ? "#f4f7fa" : "#ffffff",
                      border: "none",
                    }}
                  >
                    {text}
                  </td>
                );
              })}
              <td
                style={{
                  padding: "3px 10px",
                  textAlign: "right",
                  background: "rgba(0, 71, 171, 0.04)",
                  border: "none",
                  borderLeft: "1px solid #cbd5e1",
                }}
              />
            </tr>
          </thead>

          <tbody>
            {ytdRows.map((row, rIdx) => {
              if (rIdx < 2) return null;

              const label = String(row.label || "").trim();

              // Detect if this spacer is the gap between Operating Profit % and Staff costs ratio
              let prevLbl = "";
              for (let k = rIdx - 1; k >= 2; k--) {
                if (ytdRows[k]?.label && ytdRows[k].label.toLowerCase() !== "hide") {
                  prevLbl = ytdRows[k].label.toLowerCase();
                  break;
                }
              }
              let nextLbl = "";
              for (let k = rIdx + 1; k < ytdRows.length; k++) {
                if (ytdRows[k]?.label && ytdRows[k].label.toLowerCase() !== "hide") {
                  nextLbl = ytdRows[k].label.toLowerCase();
                  break;
                }
              }
              const isOpToStaffGap =
                (prevLbl.includes("operating profit %") || prevLbl.includes("operating profit margin")) &&
                (nextLbl.includes("staff costs to") || nextLbl.includes("staff ratio"));

              if (label.toLowerCase() === "hide" || (!label && !row.totalVal)) {
                const spacerHeight = isOpToStaffGap ? 18 : 6;
                return (
                  <tr key={rIdx} style={{ height: `${spacerHeight}px`, lineHeight: 0 }}>
                    <td
                      style={{
                        padding: 0,
                        background: "#ffffff",
                        position: "sticky",
                        left: 0,
                        zIndex: 2,
                        border: "none",
                      }}
                    />
                    {displayedMonths.map((_, mIdx) => {
                      const st = String((activeYear.statusValues || activeYear.monthStatuses || [])[mIdx] || "").trim().toLowerCase();
                      const isAct = st === "actual";
                      return (
                        <td
                          key={mIdx}
                          style={{
                            padding: 0,
                            background: isAct ? "#f4f7fa" : "#ffffff",
                            border: "none",
                          }}
                        />
                      );
                    })}
                    <td
                      style={{
                        padding: 0,
                        background: "rgba(0, 71, 171, 0.04)",
                        border: "none",
                        borderLeft: "1px solid #cbd5e1",
                      }}
                    />
                  </tr>
                );
              }

              const rowStyle = getRowStyle(label);
              const isPercentageRow = row.isPct || label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");
              const isMarginRow = Boolean(rowStyle.isMarginRow);

              // Row height: narrower for KPI margin rows (21px) vs regular (25px) vs major (32px)
              const rowHeight = rowStyle.isMajor ? "32px" : isMarginRow ? "21px" : "25px";
              const fontSize = rowStyle.isMajor ? "13px" : isMarginRow ? "11px" : rowStyle.isHeader ? "11px" : "11.5px";

              // YTD Total formatted string
              let ytdDisplay = "";
              if (row.isPct) {
                if (label.toLowerCase().includes("gross profit margin")) ytdDisplay = formatPct(ytdGpMarginPct);
                else if (label.toLowerCase().includes("overheads as %")) ytdDisplay = formatPct(ytdOverheadsPct);
                else if (label.toLowerCase().includes("operating profit %")) ytdDisplay = formatPct(ytdOpMarginPct);
                else ytdDisplay = row.monthVals[row.monthVals.length - 1] || "";
              } else {
                ytdDisplay = formatMoney(row.ytdTotalVal, 0, currencySymbol, thousandsSeparator);
              }

              return (
                <tr
                  key={rIdx}
                  style={{
                    height: rowHeight,
                    borderBottom: rowStyle.isMajor ? "2px solid #cbd5e1" : "1px solid #f1f5f9",
                    background: rowStyle.isMajor ? rowStyle.bg : "#ffffff",
                    fontWeight: rowStyle.bold ? 700 : 400,
                  }}
                >
                  {/* Sticky Line Item Column */}
                  <td
                    style={{
                      padding: rowStyle.isHeader ? "5px 10px" : isMarginRow ? "2px 10px" : "4.5px 10px",
                      color: rowStyle.isMajor ? "#ffffff" : rowStyle.color,
                      fontSize: fontSize,
                      textTransform: rowStyle.isHeader ? "uppercase" : "none",
                      letterSpacing: rowStyle.isHeader ? "0.6px" : "normal",
                      paddingLeft: isMarginRow
                        ? "20px"
                        : !rowStyle.isHeader && !rowStyle.isMajor
                        ? "16px"
                        : "10px",
                      fontStyle: isPercentageRow ? "italic" : "normal",
                      position: "sticky",
                      left: 0,
                      background: rowStyle.isMajor ? rowStyle.bg : "#ffffff",
                      borderLeft: isMarginRow && rowStyle.accentBar ? `4px solid ${rowStyle.accentBar}` : "none",
                      zIndex: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                    }}
                    title={label}
                  >
                    {label}
                  </td>

                  {/* Monthly Value Columns */}
                  {row.monthVals.map((val, mIdx) => {
                    const mBadge = isPercentageRow ? getMarginBadgeStyle(label, val) : null;
                    const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                    const isClickable = Boolean(ddType && val && val !== "—" && val !== "" && Math.abs(parseMoney(val)) >= 0.001);
                    const monthLabel = activeYear.headerMonths?.[mIdx] || `Month ${mIdx + 1}`;
                    const displayVal = val === "—" ? "" : formatCurrencyString(val, null, currencySymbol, thousandsSeparator);
                    const st = String((activeYear.statusValues || activeYear.monthStatuses || [])[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    const colBg = isAct ? "#f4f7fa" : "#ffffff";

                    // If major row: solid band, transparent cell
                    if (rowStyle.isMajor) {
                      return (
                        <td
                          key={mIdx}
                          onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
                          style={{
                            padding: "4.5px 4px",
                            textAlign: "right",
                            color: "#ffffff",
                            fontSize: "13px",
                            fontWeight: 700,
                            background: "transparent",
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed rgba(255,255,255,0.6) 1px" : "none",
                            textUnderlineOffset: "2px",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {displayVal}
                        </td>
                      );
                    }

                    // If KPI margin row: narrower, with column-colored border buffer
                    if (isMarginRow) {
                      return (
                        <td
                          key={mIdx}
                          style={{
                            padding: "1px 2px",
                            background: colBg,
                            textAlign: "right",
                            height: "21px",
                          }}
                        >
                          <div
                            style={{
                              display: "inline-block",
                              width: "100%",
                              padding: "1.5px 3px",
                              borderRadius: "4px",
                              background: mBadge ? mBadge.bg : "transparent",
                              color: mBadge ? mBadge.color : "#0047AB",
                              border: mBadge ? `1.5px solid ${colBg}` : "none",
                              fontStyle: "italic",
                              fontSize: "11px",
                              fontWeight: mBadge ? 700 : 400,
                              fontVariantNumeric: "tabular-nums",
                              boxSizing: "border-box",
                            }}
                          >
                            {displayVal}
                          </div>
                        </td>
                      );
                    }

                    // Regular data row
                    return (
                      <td
                        key={mIdx}
                        onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
                        style={{
                          padding: "4.5px 4px",
                          textAlign: "right",
                          color: rowStyle.color,
                          fontSize: "11.5px",
                          fontWeight: rowStyle.bold ? 700 : 400,
                          background: colBg,
                          cursor: isClickable ? "pointer" : "default",
                          textDecoration: isClickable ? "underline dashed #94a3b8 1px" : "none",
                          textUnderlineOffset: "2px",
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                          transition: "background-color 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                        }}
                        onMouseLeave={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "none";
                        }}
                      >
                        {rowStyle.isHeader ? "" : displayVal}
                      </td>
                    );
                  })}

                  {/* YTD Total Column (Continuous unbroken Total column shading) */}
                  {(() => {
                    const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                    const isClickable = Boolean(ddType && ytdDisplay && ytdDisplay !== "—" && ytdDisplay !== "" && Math.abs(parseMoney(ytdDisplay)) >= 0.001);
                    const ytdBadge = isPercentageRow ? getMarginBadgeStyle(label, ytdDisplay) : null;
                    const displayTotal = ytdDisplay === "—" ? "" : ytdDisplay || "";
                    const totalColBg = "rgba(0, 71, 171, 0.04)";

                    if (rowStyle.isMajor) {
                      return (
                        <td
                          onClick={(e) =>
                            isClickable &&
                            handleCellClick(e, label, ytdDisplay, -1, `YTD Through ${cutoffLabel}`)
                          }
                          style={{
                            padding: "4.5px 10px",
                            textAlign: "right",
                            color: "#ffffff",
                            fontSize: "13px",
                            fontWeight: 800,
                            background: "transparent",
                            borderLeft: "1px solid #cbd5e1",
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed rgba(255,255,255,0.6) 1px" : "none",
                            textUnderlineOffset: "2px",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {displayTotal}
                        </td>
                      );
                    }

                    if (isMarginRow) {
                      return (
                        <td
                          style={{
                            padding: "1px 2px",
                            background: totalColBg,
                            borderLeft: "1px solid #cbd5e1",
                            textAlign: "right",
                            height: "21px",
                          }}
                        >
                          <div
                            style={{
                              display: "inline-block",
                              width: "100%",
                              padding: "1.5px 6px",
                              borderRadius: "4px",
                              background: ytdBadge ? ytdBadge.bg : "transparent",
                              color: ytdBadge ? ytdBadge.color : "#0047AB",
                              border: ytdBadge ? `1.5px solid ${totalColBg}` : "none",
                              fontStyle: "italic",
                              fontSize: "11px",
                              fontWeight: 700,
                              fontVariantNumeric: "tabular-nums",
                              boxSizing: "border-box",
                            }}
                          >
                            {displayTotal}
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td
                        onClick={(e) =>
                          isClickable &&
                          handleCellClick(e, label, ytdDisplay, -1, `YTD Through ${cutoffLabel}`)
                        }
                        style={{
                          padding: "4.5px 10px",
                          textAlign: "right",
                          color: "#0047AB",
                          fontSize: "11.5px",
                          fontWeight: rowStyle.bold ? 700 : 600,
                          background: totalColBg,
                          borderLeft: "1px solid #cbd5e1",
                          cursor: isClickable ? "pointer" : "default",
                          textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                          textUnderlineOffset: "2px",
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                          transition: "background-color 0.15s ease",
                        }}
                        onMouseEnter={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                        }}
                        onMouseLeave={(e) => {
                          if (isClickable) e.currentTarget.style.filter = "none";
                        }}
                      >
                        {rowStyle.isHeader ? "" : displayTotal}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeYearIdx < years.length - 1 && (
        <button
          type="button"
          className="fy-nav-arrow-right"
          onClick={() => setSelectedYearIdx(Math.min(years.length - 1, activeYearIdx + 1))}
          title="Next Year"
          style={{
            position: "absolute",
            right: "-42px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            color: "#a2c4c9",
            border: "none",
            fontSize: "2.8rem",
            fontWeight: "bold",
            cursor: "pointer",
            padding: "0",
            zIndex: 10,
            lineHeight: 1,
            userSelect: "none",
            transition: "color 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#8fb5bb")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#a2c4c9")}
        >
          ›
        </button>
      )}
    </div>

      {/* Performance Trajectory Chart sitting below the table with 3x white space */}
      <PerformanceTrajectoryChartRow
        months={displayedMonths}
        statuses={(activeYear.statusValues || activeYear.monthStatuses || []).slice(0, displayedMonths.length)}
        revenue={chartRevVals}
        grossProfit={chartGpVals}
        operatingProfit={chartOpVals}
        currencySymbol={currencySymbol}
        thousandsSeparator={thousandsSeparator}
        layout="ytd"
        scrollRef={chartScrollRef}
        onScroll={handleChartScroll}
      />

      <style jsx>{`
        @media (orientation: landscape) and (max-width: 1024px) {
          .fy-table-scroll-wrapper,
          .fy-chart-scroll-wrapper {
            margin: 0 !important;
            width: fit-content !important;
            max-width: 100% !important;
          }
          .fy-nav-arrow-left {
            left: -32px !important;
            font-size: 2.4rem !important;
          }
          .fy-nav-arrow-right {
            right: -32px !important;
            font-size: 2.4rem !important;
          }
        }
        @media (max-width: 768px) and (orientation: portrait) {
          .fy-nav-arrow-left {
            left: 2px !important;
            font-size: 2.2rem !important;
          }
          .fy-nav-arrow-right {
            right: 2px !important;
            font-size: 2.2rem !important;
          }
          .fy-table-scroll-wrapper,
          .fy-chart-scroll-wrapper {
            margin: 0 24px !important;
            width: calc(100% - 48px) !important;
          }
        }
      `}</style>
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
