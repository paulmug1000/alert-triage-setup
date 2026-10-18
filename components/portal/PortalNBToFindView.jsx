import React, { useState, useEffect, useMemo } from "react";
import Spinner from "../Spinner";
import { formatMoney, parseMoney } from "../../services/deepDiveHelper";
import { downloadCsv } from "../../utils/helpers";

export default function PortalNBToFindView({
  clientName,
  clientSheetId,
  data,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isReadOnly = true,
}) {
  const nbData = data?.nbtofind;
  const [selectedYear, setSelectedYear] = useState(nbData?.currentYear || 2);

  useEffect(() => {
    if (nbData?.currentYear) {
      setSelectedYear(nbData.currentYear);
    }
  }, [nbData?.currentYear]);

  const mode = nbData?.mode || data?.mode || data?.outgoingsMeta?.mode || "Revenue";
  const isRevenueMode = String(mode).toLowerCase() === "revenue";
  const modeTermLower = isRevenueMode ? "revenue" : "income";

  const fyLabels = useMemo(() => {
    if (data?.outgoings?.fyLabels) return data.outgoings.fyLabels;
    const getFy = (yr) => {
      const hdrs = nbData?.headers?.[yr] || [];
      const last = hdrs[hdrs.length - 1] || hdrs[0];
      const m = String(last).match(/(\d{2,4})/);
      return m ? `FY${m[1].slice(-2)}` : `FY${25 + yr}`;
    };
    return { 1: getFy(1), 2: getFy(2), 3: getFy(3) };
  }, [data, nbData]);

  const monthHeaders = useMemo(() => {
    return nbData?.headers?.[selectedYear] || nbData?.headers?.[1] || [];
  }, [nbData, selectedYear]);

  // Row 18: "New business to find" figures from NBtoFind tab
  const monthlyAllocations = useMemo(() => {
    return nbData?.allocations?.[selectedYear] || nbData?.monthlyAllocations || [];
  }, [nbData, selectedYear]);

  const numAllocations = useMemo(() => {
    return monthlyAllocations.map((v) => parseMoney(v));
  }, [monthlyAllocations]);

  const totalTarget = useMemo(() => {
    return numAllocations.reduce((acc, v) => acc + v, 0);
  }, [numAllocations]);

  // Row 23: "NB to find direct costs" figures from NBtoFind tab (only in Revenue mode)
  const monthlyDirectCosts = useMemo(() => {
    return nbData?.directCosts?.[selectedYear] || nbData?.monthlyDirectCosts || [];
  }, [nbData, selectedYear]);

  const numDirectCosts = useMemo(() => {
    return monthlyDirectCosts.map((v) => parseMoney(v));
  }, [monthlyDirectCosts]);

  const totalDirectCosts = useMemo(() => {
    return numDirectCosts.reduce((acc, v) => acc + v, 0);
  }, [numDirectCosts]);

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

  const handleDownloadCSV = () => {
    if (!monthlyAllocations) return;
    const dateStr = new Date().toISOString().split("T")[0];

    const header = ["", ...(monthHeaders || []), "Total target"];
    const rows = [
      [
        `New business to find ${modeTermLower}`,
        ...monthHeaders.map((_, mIdx) => monthlyAllocations[mIdx] || `${currencySymbol}0`),
        formatGBP(totalTarget),
      ],
    ];

    if (isRevenueMode && monthlyDirectCosts.length > 0) {
      rows.push([
        "NB to find direct costs",
        ...monthHeaders.map((_, mIdx) => monthlyDirectCosts[mIdx] || `${currencySymbol}0`),
        formatGBP(totalDirectCosts),
      ]);
    }

    downloadCsv(`Pulse_NB_To_Find_Year_${selectedYear}_${dateStr}.csv`, [header, ...rows]);
  };

  if (isLoading && !nbData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Please wait - loading
        </p>
      </div>
    );
  }

  if (error && !nbData) {
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
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load new business data</h4>
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
            New business to find
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

        {/* Controls (Non-editable view: Refresh and Download CSV) */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
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

      {/* Target Breakdown Table with Navigation Arrows */}
      <div style={{ position: "relative", width: "100%", display: "flex", alignItems: "center" }}>
        {selectedYear > 1 && (
          <button
            type="button"
            className="fy-nav-arrow-left"
            onClick={() => setSelectedYear((prev) => Math.max(1, prev - 1))}
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
                minWidth: "860px",
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
                      width: "18.8%",
                      position: "sticky",
                      left: 0,
                      background: "#0047AB",
                      zIndex: 2,
                    }}
                  />
                  {monthHeaders.map((m, idx) => (
                    <th
                      key={idx}
                      style={{
                        padding: "6px 4px",
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: "11px",
                        width: "6.1%",
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
                      width: "8.0%",
                      background: "#0047AB",
                    }}
                  >
                    Total target
                  </th>
                </tr>
              </thead>

              <tbody>
                {/* Row 18: New Business to Find */}
                <tr style={{ background: "#ffffff", borderBottom: isRevenueMode ? "1px solid #e2e8f0" : "none" }}>
                  <td
                    style={{
                      padding: "8px 8px",
                      fontWeight: 700,
                      color: "#0f172a",
                      position: "sticky",
                      left: 0,
                      background: "#ffffff",
                      zIndex: 1,
                    }}
                  >
                    New business to find {modeTermLower}
                  </td>

                  {monthHeaders.map((_, mIdx) => {
                    const val = monthlyAllocations[mIdx] !== undefined ? monthlyAllocations[mIdx] : `${currencySymbol}0`;
                    return (
                      <td
                        key={mIdx}
                        style={{
                          padding: "8px 4px",
                          textAlign: "right",
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "#1e293b",
                        }}
                      >
                        {formatGBP(val)}
                      </td>
                    );
                  })}

                  <td
                    style={{
                      padding: "8px 8px",
                      textAlign: "right",
                      fontWeight: 800,
                      color: "#0047AB",
                      fontSize: "12px",
                      background: "#ffffff",
                    }}
                  >
                    {formatGBP(totalTarget)}
                  </td>
                </tr>

                {/* Row 23: NB to Find Direct Costs (Shown in Revenue mode only) */}
                {isRevenueMode && (
                  <tr style={{ background: "#f8fafc" }}>
                    <td
                      style={{
                        padding: "8px 8px",
                        fontWeight: 700,
                        color: "#991b1b",
                        position: "sticky",
                        left: 0,
                        background: "#f8fafc",
                        zIndex: 1,
                      }}
                    >
                      NB to find direct costs
                    </td>

                    {monthHeaders.map((_, mIdx) => {
                      const val = monthlyDirectCosts[mIdx] !== undefined ? monthlyDirectCosts[mIdx] : `${currencySymbol}0`;
                      return (
                        <td
                          key={mIdx}
                          style={{
                            padding: "8px 4px",
                            textAlign: "right",
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "#991b1b",
                          }}
                        >
                          {formatGBP(val)}
                        </td>
                      );
                    })}

                    <td
                      style={{
                        padding: "8px 8px",
                        textAlign: "right",
                        fontWeight: 800,
                        color: "#991b1b",
                        fontSize: "12px",
                        background: "#f8fafc",
                      }}
                    >
                      {formatGBP(totalDirectCosts)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selectedYear < 3 && (
          <button
            type="button"
            className="fy-nav-arrow-right"
            onClick={() => setSelectedYear((prev) => Math.min(3, prev + 1))}
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
