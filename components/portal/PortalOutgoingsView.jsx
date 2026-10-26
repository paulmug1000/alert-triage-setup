import React, { useState, useEffect, useMemo } from "react";
import Spinner from "../Spinner";
import { PortalTableSkeleton } from "../Skeleton";
import { formatMoney, parseMoney } from "../../services/deepDiveHelper";
import { downloadCsv, isPlaceholderExpense } from "../../utils/helpers";
import AddContractorModal from "./AddContractorModal";
import AddExpenseModal from "./AddExpenseModal";
import ContractorExpenseModal from "./ContractorExpenseModal";

function getContractorColLetter(year, mIdx) {
  let colIndex = 6 + mIdx; // Year 1: cols G-R (6 to 17)
  if (year === 2) colIndex = 21 + mIdx; // Year 2: cols V-AG (21 to 32)
  else if (year === 3) colIndex = 36 + mIdx; // Year 3: cols AK-AV (36 to 47)

  let temp, letter = "";
  let c = colIndex + 1;
  while (c > 0) {
    temp = (c - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    c = Math.floor((c - temp - 1) / 26);
  }
  return letter;
}

const getContractorStatusPill = (status) => {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") {
    return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  }
  if (s === "received" || s === "sent") {
    return { background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  }
  return { background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
};

export default function PortalOutgoingsView({
  clientName,
  clientSheetId,
  category = "contractors", // 'contractors' | 'expenses' | 'dividends'
  data,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isReadOnly = false,
}) {
  const outgoingsData = data?.outgoings;
  const [selectedYear, setSelectedYear] = useState(outgoingsData?.currentYear || 2); // 1, 2, 3
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const [contractorModalConfig, setContractorModalConfig] = useState(null);

  const toggleRowExpand = (rowKey) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };
  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState({}); // { [rowNumber]: string[] (12 months) }
  const [editDeliveryPcts, setEditDeliveryPcts] = useState({}); // { [rowNumber]: string } (for Dividends)
  const [optimisticDeliveryPcts, setOptimisticDeliveryPcts] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [optimisticAllocs, setOptimisticAllocs] = useState({}); // { [year]: { [rowNumber]: string[] } }

  // Modals for adding items in edit mode
  const [showAddContractorModal, setShowAddContractorModal] = useState(false);
  const [showAddExpenseModal, setShowAddExpenseModal] = useState(false);
  const [localNewItems, setLocalNewItems] = useState([]);

  // Clear optimistic allocations and local new items when fresh server data arrives
  useEffect(() => {
    setOptimisticAllocs({});
    setOptimisticDeliveryPcts({});
    setLocalNewItems([]);
  }, [outgoingsData]);

  useEffect(() => {
    if (outgoingsData?.currentYear) {
      setSelectedYear(outgoingsData.currentYear);
    }
  }, [outgoingsData?.currentYear]);

  const fyLabels = useMemo(() => {
    if (outgoingsData?.fyLabels) return outgoingsData.fyLabels;
    const getFy = (yr) => {
      const hdrs = outgoingsData?.headers?.[yr] || [];
      const last = hdrs[hdrs.length - 1] || hdrs[0];
      const m = String(last).match(/(\d{2,4})/);
      return m ? `FY${m[1].slice(-2)}` : `FY${24 + yr}`;
    };
    return { 1: getFy(1), 2: getFy(2), 3: getFy(3) };
  }, [outgoingsData]);

  const itemsList = useMemo(() => {
    if (!outgoingsData) return [];
    let list = [];
    if (category === "contractors") list = outgoingsData.contractors || [];
    else if (category === "expenses") list = outgoingsData.expenses || [];
    else if (category === "dividends") list = outgoingsData.dividends || [];

    if (category === "dividends") {
      list = list.filter((item) => !String(item.name || "").toLowerCase().includes("total"));
    }

    // Merge any locally added items for this category
    const relevantLocal = localNewItems.filter((it) => {
      if (category === "contractors") return it.isContractor;
      if (category === "expenses") return !it.isContractor;
      return false;
    });

    return [...list, ...relevantLocal];
  }, [outgoingsData, category, localNewItems]);

  const deliveryExpenses = useMemo(() => {
    if (category !== "expenses") return [];
    return itemsList.filter((item) => item.isDelivery);
  }, [category, itemsList]);

  const nonDeliveryExpenses = useMemo(() => {
    if (category !== "expenses") return [];
    return itemsList.filter((item) => !item.isDelivery);
  }, [category, itemsList]);

  const monthHeaders = useMemo(() => {
    if (!outgoingsData?.headers) return [];
    return outgoingsData.headers[selectedYear] || [];
  }, [outgoingsData, selectedYear]);

  // Page title mapping matching original WebApp
  const getPageTitle = () => {
    if (category === "contractors") return "Contractors";
    if (category === "expenses") return "Expenses";
    if (category === "dividends") return "Dividends";
    return "Outgoings";
  };

  const pageTitle = getPageTitle();

  const rawSymbol =
    (propCurrencySymbol && propCurrencySymbol !== "£" ? propCurrencySymbol : null) ||
    data?.currencySymbol ||
    data?.clientInfo?.currencySymbol ||
    propCurrencySymbol ||
    "£";
  const currencySymbol =
    rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;
  const thousandsSeparator =
    (propThousandsSeparator && propThousandsSeparator !== "," ? propThousandsSeparator : null) ||
    data?.thousandsSeparator ||
    data?.clientInfo?.thousandsSeparator ||
    propThousandsSeparator ||
    (currencySymbol === "€" ? "." : ",");

  const formatGBP = (val) => {
    return formatMoney(val, 0, currencySymbol, thousandsSeparator);
  };

  const handleStartEdit = () => {
    if (isReadOnly) return;
    const initial = {};
    const initialDeliveryPcts = {};

    itemsList.forEach((item) => {
      const optAllocs = optimisticAllocs[selectedYear]?.[item.rowNumber];
      const yearAlloc = optAllocs || item.allocations?.[selectedYear] || item.monthlyAllocations || [];
      initial[item.rowNumber] = yearAlloc.slice(0, 12).map((val) => {
        const num = parseMoney(val, thousandsSeparator);
        return formatMoney(num, 0, currencySymbol, thousandsSeparator);
      });
      if (category === "dividends") {
        initialDeliveryPcts[item.rowNumber] = optimisticDeliveryPcts[item.rowNumber] || item.deliveryPct || "0%";
      }
    });

    setEditValues(initial);
    setEditDeliveryPcts(initialDeliveryPcts);
    setIsEditing(true);
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditValues({});
    setEditDeliveryPcts({});
    setSaveError(null);
  };

  const handleCellChange = (rowNumber, mIdx, val) => {
    if (isReadOnly) return;
    if (category === "expenses" && outgoingsData?.reconciledMonths?.[selectedYear]?.[mIdx]) {
      return;
    }
    const targetItem = itemsList.find((it) => it.rowNumber === rowNumber);
    if (category === "contractors" && targetItem?.lockedCells?.[selectedYear]?.[mIdx]) {
      return;
    }
    setEditValues((prev) => {
      const current = prev[rowNumber] ? [...prev[rowNumber]] : new Array(12).fill(`${currencySymbol}0`);
      current[mIdx] = val;
      return {
        ...prev,
        [rowNumber]: current,
      };
    });
  };

  const handleDeliveryPctChange = (rowNumber, val) => {
    if (isReadOnly) return;
    setEditDeliveryPcts((prev) => ({
      ...prev,
      [rowNumber]: val,
    }));
  };

  const handleSaveData = async () => {
    if (isReadOnly) return;
    setIsSaving(true);
    setSaveError(null);

    try {
      const updates = [];
      const colRange = selectedYear === 1 ? "G:R" : selectedYear === 2 ? "V:AG" : "AK:AV";
      const [startCol, endCol] = colRange.split(":");

      itemsList.forEach((item) => {
        const edits = editValues[item.rowNumber];
        if (edits) {
          const origAlloc = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
          const safeEdits = edits.map((v, idx) => {
            const isLocked = category === "expenses"
              ? Boolean(outgoingsData?.reconciledMonths?.[selectedYear]?.[idx])
              : category === "contractors"
                ? Boolean(item.lockedCells?.[selectedYear]?.[idx])
                : false;
            return isLocked ? (origAlloc[idx] !== undefined ? origAlloc[idx] : `${currencySymbol}0`) : v;
          });

          const hasChanged = safeEdits.some((v, idx) => v !== origAlloc[idx]);

          if (hasChanged) {
            updates.push({
              range: `Outgoings!${startCol}${item.rowNumber}:${endCol}${item.rowNumber}`,
              values: [safeEdits],
            });
          }
        }

        // For Dividends: Check if Delivery % (Col E) changed
        if (category === "dividends") {
          const newPct = editDeliveryPcts[item.rowNumber];
          const origPct = optimisticDeliveryPcts[item.rowNumber] || item.deliveryPct || "0%";
          if (newPct !== undefined && newPct !== origPct) {
            let pctFormatted = String(newPct).trim();
            if (pctFormatted && !pctFormatted.endsWith("%") && !isNaN(Number(pctFormatted))) {
              pctFormatted = `${pctFormatted}%`;
            }
            updates.push({
              range: `Outgoings!E${item.rowNumber}`,
              values: [[pctFormatted]],
            });
          }
        }
      });

      if (updates.length > 0) {
        const res = await fetch("/api/portal/save-table-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientSheetId,
            clientName,
            sheetName: "Outgoings",
            updates,
          }),
        });

        const resData = await res.json();
        if (!resData.success) {
          throw new Error(resData.error || "Failed to save outgoings data");
        }

        // Optimistically update local allocations
        setOptimisticAllocs((prev) => ({
          ...prev,
          [selectedYear]: {
            ...(prev[selectedYear] || {}),
            ...editValues,
          },
        }));

        if (category === "dividends") {
          setOptimisticDeliveryPcts((prev) => ({
            ...prev,
            ...editDeliveryPcts,
          }));
        }
      }

      setIsEditing(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Save outgoings error:", err);
      setSaveError(err.message || "An error occurred while saving.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleContractorCreated = (newItem) => {
    const itemWithCategory = {
      ...newItem,
      isContractor: true,
      allocations: {
        1: new Array(12).fill(`${currencySymbol}0`),
        2: new Array(12).fill(`${currencySymbol}0`),
        3: new Array(12).fill(`${currencySymbol}0`),
      },
    };
    setLocalNewItems((prev) => [...prev, itemWithCategory]);
    // Initialize in editValues so user can immediately edit monthly values
    setEditValues((prev) => ({
      ...prev,
      [newItem.rowNumber]: new Array(12).fill(`${currencySymbol}0`),
    }));
  };

  const handleExpenseCreated = (newItem) => {
    const itemWithCategory = {
      ...newItem,
      isContractor: false,
      allocations: {
        1: new Array(12).fill(`${currencySymbol}0`),
        2: new Array(12).fill(`${currencySymbol}0`),
        3: new Array(12).fill(`${currencySymbol}0`),
      },
    };
    setLocalNewItems((prev) => [...prev, itemWithCategory]);
    // Initialize in editValues so user can immediately edit monthly values
    setEditValues((prev) => ({
      ...prev,
      [newItem.rowNumber]: new Array(12).fill(`${currencySymbol}0`),
    }));
  };

  const handleDownloadCSV = () => {
    if (!itemsList || itemsList.length === 0) return;
    const fyName = fyLabels[selectedYear] || `FY${selectedYear}`;
    const dateStr = new Date().toISOString().split("T")[0];

    if (category === "expenses") {
      // Export Delivery expenses and Non-delivery expenses sections
      const header = ["Category", ...(monthHeaders || []), "Total"];
      const buildSectionRows = (list, sectionName) => {
        const rows = list.map((item) => {
          const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
          const currentAllocs = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;
          const liveTotal = currentAllocs.reduce((sum, v) => sum + parseMoney(v), 0);
          return [
            item.name || "",
            ...monthHeaders.map((_, mIdx) => currentAllocs[mIdx] || `${currencySymbol}0`),
            formatGBP(liveTotal),
          ];
        });

        // Add section Total row
        const totalCols = monthHeaders.map((_, mIdx) => {
          const colSum = list.reduce((sum, item) => {
            const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
            const val = isEditing ? (editValues[item.rowNumber]?.[mIdx] ?? origAllocs[mIdx]) : origAllocs[mIdx];
            return sum + parseMoney(val);
          }, 0);
          return formatGBP(colSum);
        });

        const sectionGrandTotal = list.reduce((sum, item) => {
          const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
          const cur = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;
          return sum + cur.reduce((rSum, v) => rSum + parseMoney(v), 0);
        }, 0);

        return [
          [`--- ${sectionName} ---`, ...monthHeaders.map(() => ""), ""],
          ...rows,
          ["Total", ...totalCols, formatGBP(sectionGrandTotal)],
        ];
      };

      const delRows = buildSectionRows(deliveryExpenses, "Delivery expenses");
      const nonDelRows = buildSectionRows(nonDeliveryExpenses, "Non-delivery expenses");

      downloadCsv(`Pulse_${pageTitle}_${fyName}_${dateStr}.csv`, [
        header,
        ...delRows,
        ["", ...monthHeaders.map(() => ""), ""],
        ...nonDelRows,
      ]);
      return;
    }

    const isDividends = category === "dividends";
    const header = [
      pageTitle,
      ...(isDividends ? ["Delivery %"] : []),
      ...(monthHeaders || []),
      "Total",
    ];

    const rowsData = itemsList.map((item) => {
      const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
      const currentAllocs = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;
      const liveTotal = currentAllocs.reduce((sum, v) => sum + parseMoney(v), 0);
      const delPct = isDividends
        ? (editDeliveryPcts[item.rowNumber] ?? optimisticDeliveryPcts[item.rowNumber] ?? item.deliveryPct ?? "0%")
        : null;

      return [
        item.name || "",
        ...(isDividends ? [delPct] : []),
        ...monthHeaders.map((_, mIdx) => currentAllocs[mIdx] || `${currencySymbol}0`),
        formatGBP(liveTotal),
      ];
    });

    // Total row for contractors
    if (category === "contractors") {
      const totalCols = monthHeaders.map((_, mIdx) => {
        const colSum = itemsList.reduce((sum, item) => {
          const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
          const val = isEditing ? (editValues[item.rowNumber]?.[mIdx] ?? origAllocs[mIdx]) : origAllocs[mIdx];
          return sum + parseMoney(val);
        }, 0);
        return formatGBP(colSum);
      });
      const grandTotal = itemsList.reduce((sum, item) => {
        const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
        const cur = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;
        return sum + cur.reduce((rSum, v) => rSum + parseMoney(v), 0);
      }, 0);

      rowsData.push(["Total", ...totalCols, formatGBP(grandTotal)]);
    }

    downloadCsv(`Pulse_${pageTitle}_${fyName}_${dateStr}.csv`, [header, ...rowsData]);
  };

  if (error && !outgoingsData) {
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
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load {pageTitle.toLowerCase()} data</h4>
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

  if (!outgoingsData) {
    return <PortalTableSkeleton title={pageTitle} columns={7} />;
  }

  // Helper component to render an outgoings table (supports top-left label, total row, and delivery % column)
  const renderTableSection = (tableItems, topLeftLabel = "", showTotalRow = false, showDeliveryPct = false) => {
    // Grand total across all rows in this table
    const grandTotal = tableItems.reduce((sum, item) => {
      const optAllocs = optimisticAllocs[selectedYear]?.[item.rowNumber];
      const origAllocs = optAllocs || item.allocations?.[selectedYear] || item.monthlyAllocations || [];
      const currentAllocs = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;
      const rowSum = currentAllocs.reduce((rSum, v) => rSum + parseMoney(v), 0);
      return sum + rowSum;
    }, 0);

    return (
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
              minWidth: "860px",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              tableLayout: "fixed",
              userSelect: "none",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "left",
                    fontWeight: 700,
                    width: showDeliveryPct ? "14.8%" : "18.8%",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 2,
                    fontSize: "11.5px",
                  }}
                >
                  {topLeftLabel}
                </th>

                {showDeliveryPct && (
                  <th
                    style={{
                      padding: "6px 6px",
                      textAlign: "center",
                      fontWeight: 700,
                      width: "7.0%",
                      fontSize: "11px",
                    }}
                  >
                    Delivery %
                  </th>
                )}

                {monthHeaders.map((m, idx) => {
                  const isMonthReconciled = category === "expenses" && Boolean(outgoingsData?.reconciledMonths?.[selectedYear]?.[idx]);
                  return (
                    <th
                      key={idx}
                      style={{
                        padding: "6px 4px",
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: "11px",
                        width: showDeliveryPct ? "5.85%" : "6.1%",
                        background: isMonthReconciled ? "#003b8e" : "#0047AB",
                        color: isMonthReconciled ? "#e2e8f0" : "#ffffff",
                      }}
                      title={isMonthReconciled ? "This month contains actuals and is locked" : undefined}
                    >
                      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: "3px" }}>
                        {isMonthReconciled && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ opacity: 0.85 }}
                          >
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                        )}
                        <span>{m}</span>
                      </div>
                    </th>
                  );
                })}

                <th
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    fontWeight: 800,
                    width: "8.0%",
                    background: "#0047AB",
                    fontSize: "11px",
                  }}
                >
                  Total
                </th>
              </tr>
            </thead>

            <tbody>
              {tableItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={showDeliveryPct ? 15 : 14}
                    style={{ padding: "2.5rem", textAlign: "center", color: "#64748b" }}
                  >
                    No {topLeftLabel ? topLeftLabel.toLowerCase() : pageTitle.toLowerCase()} items found.
                  </td>
                </tr>
              ) : (
                tableItems.map((item, idx) => {
                  const optAllocs = optimisticAllocs[selectedYear]?.[item.rowNumber];
                  const origAllocs = optAllocs || item.allocations?.[selectedYear] || item.monthlyAllocations || [];
                  const currentAllocs = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;

                  const liveTotal = currentAllocs.reduce((sum, v) => sum + parseMoney(v), 0);

                  const delPct = isEditing
                    ? (editDeliveryPcts[item.rowNumber] ?? optimisticDeliveryPcts[item.rowNumber] ?? item.deliveryPct ?? "0%")
                    : (optimisticDeliveryPcts[item.rowNumber] || item.deliveryPct || "0%");

                  return (
                    <tr
                      key={item.rowNumber || idx}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                    >
                      {/* Line Item name */}
                      <td
                        style={{
                          padding: "6px 8px",
                          fontWeight: 600,
                          color: "#0f172a",
                          position: "sticky",
                          left: 0,
                          background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                          zIndex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "top",
                        }}
                        title={item.name}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {category === "contractors" && (
                            <button
                              type="button"
                              onClick={() => toggleRowExpand(item.rowNumber || idx)}
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                color: "#0047AB",
                                fontSize: "11px",
                                padding: "2px 4px",
                                lineHeight: 1,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: "4px",
                              }}
                              title={expandedRows.has(item.rowNumber || idx) ? "Collapse breakdown" : "Expand breakdown"}
                            >
                              {expandedRows.has(item.rowNumber || idx) ? "▼" : "▶"}
                            </button>
                          )}
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</span>
                        </div>
                      </td>

                      {/* Delivery % column for Dividends */}
                      {showDeliveryPct && (
                        <td
                          style={{
                            padding: "4px 6px",
                            textAlign: "center",
                            fontSize: "11px",
                            fontWeight: 500,
                            color: "#334155",
                            verticalAlign: "top",
                          }}
                        >
                          {isEditing ? (
                            <input
                              type="text"
                              value={delPct}
                              onChange={(e) => handleDeliveryPctChange(item.rowNumber, e.target.value)}
                              placeholder="e.g. 50%"
                              style={{ ...inlineInputStyle, textAlign: "center" }}
                            />
                          ) : (
                            delPct
                          )}
                        </td>
                      )}

                      {/* 12 monthly columns */}
                      {monthHeaders.map((mLabel, mIdx) => {
                        const isRowExpanded = category === "contractors" && expandedRows.has(item.rowNumber || idx);
                        const isCellLocked = category === "expenses"
                          ? Boolean(outgoingsData?.reconciledMonths?.[selectedYear]?.[mIdx])
                          : category === "contractors"
                            ? Boolean(item.lockedCells?.[selectedYear]?.[mIdx])
                            : false;

                        const rawCell = currentAllocs[mIdx] !== undefined ? currentAllocs[mIdx] : `${currencySymbol}0`;
                        const val = (isEditing && typeof rawCell === "string" && rawCell.includes("£") && currencySymbol !== "£")
                          ? formatMoney(parseMoney(rawCell, thousandsSeparator), 0, currencySymbol, thousandsSeparator)
                          : rawCell;

                        const lockTooltip = category === "expenses"
                          ? "This month contains actuals and is locked"
                          : "Synced from accounting software. Only cells exclusively made up of placeholders can be edited.";

                        if (category === "contractors" && isRowExpanded) {
                          const monthBlocks = item.monthlyBlocks?.[selectedYear]?.[mIdx] || [];
                          const colLetter = getContractorColLetter(selectedYear, mIdx);

                          return (
                            <td
                              key={mIdx}
                              style={{
                                padding: "6px 4px",
                                verticalAlign: "top",
                                textAlign: "right",
                                fontSize: "11px",
                                background: isCellLocked ? "#f8fafc" : "#ffffff",
                                borderRight: "1px solid #f1f5f9",
                              }}
                            >
                              {/* Cell Total at top */}
                              <div style={{ fontWeight: 700, fontSize: "11px", color: "#0047AB", marginBottom: "4px" }}>
                                {formatGBP(val)}
                              </div>

                              {/* Breakdown of items */}
                              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                {monthBlocks.map((b, bIdx) => {
                                  const status = b.status || (isPlaceholderExpense(b.appId, b.description, b.status) ? "Placeholder" : "Received");
                                  const statusDisplay = String(status).toLowerCase() === "placeholder" ? "Placeh." : status;
                                  const statusStyle = getContractorStatusPill(status);
                                  return (
                                    <div
                                      key={b.appId || bIdx}
                                      onClick={() => {
                                        setContractorModalConfig({
                                          item: b,
                                          contractor: item,
                                          colLetter,
                                          monthLabel: mLabel,
                                          allBlocks: monthBlocks,
                                          selectedYear,
                                          mIdx,
                                        });
                                      }}
                                      title={`Click to edit · ${b.description || "Expense"} · ${status}`}
                                      style={{
                                        padding: "2px 5px",
                                        borderRadius: "4px",
                                        background: statusStyle.background,
                                        color: statusStyle.color,
                                        border: statusStyle.border,
                                        fontSize: "10px",
                                        cursor: "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: "4px",
                                        textAlign: "left",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                      }}
                                    >
                                      <span style={{ fontWeight: 600 }}>{formatGBP(b.amount)}</span>
                                      <span style={{ fontSize: "9px", opacity: 0.9 }}>{statusDisplay}</span>
                                    </div>
                                  );
                                })}

                                {/* Add amount / item button */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setContractorModalConfig({
                                      item: null,
                                      contractor: item,
                                      colLetter,
                                      monthLabel: mLabel,
                                      allBlocks: monthBlocks,
                                      selectedYear,
                                      mIdx,
                                    });
                                  }}
                                  title={`Add expense for ${item.name} (${mLabel})`}
                                  style={{
                                    marginTop: "2px",
                                    padding: "2px 4px",
                                    background: "#ffffff",
                                    border: "1px dashed #cbd5e1",
                                    borderRadius: "4px",
                                    color: "#0047AB",
                                    fontSize: "10px",
                                    fontWeight: 700,
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "2px",
                                    width: "100%",
                                    boxSizing: "border-box",
                                  }}
                                >
                                  <span>+</span>
                                </button>
                              </div>
                            </td>
                          );
                        }

                        if (category === "contractors") {
                          // Unexpanded contractor cell: clicking on amount expands the row!
                          return (
                            <td
                              key={mIdx}
                              onClick={() => toggleRowExpand(item.rowNumber || idx)}
                              style={{
                                padding: "4px 4px",
                                textAlign: "right",
                                fontSize: "11px",
                                background: isCellLocked ? "#f8fafc" : "transparent",
                                color: "#0f172a",
                                cursor: "pointer",
                                verticalAlign: "top",
                              }}
                              title="Click to view item breakdown"
                            >
                              {formatGBP(val)}
                            </td>
                          );
                        }

                        return (
                          <td
                            key={mIdx}
                            style={{
                              padding: "4px 4px",
                              textAlign: "right",
                              fontSize: "11px",
                              background: isCellLocked ? "#f8fafc" : "transparent",
                              color: isCellLocked ? "#64748b" : "#0f172a",
                              cursor: isCellLocked ? "not-allowed" : "default",
                              verticalAlign: "top",
                            }}
                            title={isCellLocked ? lockTooltip : undefined}
                          >
                            {isEditing && !isCellLocked ? (
                              <input
                                type="text"
                                value={val}
                                onChange={(e) => handleCellChange(item.rowNumber, mIdx, e.target.value)}
                                style={inlineInputStyle}
                              />
                            ) : (
                              formatGBP(val)
                            )}
                          </td>
                        );
                      })}

                      {/* Row Total */}
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          fontWeight: 700,
                          color: "#0047AB",
                          fontSize: "11.5px",
                          background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                          verticalAlign: "top",
                        }}
                      >
                        {formatGBP(liveTotal)}
                      </td>
                    </tr>
                  );
                })
              )}

              {/* Total Row */}
              {showTotalRow && tableItems.length > 0 && (
                <tr
                  style={{
                    background: "#f8fafc",
                    borderTop: "2px solid #cbd5e1",
                    fontWeight: 700,
                  }}
                >
                  <td
                    style={{
                      padding: "8px 8px",
                      position: "sticky",
                      left: 0,
                      background: "#f8fafc",
                      zIndex: 1,
                      color: "#0047AB",
                      fontWeight: 800,
                      fontSize: "11.5px",
                    }}
                  >
                    Total
                  </td>

                  {showDeliveryPct && <td></td>}

                  {monthHeaders.map((_, mIdx) => {
                    const colTotal = tableItems.reduce((sum, item) => {
                      const optAllocs = optimisticAllocs[selectedYear]?.[item.rowNumber];
                      const origAllocs = optAllocs || item.allocations?.[selectedYear] || item.monthlyAllocations || [];
                      const val = isEditing ? (editValues[item.rowNumber]?.[mIdx] ?? origAllocs[mIdx]) : origAllocs[mIdx];
                      return sum + parseMoney(val);
                    }, 0);

                    return (
                      <td
                        key={mIdx}
                        style={{
                          padding: "8px 4px",
                          textAlign: "right",
                          color: "#0047AB",
                          fontWeight: 700,
                          fontSize: "11px",
                        }}
                      >
                        {formatGBP(colTotal)}
                      </td>
                    );
                  })}

                  <td
                    style={{
                      padding: "8px 8px",
                      textAlign: "right",
                      color: "#0047AB",
                      fontWeight: 800,
                      fontSize: "11.5px",
                      background: "#f8fafc",
                    }}
                  >
                    {formatGBP(grandTotal)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

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
            {pageTitle}
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
            {fyLabels[selectedYear]}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {category === "contractors" && !isReadOnly && (
            <button
              type="button"
              onClick={() => setShowAddContractorModal(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                background: "#ffffff",
                border: "1px solid #0047AB",
                color: "#0047AB",
                padding: "5px 12px",
                borderRadius: "6px",
                fontSize: "12.5px",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(0, 71, 171, 0.08)",
              }}
            >
              <span style={{ fontSize: "15px", lineHeight: "1", fontWeight: 700 }}>+</span>
              <span>Add new contractor</span>
            </button>
          )}

          {category !== "contractors" && isEditing && (
            <>
              {category === "expenses" && (
                <button
                  type="button"
                  onClick={() => setShowAddExpenseModal(true)}
                  disabled={isSaving}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "#ffffff",
                    border: "1px solid #0047AB",
                    color: "#0047AB",
                    padding: "5px 12px",
                    borderRadius: "6px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0, 71, 171, 0.08)",
                  }}
                >
                  <span style={{ fontSize: "15px", lineHeight: "1", fontWeight: 700 }}>+</span>
                  <span>Add new expense</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleCancelEdit}
                disabled={isSaving}
                style={{
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  color: "#475569",
                  padding: "5px 12px",
                  borderRadius: "6px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleSaveData}
                disabled={isSaving}
                style={{
                  background: "#16a34a",
                  border: "none",
                  color: "#ffffff",
                  padding: "5px 16px",
                  borderRadius: "6px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  cursor: isSaving ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {isSaving ? <Spinner size={14} color="#ffffff" /> : <span>✓</span>}
                <span>{isSaving ? "Saving..." : "Save"}</span>
              </button>
            </>
          )}

          {category !== "contractors" && !isEditing && !isReadOnly && (
            <button
              type="button"
              onClick={handleStartEdit}
              title={`Edit ${pageTitle.toLowerCase()}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                padding: "5px 12px",
                fontSize: "12.5px",
                fontWeight: 600,
                color: "#0047AB",
                cursor: "pointer",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              <span>Edit</span>
            </button>
          )}

          <button
            type="button"
            className="refresh-btn no-click-spinner"
            onClick={onRefresh}
            disabled={isLoading || isSaving}
            title="Refresh data"
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
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: isLoading ? "spin 1s linear infinite" : "none",
              }}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
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

      {saveError && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "6px",
            padding: "0.6rem 0.85rem",
            color: "#991b1b",
            fontSize: "12px",
          }}
        >
          {saveError}
        </div>
      )}

      {/* Main Table(s) with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        {selectedYear > 1 && (
          <button
            type="button"
            className="fy-nav-arrow-left"
            onClick={() => {
              setSelectedYear((prev) => Math.max(1, prev - 1));
              setIsEditing(false);
            }}
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

        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", width: "100%" }}>
          {category === "expenses" ? (
            <>
              {/* Delivery expenses table */}
              {renderTableSection(deliveryExpenses, "Delivery expenses", true, false)}

              {/* Non-delivery expenses table */}
              {renderTableSection(nonDeliveryExpenses, "Non-delivery expenses", true, false)}
            </>
          ) : category === "contractors" ? (
            renderTableSection(itemsList, "Contractors", true, false)
          ) : (
            // Dividends
            renderTableSection(itemsList, "Dividends", false, true)
          )}
        </div>

        {selectedYear < 3 && (
          <button
            type="button"
            className="fy-nav-arrow-right"
            onClick={() => {
              setSelectedYear((prev) => Math.min(3, prev + 1));
              setIsEditing(false);
            }}
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

      {/* Add Contractor Modal */}
      {showAddContractorModal && (
        <AddContractorModal
          clientSheetId={clientSheetId}
          clientName={clientName}
          onClose={() => setShowAddContractorModal(false)}
          onSuccess={handleContractorCreated}
        />
      )}

      {/* Add Expense Modal */}
      {showAddExpenseModal && (
        <AddExpenseModal
          clientSheetId={clientSheetId}
          clientName={clientName}
          onClose={() => setShowAddExpenseModal(false)}
          onSuccess={handleExpenseCreated}
        />
      )}

      {/* Contractor Expense Modal */}
      {contractorModalConfig && (
        <ContractorExpenseModal
          isOpen={true}
          item={contractorModalConfig.item}
          contractor={contractorModalConfig.contractor}
          colLetter={contractorModalConfig.colLetter}
          monthLabel={contractorModalConfig.monthLabel}
          allBlocks={contractorModalConfig.allBlocks}
          clientSheetId={clientSheetId}
          clientName={clientName}
          onClose={() => setContractorModalConfig(null)}
          onSaveSuccess={(updatedBlocks) => {
            const { contractor, selectedYear: sYr, mIdx } = contractorModalConfig;
            if (contractor) {
              if (!contractor.monthlyBlocks) {
                contractor.monthlyBlocks = { 1: Array.from({ length: 12 }, () => []), 2: Array.from({ length: 12 }, () => []), 3: Array.from({ length: 12 }, () => []) };
              }
              if (!contractor.monthlyBlocks[sYr]) {
                contractor.monthlyBlocks[sYr] = Array.from({ length: 12 }, () => []);
              }
              contractor.monthlyBlocks[sYr][mIdx] = updatedBlocks;

              const newTotal = updatedBlocks.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
              const formattedVal = formatGBP(newTotal);

              setOptimisticAllocs((prev) => {
                const yrAllocs = prev[sYr] || {};
                const curRowAllocs = [...(yrAllocs[contractor.rowNumber] || contractor.allocations?.[sYr] || contractor.monthlyAllocations || [])];
                curRowAllocs[mIdx] = formattedVal;
                return {
                  ...prev,
                  [sYr]: {
                    ...yrAllocs,
                    [contractor.rowNumber]: curRowAllocs,
                  },
                };
              });
            }
            if (onRefresh) onRefresh();
          }}
        />
      )}

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
        }
      `}</style>
    </div>
  );
}

const inlineInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "2px 4px",
  borderRadius: "4px",
  border: "1px solid #94a3b8",
  fontSize: "11px",
  textAlign: "right",
  background: "#ffffff",
  color: "#0f172a",
};
