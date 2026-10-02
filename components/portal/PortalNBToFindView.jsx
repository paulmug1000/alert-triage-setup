import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function PortalNBToFindView({
  clientName,
  clientSheetId,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [selectedYear, setSelectedYear] = useState(2); // Year 2 typically has targets
  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState([]); // 12 monthly targets
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const nbData = data?.nbtofind;

  const monthHeaders = useMemo(() => {
    return nbData?.headers?.[selectedYear] || nbData?.headers?.[1] || [];
  }, [nbData, selectedYear]);

  const monthlyAllocations = useMemo(() => {
    return nbData?.allocations?.[selectedYear] || nbData?.monthlyAllocations || [];
  }, [nbData, selectedYear]);

  const currentAllocations = isEditing ? editValues : monthlyAllocations;

  const numAllocations = useMemo(() => {
    return currentAllocations.map((v) => parseFloat(String(v).replace(/[£,]/g, "")) || 0);
  }, [currentAllocations]);

  const totalTarget = useMemo(() => {
    return numAllocations.reduce((acc, v) => acc + v, 0);
  }, [numAllocations]);

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "") return "£0";
    if (typeof val === "number") {
      return (val < 0 ? "-" : "") + "£" + Math.abs(Math.round(val)).toLocaleString("en-GB");
    }
    const num = parseFloat(String(val).replace(/[£,]/g, ""));
    return isNaN(num) ? String(val) : (num < 0 ? "-" : "") + "£" + Math.abs(Math.round(num)).toLocaleString("en-GB");
  };

  const handleStartEdit = () => {
    setEditValues(monthlyAllocations.slice(0, 12));
    setIsEditing(true);
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditValues([]);
    setSaveError(null);
  };

  const handleCellChange = (mIdx, val) => {
    setEditValues((prev) => {
      const copy = [...prev];
      copy[mIdx] = val;
      return copy;
    });
  };

  const handleSaveData = async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      const colRange = selectedYear === 1 ? "G:R" : selectedYear === 2 ? "V:AG" : "AK:AV";
      const [startCol, endCol] = colRange.split(":");

      // NB target row in NBtoFind sheet is row 2
      const updates = [
        {
          range: `NBtoFind!${startCol}2:${endCol}2`,
          values: [editValues],
        },
      ];

      const res = await fetch("/api/portal/save-table-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          sheetName: "NBtoFind",
          updates,
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to save new business targets");
      }

      setIsEditing(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Save NB targets error:", err);
      setSaveError(err.message || "An error occurred while saving.");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !nbData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading New Business targets for {clientName}...
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
              borderRadius: "10px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            Year {selectedYear} Target: {formatGBP(totalTarget)}
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
              <option value={1}>Year 1</option>
              <option value={2}>Year 2</option>
              <option value={3}>Year 3</option>
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
              title="Edit new business targets"
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

      {/* Target Breakdown Table (Fitting desktop width) */}
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
                  Metric / Target
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
                  Total Target
                </th>
              </tr>
            </thead>

            <tbody>
              <tr style={{ background: "#ffffff", borderBottom: "1px solid #f1f5f9" }}>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 700,
                    color: "#0f172a",
                    position: "sticky",
                    left: 0,
                    background: "#ffffff",
                    zIndex: 1,
                  }}
                >
                  New Business to Find
                </td>

                {monthHeaders.map((_, mIdx) => {
                  const val = currentAllocations[mIdx] || "£0";

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
                          onChange={(e) => handleCellChange(mIdx, e.target.value)}
                          style={inlineInputStyle}
                        />
                      ) : (
                        formatGBP(val)
                      )}
                    </td>
                  );
                })}

                <td
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    fontWeight: 800,
                    color: "#0047AB",
                    fontSize: "12px",
                    background: "rgba(0, 71, 171, 0.04)",
                  }}
                >
                  {formatGBP(totalTarget)}
                </td>
              </tr>
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
