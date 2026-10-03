import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";
import DeepDivePopover from "./DeepDivePopover";
import { PulseMath, mutateFYDataForScenarios, getDeepDiveType, buildDeepDiveData } from "../../services/deepDiveHelper";

export default function ScenariosView({
  clientName,
  performanceData,
  keyData,
  isLoading,
  error,
  onRefresh,
}) {
  const years = performanceData?.years || [];
  const defaultYearIdx =
    performanceData?.currentYearIdx !== undefined
      ? performanceData.currentYearIdx
      : years.length > 0
      ? years.length - 2
      : 0;
  const [selectedYearIdx, setSelectedYearIdx] = useState(defaultYearIdx);
  const [pipelineSort, setPipelineSort] = useState("startDate-desc");

  const activeYearIdx = Math.min(Math.max(0, selectedYearIdx), Math.max(0, years.length - 1));
  const activeYear = years[activeYearIdx];

  const pipelineJobs = useMemo(() => {
    return keyData?.jobs?.pipeline || [];
  }, [keyData]);

  // Adjustments state: 12 months
  // nbChecked: boolean[12], rev: number[12], delStaff: number[12], delExp: number[12], nonDelStaff: number[12], nonDelExp: number[12]
  const [adjs, setAdjs] = useState({
    nbChecked: new Array(12).fill(true),
    rev: new Array(12).fill(0),
    delStaff: new Array(12).fill(0),
    delExp: new Array(12).fill(0),
    nonDelStaff: new Array(12).fill(0),
    nonDelExp: new Array(12).fill(0),
  });

  // Pipeline job toggles:
  // disabledJobs: Set of job IDs excluded from pipeline
  // confirmedJobs: Set of job IDs treated as confirmed
  const [disabledJobIds, setDisabledJobIds] = useState(new Set());
  const [confirmedJobIds, setConfirmedJobIds] = useState(new Set());

  // Master checkboxes status
  const allIncluded = pipelineJobs.length > 0 && pipelineJobs.every((j) => !disabledJobIds.has(j.id) && !confirmedJobIds.has(j.id));
  const allConfirmed = pipelineJobs.length > 0 && pipelineJobs.every((j) => confirmedJobIds.has(j.id));

  const toggleAllIncluded = () => {
    if (allIncluded) {
      // Exclude all that are not confirmed
      setDisabledJobIds(new Set(pipelineJobs.map((j) => j.id)));
    } else {
      // Include all, clear exclusions
      setDisabledJobIds(new Set());
    }
  };

  const toggleAllConfirmed = () => {
    if (allConfirmed) {
      setConfirmedJobIds(new Set());
      setDisabledJobIds(new Set());
    } else {
      setConfirmedJobIds(new Set(pipelineJobs.map((j) => j.id)));
      setDisabledJobIds(new Set());
    }
  };

  const toggleJobIncluded = (id) => {
    if (confirmedJobIds.has(id)) return; // disabled if confirmed
    setDisabledJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleJobConfirmed = (id) => {
    setConfirmedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setDisabledJobIds((dPrev) => {
          const dNext = new Set(dPrev);
          dNext.delete(id);
          return dNext;
        });
      } else {
        next.add(id);
        setDisabledJobIds((dPrev) => {
          const dNext = new Set(dPrev);
          dNext.delete(id);
          return dNext;
        });
      }
      return next;
    });
  };

  const handleAdjMonthChange = (category, mIdx, val) => {
    const num = parseFloat(String(val).replace(/[£,]/g, "")) || 0;
    setAdjs((prev) => {
      const copy = [...prev[category]];
      copy[mIdx] = num;
      return { ...prev, [category]: copy };
    });
  };

  const handleToggleNBMonth = (mIdx) => {
    setAdjs((prev) => {
      const copy = [...prev.nbChecked];
      copy[mIdx] = !copy[mIdx];
      return { ...prev, nbChecked: copy };
    });
  };

  const handleToggleMasterNB = () => {
    const anyUnchecked = adjs.nbChecked.some((c) => !c);
    setAdjs((prev) => ({
      ...prev,
      nbChecked: new Array(12).fill(anyUnchecked),
    }));
  };

  const handleResetScenarios = () => {
    setAdjs({
      nbChecked: new Array(12).fill(true),
      rev: new Array(12).fill(0),
      delStaff: new Array(12).fill(0),
      delExp: new Array(12).fill(0),
      nonDelStaff: new Array(12).fill(0),
      nonDelExp: new Array(12).fill(0),
    });
    setDisabledJobIds(new Set());
    setConfirmedJobIds(new Set());
  };

  const [activePopover, setActivePopover] = useState(null);

  const handleCellClick = (e, rowLabel, val, mIdx, periodLabel) => {
    const ddType = getDeepDiveType(rowLabel);
    if (!ddType || !val || val === "£0" || val === "—" || val === "") return;

    const rect = e.currentTarget.getBoundingClientRect();
    const isFY = mIdx === -1;
    const targetDate = isFY
      ? (headerMonths[0] ? parseHeaderMonthDate(headerMonths[0]) : new Date(2025, 3, 1))
      : (headerMonths[mIdx] ? parseHeaderMonthDate(headerMonths[mIdx]) : null);

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
      keyData,
      isIncomeMode,
      isScenarioView: true,
      scenariosConfig: {
        confirmedJobs: confirmedJobIds,
        disabledJobs: disabledJobIds,
        adjs,
        jobs: pipelineJobs,
        outgoingsMeta: keyData?.outgoingsMeta,
        profitShareSwitch: keyData?.outgoingsMeta?.profitShareSwitch,
        profitSharePct: keyData?.outgoingsMeta?.profitSharePct,
        scenarioMeta: mutatedYearData?.scenarioMeta,
      },
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

  const parseNum = (val) => {
    if (typeof val === "number") return val;
    if (!val) return 0;
    const clean = String(val).replace(/[£,]/g, "").trim();
    if (clean.includes("%")) return parseFloat(clean) / 100;
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
  };

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString()}`;
  };

  const formatPct = (val) => `${Math.round((val || 0) * 100)}%`;

  const parseDateSafe = (dateVal) => {
    if (!dateVal) return null;
    if (dateVal instanceof Date && !isNaN(dateVal.getTime())) return dateVal;
    const str = String(dateVal).trim();
    const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ukMatch) {
      return new Date(parseInt(ukMatch[3], 10), parseInt(ukMatch[2], 10) - 1, parseInt(ukMatch[1], 10));
    }
    const shortUk = str.match(/^(\d{1,2})[\-\/\s]([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
    if (shortUk) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mi = months[shortUk[2].toLowerCase()];
      let yr = parseInt(shortUk[3], 10);
      if (yr < 100) yr += 2000;
      return new Date(yr, mi, parseInt(shortUk[1], 10));
    }
    const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (isoMatch) {
      return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  };

  const parseHeaderMonthDate = (str) => {
    if (!str) return null;
    const m = String(str).match(/([a-zA-Z]{3})[\s\-']?(\d{2,4})/);
    if (m) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mi = months[m[1].toLowerCase()];
      let yr = parseInt(m[2], 10);
      if (yr < 100) yr += 2000;
      return new Date(yr, mi, 1);
    }
    return null;
  };

  const formatDateDisplay = (dateVal) => {
    const d = parseDateSafe(dateVal);
    if (!d) return "—";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };

  const headerMonths = useMemo(() => activeYear?.headerMonths || [], [activeYear?.headerMonths]);

  // Sorted pipeline jobs
  const sortedPipelineJobs = useMemo(() => {
    return [...pipelineJobs].sort((a, b) => {
      if (pipelineSort === "startDate-asc") {
        const dA = parseDateSafe(a.startDate);
        const dB = parseDateSafe(b.startDate);
        const tA = dA ? dA.getTime() : Infinity;
        const tB = dB ? dB.getTime() : Infinity;
        if (tA !== tB) return tA - tB;
        return String(a.client || "").localeCompare(String(b.client || ""));
      }
      if (pipelineSort === "likelihood-desc") {
        const lA = a.likelihoodNum !== undefined ? a.likelihoodNum : 0;
        const lB = b.likelihoodNum !== undefined ? b.likelihoodNum : 0;
        if (lB !== lA) return lB - lA;
        return String(a.client || "").localeCompare(String(b.client || ""));
      }
      if (pipelineSort === "likelihood-asc") {
        const lA = a.likelihoodNum !== undefined ? a.likelihoodNum : 0;
        const lB = b.likelihoodNum !== undefined ? b.likelihoodNum : 0;
        if (lA !== lB) return lA - lB;
        return String(a.client || "").localeCompare(String(b.client || ""));
      }
      if (pipelineSort === "client-asc") {
        const cA = String(a.client || "").localeCompare(String(b.client || ""));
        if (cA !== 0) return cA;
        return String(a.jobName || "").localeCompare(String(b.jobName || ""));
      }
      // Default: startDate-desc
      const dA = parseDateSafe(a.startDate);
      const dB = parseDateSafe(b.startDate);
      const tA = dA ? dA.getTime() : -Infinity;
      const tB = dB ? dB.getTime() : -Infinity;
      if (tB !== tA) return tB - tA;
      return String(a.client || "").localeCompare(String(b.client || ""));
    });
  }, [pipelineJobs, pipelineSort]);

  // Calculate Scenario Deltas using the exact algebraic resolution engine from WebApp.html
  const mutatedYearData = useMemo(() => {
    if (!activeYear?.rows) return null;
    return mutateFYDataForScenarios(activeYear, {
      confirmedJobs: confirmedJobIds,
      disabledJobs: disabledJobIds,
      adjs,
      jobs: pipelineJobs,
      outgoingsMeta: keyData?.outgoingsMeta,
      profitShareSwitch: keyData?.outgoingsMeta?.profitShareSwitch,
      profitSharePct: keyData?.outgoingsMeta?.profitSharePct,
      yearIndex: activeYearIdx,
    });
  }, [activeYear, confirmedJobIds, disabledJobIds, adjs, pipelineJobs, keyData?.outgoingsMeta, activeYearIdx]);

  const mutatedRows = mutatedYearData?.rows || activeYear?.rows || [];

  // Row styling matching PerformanceFYView and WebApp.html
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
      return { bg: "#efefef", color: "#0047AB", bold: true, isHeader: true };
    }
    if (l === "total costs of sale" || l === "total cost of sales") {
      return { bg: "#efefef", color: "#0047AB", bold: true, isMajor: false };
    }
    return { bg: "#efefef", color: "#0047AB", bold: false, isMajor: false };
  };

  const getMarginBadgeStyle = (label, valStr) => {
    if (!valStr || !String(valStr).includes("%")) return null;
    const num = parseFloat(String(valStr).replace(/%/g, "")) / 100;
    if (isNaN(num)) return null;

    const t = performanceData?.thresholds || [0.495, 0.445, 0, 0, 0, 0.309, 0.2, 0, 0, 0, 0.145, 0.05, 0, 0, 0, 0.705, 0.66, 0.54];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, ""));
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    const l = String(label || "").toLowerCase();
    if (l.includes("gross profit margin")) {
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (num < z43) return { bg: "#f4cccc", color: "#000000" };
      if (num <= z42) return { bg: "#fce5cd", color: "#000000" };
      return { bg: "#d9ead3", color: "#000000" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.20);
      if (num > z47) return { bg: "#f4cccc", color: "#000000" };
      if (num >= z48) return { bg: "#d9ead3", color: "#000000" };
      return { bg: "#fce5cd", color: "#000000" };
    }
    if (l.includes("operating profit %")) {
      const z52 = parseT(10, 0.145);
      const z53 = parseT(11, 0.05);
      if (num < z53) return { bg: "#f4cccc", color: "#000000" };
      if (num <= z52) return { bg: "#fce5cd", color: "#000000" };
      return { bg: "#d9ead3", color: "#000000" };
    }
    if (l.includes("staff costs to income") || l.includes("staff ratio")) {
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (num < z59) return { bg: "#fce5cd", color: "#000000" };
      if (num <= z58) return { bg: "#d9ead3", color: "#000000" };
      if (num <= z57) return { bg: "#fce5cd", color: "#000000" };
      return { bg: "#f4cccc", color: "#000000" };
    }
    return null;
  };

  if (isLoading && !activeYear) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Please wait - loading
        </p>
      </div>
    );
  }

  if (error && !activeYear) {
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
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load scenario data</h4>
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
          flexWrap: "wrap",
          gap: "1rem",
          padding: "0.25rem 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
            Scenario planning
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {years.length > 1 && (
              <button
                type="button"
                onClick={() => setSelectedYearIdx((prev) => Math.max(0, prev - 1))}
                disabled={activeYearIdx <= 0}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: activeYearIdx <= 0 ? "not-allowed" : "pointer",
                  color: activeYearIdx <= 0 ? "#cbd5e1" : "#0047AB",
                  fontSize: "14px",
                  fontWeight: 700,
                  padding: "0 4px",
                }}
              >
                ‹
              </button>
            )}
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
              {activeYear?.fyLabel || activeYear?.displayTitle}
            </span>
            {years.length > 1 && (
              <button
                type="button"
                onClick={() => setSelectedYearIdx((prev) => Math.min(years.length - 1, prev + 1))}
                disabled={activeYearIdx >= years.length - 1}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: activeYearIdx >= years.length - 1 ? "not-allowed" : "pointer",
                  color: activeYearIdx >= years.length - 1 ? "#cbd5e1" : "#0047AB",
                  fontSize: "14px",
                  fontWeight: 700,
                  padding: "0 4px",
                }}
              >
                ›
              </button>
            )}
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleResetScenarios}
            title="Reset scenario inputs"
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              color: "#475569",
              padding: "5px 12px",
              borderRadius: "6px",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reset Scenarios
          </button>

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

      {/* 1. TOP SECTION: Full Financial Year Performance Table (All Rows Reflecting Scenarios) */}
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
              minWidth: "780px",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              tableLayout: "fixed",
            }}
          >
            <thead>
              {/* Row 1: Header Titles with NO 'Line Item' in top-left cell */}
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "left",
                    fontWeight: 700,
                    width: "22%",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 2,
                  }}
                >
                  {/* Empty top-left cell */}
                </th>
                {headerMonths.map((m, idx) => (
                  <th
                    key={idx}
                    style={{
                      padding: "6px 4px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "11px",
                      width: "5.8%",
                    }}
                  >
                    {m}
                  </th>
                ))}
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    fontWeight: 800,
                    width: "8.4%",
                    background: "#0047AB",
                  }}
                >
                  {activeYear?.totalColHeader || "FY Total"}
                </th>
              </tr>

              {/* Row 2: Status row (Actual vs Forecast) with NO column header */}
              <tr style={{ background: "#efefef", borderBottom: "1px solid #ffffff", fontSize: "10.5px" }}>
                <td
                  style={{
                    padding: "3px 8px",
                    position: "sticky",
                    left: 0,
                    background: "#efefef",
                    zIndex: 2,
                  }}
                >
                  {/* Empty cell, NO Status label */}
                </td>
                {activeYear?.statusValues?.map((st, idx) => {
                  const raw = String(st || "").trim();
                  const text = raw.toLowerCase() === "actual" ? "Actual" : raw.toLowerCase() === "forecast" ? "Forecast" : raw;
                  return (
                    <td key={idx} style={{ padding: "3px 4px", textAlign: "right", color: "#666666", fontStyle: "italic", background: "#efefef" }}>
                      {text}
                    </td>
                  );
                })}
                <td style={{ padding: "3px 8px", textAlign: "right", background: "#efefef" }}></td>
              </tr>
            </thead>

            <tbody>
              {mutatedRows.map((row, rIdx) => {
                const label = row.label;
                const totalVal = row.totalVal;

                if (!label || label.toLowerCase() === "hide") {
                  return (
                    <tr key={rIdx} style={{ height: "6px", background: "#efefef" }}>
                      <td colSpan={14} style={{ padding: 0, background: "#efefef" }} />
                    </tr>
                  );
                }

                const rowStyle = getRowStyle(label);
                const isPercentageRow = label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");
                const totalBadge = isPercentageRow ? getMarginBadgeStyle(label, totalVal) : null;

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
                        padding: rowStyle.isHeader ? "4px 8px" : "4px 8px",
                        color: rowStyle.color,
                        fontSize: rowStyle.isMajor ? "13px" : rowStyle.isHeader ? "11px" : "11.5px",
                        textTransform: rowStyle.isHeader ? "uppercase" : "none",
                        letterSpacing: rowStyle.isHeader ? "0.5px" : "normal",
                        paddingLeft: !rowStyle.isHeader && !rowStyle.isMajor ? "16px" : "8px",
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

                    {/* 12 Month Values */}
                    {row.monthlyValues?.map((val, mIdx) => {
                      const mBadge = isPercentageRow ? getMarginBadgeStyle(label, val) : null;
                      const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                      const isClickable = Boolean(ddType && val && val !== "£0" && val !== "—" && val !== "");
                      const monthLabel = headerMonths[mIdx] || `Month ${mIdx + 1}`;
                      const displayVal = val === "—" ? "" : val || "";

                      return (
                        <td
                          key={mIdx}
                          onClick={(e) => isClickable && handleCellClick(e, label, val, mIdx, monthLabel)}
                          style={{
                            padding: "4px 4px",
                            textAlign: "right",
                            color: rowStyle.isMajor ? "#ffffff" : mBadge ? mBadge.color : rowStyle.color,
                            fontStyle: isPercentageRow ? "italic" : "normal",
                            fontSize: rowStyle.isMajor ? "12px" : "11px",
                            background: mBadge ? mBadge.bg : "transparent",
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed #94a3b8 1px" : "none",
                            textUnderlineOffset: isClickable ? "2px" : "initial",
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "none";
                          }}
                        >
                          {displayVal}
                        </td>
                      );
                    })}

                    {/* Total Column */}
                    {(() => {
                      const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                      const isClickable = Boolean(ddType && totalVal && totalVal !== "£0" && totalVal !== "—" && totalVal !== "");
                      const displayTotal = totalVal === "—" ? "" : totalVal || "";

                      return (
                        <td
                          onClick={(e) => isClickable && handleCellClick(e, label, totalVal, -1, `${activeYear?.fyLabel || "FY"} Total`)}
                          style={{
                            padding: "4px 8px",
                            textAlign: "right",
                            fontWeight: rowStyle.isMajor ? 800 : 700,
                            color: rowStyle.isMajor ? "#ffffff" : totalBadge ? totalBadge.color : "#0047AB",
                            fontStyle: isPercentageRow ? "italic" : "normal",
                            fontSize: rowStyle.isMajor ? "13px" : "11.5px",
                            background: totalBadge ? totalBadge.bg : (rowStyle.isMajor ? "transparent" : rowStyle.bg),
                            cursor: isClickable ? "pointer" : "default",
                            textDecoration: isClickable ? "underline dashed #0047AB 1px" : "none",
                            textUnderlineOffset: isClickable ? "2px" : "initial",
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "brightness(0.92)";
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable) e.currentTarget.style.filter = "none";
                          }}
                        >
                          {displayTotal}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 2. MIDDLE SECTION: Synchronized Financial Adjustments Grid */}
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
        <div
          style={{
            padding: "0.6rem 1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "12px", fontWeight: 700, color: "#0047AB" }}>
            Scenario Financial Adjustments
          </span>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Enter deltas (+/-) to dynamically simulate business conditions
          </span>
        </div>

        <div style={{ overflowX: "auto", width: "100%" }}>
          <table
            style={{
              width: "100%",
              minWidth: "780px",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr style={{ background: "#f1f5f9", color: "#475569" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontWeight: 700, width: "22%", position: "sticky", left: 0, background: "#f1f5f9", zIndex: 2 }}>
                  Adjustment Item
                </th>
                {headerMonths.map((m, idx) => (
                  <th key={idx} style={{ padding: "6px 4px", textAlign: "center", fontWeight: 600, fontSize: "11px", width: "5.8%" }}>
                    {m}
                  </th>
                ))}
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, width: "8.4%" }}>
                  Total Delta
                </th>
              </tr>
            </thead>

            <tbody>
              {/* Include NB to Find Checkboxes */}
              <tr style={{ borderBottom: "1px solid #ffffff", background: "#efefef" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600, color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="checkbox"
                      checked={adjs.nbChecked.every(Boolean)}
                      onChange={handleToggleMasterNB}
                      style={{ cursor: "pointer", width: "14px", height: "14px", accentColor: "#0047AB" }}
                      title="Toggle all months"
                    />
                    <span>Include NB to find?</span>
                  </div>
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "4px 4px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={adjs.nbChecked[mIdx]}
                      onChange={() => handleToggleNBMonth(mIdx)}
                      style={{ cursor: "pointer", width: "14px", height: "14px", accentColor: "#0047AB" }}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>
                  {adjs.nbChecked.filter(Boolean).length}/12 Months
                </td>
              </tr>

              {/* Additional Revenue Inputs */}
              <tr style={{ borderBottom: "1px solid #ffffff", background: "#efefef" }}>
                <td style={{ padding: "6px 8px", color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  Additional revenue
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "3px 3px" }}>
                    <input
                      type="text"
                      value={adjs.rev[mIdx] || ""}
                      onChange={(e) => handleAdjMonthChange("rev", mIdx, e.target.value)}
                      placeholder="0"
                      style={gridInputStyle}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(adjs.rev.reduce((a, b) => a + b, 0))}
                </td>
              </tr>

              {/* Additional delivery staff costs */}
              <tr style={{ borderBottom: "1px solid #ffffff", background: "#efefef" }}>
                <td style={{ padding: "6px 8px", color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  Additional delivery staff costs
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "3px 3px" }}>
                    <input
                      type="text"
                      value={adjs.delStaff[mIdx] || ""}
                      onChange={(e) => handleAdjMonthChange("delStaff", mIdx, e.target.value)}
                      placeholder="0"
                      style={gridInputStyle}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(adjs.delStaff.reduce((a, b) => a + b, 0))}
                </td>
              </tr>

              {/* Additional delivery expenses */}
              <tr style={{ borderBottom: "1px solid #ffffff", background: "#efefef" }}>
                <td style={{ padding: "6px 8px", color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  Additional delivery expenses
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "3px 3px" }}>
                    <input
                      type="text"
                      value={adjs.delExp[mIdx] || ""}
                      onChange={(e) => handleAdjMonthChange("delExp", mIdx, e.target.value)}
                      placeholder="0"
                      style={gridInputStyle}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(adjs.delExp.reduce((a, b) => a + b, 0))}
                </td>
              </tr>

              {/* Additional non-delivery staff costs */}
              <tr style={{ borderBottom: "1px solid #ffffff", background: "#efefef" }}>
                <td style={{ padding: "6px 8px", color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  Additional non-delivery staff costs
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "3px 3px" }}>
                    <input
                      type="text"
                      value={adjs.nonDelStaff[mIdx] || ""}
                      onChange={(e) => handleAdjMonthChange("nonDelStaff", mIdx, e.target.value)}
                      placeholder="0"
                      style={gridInputStyle}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(adjs.nonDelStaff.reduce((a, b) => a + b, 0))}
                </td>
              </tr>

              {/* Additional non-delivery expenses */}
              <tr style={{ background: "#efefef" }}>
                <td style={{ padding: "6px 8px", color: "#0047AB", position: "sticky", left: 0, background: "#efefef", zIndex: 1, whiteSpace: "nowrap" }}>
                  Additional non-delivery expenses
                </td>
                {headerMonths.map((_, mIdx) => (
                  <td key={mIdx} style={{ padding: "3px 3px" }}>
                    <input
                      type="text"
                      value={adjs.nonDelExp[mIdx] || ""}
                      onChange={(e) => handleAdjMonthChange("nonDelExp", mIdx, e.target.value)}
                      placeholder="0"
                      style={gridInputStyle}
                    />
                  </td>
                ))}
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(adjs.nonDelExp.reduce((a, b) => a + b, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. BOTTOM SECTION: Pipeline Table (Exact 10 Columns Matching Original WebApp) */}
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
        <div
          style={{
            padding: "0.75rem 1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #cbd5e1",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, color: "#1e293b", fontSize: "16px", fontWeight: 700 }}>
              Pipeline
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="scenario-sort-select" style={{ fontSize: "12px", fontWeight: 500, color: "#64748b" }}>
                Sort by:
              </label>
              <select
                id="scenario-sort-select"
                value={pipelineSort}
                onChange={(e) => setPipelineSort(e.target.value)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#1e293b",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                <option value="startDate-desc">Job start date (descending)</option>
                <option value="startDate-asc">Job start date (ascending)</option>
                <option value="likelihood-desc">Likelihood (descending)</option>
                <option value="likelihood-asc">Likelihood (ascending)</option>
                <option value="client-asc">Client name</option>
              </select>
            </div>
          </div>
        </div>

        <div style={{ overflowX: "auto", width: "100%" }}>
          <table
            style={{
              width: "100%",
              minWidth: "750px",
              borderCollapse: "collapse",
              background: "#ffffff",
              textAlign: "left",
              fontSize: "13px",
            }}
          >
            <thead style={{ background: "#f1f5f9", color: "#475569" }}>
              <tr>
                {/* Column 1: Include with Master Checkbox */}
                <th style={{ padding: "10px 8px", borderBottom: "1px solid #cbd5e1", textAlign: "center", width: "70px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                    <input
                      type="checkbox"
                      checked={allIncluded}
                      onChange={toggleAllIncluded}
                      style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#0047AB" }}
                      title="Include all in pipeline"
                    />
                    <span style={{ fontSize: "11px", fontWeight: 600 }}>Include</span>
                  </div>
                </th>

                {/* Column 2: Assume Conf with Master Checkbox */}
                <th style={{ padding: "10px 8px", borderBottom: "1px solid #cbd5e1", textAlign: "center", width: "85px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                    <input
                      type="checkbox"
                      checked={allConfirmed}
                      onChange={toggleAllConfirmed}
                      style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#0047AB" }}
                      title="Assume all confirmed"
                    />
                    <span style={{ fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap" }}>Assume Conf</span>
                  </div>
                </th>

                {/* Column 3: Client */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  Client
                </th>

                {/* Column 4: Job Name */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  Job Name
                </th>

                {/* Column 5: Type */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  Type
                </th>

                {/* Column 6: Start */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  Start
                </th>

                {/* Column 7: End */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  End
                </th>

                {/* Column 8: Likelihood */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", fontWeight: 600 }}>
                  Likelihood
                </th>

                {/* Column 9: Revenue */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", textAlign: "right", fontWeight: 600 }}>
                  Revenue
                </th>

                {/* Column 10: Direct costs */}
                <th style={{ padding: "10px 12px", borderBottom: "1px solid #cbd5e1", textAlign: "right", fontWeight: 600 }}>
                  Direct costs
                </th>
              </tr>
            </thead>

            <tbody>
              {sortedPipelineJobs.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
                    No pipeline deals found.
                  </td>
                </tr>
              ) : (
                sortedPipelineJobs.map((job, idx) => {
                  const isConf = confirmedJobIds.has(job.id);
                  const isUnchecked = disabledJobIds.has(job.id);
                  const isIncluded = !isUnchecked && !isConf;

                  const isRetainer = String(job.projectRetainer || job.type || "").toLowerCase().includes("retain");
                  const typeBg = isRetainer ? "#dbeafe" : "#f3e8ff";
                  const typeColor = isRetainer ? "#1e40af" : "#6b21a8";

                  let likelihoodDisp = job.likelihood || "";
                  const parsedLikelihood = parseFloat(String(likelihoodDisp).replace("%", ""));
                  if (!isNaN(parsedLikelihood)) {
                    likelihoodDisp = `${Math.round(parsedLikelihood <= 1 && !String(job.likelihood).includes("%") ? parsedLikelihood * 100 : parsedLikelihood)}%`;
                  } else {
                    likelihoodDisp = "—";
                  }

                  return (
                    <tr
                      key={job.id || idx}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        backgroundColor: isConf ? "#f8fafc" : "transparent",
                      }}
                    >
                      {/* Checkbox 1: Include */}
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          disabled={isConf}
                          onChange={() => toggleJobIncluded(job.id)}
                          style={{
                            width: "16px",
                            height: "16px",
                            cursor: isConf ? "not-allowed" : "pointer",
                            opacity: isConf ? "0.4" : "1",
                            accentColor: "#0047AB",
                          }}
                        />
                      </td>

                      {/* Checkbox 2: Assume Conf */}
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={isConf}
                          onChange={() => toggleJobConfirmed(job.id)}
                          style={{
                            width: "16px",
                            height: "16px",
                            cursor: "pointer",
                            accentColor: "#0047AB",
                          }}
                        />
                      </td>

                      {/* Client */}
                      <td style={{ padding: "10px 12px", fontWeight: 600, color: isConf ? "#64748b" : "#0f172a" }}>
                        {job.client}
                      </td>

                      {/* Job Name */}
                      <td style={{ padding: "10px 12px", color: "#334155" }}>
                        {job.jobName}
                      </td>

                      {/* Type Badge */}
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            background: typeBg,
                            color: typeColor,
                            padding: "3px 8px",
                            borderRadius: "999px",
                            fontSize: "11px",
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {job.projectRetainer || (isRetainer ? "Retainer" : "Project")}
                        </span>
                      </td>

                      {/* Start Date */}
                      <td style={{ padding: "10px 12px", color: "#475569", whiteSpace: "nowrap" }}>
                        {formatDateDisplay(job.startDate)}
                      </td>

                      {/* End Date */}
                      <td style={{ padding: "10px 12px", color: "#475569", whiteSpace: "nowrap" }}>
                        {formatDateDisplay(job.endDate)}
                      </td>

                      {/* Likelihood */}
                      <td style={{ padding: "10px 12px", color: "#0f172a", fontWeight: 500 }}>
                        {likelihoodDisp}
                      </td>

                      {/* Revenue */}
                      <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#0f172a" }}>
                        {job.revenue || formatMoney(job.revNum)}
                      </td>

                      {/* Direct Costs */}
                      <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#0f172a" }}>
                        {job.directCosts || formatMoney(job.dcNum)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const gridInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "3px 4px",
  borderRadius: "4px",
  border: "1px solid #cbd5e1",
  fontSize: "11px",
  textAlign: "right",
  background: "#f8fafc",
  color: "#0047AB",
};
