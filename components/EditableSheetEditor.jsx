import React, { useState, useEffect, useRef, useCallback } from "react";
import Spinner from "./Spinner";

// Columns checked to determine if a row is blank:
// Column A (0), G:R (6..17), V:AG (21..32), and AK:AV (36..47)
const BLANK_CHECK_COLS = [
  0,
  ...Array.from({ length: 12 }, (_, i) => 6 + i),  // G:R (6..17)
  ...Array.from({ length: 12 }, (_, i) => 21 + i), // V:AG (21..32)
  ...Array.from({ length: 12 }, (_, i) => 36 + i), // AK:AV (36..47)
];

function isRowBlank(row) {
  if (!row || row.length === 0) return true;
  for (const colIdx of BLANK_CHECK_COLS) {
    const val = row[colIdx]?.v;
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return false;
    }
  }
  return true;
}

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

function isCellEditable(sheetRow, colIdx, screenTab) {
  const isAllowedCol =
    (colIdx >= 0 && colIdx <= 5) ||   // A:F
    (colIdx >= 6 && colIdx <= 17) ||  // G:R
    (colIdx >= 21 && colIdx <= 32) || // V:AG
    (colIdx >= 36 && colIdx <= 47);   // AK:AV

  if (screenTab === "contractors") {
    return sheetRow >= 13 && sheetRow <= 110 && isAllowedCol;
  }
  if (screenTab === "outgoings") {
    return sheetRow >= 126 && sheetRow <= 225 && isAllowedCol;
  }
  if (screenTab === "budget") {
    return isBudgetCellEditable(sheetRow, colIdx);
  }
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
  const [activeTab, setActiveTab] = useState(initialTab); // 'budget' | 'contractors' | 'outgoings'
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [contractorsFyIdx, setContractorsFyIdx] = useState(0);
  const [outgoingsFyIdx, setOutgoingsFyIdx] = useState(0);
  const [budgetFyIdx, setBudgetFyIdx] = useState(0);
  const [showBlankRows, setShowBlankRows] = useState(false);

  const cacheRef = useRef({});
  const clientKey = client?.clientSheetId || "";
  const masterKey = client?.masterSheetId || "";

  const fetchData = useCallback(async (tab, forceRefresh = false) => {
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

        if (tab === "contractors" && data.defaultFyIndex !== undefined) {
          setContractorsFyIdx(data.defaultFyIndex);
        }
        if (tab === "outgoings" && data.defaultFyIndex !== undefined) {
          setOutgoingsFyIdx(data.defaultFyIndex);
        }
        if (tab === "budget" && data.defaultFyIndex !== undefined) {
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
    fetchData(activeTab);
  }, [activeTab, fetchData]);

  const handleUpdateCell = async (tabName, sheetRow, colIdx, newValue) => {
    if (!client || !client.clientSheetId) return;
    const clientKey = client.clientSheetId;
    const colLetter = colIndexToLetter(colIdx + 1);

    let displayVal = newValue;
    if (colIdx >= 6 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (tabName === "budget" && sheetRow >= 59 && sheetRow <= 111 && colIdx === 1 && newValue !== "") {
      displayVal = formatCurrency(newValue);
    } else if (
      ((tabName === "budget" && (colIdx === 4 || (sheetRow === 142 && colIdx === 1))) ||
        ((tabName === "contractors" || tabName === "outgoings") && (colIdx === 4 || colIdx === 5))) &&
      newValue !== ""
    ) {
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

      const updateRowList = (rows, startRow) => {
        return (rows || []).map((row, idx) => {
          if (startRow + idx !== sheetRow) return row;
          const newRow = [...(row || [])];
          newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
          return newRow;
        });
      };

      const updatedTabData = { ...tabData };
      if (tabName === "contractors") {
        if (updatedTabData.contractorRows) {
          updatedTabData.contractorRows = updateRowList(updatedTabData.contractorRows, 13);
        }
        if (updatedTabData.mainRows) {
          updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 13);
        }
      } else if (tabName === "outgoings") {
        if (updatedTabData.outgoingRows) {
          updatedTabData.outgoingRows = updateRowList(updatedTabData.outgoingRows, 126);
        }
        if (updatedTabData.mainRows) {
          updatedTabData.mainRows = updateRowList(updatedTabData.mainRows, 126);
        }
      } else if (tabName === "budget") {
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
      if (tabName === "contractors") {
        const r = currentTab?.contractorRows?.[sheetRow - 13] || currentTab?.mainRows?.[sheetRow - 13];
        rowDesc = r?.[0]?.v || "";
      } else if (tabName === "outgoings") {
        const r = currentTab?.outgoingRows?.[sheetRow - 126] || currentTab?.mainRows?.[sheetRow - 126];
        rowDesc = r?.[0]?.v || "";
      } else if (tabName === "budget") {
        const r = currentTab?.matrix?.[sheetRow - 1];
        rowDesc = r?.[0]?.v || `Row ${sheetRow}`;
      }
      const headerLabel =
        tabName === "budget"
          ? currentTab?.matrix?.[0]?.[colIdx]?.v || ""
          : currentTab?.headerRow?.[colIdx]?.v || "";

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_view_cell",
          clientSheetId: client.clientSheetId,
          masterSheetId: client.masterSheetId,
          clientName: client.clientName,
          tab: tabName === "budget" ? "Budget" : "Outgoings",
          screenTab: tabName,
          sheetRow,
          colLetter,
          colIdx,
          value: displayVal,
          contractorName: tabName === "contractors" ? (colIdx === 0 ? displayVal : rowDesc) : undefined,
          rowDescription: tabName === "outgoings" || tabName === "budget" ? (colIdx === 0 ? displayVal : rowDesc) : undefined,
          headerLabel,
          monthLabel: headerLabel,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Failed to update cell (status ${res.status})`);
      }

      if (tabName === "budget" && data.updatedMatrix) {
        setCache((prev) => {
          const clientData = prev[clientKey];
          if (!clientData || !clientData.budget) return prev;
          const next = {
            ...prev,
            [clientKey]: {
              ...clientData,
              budget: {
                ...clientData.budget,
                matrix: data.updatedMatrix,
              },
            },
          };
          cacheRef.current = next;
          return next;
        });
      }
    } catch (err) {
      console.error("Cell update error:", err);
      fetchData(tabName, true);
    }
  };

  const currentTabData = client?.clientSheetId ? cache[client.clientSheetId]?.[activeTab] : null;

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
        padding: "16px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "14px",
          width: "98vw",
          maxWidth: "1600px",
          height: "94vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        {/* Modal Top Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px",
            background: "#0f172a",
            color: "#ffffff",
            flexWrap: "wrap",
            gap: "12px",
            borderBottom: "1px solid #334155",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <span style={{ fontSize: "16px", fontWeight: "700", letterSpacing: "0.2px" }}>
              Data editor
            </span>
            <span
              style={{
                fontSize: "12px",
                fontWeight: "600",
                padding: "3px 10px",
                borderRadius: "12px",
                background: "rgba(255, 255, 255, 0.15)",
                color: "#e2e8f0",
              }}
            >
              {client.clientName}
            </span>
          </div>

          {/* Tab Switcher Buttons */}
          <div style={{ display: "flex", alignItems: "center", background: "#1e293b", borderRadius: "8px", padding: "3px" }}>
            {[
              { id: "budget", label: "Budget" },
              { id: "contractors", label: "Contractors" },
              { id: "outgoings", label: "Outgoings" },
            ].map((t) => {
              const isSelected = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    background: isSelected ? "#0284c7" : "transparent",
                    color: isSelected ? "#ffffff" : "#94a3b8",
                    border: "none",
                    borderRadius: "6px",
                    padding: "6px 14px",
                    fontSize: "13px",
                    fontWeight: isSelected ? "700" : "500",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Right Action Controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              onClick={() => fetchData(activeTab, true)}
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
                href={`https://docs.google.com/spreadsheets/d/${activeTab === "budget" ? client.masterSheetId : client.clientSheetId}/edit`}
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

        {/* Secondary Bar for Tab Controls (e.g. Blank Rows filter) */}
        {(activeTab === "contractors" || activeTab === "outgoings") && (
          <div
            style={{
              padding: "8px 20px",
              background: "#f8fafc",
              borderBottom: "1px solid #e2e8f0",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#475569", cursor: "pointer", fontWeight: "600" }}>
              <input
                type="checkbox"
                checked={showBlankRows}
                onChange={(e) => setShowBlankRows(e.target.checked)}
              />
              Show blank rows
            </label>
          </div>
        )}

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
                  onClick={() => fetchData(activeTab, true)}
                  style={{ padding: "6px 14px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <>
              {activeTab === "budget" && (
                <BudgetView
                  data={currentTabData}
                  fyIdx={budgetFyIdx}
                  onFyChange={setBudgetFyIdx}
                  onUpdateCell={(sheetRow, colIdx, val) => handleUpdateCell("budget", sheetRow, colIdx, val)}
                />
              )}
              {activeTab === "contractors" && (
                <ContractorsView
                  data={currentTabData}
                  fyIdx={contractorsFyIdx}
                  onFyChange={setContractorsFyIdx}
                  showBlankRows={showBlankRows}
                  onUpdateCell={(sheetRow, colIdx, val) => handleUpdateCell("contractors", sheetRow, colIdx, val)}
                />
              )}
              {activeTab === "outgoings" && (
                <OutgoingsTableView
                  data={currentTabData}
                  fyIdx={outgoingsFyIdx}
                  onFyChange={setOutgoingsFyIdx}
                  showBlankRows={showBlankRows}
                  onUpdateCell={(sheetRow, colIdx, val) => handleUpdateCell("outgoings", sheetRow, colIdx, val)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTORS VIEW COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function ContractorsView({ data, fyIdx, onFyChange, showBlankRows, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const committingRef = useRef(false);

  if (!data || !data.fyConfigs) return null;

  const { headerRow, contractorRows, totalRows, mainRows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];
  const DARK_RED = "#7f1d1d";

  const rawContractors = (contractorRows || (mainRows ? mainRows.slice(0, 98) : [])).map((row, idx) => ({
    row,
    sheetRow: 13 + idx,
  }));

  const visibleContractors = showBlankRows
    ? rawContractors
    : rawContractors.filter((item) => !isRowBlank(item.row));

  const contractorTotals = totalRows || (mainRows ? mainRows.slice(98, 102) : []);

  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Contractor Name", width: "170px", minWidth: "150px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isCellEditable(sheetRow, colIdx, "contractors");
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    let inputType = "text";
    let options = null;
    let initialEditVal = cellValue ?? "";

    if (colIdx === 1) {
      inputType = "select";
      options = ["Yes", "No"];
    } else if (colIdx === 2 || colIdx === 3) {
      inputType = "select";
      options = ["Curr", "Next"];
    } else if (colIdx === 4 || colIdx === 5) {
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6) {
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType,
      options,
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell((prev) => (prev ? { ...prev, editValue: val } : null)),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
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
        <span style={{ fontSize: "13px", fontWeight: "700", color: DARK_RED, minWidth: "60px", textAlign: "center" }}>
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
            <tr style={{ background: DARK_RED, color: "#ffffff" }}>
              <th style={{ padding: "8px 6px", border: "1px solid #991b1b", width: "35px" }}>#</th>
              {metaCols.map((c) => (
                <th key={c.idx} style={{ padding: "8px 6px", border: "1px solid #991b1b", minWidth: c.minWidth, width: c.width, textAlign: c.isName ? "left" : "center", fontSize: c.isName ? "12px" : "11px" }}>
                  {c.label}
                </th>
              ))}
              {allActiveFyCols.map((colIdx) => (
                <th key={colIdx} style={{ padding: "8px 8px", border: "1px solid #991b1b", minWidth: "85px", textAlign: "right" }}>
                  {headerRow?.[colIdx]?.v || `Col ${colIdx}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleContractors.map(({ row, sheetRow }) => (
              <tr key={sheetRow} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px", textAlign: "center", color: "#94a3b8", background: "#f8fafc", borderRight: "1px solid #e2e8f0" }}>{sheetRow}</td>
                {metaCols.map((c) => {
                  const cell = row?.[c.idx];
                  const opts = getEditableOpts(sheetRow, c.idx, cell?.v);
                  return (
                    <EditableCell
                      key={c.idx}
                      cell={cell}
                      editableOpts={opts}
                      align={c.isName ? "left" : "center"}
                      fontSize={c.isName ? "12px" : "11px"}
                    />
                  );
                })}
                {allActiveFyCols.map((colIdx) => {
                  const cell = row?.[colIdx];
                  const opts = getEditableOpts(sheetRow, colIdx, cell?.v);
                  return (
                    <EditableCell
                      key={colIdx}
                      cell={cell}
                      editableOpts={opts}
                      align="right"
                      isAmount={true}
                    />
                  );
                })}
              </tr>
            ))}
            {/* Totals */}
            {contractorTotals.map((row, idx) => (
              <tr key={`tot-${idx}`} style={{ background: "#fef2f2", fontWeight: "700" }}>
                <td style={{ padding: "6px", textAlign: "center", color: "#94a3b8" }}>-</td>
                {metaCols.map((c) => (
                  <td key={c.idx} style={{ padding: "6px 8px", border: "1px solid #fee2e2", textAlign: c.isName ? "left" : "center" }}>
                    {row?.[c.idx]?.v || ""}
                  </td>
                ))}
                {allActiveFyCols.map((colIdx) => (
                  <td key={colIdx} style={{ padding: "6px 8px", border: "1px solid #fee2e2", textAlign: "right", color: DARK_RED }}>
                    {row?.[colIdx]?.v || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTGOINGS VIEW COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function OutgoingsTableView({ data, fyIdx, onFyChange, showBlankRows, onUpdateCell }) {
  const [editingCell, setEditingCell] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const committingRef = useRef(false);

  if (!data || !data.fyConfigs) return null;

  const { headerRow, outgoingRows, totalRows, mainRows, fyConfigs } = data;
  const currentFy = fyConfigs[fyIdx] || fyConfigs[0];
  const maxFyIdx = fyConfigs.length - 1;

  const fyCols = currentFy.monthCols;
  const totalCol = currentFy.totalCol;
  const allActiveFyCols = [...fyCols, totalCol];
  const DARK_RED = "#7f1d1d";

  const rawOutgoings = (outgoingRows || (mainRows ? mainRows.slice(0, 100) : [])).map((row, idx) => ({
    row,
    sheetRow: 126 + idx,
  }));

  const visibleOutgoings = showBlankRows
    ? rawOutgoings
    : rawOutgoings.filter((item) => !isRowBlank(item.row));

  const outgoingTotals = totalRows || (mainRows ? mainRows.slice(100, 104) : []);

  const metaCols = [
    { idx: 0, label: headerRow?.[0]?.v || "Expense Name", width: "170px", minWidth: "150px", isName: true },
    { idx: 1, label: headerRow?.[1]?.v || "VAT?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 2, label: headerRow?.[2]?.v || "Inv?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 3, label: headerRow?.[3]?.v || "Pay?", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 4, label: headerRow?.[4]?.v || "Del", width: "24px", minWidth: "22px", maxWidth: "28px" },
    { idx: 5, label: headerRow?.[5]?.v || "Likl. %", width: "30px", minWidth: "26px", maxWidth: "34px" },
  ];

  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isCellEditable(sheetRow, colIdx, "outgoings");
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    let inputType = "text";
    let options = null;
    let initialEditVal = cellValue ?? "";

    if (colIdx === 1) {
      inputType = "select";
      options = ["Yes", "No"];
    } else if (colIdx === 2 || colIdx === 3) {
      inputType = "select";
      options = ["Curr", "Next"];
    } else if (colIdx === 4 || colIdx === 5) {
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6) {
      inputType = "text";
      initialEditVal = String(cellValue ?? "").replace(/[£,]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      inputType,
      options,
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) => setEditingCell((prev) => (prev ? { ...prev, editValue: val } : null)),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
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
        <span style={{ fontSize: "13px", fontWeight: "700", color: DARK_RED, minWidth: "60px", textAlign: "center" }}>
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
            <tr style={{ background: DARK_RED, color: "#ffffff" }}>
              <th style={{ padding: "8px 6px", border: "1px solid #991b1b", width: "35px" }}>#</th>
              {metaCols.map((c) => (
                <th key={c.idx} style={{ padding: "8px 6px", border: "1px solid #991b1b", minWidth: c.minWidth, width: c.width, textAlign: c.isName ? "left" : "center", fontSize: c.isName ? "12px" : "11px" }}>
                  {c.label}
                </th>
              ))}
              {allActiveFyCols.map((colIdx) => (
                <th key={colIdx} style={{ padding: "8px 8px", border: "1px solid #991b1b", minWidth: "85px", textAlign: "right" }}>
                  {headerRow?.[colIdx]?.v || `Col ${colIdx}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleOutgoings.map(({ row, sheetRow }) => (
              <tr key={sheetRow} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px", textAlign: "center", color: "#94a3b8", background: "#f8fafc", borderRight: "1px solid #e2e8f0" }}>{sheetRow}</td>
                {metaCols.map((c) => {
                  const cell = row?.[c.idx];
                  const opts = getEditableOpts(sheetRow, c.idx, cell?.v);
                  return (
                    <EditableCell
                      key={c.idx}
                      cell={cell}
                      editableOpts={opts}
                      align={c.isName ? "left" : "center"}
                      fontSize={c.isName ? "12px" : "11px"}
                    />
                  );
                })}
                {allActiveFyCols.map((colIdx) => {
                  const cell = row?.[colIdx];
                  const opts = getEditableOpts(sheetRow, colIdx, cell?.v);
                  return (
                    <EditableCell
                      key={colIdx}
                      cell={cell}
                      editableOpts={opts}
                      align="right"
                      isAmount={true}
                    />
                  );
                })}
              </tr>
            ))}
            {/* Totals */}
            {outgoingTotals.map((row, idx) => (
              <tr key={`tot-${idx}`} style={{ background: "#fef2f2", fontWeight: "700" }}>
                <td style={{ padding: "6px", textAlign: "center", color: "#94a3b8" }}>-</td>
                {metaCols.map((c) => (
                  <td key={c.idx} style={{ padding: "6px 8px", border: "1px solid #fee2e2", textAlign: c.isName ? "left" : "center" }}>
                    {row?.[c.idx]?.v || ""}
                  </td>
                ))}
                {allActiveFyCols.map((colIdx) => (
                  <td key={colIdx} style={{ padding: "6px 8px", border: "1px solid #fee2e2", textAlign: "right", color: DARK_RED }}>
                    {row?.[colIdx]?.v || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET VIEW COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function BudgetView({ data, fyIdx, onFyChange, onUpdateCell }) {
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
        setTimeout(() => { committingRef.current = false; }, 100);
        if (!cur && overrideVal === undefined) return;

        let rawVal = overrideVal !== undefined ? overrideVal : (cur ? cur.editValue : "");
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

  const { isEditing, isSaving, inputType, options, editValue, onChangeEditValue, onCommitEdit, onStartEdit, onCancelEdit } = editableOpts;

  if (isSaving) {
    return (
      <td style={{ padding: "4px 8px", textAlign: align, background: "#fef9c3", borderRight: "1px solid #fde047" }}>
        <Spinner size={12} color="#ca8a04" />
      </td>
    );
  }

  if (isEditing) {
    if (inputType === "select") {
      return (
        <td style={{ padding: "2px", textAlign: align, background: "#eff6ff" }}>
          <select
            value={editValue}
            autoFocus
            onChange={(e) => {
              onChangeEditValue(e.target.value);
              onCommitEdit(e.target.value);
            }}
            onBlur={() => onCommitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancelEdit();
              if (e.key === "Enter") onCommitEdit();
            }}
            style={{ width: "100%", fontSize: "11px", padding: "2px", border: "1px solid #3b82f6", borderRadius: "3px" }}
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </td>
      );
    }

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
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#eff6ff"; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = cell?.v ? "transparent" : "#fafafa"; }}
    >
      {cell?.v ?? ""}
    </td>
  );
}
