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
  const [pipelineSort, setPipelineSort] = useState("likelihood-desc");

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
    if (l === "total costs of sale" || l === "total cost of sales") {
      return { bg: "#ffffff", color: "#0047AB", bold: true, isMajor: false };
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

  const getMarginBadgeStyle = (label, valStr) => {
    if (!valStr || !String(valStr).includes("%")) return null;
    const num = parseFloat(String(valStr).replace(/%/g, "")) / 100;
    if (isNaN(num)) return null;

    const t = performanceData?.thresholds || [0.495, 0.445, 0, 0, 0, 0.309, 0.2, 0, 0, 0, 0.145, 0.05, 0, 0, 0, 0.705, 0.66, 0.54];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : (String(v).includes("%") || n > 1 ? n / 100 : n);
    };

    const l = String(label || "").toLowerCase();
    if (l.includes("gross profit margin")) {
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (num < z43) return { bg: "#f4cccc", color: "#0047AB" };
      if (num <= z42) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#d9ead3", color: "#0047AB" };
    }
    if (l.includes("overheads as %") || l.includes("overheads %")) {
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.20);
      if (num > z47) return { bg: "#f4cccc", color: "#0047AB" };
      if (num >= z48) return { bg: "#d9ead3", color: "#0047AB" };
      return { bg: "#fce5cd", color: "#0047AB" };
    }
    if (l.includes("operating profit %")) {
      const z52 = parseT(10, 0.145);
      const z53 = parseT(11, 0.05);
      if (num < z53) return { bg: "#f4cccc", color: "#0047AB" };
      if (num <= z52) return { bg: "#fce5cd", color: "#0047AB" };
      return { bg: "#d9ead3", color: "#0047AB" };
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
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
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
            Reset scenario
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

      {/* 1. TOP SECTION: Full Financial Year Performance Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
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
                minWidth: "1180px",
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
                      width: "240px",
                      minWidth: "240px",
                      position: "sticky",
                      left: 0,
                      background: "#0047AB",
                      zIndex: 3,
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
                        width: "7.0%",
                        minWidth: "72px",
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
                      width: "8.5%",
                      minWidth: "88px",
                      background: "#0047AB",
                      borderLeft: "1px solid #cbd5e1",
                    }}
                  >
                    {activeYear?.totalColHeader || "FY Total"}
                  </th>
                </tr>

                {/* Row 2: Status row (Actual vs Forecast) with NO column header */}
                <tr style={{ background: "#ffffff", borderBottom: "1px solid #cbd5e1", fontSize: "10.5px" }}>
                  <td
                    style={{
                      padding: "3px 8px",
                      position: "sticky",
                      left: 0,
                      background: "#ffffff",
                      zIndex: 3,
                      width: "240px",
                      minWidth: "240px",
                      border: "none",
                    }}
                  >
                    {/* Empty cell, NO Status label */}
                  </td>
                  {activeYear?.statusValues?.map((st, idx) => {
                    const raw = String(st || "").trim();
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
                          width: "7.0%",
                          minWidth: "72px",
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
                      width: "8.5%",
                      minWidth: "88px",
                      border: "none",
                      borderLeft: "1px solid #cbd5e1",
                    }}
                  />
                </tr>
              </thead>

              <tbody>
                {mutatedRows.map((row, rIdx) => {
                  const label = row.label;
                  const totalVal = row.totalVal;

                  // Detect if this spacer is the gap between Operating Profit % and Staff costs ratio
                  let prevLbl = "";
                  for (let k = rIdx - 1; k >= 0; k--) {
                    if (mutatedRows[k]?.label && mutatedRows[k].label.toLowerCase() !== "hide") {
                      prevLbl = mutatedRows[k].label.toLowerCase();
                      break;
                    }
                  }
                  let nextLbl = "";
                  for (let k = rIdx + 1; k < mutatedRows.length; k++) {
                    if (mutatedRows[k]?.label && mutatedRows[k].label.toLowerCase() !== "hide") {
                      nextLbl = mutatedRows[k].label.toLowerCase();
                      break;
                    }
                  }
                  const isOpToStaffGap =
                    (prevLbl.includes("operating profit %") || prevLbl.includes("operating profit margin")) &&
                    (nextLbl.includes("staff costs to") || nextLbl.includes("staff ratio"));

                  if (!label || label.toLowerCase() === "hide") {
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
                            width: "240px",
                            minWidth: "240px",
                            border: "none",
                          }}
                        />
                        {headerMonths.map((_, mIdx) => {
                          const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
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
                  const isPercentageRow = label.includes("%") || label.toLowerCase().includes("ratio") || label.toLowerCase().includes("margin");
                  const totalBadge = isPercentageRow ? getMarginBadgeStyle(label, totalVal) : null;
                  const isMarginRow = Boolean(rowStyle.isMarginRow);

                  // Row height: narrower for KPI margin rows (21px) vs regular (25px) vs major (32px)
                  const rowHeight = rowStyle.isMajor ? "32px" : isMarginRow ? "21px" : "25px";
                  const fontSize = rowStyle.isMajor ? "13px" : isMarginRow ? "11px" : rowStyle.isHeader ? "11px" : "11.5px";

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
                      {/* Sticky Line Item */}
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
                          width: "240px",
                          minWidth: "240px",
                          maxWidth: "240px",
                          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
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
                        const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
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

                      {/* Total Column (Continuous unbroken Total column shading) */}
                      {(() => {
                        const ddType = !isPercentageRow && !rowStyle.isHeader ? getDeepDiveType(label) : null;
                        const isClickable = Boolean(ddType && totalVal && totalVal !== "£0" && totalVal !== "—" && totalVal !== "");
                        const displayTotal = totalVal === "—" ? "" : totalVal || "";
                        const totalColBg = "rgba(0, 71, 171, 0.04)";

                        if (rowStyle.isMajor) {
                          return (
                            <td
                              onClick={(e) =>
                                isClickable &&
                                handleCellClick(e, label, totalVal, -1, `${activeYear?.fyLabel || "FY"} Total`)
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
                                  background: totalBadge ? totalBadge.bg : "transparent",
                                  color: totalBadge ? totalBadge.color : "#0047AB",
                                  border: totalBadge ? `1.5px solid ${totalColBg}` : "none",
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
                              handleCellClick(e, label, totalVal, -1, `${activeYear?.fyLabel || "FY"} Total`)
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

                {/* Synchronized Financial Adjustments Section Divider Row */}
                <tr style={{ background: "#f8fafc", borderTop: "2px solid #cbd5e1", borderBottom: "1px solid #cbd5e1" }}>
                  <td
                    style={{
                      padding: "8px 12px",
                      background: "#f8fafc",
                      position: "sticky",
                      left: 0,
                      zIndex: 2,
                      width: "240px",
                      minWidth: "240px",
                      maxWidth: "240px",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0047AB",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Scenario adjustments
                  </td>
                  <td
                    colSpan={headerMonths.length}
                    style={{
                      padding: "8px 12px",
                      fontSize: "11px",
                      color: "#64748b",
                      background: "#f8fafc",
                    }}
                  >
                    Enter adjustments (+/-) to build your scenario
                  </td>
                  <td
                    style={{
                      padding: 0,
                      background: "rgba(0, 71, 171, 0.04)",
                      borderLeft: "1px solid #cbd5e1",
                    }}
                  />
                </tr>

                {/* Include NB to Find Checkboxes */}
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", fontWeight: 600, color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
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
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "4px 4px", textAlign: "center", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="checkbox"
                          checked={adjs.nbChecked[mIdx]}
                          onChange={() => handleToggleNBMonth(mIdx)}
                          style={{ cursor: "pointer", width: "14px", height: "14px", accentColor: "#0047AB" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontSize: "11px", color: "#64748b", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {adjs.nbChecked.filter(Boolean).length}/12 Months
                  </td>
                </tr>

                {/* Additional Revenue Inputs */}
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
                    Addl. revenue
                  </td>
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "3px 3px", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="text"
                          value={adjs.rev[mIdx] || ""}
                          onChange={(e) => handleAdjMonthChange("rev", mIdx, e.target.value)}
                          placeholder="0"
                          style={{ ...gridInputStyle, background: "#ffffff" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {formatMoney(adjs.rev.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>

                {/* Additional delivery staff costs */}
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
                    Addl. delivery staff costs
                  </td>
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "3px 3px", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="text"
                          value={adjs.delStaff[mIdx] || ""}
                          onChange={(e) => handleAdjMonthChange("delStaff", mIdx, e.target.value)}
                          placeholder="0"
                          style={{ ...gridInputStyle, background: "#ffffff" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {formatMoney(adjs.delStaff.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>

                {/* Additional delivery expenses */}
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
                    Addl. delivery expenses
                  </td>
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "3px 3px", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="text"
                          value={adjs.delExp[mIdx] || ""}
                          onChange={(e) => handleAdjMonthChange("delExp", mIdx, e.target.value)}
                          placeholder="0"
                          style={{ ...gridInputStyle, background: "#ffffff" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {formatMoney(adjs.delExp.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>

                {/* Additional non-delivery staff costs */}
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
                    Addl. non-delivery staff costs
                  </td>
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "3px 3px", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="text"
                          value={adjs.nonDelStaff[mIdx] || ""}
                          onChange={(e) => handleAdjMonthChange("nonDelStaff", mIdx, e.target.value)}
                          placeholder="0"
                          style={{ ...gridInputStyle, background: "#ffffff" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {formatMoney(adjs.nonDelStaff.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>

                {/* Additional non-delivery expenses */}
                <tr style={{ background: "#ffffff" }}>
                  <td style={{ padding: "6px 10px", color: "#0047AB", position: "sticky", left: 0, background: "#ffffff", zIndex: 2, whiteSpace: "nowrap", width: "240px", minWidth: "240px", maxWidth: "240px", boxShadow: "2px 0 3px rgba(0,0,0,0.02)" }}>
                    Addl. non-delivery expenses
                  </td>
                  {headerMonths.map((_, mIdx) => {
                    const st = String(activeYear?.statusValues?.[mIdx] || "").trim().toLowerCase();
                    const isAct = st === "actual";
                    return (
                      <td key={mIdx} style={{ padding: "3px 3px", background: isAct ? "#f4f7fa" : "#ffffff" }}>
                        <input
                          type="text"
                          value={adjs.nonDelExp[mIdx] || ""}
                          onChange={(e) => handleAdjMonthChange("nonDelExp", mIdx, e.target.value)}
                          placeholder="0"
                          style={{ ...gridInputStyle, background: "#ffffff" }}
                        />
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", background: "rgba(0, 71, 171, 0.04)", borderLeft: "1px solid #cbd5e1" }}>
                    {formatMoney(adjs.nonDelExp.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
                <option value="likelihood-desc">Likelihood (descending)</option>
                <option value="likelihood-asc">Likelihood (ascending)</option>
                <option value="startDate-desc">Job start date (descending)</option>
                <option value="startDate-asc">Job start date (ascending)</option>
                <option value="client-asc">Client name</option>
              </select>
            </div>
          </div>
        </div>

        <div style={{ overflowX: "auto", width: "100%" }}>
          <table
            className="scenario-pipeline-table"
            style={{
              width: "100%",
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

      <style jsx>{`
        @media (orientation: landscape) and (max-width: 1024px) {
          .fy-table-scroll-wrapper {
            margin: 0 !important;
            width: 100% !important;
          }
          .fy-nav-arrow-left {
            left: -32px !important;
            font-size: 2.4rem !important;
          }
          .fy-nav-arrow-right {
            right: -32px !important;
            font-size: 2.4rem !important;
          }
          .scenario-pipeline-table {
            font-size: 11px !important;
            min-width: 100% !important;
          }
          .scenario-pipeline-table th,
          .scenario-pipeline-table td {
            padding: 6px 4px !important;
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
          .fy-table-scroll-wrapper {
            margin: 0 24px !important;
            width: calc(100% - 48px) !important;
          }
          .scenario-pipeline-table {
            font-size: 11px !important;
            min-width: 100% !important;
          }
          .scenario-pipeline-table th,
          .scenario-pipeline-table td {
            padding: 6px 4px !important;
          }
        }
      `}</style>
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
