import React, { useState, useRef, useEffect } from "react";
import { toSheetDateFormat, toInputDateFormat } from "../utils/helpers";

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

function getMonthDetails(monthObj) {
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
        border: "1px solid #ddd",
        borderRadius: "6px",
        fontSize: "14px",
        backgroundColor: "#ffffff",
        boxSizing: "border-box",
        cursor: "pointer",
        minHeight: "38px",
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

export default function OutgoingsEstimateModal({ estimateData, outgoingsData, updateCell, onClose }) {
  const { contractor } = estimateData;
  const [amount, setAmount] = useState("");
  const defaultIdx = outgoingsData ? Math.max(0, outgoingsData.months.findIndex(m => m.colLetter === estimateData.colLetter)) : 0;
  const [selectedMonthIdx, setSelectedMonthIdx] = useState(defaultIdx);
  const selectedMonth = outgoingsData?.months?.[selectedMonthIdx];

  const { baseDate, dateStr } = getMonthDetails(selectedMonth);
  const defaultPayDate = computeTargetDate(baseDate, contractor?.payTiming, 28);
  const defaultRecDate = computeTargetDate(baseDate, contractor?.invTiming, 5);

  const [payDate, setPayDate] = useState(defaultPayDate);
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedMonth) {
      const details = getMonthDetails(selectedMonth);
      setPayDate(computeTargetDate(details.baseDate, contractor?.payTiming, 28));
    }
  }, [selectedMonthIdx, contractor?.payTiming]);

  const save = async () => {
    if (!amount || !selectedMonth) return;
    setSaving(true);
    const manualId = generatePlaceholderId(contractor?.name, dateStr);
    const existing = (contractor.cells?.[selectedMonth.colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"));
    await updateCell(contractor, selectedMonth.colLetter, [...existing, {
      appId: manualId,
      amount: parseFloat(amount),
      status: "",
      recDate: defaultRecDate,
      payDate: payDate || defaultPayDate,
      description: desc.trim() || `${contractor.name} expense`,
    }]);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 440px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Add estimate</h3>
            <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>{contractor.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Month *</label>
            <select value={selectedMonthIdx} onChange={e => setSelectedMonthIdx(parseInt(e.target.value, 10))}
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px" }}>
              {(outgoingsData?.months || []).map((m, idx) => <option key={m.colLetter} value={idx}>{fmtMonthLabel(m.isoMonth || m.label)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Amount (£) *</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" autoFocus
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Expected pay date</label>
            <CalendarDatePicker value={payDate} onChange={val => setPayDate(val)} placeholder="Select pay date" />
          </div>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Description</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder={`e.g. ${contractor.name} expense`}
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
          <button onClick={save} disabled={!amount || saving}
            style={{ padding: "8px 22px", background: !amount ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: !amount ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
            {saving ? "Adding..." : "Add estimate"}
          </button>
        </div>
      </div>
    </div>
  );
}