import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import { formatCurrency } from "./JobsView";
import { isPlaceholderExpense } from "../utils/helpers";

export default function OutgoingsContractorPickerModal({
  isOpen,
  onClose,
  clientSheetId,
  clientName,
  expense,
  onSelectCell,
  isAdmin = false
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [contractors, setContractors] = useState([]);
  const [months, setMonths] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [monthWindowOffset, setMonthWindowOffset] = useState(0);
  const [replacePrompt, setReplacePrompt] = useState(null);

  useEffect(() => {
    if (!isOpen || !clientSheetId) {
      setContractors([]);
      setMonths([]);
      setError(null);
      setSearchQuery("");
      return;
    }

    let isMounted = true;
    const fetchOutgoings = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_outgoings",
            clientSheetId
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to load Outgoings data");
        if (isMounted) {
          setContractors(data.contractors || []);
          setMonths(data.months || []);

          // Find index of expense month or current month to set initial window offset
          const expDateStr = String(expense?.date || "").trim();
          let targetMonthIdx = -1;
          if (expDateStr) {
            const monthsMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
            const mMatch = expDateStr.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
            if (mMatch) {
              const mName = mMatch[2].toLowerCase();
              const yr = mMatch[3].slice(-2);
              const targetLabel = `${mMatch[2]}-${yr}`.toLowerCase();
              targetMonthIdx = (data.months || []).findIndex(m => m.label.toLowerCase() === targetLabel);
            }
          }
          if (targetMonthIdx === -1) {
            const now = new Date();
            const curIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
            targetMonthIdx = (data.months || []).findIndex(m => (m.isoMonth || "").startsWith(curIso));
          }
          if (targetMonthIdx >= 0) {
            setMonthWindowOffset(Math.max(0, targetMonthIdx - 2));
          }
        }
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchOutgoings();

    return () => {
      isMounted = false;
    };
  }, [isOpen, clientSheetId, expense]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Identify likely matching month
  const likelyMonthColLetter = useMemo(() => {
    if (!expense?.date || months.length === 0) return null;
    const dStr = String(expense.date).trim();
    // 1. DD-Mon-YY
    const mMatch = dStr.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
    if (mMatch) {
      const targetLabel = `${mMatch[2]}-${mMatch[3].slice(-2)}`.toLowerCase();
      const found = months.find(m => m.label.toLowerCase() === targetLabel);
      if (found) return found.colLetter;
    }
    // 2. YYYY-MM-DD
    const isoMatch = dStr.match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      const found = months.find(m => (m.isoMonth || "").startsWith(isoMatch[0]));
      if (found) return found.colLetter;
    }
    return null;
  }, [expense?.date, months]);

  // Identify likely matching contractor
  const likelyContractorRow = useMemo(() => {
    if (!contractors.length) return null;
    const rawTarget = String(expense?.vendor || expense?.description || expense?.reference || "").toLowerCase();
    if (!rawTarget) return null;

    let bestScore = 0;
    let bestRow = null;

    contractors.forEach(c => {
      const cName = String(c.name || "").toLowerCase().trim();
      if (!cName || cName === "contractors") return;

      if (rawTarget.includes(cName) || cName.includes(rawTarget)) {
        const score = cName.length;
        if (score > bestScore) {
          bestScore = score;
          bestRow = c.sheetRow;
        }
      }
    });

    return bestRow;
  }, [contractors, expense]);

  // Filter contractors by search query
  const filteredContractors = useMemo(() => {
    if (!searchQuery.trim()) return contractors;
    const q = searchQuery.toLowerCase().trim();
    return contractors.filter(c => (c.name || "").toLowerCase().includes(q));
  }, [contractors, searchQuery]);

  // Visible window of months (e.g. 6 months at a time)
  const VISIBLE_MONTHS_COUNT = 6;
  const visibleMonths = useMemo(() => {
    return months.slice(monthWindowOffset, monthWindowOffset + VISIBLE_MONTHS_COUNT);
  }, [months, monthWindowOffset]);

  if (!isOpen) return null;

  const expAmountStr = `£${(parseFloat(String(expense?.amount || "0").replace(/[£$€,\s]/g, "")) || 0).toFixed(2)}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 1050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(96vw, 1050px)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          overflow: "hidden"
        }}
      >
        {/* Modal Header */}
        <div style={{
          padding: "18px 24px",
          borderBottom: "1px solid #e2e8f0",
          background: "#f8fafc",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
          <div>
            <h2 style={{ fontSize: "17px", fontWeight: "700", color: "#0f172a", margin: 0 }}>
              Place Expense against Contractor (Outgoings)
            </h2>
            <div style={{ fontSize: "13px", color: "#64748b", marginTop: "3px" }}>
              Placing <strong style={{ color: "#059669" }}>{expAmountStr}</strong>
              {" · "}{expense?.description || expense?.reference || "Expense"}
              {expense?.date && <span>{" · Date: "}<strong>{expense.date}</strong></span>}
            </div>
          </div>
          <button
            type="button"
            className="triage-btn"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#475569",
              cursor: "pointer"
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Search & Navigation Bar */}
        <div style={{
          padding: "12px 24px",
          borderBottom: "1px solid #f1f5f9",
          background: "#ffffff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "14px"
        }}>
          <div style={{ flex: 1, maxWidth: "420px", position: "relative" }}>
            <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", fontSize: "13px", color: "#94a3b8" }}>
              🔍
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search contractors..."
              style={{
                width: "100%",
                padding: "8px 10px 8px 32px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                outline: "none",
                boxSizing: "border-box"
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="triage-btn"
              disabled={monthWindowOffset === 0}
              onClick={() => setMonthWindowOffset(prev => Math.max(0, prev - 3))}
              style={{
                padding: "6px 10px",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: "600",
                color: monthWindowOffset === 0 ? "#cbd5e1" : "#334155",
                cursor: monthWindowOffset === 0 ? "not-allowed" : "pointer"
              }}
            >
              ← Earlier Months
            </button>
            <button
              type="button"
              className="triage-btn"
              disabled={monthWindowOffset + VISIBLE_MONTHS_COUNT >= months.length}
              onClick={() => setMonthWindowOffset(prev => Math.min(months.length - VISIBLE_MONTHS_COUNT, prev + 3))}
              style={{
                padding: "6px 10px",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: "600",
                color: (monthWindowOffset + VISIBLE_MONTHS_COUNT >= months.length) ? "#cbd5e1" : "#334155",
                cursor: (monthWindowOffset + VISIBLE_MONTHS_COUNT >= months.length) ? "not-allowed" : "pointer"
              }}
            >
              Later Months →
            </button>
          </div>
        </div>

        {/* Grid Body */}
        <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", padding: "16px 24px", background: "#f8fafc" }}>
          {loading && (
            <div style={{ padding: "50px", textAlign: "center", color: "#64748b" }}>
              <Spinner color="#059669" />
              <div style={{ marginTop: "12px", fontSize: "14px" }}>Loading Outgoings contractors and months...</div>
            </div>
          )}

          {error && !loading && (
            <div style={{ padding: "16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#991b1b", fontSize: "13px" }}>
              ⚠️ {error}
            </div>
          )}

          {!loading && !error && (
            <div style={{ background: "#ffffff", borderRadius: "8px", border: "1px solid #e2e8f0", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", borderBottom: "2px solid #cbd5e1" }}>
                    <th style={{ padding: "10px 14px", fontWeight: "700", color: "#334155", minWidth: "180px", position: "sticky", left: 0, background: "#f1f5f9", zIndex: 2 }}>
                      Contractor
                    </th>
                    {visibleMonths.map(m => {
                      const isLikelyMonth = m.colLetter === likelyMonthColLetter;
                      return (
                        <th
                          key={m.colLetter}
                          style={{
                            padding: "10px 12px",
                            fontWeight: "700",
                            textAlign: "center",
                            minWidth: "110px",
                            color: isLikelyMonth ? "#065f46" : "#334155",
                            background: isLikelyMonth ? "#ecfdf5" : "transparent",
                            borderLeft: "1px solid #e2e8f0"
                          }}
                        >
                          <div>{m.label}</div>
                          {isLikelyMonth && (
                            <span style={{ fontSize: "9px", color: "#059669", fontWeight: "700", textTransform: "uppercase" }}>
                              ★ Expense Month
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredContractors.length === 0 ? (
                    <tr>
                      <td colSpan={visibleMonths.length + 1} style={{ padding: "30px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                        No contractors match your search query.
                      </td>
                    </tr>
                  ) : (
                    filteredContractors.map((c) => {
                      const isLikelyContractor = c.sheetRow === likelyContractorRow;

                      return (
                        <tr
                          key={c.sheetRow}
                          style={{
                            borderBottom: "1px solid #e2e8f0",
                            background: isLikelyContractor ? "#f0fdf4" : "transparent"
                          }}
                        >
                          {/* Contractor Name */}
                          <td style={{
                            padding: "10px 14px",
                            fontWeight: "600",
                            color: "#0f172a",
                            position: "sticky",
                            left: 0,
                            background: isLikelyContractor ? "#f0fdf4" : "#ffffff",
                            zIndex: 1,
                            borderRight: "1px solid #e2e8f0"
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span>{c.name}</span>
                              {isLikelyContractor && (
                                <span style={{
                                  fontSize: "10px", padding: "1px 6px",
                                  borderRadius: "10px", background: "#dcfce7",
                                  color: "#166534", fontWeight: "700", border: "1px solid #bbf7d0"
                                }}>
                                  ★ Likely Match
                                </span>
                              )}
                            </div>
                            {isAdmin && (
                              <div style={{ fontSize: "10px", color: "#94a3b8" }}>Row {c.sheetRow}</div>
                            )}
                          </td>

                          {/* Month Cells */}
                          {visibleMonths.map(m => {
                            const cell = c.cells?.[m.colLetter] || { value: "", note: "", blocks: [] };
                            const isLikelyCell = isLikelyContractor && (m.colLetter === likelyMonthColLetter);
                            const val = cell.value ? formatCurrency(cell.value) : "—";
                            const blockCount = cell.blocks?.length || 0;

                            return (
                              <td
                                key={m.colLetter}
                                style={{
                                  padding: "8px 10px",
                                  textAlign: "center",
                                  borderLeft: "1px solid #e2e8f0",
                                  background: isLikelyCell ? "#fef3c7" : "transparent",
                                  border: isLikelyCell ? "2px solid #f59e0b" : undefined
                                }}
                              >
                                <div style={{ fontSize: "12px", fontWeight: cell.value ? "700" : "normal", color: cell.value ? "#0f172a" : "#94a3b8" }}>
                                  {val}
                                </div>
                                {blockCount > 0 && (
                                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                                    {blockCount} item{blockCount !== 1 ? "s" : ""}
                                  </div>
                                )}

                                <div style={{ marginTop: "6px" }}>
                                  <button
                                    type="button"
                                    className="triage-btn"
                                    onClick={() => {
                                      const allBlocks = cell.blocks || [];
                                      const placeholderBlocks = allBlocks.filter(b => isPlaceholderExpense(b.appId, b.description, b.status));
                                      const expAmt = parseFloat(String(expense?.amount || "0").replace(/[£$€,\s]/g, "")) || 0;

                                      if (placeholderBlocks.length > 0) {
                                        const totalManual = placeholderBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                                        setReplacePrompt({
                                          contractor: c,
                                          month: m,
                                          colLetter: m.colLetter,
                                          sheetRow: c.sheetRow,
                                          cell,
                                          totalManual,
                                          placeholderBlocks,
                                          allBlocks,
                                          expAmount: expAmt,
                                          canUseUp: expAmt <= totalManual + 0.001
                                        });
                                        return;
                                      }

                                      if (onSelectCell) {
                                        onSelectCell({
                                          contractor: c,
                                          month: m,
                                          colLetter: m.colLetter,
                                          sheetRow: c.sheetRow,
                                          cell,
                                          mode: "add_alongside"
                                        });
                                      }
                                    }}
                                    style={{
                                      padding: "4px 8px",
                                      borderRadius: "4px",
                                      fontSize: "11px",
                                      fontWeight: "600",
                                      cursor: "pointer",
                                      border: isLikelyCell ? "1px solid #d97706" : "1px solid #cbd5e1",
                                      background: isLikelyCell ? "#f59e0b" : "#ffffff",
                                      color: isLikelyCell ? "#ffffff" : "#047857"
                                    }}
                                  >
                                    {isLikelyCell ? "⚡ Place Here" : "+ Place"}
                                  </button>
                                </div>
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
          )}
        </div>

        {/* Replace / Use Up / Add Alongside prompt */}
        {replacePrompt && (() => {
          const { contractor, month, colLetter, sheetRow, cell, totalManual, expAmount, canUseUp } = replacePrompt;
          return (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(15, 23, 42, 0.65)",
                backdropFilter: "blur(2px)",
                zIndex: 2000,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px"
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) setReplacePrompt(null);
              }}
            >
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: "12px",
                  padding: "24px",
                  width: "min(92vw, 500px)",
                  boxShadow: "0 25px 60px rgba(0,0,0,0.3)"
                }}
              >
                <h3 style={{ margin: "0 0 12px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                  Placeholder / unrecon gap exists
                </h3>
                <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#475569", lineHeight: "1.5" }}>
                  This cell already contains a placeholder / gap of <strong>£{totalManual.toFixed(2)}</strong>.<br />
                  You are placing 1 expense totaling <strong>£{expAmount.toFixed(2)}</strong> against <strong>{contractor.name}</strong> ({month.label}).<br /><br />
                  Would you like to replace it, keep both, or use up part of the estimate?
                </p>
                <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="triage-btn"
                    onClick={() => setReplacePrompt(null)}
                    style={{ padding: "8px 16px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="triage-btn"
                    onClick={() => {
                      setReplacePrompt(null);
                      if (onSelectCell) onSelectCell({ contractor, month, colLetter, sheetRow, cell, mode: "add_alongside" });
                    }}
                    style={{ padding: "8px 16px", background: "#f0f9ff", border: "1px solid #93c5fd", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#1d4ed8" }}
                  >
                    Add alongside
                  </button>
                  {canUseUp && (
                    <button
                      type="button"
                      className="triage-btn"
                      onClick={() => {
                        setReplacePrompt(null);
                        if (onSelectCell) onSelectCell({ contractor, month, colLetter, sheetRow, cell, mode: "use_up" });
                      }}
                      style={{ padding: "8px 16px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#166534" }}
                    >
                      Use up
                    </button>
                  )}
                  <button
                    type="button"
                    className="triage-btn"
                    onClick={() => {
                      setReplacePrompt(null);
                      if (onSelectCell) onSelectCell({ contractor, month, colLetter, sheetRow, cell, mode: "replace" });
                    }}
                    style={{ padding: "8px 16px", background: "#0284c7", color: "#ffffff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Replace
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
