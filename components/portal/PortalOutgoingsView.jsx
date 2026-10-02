import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function PortalOutgoingsView({
  clientName,
  clientSheetId,
  category = "contractors", // 'contractors' | 'expenses' | 'dividends'
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [selectedYear, setSelectedYear] = useState(1); // 1, 2, 3
  const [searchTerm, setSearchTerm] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState({}); // { [rowNumber]: string[] (12 months) }
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const outgoingsData = data?.outgoings;

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
    return list;
  }, [outgoingsData, category]);

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

  // Filtered by search
  const filteredItems = useMemo(() => {
    if (!itemsList) return [];
    if (!searchTerm.trim()) return itemsList;
    const q = searchTerm.toLowerCase().trim();
    return itemsList.filter((item) => (item.name || "").toLowerCase().includes(q));
  }, [itemsList, searchTerm]);

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "") return "£0";
    if (typeof val === "number") {
      return (val < 0 ? "-" : "") + "£" + Math.abs(Math.round(val)).toLocaleString("en-GB");
    }
    const num = parseFloat(String(val).replace(/[£,]/g, ""));
    return isNaN(num) ? String(val) : (num < 0 ? "-" : "") + "£" + Math.abs(Math.round(num)).toLocaleString("en-GB");
  };

  const handleStartEdit = () => {
    const initial = {};
    itemsList.forEach((item) => {
      const yearAlloc = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
      initial[item.rowNumber] = yearAlloc.slice(0, 12);
    });
    setEditValues(initial);
    setIsEditing(true);
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditValues({});
    setSaveError(null);
  };

  const handleCellChange = (rowNumber, mIdx, val) => {
    setEditValues((prev) => {
      const current = prev[rowNumber] ? [...prev[rowNumber]] : new Array(12).fill("£0");
      current[mIdx] = val;
      return {
        ...prev,
        [rowNumber]: current,
      };
    });
  };

  const handleSaveData = async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      const updates = [];
      const colRange = selectedYear === 1 ? "G:R" : selectedYear === 2 ? "V:AG" : "AK:AV";
      const [startCol, endCol] = colRange.split(":");

      itemsList.forEach((item) => {
        const edits = editValues[item.rowNumber];
        if (!edits) return;

        const origAlloc = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
        const hasChanged = edits.some((v, idx) => v !== origAlloc[idx]);

        if (hasChanged) {
          updates.push({
            range: `Outgoings!${startCol}${item.rowNumber}:${endCol}${item.rowNumber}`,
            values: [edits],
          });
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

  if (isLoading && !outgoingsData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading {pageTitle} for {clientName}...
        </p>
      </div>
    );
  }

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
              borderRadius: "10px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            {itemsList.length} items
          </span>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {/* Year selector */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>Year:</span>
            <select
              value={selectedYear}
              onChange={(e) => {
                setSelectedYear(parseInt(e.target.value, 10));
                setIsEditing(false);
              }}
              style={selectStyle}
            >
              <option value={1}>{fyLabels[1]} (Current)</option>
              <option value={2}>{fyLabels[2]}</option>
              <option value={3}>{fyLabels[3]}</option>
            </select>
          </div>

          {isEditing ? (
            <>
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
          ) : (
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
              <span>✏️</span>
              <span>Edit</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading || isSaving}
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

      {/* Search Input */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <input
          type="text"
          placeholder={`Search ${pageTitle.toLowerCase()}...`}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            padding: "4px 8px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            fontSize: "12px",
            width: "200px",
          }}
        />
      </div>

      {/* Main Table (Fitting desktop width) */}
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
                    width: "24%",
                    position: "sticky",
                    left: 0,
                    background: "#0047AB",
                    zIndex: 2,
                  }}
                >
                  {/* Empty top-left cell header */}
                </th>
                {monthHeaders.map((m, idx) => (
                  <th
                    key={idx}
                    style={{
                      padding: "6px 4px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "11px",
                      width: "5.5%",
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
                    width: "10%",
                    background: "#003380",
                  }}
                >
                  Total
                </th>
              </tr>
            </thead>

            <tbody>
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={14} style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
                    No {pageTitle.toLowerCase()} items found.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item, idx) => {
                  const origAllocs = item.allocations?.[selectedYear] || item.monthlyAllocations || [];
                  const currentAllocs = isEditing ? editValues[item.rowNumber] || origAllocs : origAllocs;

                  const liveTotal = currentAllocs.reduce((sum, v) => {
                    const n = parseFloat(String(v).replace(/[£,]/g, "")) || 0;
                    return sum + n;
                  }, 0);

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
                        }}
                        title={item.name}
                      >
                        {item.name}
                      </td>

                      {/* 12 monthly columns */}
                      {monthHeaders.map((_, mIdx) => {
                        const val = currentAllocs[mIdx] || "£0";

                        return (
                          <td
                            key={mIdx}
                            style={{
                              padding: "4px 4px",
                              textAlign: "right",
                              fontSize: "11px",
                            }}
                          >
                            {isEditing ? (
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
                          background: "rgba(0, 71, 171, 0.04)",
                        }}
                      >
                        {formatGBP(liveTotal)}
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
