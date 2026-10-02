import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function PortalSalariesView({
  clientName,
  clientSheetId,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [searchTerm, setSearchTerm] = useState("");

  const salariesData = data?.salaries;

  // 9-column headers from sheet or standard defaults
  const headers = useMemo(() => {
    if (salariesData?.headers && salariesData.headers.length >= 8) {
      return salariesData.headers.slice(0, 9);
    }
    return [
      "Name",
      "Role",
      "FTE Salary",
      "FTE",
      "Start Date",
      "End Date",
      "Delivery %",
      "Pension %",
      "Notes",
    ];
  }, [salariesData]);

  // Rows from rawRows or mapped from staff
  const rows = useMemo(() => {
    if (salariesData?.rawRows && salariesData.rawRows.length > 1) {
      // First row is headers, remaining rows are data
      return salariesData.rawRows.slice(1).filter((r) => {
        const name = String(r[0] || "").trim();
        return name && name.toLowerCase() !== "hide";
      });
    }

    // Fallback if rawRows not yet populated
    if (salariesData?.staff && salariesData.staff.length > 0) {
      return salariesData.staff.map((s) => [
        s.name,
        s.role,
        s.fteSalary,
        s.fte,
        s.startDate,
        s.endDate,
        s.deliveryPct,
        s.pensionPct,
        "",
      ]);
    }

    return [];
  }, [salariesData]);

  // Filter rows by search term
  const filteredRows = useMemo(() => {
    if (!searchTerm.trim()) return rows;
    const q = searchTerm.toLowerCase().trim();
    return rows.filter((r) =>
      r.some((cell) => String(cell || "").toLowerCase().includes(q))
    );
  }, [rows, searchTerm]);

  if (isLoading && !salariesData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading Salaries for {clientName}...
        </p>
      </div>
    );
  }

  if (error && !salariesData) {
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
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load salaries data</h4>
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

  // Column width configuration for the 9 columns
  const colWidths = ["20%", "18%", "11%", "7%", "10%", "10%", "8%", "8%", "8%"];

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
            Salaries
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
            {rows.length} staff
          </span>
        </div>

        {/* Search & Refresh */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="text"
            placeholder="Search salaries..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              width: "180px",
            }}
          />

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

      {/* Main Sheet Table matching original WebApp */}
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
                {headers.map((h, idx) => {
                  const isFirstCol = idx === 0;
                  const isRight = idx === 2 || idx === 3 || idx === 6 || idx === 7;
                  return (
                    <th
                      key={idx}
                      style={{
                        padding: "7px 8px",
                        textAlign: isRight ? "right" : "left",
                        fontWeight: 700,
                        fontSize: "11.5px",
                        width: colWidths[idx] || "10%",
                        position: isFirstCol ? "sticky" : "static",
                        left: isFirstCol ? 0 : "auto",
                        background: "#0047AB",
                        zIndex: isFirstCol ? 2 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
                    No staff records found.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row, rIdx) => {
                  return (
                    <tr
                      key={rIdx}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: rIdx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                    >
                      {headers.map((_, cIdx) => {
                        const cellVal = row[cIdx] !== undefined ? String(row[cIdx]) : "";
                        const isFirstCol = cIdx === 0;
                        const isRight = cIdx === 2 || cIdx === 3 || cIdx === 6 || cIdx === 7;

                        return (
                          <td
                            key={cIdx}
                            style={{
                              padding: "6px 8px",
                              textAlign: isRight ? "right" : "left",
                              color: isFirstCol ? "#0f172a" : "#334155",
                              fontWeight: isFirstCol ? 600 : 400,
                              fontSize: "12px",
                              position: isFirstCol ? "sticky" : "static",
                              left: isFirstCol ? 0 : "auto",
                              background: isFirstCol
                                ? rIdx % 2 === 0
                                  ? "#ffffff"
                                  : "#fbfcfe"
                                : "transparent",
                              zIndex: isFirstCol ? 1 : 0,
                              borderRight: isFirstCol ? "1px solid #e2e8f0" : "none",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {cellVal}
                          </td>
                        );
                      })}
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
