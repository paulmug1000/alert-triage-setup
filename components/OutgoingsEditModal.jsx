import React, { useState, useRef, useEffect } from "react";
import { isPlaceholderExpense, toSheetDateFormat, toInputDateFormat } from "../utils/helpers";

const STATUS_COLOURS = {
  "Paid":                 { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
  "Received":             { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
  "Part-paid (paid)":    { bg: "#fef3c7", border: "#f59e0b", text: "#92400e" },
  "Part-paid (balance)": { bg: "#fef3c7", border: "#f59e0b", text: "#92400e" },
  "Draft":                { bg: "#fff8e1", border: "#ffc107", text: "#e65100" },
  "":                     { bg: "#f5f5f5", border: "#bdbdbd", text: "#616161" },
};
const getStatusColour = (s) => {
  if (!s) return STATUS_COLOURS[""];
  if (STATUS_COLOURS[s]) return STATUS_COLOURS[s];
  const lower = String(s).toLowerCase();
  if (lower.includes("balance")) return STATUS_COLOURS["Part-paid (balance)"];
  if (lower.includes("part-paid") || lower.includes("part paid")) return STATUS_COLOURS["Part-paid (paid)"];
  if (lower === "paid") return STATUS_COLOURS["Paid"];
  if (lower === "received") return STATUS_COLOURS["Received"];
  if (lower === "draft") return STATUS_COLOURS["Draft"];
  return STATUS_COLOURS[""];
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtMonthLabel = (labelOrIso) => {
  if (!labelOrIso) return "";
  const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, 1);
    return d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
  }
  return String(labelOrIso).slice(0, 7);
};

function getMonthDetails(monthObj, monthLabel) {
  if (monthObj?.isoMonth) {
    const match = String(monthObj.isoMonth).match(/^(\d{4})-(\d{2})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const monthIdx = parseInt(match[2], 10) - 1;
      const dateStr = `${MONTH_NAMES[monthIdx]}-${String(year).slice(-2)}`;
      return { baseDate: new Date(year, monthIdx, 1), dateStr };
    }
  }
  if (monthObj?.dateObj) {
    const d = new Date(monthObj.dateObj);
    if (!isNaN(d.getTime())) {
      const dateStr = `${MONTH_NAMES[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      return { baseDate: new Date(d.getFullYear(), d.getMonth(), 1), dateStr };
    }
  }
  if (monthLabel) {
    const isoMatch = String(monthLabel).match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const monthIdx = parseInt(isoMatch[2], 10) - 1;
      const dateStr = `${MONTH_NAMES[monthIdx]}-${String(year).slice(-2)}`;
      return { baseDate: new Date(year, monthIdx, 1), dateStr };
    }
    const txtMatch = String(monthLabel).match(/([a-zA-Z]{3})[- ]?(\d{2,4})/);
    if (txtMatch) {
      const mIdx = MONTH_NAMES.findIndex(m => m.toLowerCase() === txtMatch[1].toLowerCase());
      let yr = parseInt(txtMatch[2], 10);
      if (yr < 100) yr += 2000;
      if (mIdx !== -1) {
        const dateStr = `${MONTH_NAMES[mIdx]}-${String(yr).slice(-2)}`;
        return { baseDate: new Date(yr, mIdx, 1), dateStr };
      }
    }
  }
  const now = new Date();
  const dateStr = `${MONTH_NAMES[now.getMonth()]}-${String(now.getFullYear()).slice(-2)}`;
  return { baseDate: new Date(now.getFullYear(), now.getMonth(), 1), dateStr };
}

function computeTargetDate(baseDate, timingStr, dayOfMonth) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
  if (String(timingStr || "").trim().toLowerCase().includes("next")) {
    d.setMonth(d.getMonth() + 1);
  }
  d.setDate(dayOfMonth);
  return `${d.getDate()}-${MONTH_NAMES[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

function generatePlaceholderId(contractorName, dateStr) {
  const cleanName = String(contractorName || "Row").trim().replace(/[^a-zA-Z0-9]/g, "");
  const shortCode = cleanName.slice(0, 5) || "Vend";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PLACE-EXP-${dateStr}-${shortCode}-${rand}`;
}

function CalendarIcon({ size = 15, color = "#64748b" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: "6px" }}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function CalendarDatePicker({ value, onChange, placeholder = "Select date" }) {
  const displayVal = value ? toSheetDateFormat(value) : "";
  const isoVal = value ? toInputDateFormat(value) : "";
  const inputRef = useRef(null);

  return (
    <div
      onClick={() => {
        try {
          inputRef.current?.showPicker?.();
        } catch {
          inputRef.current?.focus();
        }
      }}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "7px 10px",
        border: "1px solid #cbd5e1",
        borderRadius: "5px",
        fontSize: "13px",
        backgroundColor: "#ffffff",
        boxSizing: "border-box",
        cursor: "pointer",
        minHeight: "34px",
      }}
    >
      <span style={{ color: displayVal ? "#0f172a" : "#94a3b8", fontWeight: displayVal ? "500" : "400" }}>
        {displayVal || placeholder}
      </span>
      <CalendarIcon size={14} color="#64748b" />
      <input
        ref={inputRef}
        type="date"
        value={isoVal}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw ? toSheetDateFormat(raw) : "");
        }}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          cursor: "pointer",
        }}
      />
    </div>
  );
}

export default function OutgoingsEditModal({ editCellData, outgoingsData, updateCell, onReturnToInbox, onClose }) {
  const { contractor, colLetter, monthLabel } = editCellData;
  const [blocks, setBlocks] = useState(
    (contractor.cells?.[colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"))
  );
  const [topNote, setTopNote] = useState(
    editCellData.topNote ?? contractor.cells?.[colLetter]?.topNote ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [splitAmts, setSplitAmts] = useState({});

  // Month & Timing Date calculations (matching GAS 7_Cost_Sync.gs)
  const monthObj = outgoingsData?.months?.find(m => m.colLetter === colLetter);
  const { baseDate, dateStr } = getMonthDetails(monthObj, monthLabel);
  const defaultPayDate = computeTargetDate(baseDate, contractor.payTiming, 28);
  const defaultRecDate = computeTargetDate(baseDate, contractor.invTiming, 5);

  // New expense creation fields
  const [newAmount, setNewAmount] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPayDate, setNewPayDate] = useState(defaultPayDate);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addError, setAddError] = useState("");
  
  // Track whether blocks or note have been modified since last write
  const dirtyRef = useRef(false);
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);

  const updateBlock = (i, field, val) => {
    dirtyRef.current = true;
    setBlocks(prev => prev.map((b, idx) => idx === i ? { ...b, [field]: val } : b));
  };
  const removeBlock = (i) => {
    dirtyRef.current = true;
    setBlocks(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleAddExpense = () => {
    const amt = parseFloat(newAmount);
    if (isNaN(amt) || amt <= 0) {
      setAddError("Please enter a valid amount greater than 0");
      return;
    }
    const newBlock = {
      appId: generatePlaceholderId(contractor.name, dateStr),
      amount: amt,
      status: "",
      recDate: defaultRecDate,
      payDate: newPayDate || defaultPayDate,
      description: newDescription.trim() || `${contractor.name} expense`,
    };
    dirtyRef.current = true;
    setBlocks(prev => [...prev, newBlock]);
    setNewAmount("");
    setNewDescription("");
    setNewPayDate(defaultPayDate);
    setAddError("");
    if (blocks.length > 0) {
      setShowAddForm(false);
    }
  };

  const save = async () => {
    let currentBlocks = [...blocksRef.current];
    if (newAmount.trim() !== "") {
      const pendingAmt = parseFloat(newAmount);
      if (isNaN(pendingAmt) || pendingAmt <= 0) {
        setAddError("Please enter a valid amount greater than 0");
        return;
      }
      const newBlock = {
        appId: generatePlaceholderId(contractor.name, dateStr),
        amount: pendingAmt,
        status: "",
        recDate: defaultRecDate,
        payDate: newPayDate || defaultPayDate,
        description: newDescription.trim() || `${contractor.name} expense`,
      };
      currentBlocks.push(newBlock);
      setBlocks(currentBlocks);
      blocksRef.current = currentBlocks;
      dirtyRef.current = true;
    }

    const initialNote = editCellData.topNote ?? contractor.cells?.[colLetter]?.topNote ?? "";
    if (topNote !== initialNote) {
      dirtyRef.current = true;
    }

    if (!dirtyRef.current) { onClose(); return; }
    setSaving(true);
    setSavedMsg("");
    await updateCell(contractor, colLetter, currentBlocks, topNote);
    setSaving(false);
    setSavedMsg("Saved ✓");
    await new Promise(r => setTimeout(r, 600));
    onClose();
  };

  const currentMonthIdx = outgoingsData?.months?.findIndex(m => m.colLetter === colLetter) ?? -1;
  const prevMonth = currentMonthIdx > 0 ? outgoingsData.months[currentMonthIdx - 1] : null;
  const nextMonth = currentMonthIdx >= 0 && currentMonthIdx < (outgoingsData?.months?.length ?? 0) - 1 ? outgoingsData.months[currentMonthIdx + 1] : null;

  const doSplit = (blockIdx, targetCol, amt) => {
    const b = blocks[blockIdx];
    const splitAmt = parseFloat(amt);
    if (!splitAmt || splitAmt <= 0 || splitAmt >= b.amount) return;
    const newSrcAmt = parseFloat((b.amount - splitAmt).toFixed(2));
    const newBlocks = blocks.map((bl, i) => i === blockIdx ? { ...bl, amount: newSrcAmt } : bl);
    blocksRef.current = newBlocks;
    dirtyRef.current = false;
    setBlocks(newBlocks);
    updateCell(contractor, colLetter, newBlocks, topNote);
    const tb = [...(contractor.cells?.[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))];
    tb.push({ ...b, amount: splitAmt });
    updateCell(contractor, targetCol, tb);
    setSplitAmts(prev => ({ ...prev, [`${blockIdx}_${targetCol}`]: "" }));
    setSavedMsg("Split saved ✓");
  };

  const doMove = async (blockIdx, targetCol) => {
    if (!targetCol) return;
    const b = blocks[blockIdx];
    if (!b) return;

    // 1. Remove from source month and update source cell immediately in sheet
    const newBlocks = blocks.filter((_, idx) => idx !== blockIdx);
    blocksRef.current = newBlocks;
    dirtyRef.current = false;
    setBlocks(newBlocks);
    await updateCell(contractor, colLetter, newBlocks, topNote);

    // 2. Add to target month and write to target cell immediately in sheet
    const targetBlocks = [
      ...(contractor.cells?.[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))
    ];
    targetBlocks.push({ ...b });
    await updateCell(contractor, targetCol, targetBlocks);

    setSavedMsg("Moved ✓");
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 660px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)", position: "relative" }}>
        {saving && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.8)", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, fontSize: "14px", color: "#0066cc", fontWeight: "600" }}>
            Saving changes...
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>{contractor.name}</h3>
            <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>{fmtMonthLabel(monthLabel)}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>

        {/* ── SECTION 1: EXPENSES ────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h4 style={{ margin: 0, fontSize: "13px", fontWeight: "700", color: "#334155" }}>
            Expenses ({blocks.length})
          </h4>
          {blocks.length > 0 && !showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              style={{
                background: "none",
                border: "1px solid #c5cff0",
                borderRadius: "5px",
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: "600",
                color: "#1a56db",
                cursor: "pointer",
              }}
            >
              + Add expense
            </button>
          )}
        </div>

        {blocks.length === 0 && (
          <div style={{ marginBottom: "14px", padding: "10px 14px", background: "#f8fafc", borderRadius: "6px", border: "1px dashed #cbd5e1", fontSize: "12px", color: "#64748b" }}>
            No expenses recorded for this month yet. Enter an amount below to create a new expense for this vendor, or leave blank to save only the note.
          </div>
        )}

        {blocks.map((b, i) => {
          const sc = getStatusColour(b.status);
          const isManual = isPlaceholderExpense(b.appId);
          return (
            <div key={i} style={{ border: `1px solid ${sc.border}`, background: sc.bg, borderRadius: "8px", padding: "14px", marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                <div style={{ flex: 1, marginRight: "8px" }}>
                  <div style={{ fontSize: "14px", fontWeight: "700", color: "#1e293b", marginBottom: "2px" }}>
                    {b.description || (isManual ? "Manual estimate" : b.appId)}
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace" }}>{b.appId}</div>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  {!isPlaceholderExpense(b.appId) && (
                    <button onClick={async () => {
                      const newBlocks = blocksRef.current.filter((_, idx) => idx !== i);
                      blocksRef.current = newBlocks;
                      dirtyRef.current = false;
                      await updateCell(contractor, colLetter, newBlocks, topNote);
                      onReturnToInbox({
                        appId: b.appId, amount: b.amount,
                        date: b.recDate || "", datePaid: b.payDate || "",
                        description: b.description || "", accountName: b.description || "",
                        status: b.status || "",
                      });
                      onClose();
                    }} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "12px", fontWeight: "500" }}>↩ Return to inbox</button>
                  )}
                  <button onClick={() => removeBlock(i)} style={{ background: "none", border: "none", color: "#e53935", cursor: "pointer", fontSize: "12px", fontWeight: "500" }}>Remove</button>
                </div>
              </div>

              {/* Prominent Description View/Edit */}
              {isManual ? (
                <div style={{ marginBottom: "12px" }}>
                  <label style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", display: "block", marginBottom: "3px" }}>Description</label>
                  <input type="text" value={b.description || ""} placeholder="e.g. Freelance design services"
                    onChange={e => updateBlock(i, "description", e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                </div>
              ) : (
                <div style={{ marginBottom: "12px", padding: "8px 12px", background: "rgba(255,255,255,0.85)", borderRadius: "6px", border: "1px solid rgba(0,0,0,0.08)" }}>
                  <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Item description</div>
                  <div style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a" }}>
                    {(() => {
                      if (!b.description) return "(No description provided)";
                      const bracketMatch = b.description.match(/^([^(]+?)\s*[\(\[]([^)\]]+)[\)\]]$/);
                      if (bracketMatch) {
                        return `${bracketMatch[2].trim()} (${bracketMatch[1].trim()})`;
                      }
                      return b.description;
                    })()}
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.2fr", gap: "10px" }}>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Amount</label>
                  <input type="number" step="0.01" value={b.amount} onChange={e => updateBlock(i, "amount", parseFloat(e.target.value) || 0)}
                    style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Status</label>
                  <div style={{ padding: "7px 9px", fontSize: "13px", fontWeight: "600", color: sc.text }}>{b.status || "-"}</div>
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Rec date</label>
                  <div style={{ padding: "7px 9px", fontSize: "13px", color: "#334155" }}>{b.recDate || "-"}</div>
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Pay date</label>
                  {isManual ? (
                    <CalendarDatePicker value={b.payDate} onChange={val => updateBlock(i, "payDate", val)} />
                  ) : <div style={{ padding: "7px 9px", fontSize: "13px", color: "#334155" }}>{b.payDate || "-"}</div>}
                </div>
              </div>
              <div style={{ marginTop: "10px", borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: "10px" }}>
                <div style={{ fontSize: "11px", color: "#888", marginBottom: "6px" }}>Split portion to another month:</div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  {[...(prevMonth ? [{ m: prevMonth, dir: "◀" }] : []), ...(nextMonth ? [{ m: nextMonth, dir: "▶" }] : [])].map(({ m, dir }) => {
                    const key = `${i}_${m.colLetter}`;
                    return (
                      <div key={m.colLetter} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{ fontSize: "11px", color: "#666" }}>{dir} {fmtMonthLabel(m.isoMonth || m.label)}:</span>
                        <input type="number" step="0.01" value={splitAmts[key] || ""}
                          onChange={e => setSplitAmts(prev => ({ ...prev, [key]: e.target.value }))}
                          placeholder="amt" style={{ width: "70px", padding: "4px 6px", border: "1px solid #ddd", borderRadius: "4px", fontSize: "12px" }} />
                        <button onClick={() => doSplit(i, m.colLetter, splitAmts[key])}
                          disabled={!splitAmts[key] || parseFloat(splitAmts[key]) <= 0 || parseFloat(splitAmts[key]) >= b.amount}
                          style={{ padding: "4px 8px", background: "#f0f4ff", border: "1px solid #c5cff0", borderRadius: "4px", cursor: "pointer", fontSize: "11px", color: "#3a57c4" }}>Split</button>
                      </div>
                    );
                  })}
                  {!prevMonth && !nextMonth && <span style={{ fontSize: "11px", color: "#bbb" }}>No adjacent months visible</span>}
                </div>
              </div>
              <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "11px", color: "#888" }}>Move to:</span>
                <select value="" onChange={e => doMove(i, e.target.value)}
                  style={{ padding: "4px 6px", border: "1px solid #ddd", borderRadius: "4px", fontSize: "11px" }}>
                  <option value="">- select month -</option>
                  {(outgoingsData?.months || []).filter(m => m.colLetter !== colLetter).map(m => (
                    <option key={m.colLetter} value={m.colLetter}>{fmtMonthLabel(m.isoMonth || m.label)}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}

        {/* ── CREATE EXPENSE FORM ───────────────────────────────────────── */}
        {(blocks.length === 0 || showAddForm) && (
          <div style={{
            background: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "14px",
            marginBottom: "16px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: "#1e293b" }}>
                {blocks.length === 0 ? "Create new expense" : "Add another expense"}
              </span>
              {blocks.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setNewAmount("");
                    setNewDescription("");
                    setNewPayDate(defaultPayDate);
                    setAddError("");
                  }}
                  style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "14px" }}
                >
                  ✕
                </button>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <div>
                <label style={{ fontSize: "11px", color: "#475569", display: "block", marginBottom: "3px", fontWeight: "600" }}>
                  Amount (£) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newAmount}
                  onChange={e => {
                    setNewAmount(e.target.value);
                    if (addError) setAddError("");
                  }}
                  placeholder="0.00"
                  autoFocus={blocks.length === 0}
                  style={{
                    width: "100%",
                    padding: "7px 10px",
                    border: addError ? "1px solid #ef4444" : "1px solid #cbd5e1",
                    borderRadius: "5px",
                    fontSize: "13px",
                    boxSizing: "border-box"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: "11px", color: "#475569", display: "block", marginBottom: "3px", fontWeight: "600" }}>
                  Expected pay date
                </label>
                <CalendarDatePicker
                  value={newPayDate}
                  onChange={val => setNewPayDate(val)}
                  placeholder="Select pay date"
                />
              </div>
            </div>

            <div style={{ marginBottom: "12px" }}>
              <label style={{ fontSize: "11px", color: "#475569", display: "block", marginBottom: "3px", fontWeight: "600" }}>
                Description
              </label>
              <input
                type="text"
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder={`e.g. ${contractor.name} expense`}
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }}
              />
            </div>

            {addError && (
              <div style={{ fontSize: "11px", color: "#ef4444", marginBottom: "10px" }}>{addError}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={handleAddExpense}
                style={{
                  padding: "6px 14px",
                  background: "#1a56db",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "5px",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Add to expense list
              </button>
            </div>
          </div>
        )}

        {/* ── SECTION 2: CELL NOTE (MOVED TO BOTTOM) ───────────────────── */}
        <div style={{ marginBottom: "16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <label style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>
              Cell note
            </label>
            <span style={{ fontSize: "11px", color: "#64748b" }}>Synced to Google Sheet cell note</span>
          </div>
          <textarea
            value={topNote}
            onChange={(e) => {
              dirtyRef.current = true;
              setTopNote(e.target.value);
            }}
            placeholder="Add note for this cell..."
            rows={2}
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: "12px",
              lineHeight: "1.4",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              boxSizing: "border-box",
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </div>

        {/* ── FOOTER ACTIONS ───────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end", borderTop: "1px solid #f0f0f0", paddingTop: "16px", alignItems: "center" }}>
          {savedMsg && <span style={{ fontSize: "13px", color: "#2e7d32", fontWeight: "600", marginRight: "auto" }}>{savedMsg}</span>}
          <button onClick={() => onClose()}
            style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
            {dirtyRef.current || newAmount.trim() ? "Cancel" : "Close"}
          </button>
          <button onClick={save} disabled={saving}
            style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}