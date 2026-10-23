import React, { useState, useMemo, useEffect } from "react";
import Spinner from "../Spinner";
import { CashDeepDiveEngine, DeepDiveEngine, formatMoney as universalFormatMoney, parseMoney } from "../../services/deepDiveHelper";
import { downloadCsv } from "../../utils/helpers";

export default function CashflowBreakdownView({
  clientName,
  data,
  keyData,
  currencySymbol = "£",
  thousandsSeparator = ",",
  isLoading,
  error,
  onRefresh,
  isSenior = false,
}) {
  const [activeCategory, setActiveCategory] = useState("cashConfInc");

  const formatMoney = (val) => {
    return universalFormatMoney(val, 2, currencySymbol, thousandsSeparator);
  };

  // Support all financial months when available from Cash sheet (36 months across 3 financial years), falling back to rolling window
  const availableMonths = useMemo(() => {
    return data?.allMonths && data.allMonths.length > 0 ? data.allMonths : (data?.rollingMonths || []);
  }, [data?.allMonths, data?.rollingMonths]);

  const getRowValue = (row, idx) => {
    if (!row) return 0;
    const val = row.allValues ? row.allValues[idx] : row.rollingValues?.[idx];
    return parseMoney(val);
  };

  const getRowNote = (row, idx) => {
    if (!row) return "";
    const note = row.allNotes ? row.allNotes[idx] : row.rollingNotes?.[idx];
    return typeof note === "string" ? note.trim() : "";
  };

  const renderStatusBadge = (status, isPartPayment = false) => {
    if (!status || status === "—") return <span style={{ color: "#94a3b8" }}>—</span>;
    const s = String(status).trim();
    const lower = s.toLowerCase();

    let bg = "#f1f5f9";
    let text = "#475569";
    let border = "#cbd5e1";
    let label = s;

    if (lower === "paid") {
      bg = "#ecfdf5";
      text = "#047857";
      border = "#a7f3d0";
      label = isPartPayment ? "Paid (part)" : "Paid";
    } else if (lower.includes("balance")) {
      bg = "#f5f3ff";
      text = "#6d28d9";
      border = "#ddd6fe";
      label = "Part-paid (balance)";
    } else if (lower === "part-paid (received)" || (lower.includes("received") && lower.includes("part"))) {
      bg = "#eff6ff";
      text = "#1d4ed8";
      border = "#bfdbfe";
      label = "Part-paid (received)";
    } else if (lower === "part-paid (paid)" || (lower.includes("paid") && lower.includes("part"))) {
      bg = "#ecfdf5";
      text = "#047857";
      border = "#a7f3d0";
      label = "Part-paid (paid)";
    } else if (lower === "received") {
      bg = "#f0fdf4";
      text = "#15803d";
      border = "#bbf7d0";
      label = "Received";
    } else if (lower === "sent") {
      bg = "#f0f9ff";
      text = "#0369a1";
      border = "#bae6fd";
      label = "Sent";
    } else if (lower === "draft") {
      bg = "#f8fafc";
      text = "#64748b";
      border = "#cbd5e1";
      label = "Draft";
    }

    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          fontSize: "0.75rem",
          fontWeight: 600,
          borderRadius: "9999px",
          backgroundColor: bg,
          color: text,
          border: `1px solid ${border}`,
          whiteSpace: "nowrap",
          lineHeight: "1.25",
        }}
      >
        {label}
      </span>
    );
  };

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
      { id: "cashOutgoings", name: "Other expenses" },
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
    if (availableMonths.length === 0) return 0;
    const now = new Date();
    const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let closestIdx = 0;
    let closestDiff = Infinity;
    availableMonths.forEach((mStr, idx) => {
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
  }, [availableMonths]);

  const [selectedMonthIdx, setSelectedMonthIdx] = useState(0);
  const [hasUserSelectedMonth, setHasUserSelectedMonth] = useState(false);

  useEffect(() => {
    if (!hasUserSelectedMonth && availableMonths.length > 0) {
      setSelectedMonthIdx(defaultMonthIdx);
    }
  }, [defaultMonthIdx, hasUserSelectedMonth, availableMonths.length]);

  const [openAccordions, setOpenAccordions] = useState({});

  useEffect(() => {
    setOpenAccordions({});
  }, [selectedMonthIdx, activeCategory]);

  const toggleAccordion = (key) => {
    setOpenAccordions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const targetDate = useMemo(() => {
    if (availableMonths.length === 0) return new Date();
    const str = availableMonths[selectedMonthIdx] || availableMonths[0];
    return DeepDiveEngine.parseHeaderDate(str) || new Date();
  }, [availableMonths, selectedMonthIdx]);

  const periodLabel = useMemo(() => {
    return availableMonths[selectedMonthIdx] || `Month ${selectedMonthIdx + 1}`;
  }, [availableMonths, selectedMonthIdx]);

  const allJobs = useMemo(() => {
    return keyData?.jobs?.all || [
      ...(keyData?.jobs?.confirmed || []),
      ...(keyData?.jobs?.pipeline || []),
    ];
  }, [keyData]);

  const isNotesMode = useMemo(() => {
    return String(
      keyData?.outgoingsMeta?.contractorSource || keyData?.outgoings?.contractorSource || ""
    ).toLowerCase().includes("notes");
  }, [keyData]);

  // Extract sheet cell total from data.includingPipeline (to match original Google Sheets Cash tab exactly)
  const sheetTargetTotal = useMemo(() => {
    const rows = data?.includingPipeline || data?.excludingPipeline || [];
    if (rows.length === 0 || !availableMonths[selectedMonthIdx]) return null;

    const sumRows = (labelPatterns, rowIndices = []) => {
      const matching = rows.filter((r) => {
        if (rowIndices.includes(r.rowIndex)) return true;
        const l = (r.label || "").toLowerCase();
        return labelPatterns.some((p) => l === p.toLowerCase() || l.startsWith(p.toLowerCase()));
      });
      return matching.reduce((sum, r) => sum + getRowValue(r, selectedMonthIdx), 0);
    };

    if (activeCategory === "cashConfInc") return sumRows(["confirmed cash incoming", "cash incoming adjustment", "incoming cash adjustment"], [6, 7, 47, 49]);
    if (activeCategory === "cashPipeInc") return sumRows(["pipeline cash incoming"], [48]);
    if (activeCategory === "cashDirCosts") return sumRows(["direct costs outgoing", "direct costs adjustment"], [14, 15, 56, 57]);
    if (activeCategory === "cashSalaries") {
      const salVal = sumRows(["salaries outgoing", "salaries adjustment"], [8, 9, 50, 51]);
      const divVal = sumRows(["dividends as salary outgoing", "dividends as salary adjustment"], [10, 11, 52, 53]);
      return salVal + divVal;
    }
    if (activeCategory === "cashContractors") return sumRows(["contractors outgoing", "contractors adjustment"], [12, 13, 54, 55]);
    if (activeCategory === "cashOutgoings") return sumRows(["other expenses outgoing", "other expenses adjustment"], [16, 17, 58, 59]);
    if (activeCategory === "cashTaxes") return sumRows(["corporation tax", "corporation tax adjustment", "vat", "vat adjustment"], [19, 20, 21, 22, 61, 62, 63, 64]);
    if (activeCategory === "cashOther") return sumRows(["non-operating income", "non-operating expenses", "other cash movements", "other adjustments"], [24, 25, 26, 27, 29, 30, 66, 67, 68, 69, 71, 72]);
    return null;
  }, [data, activeCategory, selectedMonthIdx, availableMonths, isNotesMode]);

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
      let results = [];
      if (keyData?.salaries?.deepDive && keyData?.salaries?.monthHeaders) {
        results = CashDeepDiveEngine.getSalariesCash(targetDate, keyData.salaries);
      }

      // If deepDive is empty or not yet loaded, fall back to the Cash sheet salaries outgoing row
      if (results.length === 0) {
        const rows = data?.includingPipeline || data?.excludingPipeline || [];
        const salRow = rows.find((r) => {
          const l = (r.label || "").toLowerCase();
          return l === "salaries" || l === "salaries outgoing" || l === "salary payments";
        });
        const val = getRowValue(salRow, selectedMonthIdx);
        if (Math.abs(val) > 0.01) {
          results.push({ name: "Net Payroll", amount: val });
        }
      }

      // Add Dividends as salary matching original WebApp.html:17158-17172
      const rows = data?.includingPipeline || data?.excludingPipeline || [];
      const divRow = rows.find((r) => {
        const l = (r.label || "").toLowerCase();
        return l === "dividends as salary" || l === "dividends as salary outgoing";
      });
      const divAdj = rows.find((r) => (r.label || "").toLowerCase() === "dividends as salary adjustment");
      const divVal = getRowValue(divRow, selectedMonthIdx) + getRowValue(divAdj, selectedMonthIdx);
      if (Math.abs(divVal) > 0.01) {
        results.push({
          name: "Dividends as salary",
          amount: divVal,
        });
      }

      if (isSenior && results.length > 0) {
        const totalSal = results.reduce((sum, item) => sum + item.amount, 0);
        return [{ name: "Salary payments", amount: totalSal }];
      }

      return results;
    }

    if (activeCategory === "cashContractors" && isNotesMode) {
      return CashDeepDiveEngine.getOutgoingsCash(targetDate, "cashContractors", keyData);
    }

    if (activeCategory === "cashOutgoings") {
      return CashDeepDiveEngine.getOutgoingsCash(targetDate, "expCash", keyData);
    }

    if (activeCategory === "cashContractors") {
      const results = [];
      const isCon = true;
      const items = keyData?.outgoings?.contractors || [];
      const headers = keyData?.outgoings?.headers || {};
      const outgoingsMeta = keyData?.outgoingsMeta;

      const targetYear = targetDate.getFullYear();
      const targetMonth = targetDate.getMonth();

      // Find which year (1, 2, or 3) and column (0..11) corresponds to targetDate matching WebApp.html:16868-16878
      let foundY = -1;
      let foundC = -1;
      for (const y of [1, 2, 3]) {
        const yHeaders = headers[y] || [];
        for (let c = 0; c < yHeaders.length; c++) {
          const hd = DeepDiveEngine.parseHeaderDate(yHeaders[c]);
          if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
            foundY = y;
            foundC = c;
            break;
          }
        }
        if (foundY !== -1) break;
      }

      if (foundY !== -1) {
        items.forEach((item) => {
          if (!item.name || item.name.toLowerCase() === "hide") return;
          if (item.name.toLowerCase().includes("depreciation")) return;
          const payTiming = item.paymentTiming || "Curr";
          let yearToRead = foundY;
          let colToRead = foundC;

          if (String(payTiming).toLowerCase() === "next") {
            if (foundC === 0) {
              yearToRead = foundY - 1;
              colToRead = 11;
            } else {
              colToRead = foundC - 1;
            }
          }

          if (yearToRead >= 1 && yearToRead <= 3) {
            const allocs = item.allocations?.[yearToRead] || [];
            const rawVal = allocs[colToRead];
            let amt = parseMoney(rawVal);
            if (Math.abs(amt) > 0.01) {
              if (item.vat === "Yes") {
                amt *= 1.2;
              }
              amt = -Math.abs(amt);
              results.push({
                name: item.name,
                amount: Math.round(amt),
              });
            }
          }
        });

        // Making up CoS amount for contractors matching WebApp.html:16921-16953
        if (isCon && outgoingsMeta) {
          const payTiming = outgoingsMeta.makingUpCosTiming || "Curr";
          const vatStatus = outgoingsMeta.makingUpCosVat || "";
          let yearToRead = foundY;
          let colToRead = foundC;

          if (String(payTiming).toLowerCase() === "next") {
            if (foundC === 0) {
              yearToRead = foundY - 1;
              colToRead = 11;
            } else {
              colToRead = foundC - 1;
            }
          }

          const targetArray = outgoingsMeta.makingUpCosBase;
          const yIdx = yearToRead - 1;
          if (targetArray && yIdx >= 0 && yIdx < targetArray.length) {
            const cosRow = targetArray[yIdx];
            if (cosRow && colToRead >= 0 && colToRead < cosRow.length) {
              let cosAmount = parseMoney(cosRow[colToRead]);
              if (Math.abs(cosAmount) > 0.01) {
                if (vatStatus === "Yes") {
                  cosAmount *= 1.2;
                }
                cosAmount = -Math.abs(cosAmount);
                results.push({
                  name: "Making up CoS amount",
                  amount: Math.round(cosAmount),
                });
              }
            }
          }
        }
      }

      return results;
    }

    if (activeCategory === "cashTaxes") {
      const results = [];
      const rows = data?.includingPipeline || data?.excludingPipeline || [];
      const corpRow = rows.find((r) => (r.label || "").toLowerCase() === "corporation tax");
      const corpAdj = rows.find((r) => (r.label || "").toLowerCase() === "corporation tax adjustment");
      const vatRow = rows.find((r) => (r.label || "").toLowerCase() === "vat");
      const vatAdj = rows.find((r) => (r.label || "").toLowerCase() === "vat adjustment");

      const corpVal = getRowValue(corpRow, selectedMonthIdx) + getRowValue(corpAdj, selectedMonthIdx);
      if (Math.abs(corpVal) > 0.01) {
        results.push({
          name: "Corporation tax",
          amount: corpVal,
        });
      }

      const vatVal = getRowValue(vatRow, selectedMonthIdx) + getRowValue(vatAdj, selectedMonthIdx);
      if (Math.abs(vatVal) > 0.01) {
        results.push({
          name: "VAT",
          amount: vatVal,
        });
      }

      return results;
    }

    if (activeCategory === "cashOther") {
      const results = [];
      const rows = data?.includingPipeline || data?.excludingPipeline || [];
      const findRow = (label) => rows.find((r) => String(r.label || "").toLowerCase().includes(label.toLowerCase()));
      const nonOpInc = findRow("non-operating income");
      const nonOpExp = findRow("non-operating expenses");
      const otherMove = findRow("other cash movements");
      if (nonOpInc) {
        const val = getRowValue(nonOpInc, selectedMonthIdx);
        if (Math.abs(val) > 0.01) results.push({ client: "Other", name: "Non-operating income", desc: "", amount: val, status: "", type: "Income" });
      }
      if (nonOpExp) {
        const val = getRowValue(nonOpExp, selectedMonthIdx);
        if (Math.abs(val) > 0.01) results.push({ client: "Other", name: "Non-operating expenses", desc: "", amount: -Math.abs(val), status: "", type: "Expense" });
      }
      if (otherMove) {
        const val = getRowValue(otherMove, selectedMonthIdx);
        if (Math.abs(val) > 0.01) results.push({ client: "Other", name: "Other cash movements", desc: "", amount: val, status: "", type: "Movement" });
      }
      return results;
    }

    return [];
  }, [activeCategory, allJobs, targetDate, keyData, selectedMonthIdx, data, isSenior, isNotesMode]);

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
  const finalDisplayTotal = sheetTargetTotal !== null ? sheetTargetTotal : computedSum;
  const manualAdjustment = finalDisplayTotal - computedSum;

  const manualAdjustmentLabel = useMemo(() => {
    const inclRows = data?.includingPipeline || [];
    const exclRows = data?.excludingPipeline || [];

    // Map activeCategory to target row indices (checking adjustment row first, then base row)
    const categoryRowMap = {
      cashConfInc: { incl: [49, 47], excl: [7, 6] },
      cashPipeInc: { incl: [48], excl: [] },
      cashSalaries: { incl: [51, 53, 50, 52], excl: [9, 11, 8, 10] },
      cashContractors: { incl: [55, 54], excl: [13, 12] },
      cashDirCosts: { incl: [57, 56], excl: [15, 14] },
      cashOutgoings: { incl: [59, 58], excl: [17, 16] },
      cashTaxes: { incl: [62, 64, 61, 63], excl: [20, 22, 19, 21] },
      cashOther: { incl: [67, 69, 72, 66, 68, 71], excl: [25, 27, 30, 24, 26, 29] },
    };

    const targetIndices = categoryRowMap[activeCategory];
    let note = "";
    if (targetIndices) {
      // 1. Check inclRows
      for (const rIdx of targetIndices.incl) {
        const r = inclRows.find((row) => row.rowIndex === rIdx);
        const cellNote = getRowNote(r, selectedMonthIdx);
        if (cellNote) {
          note = cellNote;
          break;
        }
      }
      // 2. Fall back to exclRows
      if (!note) {
        for (const rIdx of targetIndices.excl) {
          const r = exclRows.find((row) => row.rowIndex === rIdx);
          const cellNote = getRowNote(r, selectedMonthIdx);
          if (cellNote) {
            note = cellNote;
            break;
          }
        }
      }
    }

    if (note) {
      const match = note.match(/\[Note:\s*([^\]]+)\]/i);
      if (match && match[1]?.trim()) {
        return `Manual adjustment (${match[1].trim()})`;
      }
    }
    return "Manual adjustment";
  }, [data, activeCategory, selectedMonthIdx]);

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
    } else if (activeCategory === "cashOutgoings") {
      rows.push(["Category / Item", "Details", "Amount", "Reference", "Net", "VAT", "Gross", "Status"]);
      listData.forEach((item) => {
        rows.push([item.name || "", "", item.amount || 0, "", "", "", "", ""]);
        if (item.transactions && item.transactions.length > 0) {
          item.transactions.forEach((t) => {
            const dateStr = t.paidDate ? (t.date && t.date !== t.paidDate ? `${t.paidDate} (Inv: ${t.date})` : t.paidDate) : (t.date || "");
            rows.push([
              `  [Txn] ${dateStr}`,
              t.supplier || "",
              t.gross !== undefined ? -Math.abs(t.gross) : (t.amount || 0),
              t.ref || "",
              t.net !== undefined ? t.net : 0,
              t.vat !== undefined ? t.vat : 0,
              t.gross !== undefined ? t.gross : 0,
              t.isUnreconciled ? "Pending Recon" : "Reconciled",
            ]);
          });
        }
      });
      if (Math.abs(manualAdjustment) > 2 && !listData.some((i) => (i.name || "").toLowerCase().includes("adjustment"))) {
        rows.push([manualAdjustmentLabel, "", manualAdjustment, "", "", "", "", ""]);
      }
      rows.push([]);
      rows.push(["Total", "", finalDisplayTotal, "", "", "", "", ""]);
    } else if (activeCategory === "cashContractors" && isNotesMode) {
      rows.push(["Pay date", "Vendor", "Description", "Total excl VAT", "VAT included", "Total incl VAT", "Received date", "Status"]);
      listData.forEach((item) => {
        rows.push([
          DeepDiveEngine.formatShortDate(item.payDate),
          item.vendor || item.contractorName || "",
          item.itemDesc || item.rawDesc || "",
          item.amountNet || 0,
          item.vatAmount || 0,
          item.amount || 0,
          item.recDate ? DeepDiveEngine.formatShortDate(item.recDate) : "",
          item.status || "",
        ]);
      });
      const totNet = listData.reduce((s, i) => s + (i.amountNet || 0), 0);
      const totVat = listData.reduce((s, i) => s + (i.vatAmount || 0), 0);
      if (Math.abs(manualAdjustment) > 2) {
        rows.push(["", manualAdjustmentLabel, "", "", "", manualAdjustment, "", ""]);
      }
      rows.push(["", "", "Total", totNet, totVat, finalDisplayTotal, "", ""]);
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
        rows.push(["", manualAdjustmentLabel, "", "", "", manualAdjustment, ""]);
      }
      rows.push(["", "", "", "", "Total", finalDisplayTotal, ""]);
    } else {
      rows.push(["Name", "Description", "Amount"]);
      listData.forEach((item) => {
        rows.push([item.client || item.name, item.desc, item.amount]);
      });
      if (Math.abs(manualAdjustment) > 2) {
        rows.push([manualAdjustmentLabel, "", manualAdjustment]);
      }
      rows.push(["Total", "", finalDisplayTotal]);
    }

    downloadCsv(`cash_breakdown_${activeCategory}_${periodLabel.replace(/\s+/g, "_")}.csv`, rows);
  };

  if (isLoading && (!data || !keyData)) {
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
        <h1 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
          Cash breakdowns
        </h1>

        {/* Category Dropdown */}
        <select
          className="breakdown-select"
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
          className="breakdown-select"
          value={selectedMonthIdx}
          onChange={(e) => {
            setHasUserSelectedMonth(true);
            setSelectedMonthIdx(parseInt(e.target.value, 10));
          }}
          style={dropdownStyle}
        >
          {availableMonths.map((m, idx) => (
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
      <div style={{ width: "100%", maxWidth: "100%", margin: "0" }}>

        {/* 1. Invoices Sent View (Matching original WebApp table layout) */}
        {activeCategory === "cashInvoicesSent" ? (
          <div>
            {(invoicesSentData?.confirmed?.length > 0 || invoicesSentData?.pipeline?.length > 0) ? (
              <div className="breakdown-scroll-wrapper" style={{ width: "100%", maxWidth: "100%", marginTop: "1rem", marginBottom: "2rem", overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: "640px", borderCollapse: "collapse", fontSize: "14px" }}>
                  {/* Confirmed Section */}
                  {invoicesSentData?.confirmed?.length > 0 && (
                    <>
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
                          <tr key={`conf-${idx}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "12px 10px 12px 0", color: "#6b7280", whiteSpace: "nowrap" }}>
                              {DeepDiveEngine.formatShortDate(inv.sendDate)}
                            </td>
                            <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827" }}>{inv.client}</td>
                            <td style={{ padding: "12px 10px", color: "#475569" }}>{inv.jobName}</td>
                            <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.type}</td>
                            <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.ref || ""}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right", color: "#111827", lineHeight: "1.2" }}>
                              <div>{formatMoney(inv.amountExVat)}</div>
                              <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>ex</div>
                            </td>
                            <td style={{ padding: "12px 10px", textAlign: "right", color: "#475569", lineHeight: "1.2" }}>
                              <div>{formatMoney(inv.vatAmount)}</div>
                              <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>VAT</div>
                            </td>
                            <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                              {formatMoney(inv.totalAmount)}
                            </td>
                            <td style={{ padding: "12px 0 12px 10px", textAlign: "right" }}>
                              {renderStatusBadge(inv.status)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {/* Pipeline Section */}
                  {invoicesSentData?.pipeline?.length > 0 && (
                    <>
                      <thead>
                        <tr>
                          <td colSpan={7} style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "left", padding: "16px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}>
                            Pipeline
                          </td>
                          <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "right", padding: "16px 10px 10px 10px", borderBottom: "1px solid #e5e7eb" }}>
                            {formatMoney(invoicesSentData.pipeline.reduce((sum, inv) => sum + inv.totalAmount, 0))}
                          </td>
                          <td style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                        </tr>
                      </thead>
                      <tbody>
                        {invoicesSentData.pipeline.map((inv, idx) => (
                          <tr key={`pipe-${idx}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "12px 10px 12px 0", color: "#6b7280", whiteSpace: "nowrap" }}>
                              {DeepDiveEngine.formatShortDate(inv.sendDate)}
                            </td>
                            <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827" }}>{inv.client}</td>
                            <td style={{ padding: "12px 10px", color: "#475569" }}>{inv.jobName}</td>
                            <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.type}</td>
                            <td style={{ padding: "12px 10px", color: "#6b7280" }}>{inv.ref || ""}</td>
                            <td style={{ padding: "12px 10px", textAlign: "right", color: "#111827", lineHeight: "1.2" }}>
                              <div>{formatMoney(inv.amountExVat)}</div>
                              <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>ex</div>
                            </td>
                            <td style={{ padding: "12px 10px", textAlign: "right", color: "#475569", lineHeight: "1.2" }}>
                              <div>{formatMoney(inv.vatAmount)}</div>
                              <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>VAT</div>
                            </td>
                            <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                              {formatMoney(inv.totalAmount)}
                            </td>
                            <td style={{ padding: "12px 0 12px 10px", color: "#6b7280", textAlign: "right" }}></td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            ) : isLoading ? (
              <div style={{ padding: "3rem 0", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
                <Spinner size={28} color="#0047AB" />
                <p style={{ marginTop: "0.75rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
                  Please wait - loading invoices...
                </p>
              </div>
            ) : (
              <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                No invoices sent in this period.
              </div>
            )}
          </div>
        ) : (activeCategory === "cashContractors" && isNotesMode) ? (
          /* Detailed Contractor Payments Table (Notes Metadata Mode) */
          <div className="breakdown-scroll-wrapper" style={{ width: "100%", maxWidth: "100%", overflowX: "auto", paddingBottom: "10px" }}>
            <table style={{ width: "100%", minWidth: "860px", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95em" }}>
              <thead>
                {/* Header Total Row */}
                <tr>
                  <td colSpan={3} style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.1rem", textAlign: "left", padding: "10px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}>
                    Contractor payments ({listData.length} {listData.length === 1 ? "transaction" : "transactions"})
                  </td>
                  <td style={{ fontWeight: 600, color: "#111827", fontSize: "1rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                    {formatMoney(listData.reduce((sum, item) => sum + (item.amountNet || 0), 0))}
                  </td>
                  <td style={{ fontWeight: 600, color: "#64748b", fontSize: "1rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                    {formatMoney(listData.reduce((sum, item) => sum + (item.vatAmount || 0), 0))}
                  </td>
                  <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.2rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                    {formatMoney(finalDisplayTotal)}
                  </td>
                  <td colSpan={2} style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                </tr>
                {/* Column Headers */}
                <tr style={{ borderBottom: "1px solid #cbd5e1" }}>
                  <th style={{ textAlign: "left", padding: "10px 10px 10px 0", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Pay date</th>
                  <th style={{ textAlign: "left", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Vendor</th>
                  <th style={{ textAlign: "left", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem" }}>Description</th>
                  <th style={{ textAlign: "right", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Total excl VAT</th>
                  <th style={{ textAlign: "right", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>VAT included</th>
                  <th style={{ textAlign: "right", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Total incl VAT</th>
                  <th style={{ textAlign: "left", padding: "10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Received date</th>
                  <th style={{ textAlign: "right", padding: "10px 0 10px 10px", color: "#64748b", fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} style={{ padding: "3rem 0", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
                      <Spinner size={28} color="#0047AB" />
                      <p style={{ marginTop: "0.75rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
                        Please wait - loading transactions...
                      </p>
                    </td>
                  </tr>
                ) : listData.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                      No contractor transactions in this period.
                    </td>
                  </tr>
                ) : (
                  listData.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "12px 10px 12px 0", color: "#6b7280", whiteSpace: "nowrap" }}>
                        {DeepDiveEngine.formatShortDate(item.payDate)}
                      </td>
                      <td style={{ padding: "12px 10px", fontWeight: 600, color: "#111827", whiteSpace: "nowrap" }}>
                        {item.vendor || item.contractorName || "—"}
                      </td>
                      <td style={{ padding: "12px 10px", color: "#475569", minWidth: "220px" }}>
                        {item.itemDesc || item.rawDesc || "—"}
                      </td>
                      <td style={{ padding: "12px 10px", textAlign: "right", color: "#111827", whiteSpace: "nowrap" }}>
                        <div>{formatMoney(item.amountNet)}</div>
                        <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>ex</div>
                      </td>
                      <td style={{ padding: "12px 10px", textAlign: "right", color: "#475569", whiteSpace: "nowrap" }}>
                        <div>{formatMoney(item.vatAmount)}</div>
                        <div style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "2px" }}>VAT</div>
                      </td>
                      <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB", whiteSpace: "nowrap" }}>
                        {formatMoney(item.amount)}
                      </td>
                      <td style={{ padding: "12px 10px", color: "#6b7280", whiteSpace: "nowrap" }}>
                        {item.recDate ? DeepDiveEngine.formatShortDate(item.recDate) : "—"}
                      </td>
                      <td style={{ padding: "12px 0 12px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {renderStatusBadge(item.status, item.isPartPayment)}
                      </td>
                    </tr>
                  ))
                )}
                {/* Manual Adjustment Row if applicable */}
                {Math.abs(manualAdjustment) > 2 && (
                  <tr style={{ borderTop: "1px dashed #e2e8f0", background: "#fafafa" }}>
                    <td colSpan={5} style={{ padding: "12px 10px 12px 0", color: "#64748b" }}>
                      <em>{manualAdjustmentLabel}</em>
                    </td>
                    <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                      {formatMoney(manualAdjustment)}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : isTableLayout ? (
          /* 2. Confirmed Cash / Pipeline Cash / Direct Cost Payments: Table matching original buildJobCashHtml */
          <div className="breakdown-scroll-wrapper" style={{ width: "100%", maxWidth: "100%", overflowX: "auto", paddingBottom: "10px" }}>
            <table style={{ width: "100%", minWidth: "600px", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95em", whiteSpace: "nowrap" }}>
              <tbody>
                {/* Header Total Row */}
                <tr>
                  <td colSpan={5} style={{ padding: "10px 10px 10px 0", borderBottom: "1px solid #e5e7eb" }}></td>
                  <td style={{ fontWeight: 700, color: "#0047AB", fontSize: "1.2rem", textAlign: "right", padding: "10px 10px", borderBottom: "1px solid #e5e7eb" }}>
                    {formatMoney(finalDisplayTotal)}
                  </td>
                  <td style={{ borderBottom: "1px solid #e5e7eb" }}></td>
                </tr>

                {isLoading ? (
                  <tr>
                    <td colSpan={7} style={{ padding: "3rem 0", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
                      <Spinner size={28} color="#0047AB" />
                      <p style={{ marginTop: "0.75rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
                        Please wait - loading transactions...
                      </p>
                    </td>
                  </tr>
                ) : listData.length === 0 ? (
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
                      <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                        {formatMoney(item.amount)}
                      </td>
                      <td style={{ padding: "12px 0 12px 10px", textAlign: "right" }}>
                        {renderStatusBadge(item.status, item.isPartPayment)}
                      </td>
                    </tr>
                  ))
                )}

                {/* Manual Adjustment Row if sheet total differs from transaction sum */}
                {Math.abs(manualAdjustment) > 2 && (
                  <tr style={{ borderTop: "1px dashed #e2e8f0", background: "#fafafa" }}>
                    <td colSpan={5} style={{ padding: "12px 10px 12px 0", color: "#64748b" }}>
                      <em>{manualAdjustmentLabel}</em>
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
        ) : activeCategory === "cashOutgoings" ? (
          /* Outgoings Payments: Expandable category cards with full transaction tables matching PerformanceBreakdownView */
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
                {formatMoney(finalDisplayTotal)}
              </span>
            </div>

            {isLoading ? (
              <div style={{ padding: "3rem 0", textAlign: "center", color: "#64748b" }}>
                <Spinner size={28} color="#0047AB" />
                <p style={{ marginTop: "0.75rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
                  Please wait - loading transactions...
                </p>
              </div>
            ) : listData.length === 0 ? (
              <div style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                No other expenses recorded for this period.
              </div>
            ) : (
              listData.map((item, idx) => {
                const isAdjustment =
                  item.name === "Manual adjustment" ||
                  String(item.name || "").startsWith("Manual adjustment") ||
                  item.name === "Rounding adjustment";

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
                        fontSize: "13.3px",
                      }}
                    >
                      <span style={{ color: "#64748b", fontStyle: "italic", fontSize: "12.3px" }}>
                        {manualAdjustmentLabel || item.name}
                      </span>
                      <span style={{ fontWeight: 700, color: "#0047AB" }}>
                        {formatMoney(item.amount)}
                      </span>
                    </div>
                  );
                }

                const hasTxns = Array.isArray(item.transactions) && item.transactions.length > 0;
                const itemKey = `cf_cat_${idx}_${item.name}`;
                const isExpanded = Boolean(openAccordions[itemKey]);

                if (hasTxns) {
                  return (
                    <div
                      key={idx}
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
                        onClick={() => toggleAccordion(itemKey)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px 16px",
                          background: isExpanded ? "#f1f5f9" : "#f8fafc",
                          cursor: "pointer",
                          fontWeight: 600,
                          color: "#0047AB",
                          fontSize: "14px",
                          userSelect: "none",
                          transition: "background 0.15s ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
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
                          <span style={{ color: "#0f172a", fontWeight: 700 }}>{item.name}</span>
                          <span
                            style={{
                              fontSize: "11px",
                              padding: "2px 8px",
                              borderRadius: "10px",
                              background: "#e2e8f0",
                              color: "#475569",
                              fontWeight: 500,
                            }}
                          >
                            {item.transactions.length} txn{item.transactions.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <span style={{ fontWeight: 700, color: "#0047AB", whiteSpace: "nowrap" }}>
                          {formatMoney(item.amount)}
                        </span>
                      </div>

                      {isExpanded && (
                        <div style={{ borderTop: "1px solid #e2e8f0", background: "#ffffff", overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
                            <thead>
                              <tr style={{ background: "#f8fafc", color: "#64748b", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                                <th style={{ padding: "9px 16px", fontWeight: 600, width: "140px" }}>Date</th>
                                <th style={{ padding: "9px 16px", fontWeight: 600 }}>Supplier / Description</th>
                                <th style={{ padding: "9px 16px", fontWeight: 600, width: "120px" }}>Reference</th>
                                <th style={{ padding: "9px 16px", fontWeight: 600, textAlign: "right", width: "95px" }}>Net</th>
                                <th style={{ padding: "9px 16px", fontWeight: 600, textAlign: "right", width: "80px" }}>VAT</th>
                                <th style={{ padding: "9px 16px", fontWeight: 600, textAlign: "right", width: "95px" }}>Gross</th>
                              </tr>
                            </thead>
                            <tbody>
                              {item.transactions.map((txn, tIdx) => {
                                const dateDisplay = txn.paidDate
                                  ? (txn.date && txn.date !== txn.paidDate ? `${txn.paidDate} (Inv: ${txn.date})` : txn.paidDate)
                                  : (txn.date || "—");

                                return (
                                  <tr
                                    key={tIdx}
                                    style={{
                                      borderBottom: tIdx === item.transactions.length - 1 ? "none" : "1px solid #f1f5f9",
                                      background: txn.isUnreconciled ? "#fffdf5" : "transparent",
                                      transition: "background 0.1s ease",
                                    }}
                                  >
                                    <td style={{ padding: "8px 16px", color: "#475569", whiteSpace: "nowrap", fontSize: "12px" }}>
                                      {dateDisplay}
                                    </td>
                                    <td style={{ padding: "8px 16px", color: "#0f172a" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                                        <span style={{ fontWeight: 500 }}>{txn.supplier || "—"}</span>
                                        {txn.isUnreconciled && (
                                          <span
                                            style={{
                                              fontSize: "10px",
                                              padding: "1px 5px",
                                              borderRadius: "3px",
                                              background: "#fef3c7",
                                              color: "#92400e",
                                              border: "1px solid #fde68a",
                                              fontWeight: 600,
                                              lineHeight: "1.2",
                                            }}
                                            title="Unreconciled bank statement line from Cashflow Reconciliation"
                                          >
                                            Pending Recon
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                    <td style={{ padding: "8px 16px", color: "#64748b", fontSize: "11.5px", whiteSpace: "nowrap" }}>
                                      {txn.ref || "—"}
                                    </td>
                                    <td style={{ padding: "8px 16px", textAlign: "right", color: "#64748b", fontSize: "11.5px", fontVariantNumeric: "tabular-nums" }}>
                                      {txn.net !== undefined ? formatMoney(txn.net) : "—"}
                                    </td>
                                    <td style={{ padding: "8px 16px", textAlign: "right", color: "#64748b", fontSize: "11.5px", fontVariantNumeric: "tabular-nums" }}>
                                      {txn.vat ? formatMoney(txn.vat) : "—"}
                                    </td>
                                    <td style={{ padding: "8px 16px", textAlign: "right", fontWeight: 700, color: "#0047AB", fontVariantNumeric: "tabular-nums" }}>
                                      {formatMoney(txn.gross !== undefined ? txn.gross : txn.amount)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                }

                // Card without transactions (forecast months / no txns)
                return (
                  <div
                    key={idx}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      background: "#ffffff",
                      marginBottom: "8px",
                      padding: "11px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: "13.5px",
                      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.02)",
                    }}
                  >
                    <span style={{ color: "#0f172a", fontWeight: 600 }}>{item.name}</span>
                    <span style={{ fontWeight: 700, color: "#0047AB" }}>{formatMoney(item.amount)}</span>
                  </div>
                );
              })
            )}

            {/* Manual adjustment row if sheet target differs from transaction sum and not already in listData */}
            {Math.abs(manualAdjustment) > 2 && !listData.some(i => (i.name || "").toLowerCase().includes("adjustment")) && (
              <div
                style={{
                  border: "1px dashed #cbd5e1",
                  borderRadius: "8px",
                  background: "#f8fafc",
                  marginBottom: "8px",
                  padding: "10px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "13.3px",
                }}
              >
                <span style={{ color: "#64748b", fontStyle: "italic", fontSize: "12.3px" }}>
                  {manualAdjustmentLabel}
                </span>
                <span style={{ fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(manualAdjustment)}
                </span>
              </div>
            )}
          </div>
        ) : (
          /* 3. Simple List (Salaries, Contractors, Outgoings, Taxes) matching original buildSimpleListHtml */
          <div className="breakdown-scroll-wrapper" style={{ width: "100%", maxWidth: "100%", overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: "320px", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr>
                  <th style={{ padding: "10px 48px 10px 0", borderBottom: "1px solid #e5e7eb", textAlign: "left" }}></th>
                  <th style={{ padding: "10px 0", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontSize: "1.2rem", fontWeight: 700, color: "#0047AB", whiteSpace: "nowrap" }}>
                    {formatMoney(finalDisplayTotal)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={2} style={{ padding: "3rem 0", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
                      <Spinner size={28} color="#0047AB" />
                      <p style={{ marginTop: "0.75rem", color: "#64748b", fontWeight: 500, fontSize: "14px" }}>
                        Please wait - loading transactions...
                      </p>
                    </td>
                  </tr>
                ) : listData.length === 0 ? (
                  <tr>
                    <td colSpan={2} style={{ padding: "2.5rem 0", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
                      No transactions in this period.
                    </td>
                  </tr>
                ) : (
                  listData.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "12px 48px 12px 0", fontSize: "15px", fontWeight: 500, color: "#111827", textAlign: "left" }}>
                        {item.name || item.client}
                      </td>
                      <td style={{ padding: "12px 0", fontSize: "15px", fontWeight: 700, color: "#0047AB", textAlign: "right", whiteSpace: "nowrap" }}>
                        {formatMoney(item.amount)}
                      </td>
                    </tr>
                  ))
                )}
                {Math.abs(manualAdjustment) > 2 && (
                  <tr style={{ borderTop: "1px dashed #e2e8f0", background: "#fafafa" }}>
                    <td style={{ padding: "12px 48px 12px 0", fontSize: "14px", color: "#64748b", fontStyle: "italic", textAlign: "left" }}>
                      {manualAdjustmentLabel}
                    </td>
                    <td style={{ padding: "12px 0", fontSize: "15px", fontWeight: 700, color: "#0047AB", textAlign: "right", whiteSpace: "nowrap" }}>
                      {formatMoney(manualAdjustment)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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
