import React, { useState, useMemo, useEffect } from "react";
import Spinner from "../Spinner";
import { formatMoney, parseMoney } from "../../services/deepDiveHelper";
import { downloadCsv } from "../../utils/helpers";

/**
 * Robust date parser to determine if an employee's end date is earlier than today
 */
function isFormerEmployee(endDateVal) {
  if (!endDateVal && endDateVal !== 0) return false;
  const str = String(endDateVal).trim();
  if (!str || str === "-" || str.toLowerCase() === "n/a") return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check if numeric serial number (e.g. 45869)
  const num = Number(str);
  if (!isNaN(num) && num > 30000 && num < 100000 && !str.includes("-") && !str.includes("/")) {
    const d = new Date((num - 25569) * 86400 * 1000);
    return d < today;
  }

  // Check UK format DD/MM/YYYY or DD-MM-YYYY
  const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (ukMatch) {
    let year = parseInt(ukMatch[3], 10);
    if (year < 100) year += (year <= 69 ? 2000 : 1900);
    const month = parseInt(ukMatch[2], 10) - 1;
    const day = parseInt(ukMatch[1], 10);
    const d = new Date(year, month, day);
    return d < today;
  }

  // Check DD-Mon-YYYY or DD Mon YYYY or d-Mmm-yy (e.g. 31-Jul-2025, 31 Jul 2025, 31-Jul-25)
  const shortUk = str.match(/^(\d{1,2})[\-\/\s]([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
  if (shortUk) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const m = months[shortUk[2].toLowerCase()];
    let yr = parseInt(shortUk[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    if (m !== undefined) {
      const d = new Date(yr, m, parseInt(shortUk[1], 10));
      return d < today;
    }
  }

  // Check Mon YYYY or Mon-YY (e.g. Jul 2025, Jul-25) -> compare to end of that month
  const monYr = str.match(/^([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
  if (monYr) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const m = months[monYr[1].toLowerCase()];
    let yr = parseInt(monYr[2], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    if (m !== undefined) {
      const d = new Date(yr, m + 1, 0, 23, 59, 59);
      return d < today;
    }
  }

  // Fallback
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed < today;
  }

  return false;
}

/**
 * Convert any date string / serial to YYYY-MM-DD for <input type="date">
 */
function toInputDateYMD(dateVal) {
  if (!dateVal && dateVal !== 0) return "";
  const str = String(dateVal).trim();
  if (!str || str === "-" || str.toLowerCase() === "n/a") return "";

  // Numeric serial number
  const num = Number(str);
  if (!isNaN(num) && num > 30000 && num < 100000 && !str.includes("-") && !str.includes("/")) {
    const d = new Date((num - 25569) * 86400 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Format DD/MM/YYYY or DD-MM-YYYY
  const ukMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (ukMatch) {
    let y = parseInt(ukMatch[3], 10);
    if (y < 100) y += (y <= 69 ? 2000 : 1900);
    const m = String(ukMatch[2]).padStart(2, "0");
    const day = String(ukMatch[1]).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Format d-Mmm-yy or d-Mmm-yyyy (e.g. 1-Jan-21 or 31-Jul-2025)
  const shortUk = str.match(/^(\d{1,2})[\-\/\s]([a-zA-Z]{3})[\-\/\s](\d{2,4})/);
  if (shortUk) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const mi = months[shortUk[2].toLowerCase()];
    let y = parseInt(shortUk[3], 10);
    if (y < 100) y += (y <= 69 ? 2000 : 1900);
    if (mi !== undefined) {
      const day = String(shortUk[1]).padStart(2, "0");
      return `${y}-${mi}-${day}`;
    }
  }

  // ISO YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return "";
}

/**
 * Format date to standard d-Mmm-yy (e.g. 1-Jan-21 or 31-Jul-25)
 */
function formatToDMmmYy(dateVal) {
  if (!dateVal && dateVal !== 0) return "";
  const ymd = toInputDateYMD(dateVal);
  if (!ymd) return String(dateVal).trim();
  const parts = ymd.split("-");
  if (parts.length !== 3) return String(dateVal).trim();
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthStr = months[m] || "Jan";
  const yy = String(y % 100).padStart(2, "0");
  return `${d}-${monthStr}-${yy}`;
}

/**
 * Helper to validate Del % (must be between 0 and 100)
 */
function isDelPctValid(val) {
  if (val === undefined || val === null || String(val).trim() === "") return true;
  const clean = String(val).replace(/%/g, "").trim();
  const num = Number(clean);
  return !isNaN(num) && num >= 0 && num <= 100;
}

export default function PortalSalariesView({
  clientName,
  clientSheetId,
  data,
  currencySymbol: propCurrencySymbol,
  thousandsSeparator: propThousandsSeparator,
  isLoading,
  error,
  onRefresh,
  isReadOnly = false,
}) {
  const salariesData = data?.salaries;

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

  // Toggle state to display former employees
  const [showFormer, setShowFormer] = useState(false);

  // Edit mode states
  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState({}); // { [sheetRow]: string[] (9 cols) }
  const [optimisticRows, setOptimisticRows] = useState({}); // { [sheetRow]: string[] }
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Clear optimistic changes on fresh server data
  useEffect(() => {
    setOptimisticRows({});
  }, [salariesData]);

  // Headers: 9 columns from sheet or standard defaults
  const headers = useMemo(() => {
    if (salariesData?.headers && salariesData.headers.length >= 8) {
      return salariesData.headers.slice(0, 9);
    }
    return [
      "Name",
      "Role",
      "FTE salary",
      "FTE",
      "Start date",
      "End date",
      "Del %",
      "St loan?",
      "Pens?",
    ];
  }, [salariesData]);

  // Parse all employees from rawRows with sheet row numbers
  const allEmployees = useMemo(() => {
    if (salariesData?.rawRows && salariesData.rawRows.length > 3) {
      const list = [];
      for (let idx = 3; idx < salariesData.rawRows.length; idx++) {
        const r = salariesData.rawRows[idx];
        if (!r) continue;
        const name = String(r[0] || "").trim();
        if (!name || name.toLowerCase() === "hide") continue;

        const sheetRow = idx + 1;
        const opt = optimisticRows[sheetRow];

        const rawSalary = opt ? opt[2] : r[2];
        const salaryNum = parseMoney(rawSalary, thousandsSeparator);
        const normalizedSalary = formatMoney(salaryNum, 0, currencySymbol, thousandsSeparator);

        const cells = [
          opt ? opt[0] : String(r[0] || "").trim(),
          opt ? opt[1] : String(r[1] || "").trim(),
          normalizedSalary,
          opt ? opt[3] : String(r[3] || "1.00").trim(),
          opt ? opt[4] : formatToDMmmYy(r[4]),
          opt ? opt[5] : formatToDMmmYy(r[5]),
          opt ? opt[6] : String(r[6] || "0%").trim(),
          opt ? opt[7] : String(r[7] || "No").trim(),
          opt ? opt[8] : String(r[8] || "No").trim(),
        ];

        const isFormer = isFormerEmployee(cells[5]);

        list.push({
          sheetRow,
          cells,
          isFormer,
        });
      }
      return list;
    }

    // Fallback if staff list available
    if (salariesData?.staff && salariesData.staff.length > 0) {
      return salariesData.staff.map((s, idx) => {
        const sheetRow = s.rowNumber || 4 + idx;
        const opt = optimisticRows[sheetRow];
        const salaryNum = typeof s.fteSalary === "number" ? s.fteSalary : parseMoney(s.fteSalary, thousandsSeparator);
        const normalizedSalary = formatMoney(salaryNum, 0, currencySymbol, thousandsSeparator);

        const cells = [
          opt ? opt[0] : s.name || "",
          opt ? opt[1] : s.role || "",
          opt ? opt[2] : normalizedSalary,
          opt ? opt[3] : s.fte || "1.00",
          opt ? opt[4] : formatToDMmmYy(s.startDate),
          opt ? opt[5] : formatToDMmmYy(s.endDate),
          opt ? opt[6] : s.deliveryPct || "0%",
          opt ? opt[7] : "No",
          opt ? opt[8] : s.pensionPct || "No",
        ];
        return {
          sheetRow,
          cells,
          isFormer: isFormerEmployee(cells[5]),
        };
      });
    }

    return [];
  }, [salariesData, optimisticRows, currencySymbol, thousandsSeparator]);

  // Counts
  const formerCount = useMemo(() => {
    return allEmployees.filter((e) => e.isFormer).length;
  }, [allEmployees]);

  // Filtered employees: when showFormer is true, list former employees at the bottom of the table
  const displayedEmployees = useMemo(() => {
    const current = allEmployees.filter((e) => !e.isFormer);
    if (!showFormer) return current;
    const former = allEmployees.filter((e) => e.isFormer);
    return [...current, ...former];
  }, [allEmployees, showFormer]);

  const handleStartEdit = () => {
    if (isReadOnly) return;
    const initial = {};
    allEmployees.forEach((emp) => {
      const copy = [...emp.cells];
      // Ensure FTE salary uses the correct currency symbol in edit mode
      const num = parseMoney(copy[2], thousandsSeparator);
      copy[2] = formatMoney(num, 0, currencySymbol, thousandsSeparator);
      // Ensure dates are formatted as d-Mmm-yy
      copy[4] = formatToDMmmYy(copy[4]);
      copy[5] = formatToDMmmYy(copy[5]);
      // Ensure St loan and Pension are Yes/No
      copy[7] = String(copy[7] || "").toLowerCase().startsWith("y") ? "Yes" : "No";
      copy[8] = String(copy[8] || "").toLowerCase().startsWith("y") ? "Yes" : "No";
      initial[emp.sheetRow] = copy;
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

  const handleCellChange = (sheetRow, colIdx, val) => {
    if (isReadOnly) return;
    setEditValues((prev) => {
      const current = prev[sheetRow] ? [...prev[sheetRow]] : new Array(9).fill("");
      current[colIdx] = val;
      return {
        ...prev,
        [sheetRow]: current,
      };
    });
  };

  const handleSaveData = async () => {
    if (isReadOnly) return;
    setIsSaving(true);
    setSaveError(null);

    try {
      // Validate all changed rows: Del % must be between 0 and 100
      for (const emp of allEmployees) {
        const edits = editValues[emp.sheetRow];
        if (edits) {
          const delVal = edits[6];
          if (!isDelPctValid(delVal)) {
            const empName = edits[0] || emp.cells[0] || "Employee";
            setIsSaving(false);
            setSaveError(`Delivery % must be between 0 and 100 for ${empName} (Row ${emp.sheetRow}).`);
            return;
          }
        }
      }

      const updates = [];

      allEmployees.forEach((emp) => {
        const edits = editValues[emp.sheetRow];
        if (!edits) return;

        // Normalize Del % to have % suffix
        const cleanDel = String(edits[6] || "").replace(/%/g, "").trim();
        const delNum = cleanDel === "" ? 0 : Number(cleanDel);
        const finalDel = `${delNum}%`;

        // Normalize dates to d-Mmm-yy
        const finalStart = edits[4] ? formatToDMmmYy(edits[4]) : "";
        const finalEnd = edits[5] ? formatToDMmmYy(edits[5]) : "";

        const preparedEdits = [
          edits[0] || "",
          edits[1] || "",
          edits[2] || "",
          edits[3] || "1.00",
          finalStart,
          finalEnd,
          finalDel,
          edits[7] === "Yes" ? "Yes" : "No",
          edits[8] === "Yes" ? "Yes" : "No",
        ];

        const hasChanged = preparedEdits.some(
          (v, idx) => String(v || "").trim() !== String(emp.cells[idx] || "").trim()
        );

        if (hasChanged) {
          updates.push({
            range: `Salaries!A${emp.sheetRow}:I${emp.sheetRow}`,
            values: [preparedEdits],
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
            sheetName: "Salaries",
            updates,
          }),
        });

        const resData = await res.json();
        if (!resData.success) {
          throw new Error(resData.error || "Failed to save salaries data");
        }

        // Optimistically update local state
        setOptimisticRows((prev) => ({
          ...prev,
          ...editValues,
        }));
      }

      setIsEditing(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Save salaries error:", err);
      setSaveError(err.message || "An error occurred while saving salaries.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadCSV = () => {
    if (!displayedEmployees || displayedEmployees.length === 0) return;
    const dateStr = new Date().toISOString().split("T")[0];

    const header = headers || [];
    const rowsData = displayedEmployees.map((emp) => {
      const currentCells = isEditing ? editValues[emp.sheetRow] || emp.cells : emp.cells;
      return currentCells.map((c, cIdx) => {
        if (cIdx === 2) {
          const num = parseMoney(c, thousandsSeparator);
          return formatMoney(num, 0, currencySymbol, thousandsSeparator);
        }
        if (cIdx === 4 || cIdx === 5) {
          return formatToDMmmYy(c);
        }
        return String(c || "");
      });
    });

    downloadCsv(`Pulse_Salaries_${dateStr}.csv`, [header, ...rowsData]);
  };

  if (isLoading && !salariesData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Please wait - loading
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
  const colWidths = ["18%", "18%", "11%", "7%", "11%", "11%", "8%", "8%", "8%"];

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
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
            Salaries
          </h2>

          {/* Subtle option to Display Former Employees */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
              fontSize: "12px",
              fontWeight: 500,
              color: showFormer ? "#0047AB" : "#64748b",
              cursor: "pointer",
              userSelect: "none",
              padding: "4px 9px",
              borderRadius: "6px",
              background: showFormer ? "rgba(0, 71, 171, 0.06)" : "#f8fafc",
              border: `1px solid ${showFormer ? "rgba(0, 71, 171, 0.25)" : "#e2e8f0"}`,
              transition: "all 0.15s ease",
            }}
          >
            <input
              type="checkbox"
              checked={showFormer}
              onChange={(e) => setShowFormer(e.target.checked)}
              style={{ cursor: "pointer", accentColor: "#0047AB" }}
            />
            <span>Show former employees</span>
            {formerCount > 0 && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  background: showFormer ? "#0047AB" : "#94a3b8",
                  color: "#ffffff",
                  borderRadius: "10px",
                  padding: "1px 5px",
                }}
              >
                {formerCount}
              </span>
            )}
          </label>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
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
            !isReadOnly && (
              <button
                type="button"
                onClick={handleStartEdit}
                title="Edit salaries"
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
            )
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

      {/* Main Sheet Table */}
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
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                {headers.map((h, idx) => {
                  const isFirstCol = idx === 0;
                  const isRight = idx === 2 || idx === 3 || idx === 6 || idx === 7 || idx === 8;
                  const isCenter = idx === 4 || idx === 5 || idx === 7 || idx === 8;
                  return (
                    <th
                      key={idx}
                      style={{
                        padding: "7px 8px",
                        textAlign: isCenter ? "center" : isRight ? "right" : "left",
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
              {displayedEmployees.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
                    No staff records found.
                  </td>
                </tr>
              ) : (
                displayedEmployees.map((emp, rIdx) => {
                  const currentCells = isEditing ? editValues[emp.sheetRow] || emp.cells : emp.cells;
                  const isFormer = emp.isFormer;

                  return (
                    <tr
                      key={emp.sheetRow}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: isFormer
                          ? "#f8fafc"
                          : rIdx % 2 === 0
                          ? "#ffffff"
                          : "#fbfcfe",
                        opacity: isFormer && !isEditing ? 0.75 : 1,
                      }}
                    >
                      {headers.map((_, cIdx) => {
                        const cellVal = currentCells[cIdx] !== undefined ? currentCells[cIdx] : "";
                        const isFirstCol = cIdx === 0;
                        const isRight = cIdx === 2 || cIdx === 3 || cIdx === 6;
                        const isCenter = cIdx === 4 || cIdx === 5 || cIdx === 7 || cIdx === 8;

                        // Display formatting in view mode
                        let displayContent = cellVal;
                        if (!isEditing) {
                          if (cIdx === 2) {
                            const n = parseMoney(cellVal, thousandsSeparator);
                            displayContent = formatMoney(n, 0, currencySymbol, thousandsSeparator);
                          } else if (cIdx === 4 || cIdx === 5) {
                            displayContent = formatToDMmmYy(cellVal);
                          }
                        }

                        // Validation flag for Del % in edit mode
                        const isDelCol = cIdx === 6;
                        const delInvalid = isEditing && isDelCol && !isDelPctValid(cellVal);

                        return (
                          <td
                            key={cIdx}
                            style={{
                              padding: isEditing ? "3px 4px" : "6px 8px",
                              textAlign: isCenter ? "center" : isRight ? "right" : "left",
                              color: isFirstCol ? "#0f172a" : "#334155",
                              fontWeight: isFirstCol ? 600 : 400,
                              fontSize: "12px",
                              position: isFirstCol ? "sticky" : "static",
                              left: isFirstCol ? 0 : "auto",
                              background: isFirstCol
                                ? isFormer
                                  ? "#f8fafc"
                                  : rIdx % 2 === 0
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
                            {isEditing ? (
                              cIdx === 4 || cIdx === 5 ? (
                                // Start date & End date calendar selector (ensures valid dates chosen, formatted as d-Mmm-yy)
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", width: "100%" }}>
                                  <input
                                    type="date"
                                    value={toInputDateYMD(cellVal)}
                                    onChange={(e) => {
                                      const formatted = e.target.value ? formatToDMmmYy(e.target.value) : "";
                                      handleCellChange(emp.sheetRow, cIdx, formatted);
                                    }}
                                    title={cellVal ? formatToDMmmYy(cellVal) : "Select date"}
                                    style={{
                                      ...inlineInputStyle,
                                      padding: "2px 3px",
                                      fontSize: "11px",
                                      cursor: "pointer",
                                      textAlign: "center",
                                    }}
                                  />
                                  {cellVal ? (
                                    <span style={{ fontSize: "10px", color: "#475569", fontWeight: 600 }}>
                                      {formatToDMmmYy(cellVal)}
                                    </span>
                                  ) : null}
                                </div>
                              ) : cIdx === 7 || cIdx === 8 ? (
                                // St loan? & Pens? simple Yes/No drop-down boxes
                                <select
                                  value={String(cellVal || "").toLowerCase().startsWith("y") ? "Yes" : "No"}
                                  onChange={(e) => handleCellChange(emp.sheetRow, cIdx, e.target.value)}
                                  style={{
                                    ...inlineInputStyle,
                                    padding: "3px 4px",
                                    cursor: "pointer",
                                    textAlign: "center",
                                    background: "#ffffff",
                                  }}
                                >
                                  <option value="No">No</option>
                                  <option value="Yes">Yes</option>
                                </select>
                              ) : (
                                // Text/Currency/Number inputs
                                <input
                                  type="text"
                                  value={
                                    cIdx === 2 && typeof cellVal === "string" && cellVal.includes("£") && currencySymbol !== "£"
                                      ? formatMoney(parseMoney(cellVal, thousandsSeparator), 0, currencySymbol, thousandsSeparator)
                                      : cellVal
                                  }
                                  onChange={(e) => handleCellChange(emp.sheetRow, cIdx, e.target.value)}
                                  placeholder={isDelCol ? "e.g. 100%" : ""}
                                  style={{
                                    ...inlineInputStyle,
                                    textAlign: isCenter ? "center" : isRight ? "right" : "left",
                                    border: delInvalid ? "1.5px solid #ef4444" : "1px solid #94a3b8",
                                    background: delInvalid ? "#fef2f2" : "#ffffff",
                                  }}
                                  title={delInvalid ? "Delivery % must be between 0 and 100" : undefined}
                                />
                              )
                            ) : (
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  justifyContent: isCenter ? "center" : isRight ? "flex-end" : "flex-start",
                                }}
                              >
                                <span>{displayContent}</span>
                                {isFirstCol && isFormer && (
                                  <span
                                    style={{
                                      fontSize: "10px",
                                      fontWeight: 600,
                                      padding: "1px 5px",
                                      borderRadius: "4px",
                                      background: "#e2e8f0",
                                      color: "#64748b",
                                    }}
                                  >
                                    Former
                                  </span>
                                )}
                              </div>
                            )}
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

const inlineInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: "4px",
  border: "1px solid #94a3b8",
  fontSize: "11.5px",
  background: "#ffffff",
  color: "#0f172a",
  fontFamily: "inherit",
};
