import React, { useState, useMemo, useEffect } from "react";
import Spinner from "../Spinner";
import { DeepDiveEngine, PulseMath } from "../../services/deepDiveHelper";

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

  const formatMoney = (val) => {
    const rounded = Math.round(val || 0);
    const sign = rounded < 0 ? "-" : "";
    return `${sign}£${Math.abs(rounded).toLocaleString()}`;
  };

  const formatDateDisplay = (dateVal) => {
    if (!dateVal) return "";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const day = d.getDate();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[d.getMonth()];
    const yr = String(d.getFullYear()).slice(-2);
    return `${day}-${month}-${yr}`;
  };

  // Build items based on active period and breakdownType using DeepDiveEngine
  const items = useMemo(() => {
    if (!activePeriod || !keyData) return [];

    const isFY = activePeriod.isFY;
    const targetDate = activePeriod.date;

    // 1. Confirmed Revenue / Pipeline Revenue / Direct Costs
    if (breakdownType === "confRev" || breakdownType === "pipeRev" || breakdownType === "dirCosts") {
      const allJobs = keyData.jobs?.all || [
        ...(keyData.jobs?.confirmed || []),
        ...(keyData.jobs?.pipeline || []),
      ];

      if (isFY) {
        // Find first month date of active FY
        const fyYear = years[activePeriod.yearIdx];
        const firstMonthStr = fyYear?.headerMonths?.[0];
        const startDate = DeepDiveEngine.parseHeaderDate(firstMonthStr) || new Date(2025, 4, 1);
        const aggregated = DeepDiveEngine.aggregatePeriods(startDate, 12, (d) =>
          DeepDiveEngine.getJobsForMonth(allJobs, d, breakdownType, isIncomeMode)
        );
        return aggregated.map((i) => ({
          client: i.client,
          jobName: i.name,
          amount: i.amount,
          detail: i.detail,
        }));
      }

      if (targetDate) {
        const monthItems = DeepDiveEngine.getJobsForMonth(allJobs, targetDate, breakdownType, isIncomeMode);
        return monthItems.map((i) => ({
          client: i.client,
          jobName: i.name,
          amount: i.amount,
          detail: i.detail,
        }));
      }

      return [];
    }

    // 2. Staff Costs (Delivery or Non-Delivery) - Ported from WebApp.html lines 16413-16527
    if (breakdownType === "staffDel" || breakdownType === "staffNonDel") {
      const isDel = breakdownType === "staffDel";
      const results = [];
      const yIdx = activePeriod.yearIdx;
      const mIdx = activePeriod.monthIdx >= 0 ? activePeriod.monthIdx : 0;

      // Extract target total from sheet table row
      const activeYearData = years[yIdx];
      const targetLabel = isDel ? "staff costs - delivery" : "staff costs - non-delivery";
      const targetRow = (activeYearData?.rows || []).find((r) =>
        String(r.label || "").toLowerCase().includes(targetLabel)
      );
      let cellTotal = 0;
      if (targetRow) {
        cellTotal = isFY
          ? parseMoney(targetRow.totalVal)
          : parseMoney(targetRow.monthlyValues?.[activePeriod.monthIdx]);
      }

      // If user is Senior (Restricted), match original WebApp: restrictedTotal = cellTotal - conTotal - addTotal
      if (isSenior) {
        // Contractors
        const contractorsList = keyData.outgoings?.contractors || [];
        const conResults = [];
        contractorsList.forEach((c) => {
          let delPct = 1.0;
          if (c.deliveryPct !== undefined && String(c.deliveryPct).trim() !== "") {
            delPct = parseMoney(c.deliveryPct);
            if (String(c.deliveryPct).includes("%")) delPct = delPct / 100;
            else if (delPct > 1) delPct = delPct / 100;
          }
          const applicablePct = isDel ? delPct : (1 - delPct);
          if (applicablePct <= 0.001) return;

          const allocs = c.allocations?.[yIdx + 1] || c.monthlyAllocations || [];
          const rawAmt = isFY
            ? (c.totals?.[yIdx + 1] || 0)
            : parseMoney(allocs[mIdx] || "0");
          const amt = Math.round(rawAmt * applicablePct);
          if (amt > 0) {
            conResults.push({
              client: c.name,
              jobName: "Contractors",
              amount: amt,
              detail: `Contractor • ${Math.round(applicablePct * 100)}% delivery • Timing: ${c.paymentTiming || "Curr"}`,
            });
          }
        });
        const conTotal = conResults.reduce((s, i) => s + i.amount, 0);

        let cosVal = 0;
        if (isDel && keyData.outgoingsMeta?.makingUpCosBase?.[yIdx]) {
          cosVal = isFY
            ? keyData.outgoingsMeta.makingUpCosBase[yIdx].reduce((a, b) => a + b, 0)
            : (keyData.outgoingsMeta.makingUpCosBase[yIdx][mIdx] || 0);
        }
        let psVal = 0;
        if (keyData.outgoingsMeta) {
          const psArr = isDel ? keyData.outgoingsMeta.profitShareBaseDel?.[yIdx] : keyData.outgoingsMeta.profitShareBaseNonDel?.[yIdx];
          psVal = psArr ? (isFY ? psArr.reduce((a, b) => a + b, 0) : (psArr[mIdx] || 0)) : 0;
        }

        const restrictedTotal = Math.round(cellTotal - conTotal - cosVal - psVal);
        if (Math.abs(restrictedTotal) >= 0.01) {
          results.push({
            client: "Salaries",
            jobName: "Salaries",
            amount: restrictedTotal,
            detail: "Salaries & remuneration",
          });
        }
        results.push(...conResults);
        if (cosVal > 0) {
          results.push({
            client: "Making up CoS",
            jobName: "Additional staff costs",
            amount: Math.round(cosVal),
            detail: "Cost of sale adjustment (delivery only)",
          });
        }
        if (psVal > 0) {
          results.push({
            client: "Profit share",
            jobName: "Additional staff costs",
            amount: Math.round(psVal),
            detail: `Profit share (${isDel ? "delivery" : "non-delivery"})`,
          });
        }
        return results;
      }

      // A. Salaries
      const staffList = keyData.salaries?.staff || [];
      let calcSalTotal = 0;
      staffList.forEach((s) => {
        let delPct = 0;
        if (s.deliveryPct !== undefined && String(s.deliveryPct).trim() !== "") {
          delPct = parseMoney(s.deliveryPct);
          if (String(s.deliveryPct).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;
        } else if (s.isDelivery) {
          delPct = 1;
        }
        const applicablePct = isDel ? delPct : (1 - delPct);
        if (applicablePct <= 0.001) return;

        const baseCost = isFY ? (s.actualAnnualCost || 0) : ((s.actualAnnualCost || 0) / 12);
        const amt = Math.round(baseCost * applicablePct);
        if (amt > 0) {
          calcSalTotal += amt;
          const mathText = Math.abs(applicablePct - 1) > 0.01 ? ` (${Math.round(applicablePct * 100)}% of ${formatMoney(baseCost)})` : "";
          results.push({
            client: s.name,
            jobName: "Salaries",
            amount: amt,
            detail: `${s.role || "Staff"}${mathText} | FTE: ${s.fte || "1.00"}`,
          });
        }
      });

      // Employment allowance
      let actualSalaries = 0;
      if (keyData.outgoingsMeta) {
        if (isDel && keyData.outgoingsMeta.salariesDel?.[yIdx]) {
          actualSalaries = isFY
            ? keyData.outgoingsMeta.salariesDel[yIdx].reduce((a, b) => a + b, 0)
            : (keyData.outgoingsMeta.salariesDel[yIdx][mIdx] || 0);
        } else if (!isDel && keyData.outgoingsMeta.salariesNonDel?.[yIdx]) {
          actualSalaries = isFY
            ? keyData.outgoingsMeta.salariesNonDel[yIdx].reduce((a, b) => a + b, 0)
            : (keyData.outgoingsMeta.salariesNonDel[yIdx][mIdx] || 0);
        }
      }
      const allowanceDiff = actualSalaries - calcSalTotal;
      if (Math.abs(allowanceDiff) > 2) {
        results.push({
          client: "Employment allowance",
          jobName: "Salaries",
          amount: Math.round(allowanceDiff),
          detail: "HMRC employment allowance adjustment",
        });
        calcSalTotal += allowanceDiff;
      }

      // B. Dividends as salary
      const dividendsList = keyData.outgoings?.dividends || [];
      dividendsList.forEach((d) => {
        let delPct = 0.5; // default 50%
        if (d.deliveryPct !== undefined && String(d.deliveryPct).trim() !== "") {
          delPct = parseMoney(d.deliveryPct);
          if (String(d.deliveryPct).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;
        }
        const applicablePct = isDel ? delPct : (1 - delPct);
        if (applicablePct <= 0.001) return;

        const allocs = d.allocations?.[yIdx + 1] || d.monthlyAllocations || [];
        const rawAmt = isFY
          ? (d.totals?.[yIdx + 1] || 0)
          : parseMoney(allocs[mIdx] || "0");
        const amt = Math.round(rawAmt * applicablePct);
        if (amt > 0) {
          results.push({
            client: d.name || "Dividends as salary",
            jobName: "Dividends as salary",
            amount: amt,
            detail: `Dividend in lieu • ${Math.round(applicablePct * 100)}% allocation`,
          });
        }
      });

      // C. Contractors
      const contractorsList = keyData.outgoings?.contractors || [];
      contractorsList.forEach((c) => {
        let delPct = 1.0; // default 100%
        if (c.deliveryPct !== undefined && String(c.deliveryPct).trim() !== "") {
          delPct = parseMoney(c.deliveryPct);
          if (String(c.deliveryPct).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;
        }
        const applicablePct = isDel ? delPct : (1 - delPct);
        if (applicablePct <= 0.001) return;

        const allocs = c.allocations?.[yIdx + 1] || c.monthlyAllocations || [];
        const rawAmt = isFY
          ? (c.totals?.[yIdx + 1] || 0)
          : parseMoney(allocs[mIdx] || "0");
        const amt = Math.round(rawAmt * applicablePct);
        if (amt > 0) {
          results.push({
            client: c.name,
            jobName: "Contractors",
            amount: amt,
            detail: `Contractor • ${Math.round(applicablePct * 100)}% delivery • Timing: ${c.paymentTiming || "Curr"}`,
          });
        }
      });

      // D. Additional staff costs: Making up CoS & Profit share
      if (isDel && keyData.outgoingsMeta?.makingUpCosBase?.[yIdx]) {
        const cosVal = isFY
          ? keyData.outgoingsMeta.makingUpCosBase[yIdx].reduce((a, b) => a + b, 0)
          : (keyData.outgoingsMeta.makingUpCosBase[yIdx][mIdx] || 0);
        if (cosVal > 0) {
          results.push({
            client: "Making up CoS",
            jobName: "Additional staff costs",
            amount: Math.round(cosVal),
            detail: "Cost of sale adjustment (delivery only)",
          });
        }
      }

      if (keyData.outgoingsMeta) {
        const psArr = isDel ? keyData.outgoingsMeta.profitShareBaseDel?.[yIdx] : keyData.outgoingsMeta.profitShareBaseNonDel?.[yIdx];
        const psVal = psArr ? (isFY ? psArr.reduce((a, b) => a + b, 0) : (psArr[mIdx] || 0)) : 0;
        if (psVal > 0) {
          results.push({
            client: "Profit share",
            jobName: "Additional staff costs",
            amount: Math.round(psVal),
            detail: `Profit share (${isDel ? "delivery" : "non-delivery"})`,
          });
        }
      }

      // E. Rounding adjustment so grand total matches cellTotal exactly
      if (cellTotal > 0) {
        const sumItems = results.reduce((s, i) => s + i.amount, 0);
        const drift = Math.round(cellTotal - sumItems);
        if (Math.abs(drift) >= 1) {
          results.push({
            client: "Rounding adjustment",
            jobName: "Adjustment",
            amount: drift,
            detail: "Ledger alignment adjustment",
          });
        }
      }

      return results;
    }

    // 3. Expenses (Delivery or Non-Delivery)
    if (breakdownType === "expDel" || breakdownType === "expNonDel") {
      const isDel = breakdownType === "expDel";
      const expenses = (keyData.outgoings?.expenses || []).filter((e) => (isDel ? e.isDelivery : !e.isDelivery));
      const results = [];

      expenses.forEach((e) => {
        const allocs = e.allocations?.[activePeriod.yearIdx] || e.monthlyAllocations || [];
        const amt = isFY
          ? e.totals?.[activePeriod.yearIdx] || 0
          : parseFloat(String(allocs[activePeriod.monthIdx] || "0").replace(/[£,]/g, "")) || 0;

        if (amt > 0) {
          results.push({
            client: e.name,
            jobName: "",
            amount: Math.round(amt),
            detail: `Timing: ${e.paymentTiming || "Curr"} | VAT: ${e.vat || "Yes"}`,
          });
        }
      });

      return results;
    }

    return [];
  }, [activePeriod, breakdownType, keyData, isIncomeMode, years, isSenior]);

  const totalAmount = useMemo(() => {
    return items.reduce((sum, item) => sum + (item.amount || 0), 0);
  }, [items]);

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
    rows.push(["Client", "Name", "Details", "Amount"]);
    items.forEach((item) => {
      rows.push([item.client || "", item.name || "", item.desc || "", item.amount || 0]);
    });
    rows.push([]);
    rows.push(["", "", "Total", totalAmount]);

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
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.85rem", fontWeight: 700, color: "#0047AB" }}>
          Performance breakdowns
        </h1>

        {/* Metric Dropdown */}
        <select
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
          }}
        >
          <span style={{ fontSize: "1.25rem", fontWeight: 700, color: "#0047AB" }}>
            {formatMoney(totalAmount)}
          </span>
        </div>

        {/* Item Rows */}
        {items.length === 0 ? (
          <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
            No items in this period.
          </div>
        ) : (
          items.map((item, idx) => (
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
                  <strong style={{ fontWeight: 700 }}>{item.client}</strong>
                  {item.jobName && <span style={{ color: "#334155" }}> – {item.jobName}</span>}
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
          ))
        )}
      </div>
    </div>
  );
}
