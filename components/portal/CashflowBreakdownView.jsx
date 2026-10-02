import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";
import { CashDeepDiveEngine, DeepDiveEngine, formatMoney, parseMoney } from "../../services/deepDiveHelper";

export default function CashflowBreakdownView({
  clientName,
  data,
  keyData,
  isLoading,
  error,
  onRefresh,
}) {
  const [activeCategory, setActiveCategory] = useState("cashConfInc");

  const rollingMonths = useMemo(() => data?.rollingMonths || [], [data?.rollingMonths]);

  const isIncomeMode = useMemo(() => {
    if (keyData?.outgoingsMeta?.mode) {
      return keyData.outgoingsMeta.mode.toLowerCase().includes("income");
    }
    const allLabels = [
      ...(data?.excludingPipeline || []).map((r) => String(r.label || "").toLowerCase()),
      ...(data?.includingPipeline || []).map((r) => String(r.label || "").toLowerCase()),
    ];
    return allLabels.some((l) => l.includes("confirmed income") || l.includes("total income"));
  }, [keyData, data]);

  const cashCategories = useMemo(() => {
    return [
      { id: "cashConfInc", name: "Confirmed cash incoming" },
      { id: "cashPipeInc", name: "Pipeline cash incoming" },
      { id: "cashInvoicesSent", name: "Invoices sent" },
      { id: "cashSalaries", name: "Salary payments" },
      { id: "cashContractors", name: "Contractor payments" },
      ...(!isIncomeMode ? [{ id: "cashDirCosts", name: "Direct cost payments" }] : []),
      { id: "cashOutgoings", name: "Outgoings payments" },
      { id: "cashTaxes", name: "Tax payments" },
      { id: "cashOther", name: "Other cash movements" },
    ];
  }, [isIncomeMode]);

  useEffect(() => {
    if (isIncomeMode && activeCategory === "cashDirCosts") {
      setActiveCategory("cashConfInc");
    }
  }, [isIncomeMode, activeCategory]);

  // Determine initial month: closest to current calendar date
  const defaultMonthIdx = useMemo(() => {
    if (rollingMonths.length === 0) return 0;
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let closestIdx = 0;
    let closestDiff = Infinity;
    rollingMonths.forEach((mStr, idx) => {
      const d = DeepDiveEngine.parseHeaderDate(mStr);
      if (d) {
        const diff = Math.abs(d.getTime() - currMonthStart);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestIdx = idx;
        }
      }
    });
    return closestIdx;
  }, [rollingMonths]);

  const [selectedMonthIdx, setSelectedMonthIdx] = useState(0);
  const [hasUserSelectedMonth, setHasUserSelectedMonth] = useState(false);

  useEffect(() => {
    if (!hasUserSelectedMonth && rollingMonths.length > 0) {
      setSelectedMonthIdx(defaultMonthIdx);
    }
  }, [defaultMonthIdx, hasUserSelectedMonth, rollingMonths.length]);

  const targetDate = useMemo(() => {
    if (rollingMonths.length === 0) return new Date();
    const str = rollingMonths[selectedMonthIdx] || rollingMonths[0];
    return DeepDiveEngine.parseHeaderDate(str) || new Date();
  }, [rollingMonths, selectedMonthIdx]);

  const periodLabel = useMemo(() => {
    return rollingMonths[selectedMonthIdx] || `Month ${selectedMonthIdx + 1}`;
  }, [rollingMonths, selectedMonthIdx]);

  const allJobs = useMemo(() => {
    return keyData?.jobs?.all || [
      ...(keyData?.jobs?.confirmed || []),
      ...(keyData?.jobs?.pipeline || []),
    ];
  }, [keyData]);

  // Extract sheet cell total from data.includingPipeline (to match original Google Sheets Cash tab exactly)
  const sheetTargetTotal = useMemo(() => {
    if (!data?.includingPipeline || !rollingMonths[selectedMonthIdx]) return null;
    const targetMonthStr = rollingMonths[selectedMonthIdx];

    const findRowTotal = (patterns) => {
      const foundRow = data.includingPipeline.find((r) => {
        const l = (r.label || "").toLowerCase();
        return patterns.some((p) => l.includes(p.toLowerCase()));
      });
      if (!foundRow) return 0;
      const valStr = foundRow.rollingValues?.[selectedMonthIdx];
      return parseMoney(valStr);
    };

    if (activeCategory === "cashConfInc") return findRowTotal(["confirmed cash incoming", "confirmed receipts"]);
    if (activeCategory === "cashPipeInc") return findRowTotal(["pipeline cash incoming", "pipeline receipts"]);
    if (activeCategory === "cashDirCosts") return findRowTotal(["direct cost payments", "direct costs"]);
    if (activeCategory === "cashSalaries") return findRowTotal(["salary payments", "salaries"]);
    if (activeCategory === "cashContractors") return findRowTotal(["contractor payments", "contractors"]);
    if (activeCategory === "cashOutgoings") return findRowTotal(["outgoings payments", "other expenses"]);
    if (activeCategory === "cashTaxes") return findRowTotal(["tax payments", "corporation tax", "vat payment"]);
    if (activeCategory === "cashOther") return findRowTotal(["other cash movements"]);
    return null;
  }, [data, activeCategory, selectedMonthIdx, rollingMonths]);

  // Invoices Sent Data (Confirmed & Pipeline lists)
  const invoicesSentData = useMemo(() => {
    if (activeCategory !== "cashInvoicesSent") return null;
    return CashDeepDiveEngine.getInvoicesSentCash(allJobs, targetDate);
  }, [activeCategory, allJobs, targetDate]);

  // Standard Cash List Data
  const listData = useMemo(() => {
    if (activeCategory === "cashInvoicesSent") return [];

    if (activeCategory === "cashConfInc" || activeCategory === "cashPipeInc" || activeCategory === "cashDirCosts") {
      return CashDeepDiveEngine.getJobCash(allJobs, targetDate, activeCategory);
    }

    if (activeCategory === "cashSalaries") {
      const staff = keyData?.salaries?.staff || [];
      return staff.map((s) => ({
        client: s.name,
        name: s.role,
        desc: `${s.isDelivery ? "Delivery" : "Overhead"} Payroll`,
        amount: -Math.abs(Math.round((s.actualAnnualCost || 0) / 12)),
        status: "Payroll",
        type: "Salary",
      })).filter((i) => Math.abs(i.amount) > 0);
    }

    if (activeCategory === "cashContractors") {
      const contractors = keyData?.outgoings?.contractors || [];
      return contractors.map((c) => {
        const allocs = c.allocations?.[1] || c.monthlyAllocations || [];
        const rawAmt = parseFloat(String(allocs[selectedMonthIdx] || "0").replace(/[£,]/g, "")) || 0;
        const gross = rawAmt * (c.vat === "Yes" ? 1.2 : 1.0);
        return {
          client: c.name,
          name: "Contractor Outflow",
          desc: `Timing: ${c.paymentTiming || "Curr"} • Delivery: ${c.deliveryPct}`,
          amount: -Math.abs(Math.round(gross)),
          status: "Contractor",
          type: "Contractor",
        };
      }).filter((i) => Math.abs(i.amount) > 0);
    }

    if (activeCategory === "cashOutgoings") {
      const expenses = keyData?.outgoings?.expenses || [];
      return expenses.map((e) => {
        const allocs = e.allocations?.[1] || e.monthlyAllocations || [];
        const rawAmt = parseFloat(String(allocs[selectedMonthIdx] || "0").replace(/[£,]/g, "")) || 0;
        const gross = rawAmt * (e.vat === "Yes" ? 1.2 : 1.0);
        return {
          client: e.name,
          name: "Outgoings Outflow",
          desc: `Timing: ${e.paymentTiming || "Curr"} • VAT: ${e.vat || "Yes"}`,
          amount: -Math.abs(Math.round(gross)),
          status: "Expense",
          type: "Expense",
        };
      }).filter((i) => Math.abs(i.amount) > 0);
    }

    if (activeCategory === "cashTaxes") {
      return [
        { client: "HMRC", name: "Corporation Tax", desc: "Estimated quarterly liability", amount: 0, status: "Tax" },
        { client: "HMRC", name: "VAT Payment", desc: "Quarterly return payment", amount: 0, status: "Tax" },
      ].filter((i) => i.amount !== 0);
    }

    if (activeCategory === "cashOther") {
      return [];
    }

    return [];
  }, [activeCategory, allJobs, targetDate, keyData, selectedMonthIdx]);

  // Sum of computed items
  const computedSum = useMemo(() => {
    if (activeCategory === "cashInvoicesSent" && invoicesSentData) {
      const confSum = (invoicesSentData.confirmed || []).reduce((acc, i) => acc + i.totalAmount, 0);
      const pipeSum = (invoicesSentData.pipeline || []).reduce((acc, i) => acc + i.totalAmount, 0);
      return confSum + pipeSum;
    }
    return listData.reduce((acc, i) => acc + (i.amount || 0), 0);
  }, [activeCategory, invoicesSentData, listData]);

  // Final Total to display: Use sheet target if available, otherwise computed sum
  const finalDisplayTotal = sheetTargetTotal !== null && !isNaN(sheetTargetTotal) ? sheetTargetTotal : computedSum;
  const manualAdjustment = finalDisplayTotal - computedSum;

  const isTableLayout = ["cashConfInc", "cashPipeInc", "cashDirCosts"].includes(activeCategory);

  // CSV Downloader
  const handleDownloadCSV = () => {
    let rows = [];
    const activeCatObj = cashCategories.find((c) => c.id === activeCategory);
    rows.push([`Cash breakdown: ${activeCatObj?.name || activeCategory} - ${periodLabel}`]);
    rows.push([]);

    if (activeCategory === "cashInvoicesSent") {
      rows.push(["Confirmed Invoices"]);
      rows.push(["Date", "Client", "Job", "Type", "Ref", "Ex VAT", "VAT", "Total", "Status"]);
      (invoicesSentData?.confirmed || []).forEach((inv) => {
        rows.push([
          DeepDiveEngine.formatShortDate(inv.sendDate),
          inv.client,
          inv.jobName,
          inv.type,
          inv.ref,
          inv.amountExVat,
          inv.vatAmount,
          inv.totalAmount,
          inv.status,
        ]);
      });
      rows.push([]);
      rows.push(["Pipeline Invoices"]);
      rows.push(["Date", "Client", "Job", "Type", "Ref", "Ex VAT", "VAT", "Total", "Status"]);
      (invoicesSentData?.pipeline || []).forEach((inv) => {
        rows.push([
          DeepDiveEngine.formatShortDate(inv.sendDate),
          inv.client,
          inv.jobName,
          inv.type,
          inv.ref,
          inv.amountExVat,
          inv.vatAmount,
          inv.totalAmount,
          inv.status,
        ]);
      });
    } else if (isTableLayout) {
      rows.push(["Date", "Client", "Job Name / Description", "Type", "Invoice Ref", "Amount", "Status"]);
      listData.forEach((item) => {
        rows.push([
          DeepDiveEngine.formatShortDate(item.payDate),
          item.client,
          item.name,
          item.type,
          item.desc,
          item.amount,
          item.status,
        ]);
      });
      if (Math.abs(manualAdjustment) > 2) {
        rows.push(["", "Manual adjustment", "", "", "", manualAdjustment, ""]);
      }
      rows.push(["", "", "", "", "Total", finalDisplayTotal, ""]);
    } else {
      rows.push(["Name", "Description", "Amount"]);
      listData.forEach((item) => {
        rows.push([item.client || item.name, item.desc, item.amount]);
      });
      if (Math.abs(manualAdjustment) > 2) {
        rows.push(["Manual adjustment", "", manualAdjustment]);
      }
      rows.push(["Total", "", finalDisplayTotal]);
    }

    const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.map((val) => `"${String(val || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `cash_breakdown_${activeCategory}_${periodLabel.replace(/\s+/g, "_")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

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
          Loading {clientName} cash breakdowns...
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
          Unable to Load Cash Breakdowns
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

  const dropdownStyle = {
    border: "1.5px solid #0047AB",
    borderRadius: "8px",
    padding: "6px 14px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#0047AB",
    background: "#ffffff",
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
          Cash breakdowns
        </h1>

        {/* Category Dropdown */}
        <select
          value={activeCategory}
          onChange={(e) => setActiveCategory(e.target.value)}
          style={dropdownStyle}
        >
          {cashCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {/* Month Dropdown */}
        <select
          value={selectedMonthIdx}
          onChange={(e) => setSelectedMonthIdx(parseInt(e.target.value, 10))}
          style={dropdownStyle}
        >
          {rollingMonths.map((m, idx) => (
            <option key={idx} value={idx}>
              {m}
            </option>
          ))}
        </select>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px" }}>
          {/* CSV Download Button */}
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

          {/* Refresh Button */}
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
        </div>
      </div>

      {/* Main Breakdown Content Container */}
      <div style={{ width: "100%", maxWidth: (activeCategory === "cashInvoicesSent" || isTableLayout) ? "100%" : "800px" }}>
        
        {/* 1. Invoices Sent View (Matching original WebApp table layout) */}
        {activeCategory === "cashInvoicesSent" ? (
          <div>
            {/* Confirmed Sub-table */}
            {invoicesSentData?.confirmed?.length > 0 && (
              <div style={{ marginTop: "1rem", marginBottom: "2rem" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                    <thead>
                      <tr>
                        <td colSpan={7} style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "left", padding: "10px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}>
                          Confirmed
                        </td>
                        <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb" }}>
                          {formatMoney(invoicesSentData.confirmed.reduce((sum, inv) => sum + inv.totalAmount, 0))}
                        </td>
                        <td style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                      </tr>
                    </thead>
                    <tbody>
                      {invoicesSentData.confirmed.map((inv, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ padding: "12px 10px 12px 0", color: "#6b7280", whiteSpace: "nowrap" }}>
                            {DeepDiveEngine.formatShortDate(inv.sendDate)}
                          </td>
                          <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827" }}>{inv.client}</td>
                          <td style={{ padding: "12px 10px", color: "#475569" }}>{inv.jobName}</td>
                          <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.type}</td>
                          <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.ref}</td>
                          <td style={{ padding: "12px 10px", textAlign: "right", color: "#111827" }}>
                            {formatMoney(inv.amountExVat)} <span style={{ fontSize: "0.85em", color: "#94a3b8", marginLeft: "4px" }}>ex</span>
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "right", color: "#475569" }}>
                            {formatMoney(inv.vatAmount)} <span style={{ fontSize: "0.85em", color: "#94a3b8", marginLeft: "4px" }}>VAT</span>
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                            {formatMoney(inv.totalAmount)}
                          </td>
                          <td style={{ padding: "12px 0 12px 10px", color: "#6b7280", textAlign: "right" }}>{inv.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Pipeline Sub-table */}
            {invoicesSentData?.pipeline?.length > 0 && (
              <div style={{ marginTop: "1rem", marginBottom: "2rem" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                    <thead>
                      <tr>
                        <td colSpan={7} style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "left", padding: "10px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}>
                          Pipeline
                        </td>
                        <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb" }}>
                          {formatMoney(invoicesSentData.pipeline.reduce((sum, inv) => sum + inv.totalAmount, 0))}
                        </td>
                        <td style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                      </tr>
                    </thead>
                    <tbody>
                      {invoicesSentData.pipeline.map((inv, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ padding: "12px 10px 12px 0", color: "#6b7280", whiteSpace: "nowrap" }}>
                            {DeepDiveEngine.formatShortDate(inv.sendDate)}
                          </td>
                          <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827" }}>{inv.client}</td>
                          <td style={{ padding: "12px 10px", color: "#475569" }}>{inv.jobName}</td>
                          <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.type}</td>
                          <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.ref}</td>
                          <td style={{ padding: "12px 10px", textAlign: "right", color: "#111827" }}>
                            {formatMoney(inv.amountExVat)} <span style={{ fontSize: "0.85em", color: "#94a3b8", marginLeft: "4px" }}>ex</span>
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "right", color: "#475569" }}>
                            {formatMoney(inv.vatAmount)} <span style={{ fontSize: "0.85em", color: "#94a3b8", marginLeft: "4px" }}>VAT</span>
                          </td>
                          <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                            {formatMoney(inv.totalAmount)}
                          </td>
                          <td style={{ padding: "12px 0 12px 10px", color: "#6b7280", textAlign: "right" }}>{inv.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {invoicesSentData?.confirmed?.length === 0 && invoicesSentData?.pipeline?.length === 0 && (
              <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                No invoices sent in this period.
              </div>
            )}
          </div>
        ) : isTableLayout ? (
          /* 2. Confirmed Cash / Pipeline Cash / Direct Cost Payments: 7-Column Table exactly matching original buildJobCashHtml */
          <div style={{ overflowX: "auto", paddingBottom: "10px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95em", whiteSpace: "nowrap" }}>
              <tbody>
                {/* Header Total Row */}
                <tr>
                  <td colSpan={5} style={{ padding: "10px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}></td>
                  <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.2rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb" }}>
                    {formatMoney(finalDisplayTotal)}
                  </td>
                  <td style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                </tr>

                {listData.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: "14px 10px 14px 0", color: "#94a3b8", textAlign: "center" }}>
                      No transactions in this period
                    </td>
                  </tr>
                ) : (
                  listData.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "12px 10px 12px 0", color: "#6b7280" }}>
                        {DeepDiveEngine.formatShortDate(item.payDate)}
                      </td>
                      <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827" }}>
                        {item.client || ""}
                      </td>
                      <td style={{ padding: "12px 10px", color: "#475569" }}>
                        {item.name || ""}
                      </td>
                      <td style={{ padding: "12px 10px", color: "#6b7280" }}>
                        {item.type || "—"}
                      </td>
                      <td style={{ padding: "12px 10px", color: "#6b7280" }}>
                        {item.desc || ""}
                      </td>
                      <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: item.amount < 0 ? "#b91c1c" : "#0047AB" }}>
                        {formatMoney(item.amount)}
                      </td>
                      <td style={{ padding: "12px 0 12px 10px", color: "#6b7280", textAlign: "right" }}>
                        {item.status || ""}
                      </td>
                    </tr>
                  ))
                )}

                {/* Manual Adjustment Row if sheet total differs from transaction sum */}
                {Math.abs(manualAdjustment) > 2 && (
                  <tr style={{ borderTop: "1px dashed #e2e8f0", background: "#fafafa" }}>
                    <td colSpan={5} style={{ padding: "12px 10px 12px 0", color: "#64748b" }}>
                      <em>Manual adjustment</em>
                    </td>
                    <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                      {formatMoney(manualAdjustment)}
                    </td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          /* 3. Simple List (Salaries, Contractors, Outgoings, Taxes) matching original buildSimpleListHtml */
          <div>
            {/* Top Total */}
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 0", borderBottom: "1px solid #e5e7eb" }}>
              <span style={{ fontSize: "1.2rem", fontWeight: 700, color: "#0047AB" }}>
                {formatMoney(finalDisplayTotal)}
              </span>
            </div>

            {listData.length === 0 ? (
              <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                No transactions in this period.
              </div>
            ) : (
              listData.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px 0",
                    borderBottom: "1px solid #f1f5f9",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "15px", fontWeight: 600, color: "#111827" }}>
                      {item.client || item.name}
                    </div>
                    {item.desc && (
                      <div style={{ fontSize: "13px", color: "#64748b", marginTop: "2px" }}>
                        {item.desc}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: item.amount < 0 ? "#b91c1c" : "#0047AB", whiteSpace: "nowrap" }}>
                    {formatMoney(item.amount)}
                  </div>
                </div>
              ))
            )}

            {/* Manual Adjustment Row */}
            {Math.abs(manualAdjustment) > 2 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 0",
                  borderTop: "1px dashed #e2e8f0",
                  background: "#fafafa",
                }}
              >
                <div style={{ fontSize: "14px", color: "#64748b", fontStyle: "italic" }}>
                  Manual adjustment
                </div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(manualAdjustment)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
