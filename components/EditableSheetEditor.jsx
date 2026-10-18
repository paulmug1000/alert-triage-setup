import React, { useState, useEffect, useRef, useCallback } from "react";
import Spinner from "./Spinner";

function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function isBudgetCellEditable(sheetRow, colIdx) {
  const isMonthCol =
    (colIdx >= 6 && colIdx <= 17) ||
    (colIdx >= 21 && colIdx <= 32) ||
    (colIdx >= 36 && colIdx <= 47);

  // Rows 5-7: months
  if (sheetRow >= 5 && sheetRow <= 7) return isMonthCol;
  // Rows 13-15: months
  if (sheetRow >= 13 && sheetRow <= 15) return isMonthCol;
  // Employees: A59:E111
  if (sheetRow >= 59 && sheetRow <= 111) return colIdx >= 0 && colIdx <= 4;
  // Dividends: Row 119, Col E (4) + months
  if (sheetRow === 119) return colIdx === 4 || isMonthCol;
  // Contractors: Rows 127-140, Cols A (0) & E (4) + months
  if (sheetRow >= 127 && sheetRow <= 140) return colIdx === 0 || colIdx === 4 || isMonthCol;
  // Making up CoS: B142 (Col B = 1)
  if (sheetRow === 142) return colIdx === 1;
  // Other expenses: Rows 150-250, Cols A (0) & E (4) + months
  if (sheetRow >= 150 && sheetRow <= 250) return colIdx === 0 || colIdx === 4 || isMonthCol;

  return false;
}

function formatCurrency(val) {
  if (val === "" || val === null || val === undefined) return "";
  const str = String(val).trim();
  if (str === "-" || str === "£-") return "-";
  const clean = str.replace(/[£,\s]/g, "");
  if (!isNaN(clean) && clean !== "") {
    const num = Math.round(Number(clean));
    if (num < 0) {
      return `-£${Math.abs(num).toLocaleString("en-GB")}`;
    }
    return `£${num.toLocaleString("en-GB")}`;
  }
  return str;
}

export default function EditableSheetEditor({
  client,
  initialTab = "budget",
  onClose,
  isAdmin = true,
}) {
  const [activeTab] = useState("budget");
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [budgetFyIdx, setBudgetFyIdx] = useState(0);

  const cacheRef = useRef({});
  const clientKey = client?.clientSheetId || "";
  const masterKey = client?.masterSheetId || "";

  const fetchData = useCallback(async (tab = "budget", forceRefresh = false) => {
    if (!clientKey) return;

    if (!forceRefresh && cacheRef.current[clientKey] && cacheRef.current[clientKey][tab]) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_client_view_data",
          clientSheetId: clientKey,
          masterSheetId: masterKey,
          tab,
          bypassCache: forceRefresh,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCache((prev) => {
          const next = {
            ...prev,
            [clientKey]: {
              ...(prev[clientKey] || {}),
              [tab]: data,
            },
          };
          cacheRef.current = next;
          return next;
        });

        if (data.defaultFyIndex !== undefined) {
          setBudgetFyIdx(data.defaultFyIndex);
        }
      } else {
        setError(data.error || `Failed to load ${tab} data`);
      }
    } catch (err) {
      console.error(`fetchData [${tab}] error:`, err);
      setError(err.message || `Failed to load ${tab} data`);
    } finally {
      setLoading(false);
    }
  }, [clientKey, masterKey]);

  useEffect(() => {
    fetchData("budget");
  }, [fetchData]);

  const handleUpdateCell = async (tabName, sheetRow, colIdx, newValue) => {
    if (!client || !client.clientSheetId) return;
    const clientKey = client.clientSheetId;
    const colLetter = colIndexToLetter(colIdx + 1);

    let displayVal = newValue;
    if (colIdx >= 6 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (sheetRow >= 59 && sheetRow <= 111 && colIdx === 1 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if ((colIdx === 4 || (sheetRow === 142 && colIdx === 1)) && newValue !== "") {
      const clean = String(newValue).replace(/%/g, "").trim();
      const num = parseFloat(clean);
      if (!isNaN(num)) {
        displayVal = `${num}%`;
      }
    }

    setCache((prev) => {
      const clientData = prev[clientKey];
      if (!clientData || !clientData[tabName]) return prev;
      const tabData = clientData[tabName];

      const updatedTabData = { ...tabData };
      if (updatedTabData.matrix) {
        const newMatrix = [...updatedTabData.matrix];
        const rIdx = sheetRow - 1;
        if (newMatrix[rIdx]) {
          const newRow = [...newMatrix[rIdx]];
          newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
          newMatrix[rIdx] = newRow;
          updatedTabData.matrix = newMatrix;
        }
      }

      const next = {
        ...prev,
        [clientKey]: {
          ...clientData,
          [tabName]: updatedTabData,
        },
      };
      cacheRef.current = next;
      return next;
    });

    try {
      const currentTab = cacheRef.current[clientKey]?.[tabName] || cache[clientKey]?.[tabName];
      let rowDesc = "";
      if (currentTab?.matrix) {
        rowDesc = currentTab.matrix[sheetRow - 1]?.[0]?.v || "";
      }

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_view_cell",
          clientSheetId: clientKey,
          masterSheetId: masterKey,
          tab: "budget",
          screenTab: "budget",
          sheetRow,
          colLetter,
          colIdx,
          value: newValue,
          rowDescription: rowDesc,
          clientName: client.clientName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Failed to update cell (status ${res.status})`);
      }

      if (data.formattedValue !== undefined && data.formattedValue !== displayVal) {
        setCache((prev) => {
          const clientData = prev[clientKey];
          if (!clientData || !clientData[tabName]) return prev;
          const tabData = clientData[tabName];
          const updatedTabData = { ...tabData };

          if (updatedTabData.matrix) {
            const newMatrix = [...updatedTabData.matrix];
            const rIdx = sheetRow - 1;
            if (newMatrix[rIdx]) {
              const newRow = [...newMatrix[rIdx]];
              newRow[colIdx] = { ...(newRow[colIdx] || {}), v: data.formattedValue };
              newMatrix[rIdx] = newRow;
              updatedTabData.matrix = newMatrix;
            }
          }

          const next = {
            ...prev,
            [clientKey]: {
              ...clientData,
              [tabName]: updatedTabData,
            },
          };
          cacheRef.current = next;
          return next;
        });
      }
    } catch (err) {
      console.error("handleUpdateCell error:", err);
      alert(`Failed to save cell: ${err.message}`);
      fetchData("budget", true);
    }
  };

  const currentTabData = cache[clientKey]?.["budget"];

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.75)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "95vw",
          maxWidth: "1400px",
          height: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          overflow: "hidden",
        }}
      >
        {/* Top Header Bar */}
        <div
          style={{
            padding: "14px 20px",
            background: "#0f172a",
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #1e293b",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "16px", fontWeight: "700" }}>
              Budget Editor — {client?.clientName || "Client"}
            </span>
          </div>

          {/* Right Action Controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              onClick={() => fetchData("budget", true)}
              disabled={loading}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                background: "rgba(255, 255, 255, 0.1)",
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: "600",
                cursor: loading ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <span>🔄</span>
              <span>{loading ? "Refreshing..." : "Refresh"}</span>
            </button>

            {isAdmin && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${client.masterSheetId || client.clientSheetId}/edit`}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #166534",
                  background: "#15803d",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: "600",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                <span>📊</span>
                <span>Open in Sheets</span>
              </a>
            )}

            <button
              onClick={onClose}
              style={{
                background: "rgba(239, 68, 68, 0.2)",
                border: "1px solid rgba(239, 68, 68, 0.4)",
                color: "#fca5a5",
                borderRadius: "6px",
                padding: "6px 12px",
                fontSize: "13px",
                fontWeight: "700",
                cursor: "pointer",
              }}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Table Content Area */}
        <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", padding: "16px", background: "#ffffff" }}>
          {loading && !currentTabData ? (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <Spinner size={32} color="#0066cc" />
              <div style={{ marginTop: "14px", fontSize: "14px", color: "#64748b", fontWeight: "600" }}>
                Loading sheet table data...
              </div>
            </div>
          ) : error ? (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "16px", color: "#991b1b", fontSize: "14px" }}>
              <strong>Error:</strong> {error}
              <div style={{ marginTop: "10px" }}>
                <button
                  onClick={() => fetchData("budget", true)}
                  style={{ padding: "6px 14px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <BudgetTableView
              data={currentTabData}
              fyIdx={budgetFyIdx}
              onFyChange={setBudgetFyIdx}
              onUpdateCell={(sheetRow, colIdx, val) => handleUpdateCell("budget", sheetRow, colIdx, val)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET TABLE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function BudgetTableView({ data, fyIdx, onFyChange, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const committingRef = useRef(false);

  if (!data || !data.matrix || !data.fyConfigs) return null;

  const { matrix, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const THEME_HEADER_BG = "#1e1b4b";

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isBudgetCellEditable(sheetRow, colIdx);
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    let initialEditVal = cellValue ?? "";
    if (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6 || (sheetRow >= 59 && sheetRow <= 111 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType: "text",
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell((prev) => (prev ? { ...prev, editValue: val } : null)),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => {
          committingRef.current = false;
        }, 100);
        if (!cur && overrideVal === undefined) return;

        const rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
        setSavingKey(`${sheetRow}_${colIdx}`);
        try {
          await onUpdateCell(sheetRow, colIdx, rawVal);
        } finally {
          setSavingKey(null);
        }
      },
      onStartEdit: () => {
        setEditingCell({ sheetRow, colIdx, editValue: initialEditVal });
      },
      onCancelEdit: () => setEditingCell(null),
    };
  };

  const headerRow0 = matrix[0] || [];
  const headerRow1 = matrix[1] || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* FY Switcher */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
        <span style={{ fontSize: "13px", fontWeight: "700", color: "#334155" }}>Financial Year:</span>
        <button
          onClick={() => onFyChange(Math.max(0, fyIdx - 1))}
          disabled={fyIdx === 0}
          style={{ padding: "4px 10px", borderRadius: "4px", border: "1px solid #cbd5e1", background: fyIdx === 0 ? "#f1f5f9" : "#fff", cursor: fyIdx === 0 ? "not-allowed" : "pointer" }}
        >
          ◀
        </button>
        <span style={{ fontSize: "13px", fontWeight: "700", color: THEME_HEADER_BG, minWidth: "60px", textAlign: "center" }}>
          {currentFy.label}
        </span>
        <button
          onClick={() => onFyChange(Math.min(maxFyIdx, fyIdx + 1))}
          disabled={fyIdx === maxFyIdx}
          style={{ padding: "4px 10px", borderRadius: "4px", border: "1px solid #cbd5e1", background: fyIdx === maxFyIdx ? "#f1f5f9" : "#fff", cursor: fyIdx === maxFyIdx ? "not-allowed" : "pointer" }}
        >
          ▶
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", fontFamily: "monospace" }}>
          <thead>
            <tr style={{ background: THEME_HEADER_BG, color: "#ffffff" }}>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", width: "40px" }}>Row</th>
              <th style={{ padding: "8px 8px", border: "1px solid #312e81", textAlign: "left", minWidth: "220px" }}>
                {headerRow0?.[0]?.v || "Description"}
              </th>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "75px" }}>Type</th>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "50px" }}>VAT</th>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "50px" }}>Pay</th>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "55px" }}>Del</th>
              <th style={{ padding: "8px 6px", border: "1px solid #312e81", minWidth: "55px" }}>Likl</th>
              {fyCols.map((cIdx) => (
                <th key={cIdx} style={{ padding: "8px 8px", border: "1px solid #312e81", minWidth: "85px", textAlign: "right" }}>
                  {headerRow1?.[cIdx]?.v || headerRow0?.[cIdx]?.v || `M${cIdx}`}
                </th>
              ))}
              <th style={{ padding: "8px 8px", border: "1px solid #312e81", minWidth: "95px", textAlign: "right", background: "#312e81" }}>
                {headerRow0?.[totalCol]?.v || "FY Total"}
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.slice(2).map((row, rOffset) => {
              const sheetRow = 3 + rOffset;
              const isSectionHeader = sheetRow === 4 || sheetRow === 12 || sheetRow === 19 || sheetRow === 58 || sheetRow === 118 || sheetRow === 126 || sheetRow === 149;
              return (
                <tr
                  key={sheetRow}
                  style={{
                    borderBottom: "1px solid #f1f5f9",
                    background: isSectionHeader ? "#e0e7ff" : "#ffffff",
                    fontWeight: isSectionHeader ? "700" : "normal",
                  }}
                >
                  <td style={{ padding: "4px", textAlign: "center", color: "#94a3b8", background: "#f8fafc", borderRight: "1px solid #e2e8f0" }}>{sheetRow}</td>
                  <td style={{ padding: "4px 8px", borderRight: "1px solid #f1f5f9", color: isSectionHeader ? "#1e1b4b" : "inherit" }}>
                    {row?.[0]?.v || ""}
                  </td>
                  <td style={{ padding: "4px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[1]?.v || ""}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[2]?.v || ""}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[3]?.v || ""}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[4]?.v || ""}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>{row?.[5]?.v || ""}</td>
                  {fyCols.map((cIdx) => {
                    const cell = row?.[cIdx];
                    const opts = getEditableOpts(sheetRow, cIdx, cell?.v);
                    return (
                      <EditableCell
                        key={cIdx}
                        cell={cell}
                        editableOpts={opts}
                        align="right"
                        isAmount={true}
                      />
                    );
                  })}
                  <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: "700", background: "#f8fafc" }}>
                    {row?.[totalCol]?.v || ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC EDITABLE CELL COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function EditableCell({ cell, editableOpts, align = "left", fontSize = "12px", isAmount = false }) {
  if (!editableOpts || !editableOpts.isEditable) {
    return (
      <td
        style={{
          padding: "4px 8px",
          textAlign: align,
          fontSize,
          borderRight: "1px solid #f1f5f9",
          whiteSpace: "nowrap",
        }}
      >
        {cell?.v ?? ""}
      </td>
    );
  }

  const { isEditing, isSaving, editValue, onChangeEditValue, onCommitEdit, onStartEdit, onCancelEdit } = editableOpts;

  if (isSaving) {
    return (
      <td style={{ padding: "4px 8px", textAlign: align, background: "#fef9c3", borderRight: "1px solid #fde047" }}>
        <Spinner size={12} color="#ca8a04" />
      </td>
    );
  }

  if (isEditing) {
    return (
      <td style={{ padding: "2px", textAlign: align, background: "#eff6ff" }}>
        <input
          type="text"
          value={editValue}
          autoFocus
          onChange={(e) => onChangeEditValue(e.target.value)}
          onBlur={() => onCommitEdit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
            if (e.key === "Enter") onCommitEdit();
          }}
          style={{ width: "100%", fontSize, padding: "2px 4px", border: "1px solid #3b82f6", borderRadius: "3px", textAlign: align }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={onStartEdit}
      title="Click to edit cell"
      style={{
        padding: "4px 8px",
        textAlign: align,
        fontSize,
        borderRight: "1px solid #f1f5f9",
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: cell?.v ? "transparent" : "#fafafa",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#eff6ff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = cell?.v ? "transparent" : "#fafafa";
      }}
    >
      {cell?.v ?? ""}
    </td>
  );
}
