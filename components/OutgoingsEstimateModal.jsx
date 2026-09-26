import React, { useState } from "react";

export default function OutgoingsEstimateModal({ estimateData, outgoingsData, updateCell, onClose }) {
  const { contractor } = estimateData;
  const [amount, setAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  
  const defaultIdx = outgoingsData ? Math.max(0, outgoingsData.months.findIndex(m => m.colLetter === estimateData.colLetter)) : 0;
  const [selectedMonthIdx, setSelectedMonthIdx] = useState(defaultIdx);
  const selectedMonth = outgoingsData?.months[selectedMonthIdx];

  const fmtMonthLabel = (labelOrIso) => {
    if (!labelOrIso) return "";
    const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, 1);
      return d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    }
    return String(labelOrIso).slice(0, 7);
  };

  const save = async () => {
    if (!amount || !selectedMonth) return;
    setSaving(true);
    const manualId = `PLACE-EXP-${Date.now()}`;
    const existing = (contractor.cells[selectedMonth.colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"));
    await updateCell(contractor, selectedMonth.colLetter, [...existing, {
      appId: manualId, amount: parseFloat(amount), status: "", recDate: "", payDate: payDate || "",
      description: desc || `${contractor.name} estimate`,
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
            <select value={selectedMonthIdx} onChange={e => setSelectedMonthIdx(parseInt(e.target.value))}
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
            <input type="text" value={payDate} onChange={e => setPayDate(e.target.value)} placeholder="e.g. 28-Apr-26"
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Description</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional note"
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