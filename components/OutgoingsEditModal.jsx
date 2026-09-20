import React, { useState, useRef, useEffect } from "react";

const STATUS_COLOURS = {
  "Paid":     { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
  "Received": { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
  "Draft":    { bg: "#fff8e1", border: "#ffc107", text: "#e65100" },
  "":         { bg: "#f5f5f5", border: "#bdbdbd", text: "#616161" },
};
const getStatusColour = (s) => STATUS_COLOURS[s] || STATUS_COLOURS[""];

const fmtMonthLabel = (labelOrIso) => {
  if (!labelOrIso) return "";
  const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, 1);
    return d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
  }
  return String(labelOrIso).slice(0, 7);
};

export default function OutgoingsEditModal({ editCellData, outgoingsData, updateCell, onReturnToInbox, onClose }) {
  const { contractor, colLetter, monthLabel } = editCellData;
  const [blocks, setBlocks] = useState(
    (contractor.cells[colLetter]?.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"))
  );
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [splitAmts, setSplitAmts] = useState({});
  
  // Track whether blocks have been modified since last write
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

  const save = async () => {
    if (!dirtyRef.current) { onClose(); return; }
    setSaving(true);
    setSavedMsg("");
    await updateCell(contractor, colLetter, blocksRef.current);
    setSaving(false);
    setSavedMsg("Saved ✓");
    await new Promise(r => setTimeout(r, 600));
    onClose();
  };

  const currentMonthIdx = outgoingsData?.months.findIndex(m => m.colLetter === colLetter) ?? -1;
  const prevMonth = currentMonthIdx > 0 ? outgoingsData.months[currentMonthIdx - 1] : null;
  const nextMonth = currentMonthIdx >= 0 && currentMonthIdx < (outgoingsData?.months.length ?? 0) - 1 ? outgoingsData.months[currentMonthIdx + 1] : null;

  const doSplit = (blockIdx, targetCol, amt) => {
    const b = blocks[blockIdx];
    const splitAmt = parseFloat(amt);
    if (!splitAmt || splitAmt <= 0 || splitAmt >= b.amount) return;
    const newSrcAmt = parseFloat((b.amount - splitAmt).toFixed(2));
    const newBlocks = blocks.map((bl, i) => i === blockIdx ? { ...bl, amount: newSrcAmt } : bl);
    blocksRef.current = newBlocks;
    dirtyRef.current = false; // already written below — don't re-write on Save
    setBlocks(newBlocks);
    // Write reduced source cell immediately
    updateCell(contractor, colLetter, newBlocks);
    // Write split portion to target month
    const tb = [...(contractor.cells[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))];
    tb.push({ ...b, amount: splitAmt });
    updateCell(contractor, targetCol, tb);
    setSplitAmts(prev => ({ ...prev, [`${blockIdx}_${targetCol}`]: "" }));
    setSavedMsg("Split saved ✓");
  };

  const doMove = (blockIdx, targetCol) => {
    if (!targetCol) return;
    const b = blocks[blockIdx];
    setBlocks(prev => prev.filter((_, idx) => idx !== blockIdx));
    const tb = [...(contractor.cells[targetCol]?.blocks || []).filter(bl => !bl.appId.startsWith("UNRECON-GAP"))];
    tb.push({ ...b });
    updateCell(contractor, targetCol, tb);
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
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>x</button>
        </div>

        {blocks.length === 0 && <div style={{ color: "#bbb", fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No expenses in this cell</div>}

        {blocks.map((b, i) => {
          const sc = getStatusColour(b.status);
          const isManual = b.appId.startsWith("MANUAL-ENTRY");
          return (
            <div key={i} style={{ border: `1px solid ${sc.border}`, background: sc.bg, borderRadius: "8px", padding: "14px", marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                <div style={{ fontSize: "13px", color: "#888", fontFamily: "monospace", wordBreak: "break-all", flex: 1, marginRight: "8px" }}>{b.appId}</div>
                <button onClick={() => removeBlock(i)} style={{ background: "none", border: "none", color: "#e53935", cursor: "pointer", fontSize: "12px" }}>Remove</button>
                {!b.appId.startsWith("MANUAL-ENTRY") && !b.appId.startsWith("UNRECON-GAP") && (
                  <button onClick={async () => {
                    // Remove block from cell, write immediately, return to inbox, close modal
                    const newBlocks = blocksRef.current.filter((_, idx) => idx !== i);
                    blocksRef.current = newBlocks;
                    dirtyRef.current = false;
                    // Update grid and write to Sheets
                    await updateCell(contractor, colLetter, newBlocks);
                    // Return to inbox
                    onReturnToInbox({
                      appId: b.appId, amount: b.amount,
                      date: b.recDate || "", datePaid: b.payDate || "",
                      description: b.description || "", accountName: b.description || "",
                      status: b.status || "",
                    });
                    // Close modal
                    onClose();
                  }} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "12px" }}>↩ Return to inbox</button>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Amount</label>
                  <input type="number" step="0.01" value={b.amount} onChange={e => updateBlock(i, "amount", parseFloat(e.target.value) || 0)}
                    style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Status</label>
                  {isManual ? (
                    <select value={b.status} onChange={e => updateBlock(i, "status", e.target.value)}
                      style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px" }}>
                      <option value="">—</option>
                      <option>Received</option><option>Paid</option><option>Draft</option>
                    </select>
                  ) : <div style={{ padding: "7px 9px", fontSize: "13px", fontWeight: "600", color: sc.text }}>{b.status || "—"}</div>}
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Rec date</label>
                  <div style={{ padding: "7px 9px", fontSize: "13px" }}>{b.recDate || "—"}</div>
                </div>
                <div>
                  <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Pay date{isManual ? " (editable)" : ""}</label>
                  {isManual ? (
                    <input type="text" value={b.payDate} placeholder="e.g. 28-Apr-26" onChange={e => updateBlock(i, "payDate", e.target.value)}
                      style={{ width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", boxSizing: "border-box" }} />
                  ) : <div style={{ padding: "7px 9px", fontSize: "13px" }}>{b.payDate || "—"}</div>}
                </div>
              </div>
              <div style={{ marginTop: "10px" }}>
                <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Description</label>
                <div style={{ padding: "7px 9px", fontSize: "12px", color: "#333", background: "rgba(255,255,255,0.7)", borderRadius: "4px", border: "1px solid rgba(0,0,0,0.06)" }}>{b.description || "—"}</div>
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
                  <option value="">— select month —</option>
                  {(outgoingsData?.months || []).filter(m => m.colLetter !== colLetter).map(m => (
                    <option key={m.colLetter} value={m.colLetter}>{fmtMonthLabel(m.isoMonth || m.label)}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}

        <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end", borderTop: "1px solid #f0f0f0", paddingTop: "16px", alignItems: "center" }}>
          {savedMsg && <span style={{ fontSize: "13px", color: "#2e7d32", fontWeight: "600", marginRight: "auto" }}>{savedMsg}</span>}
          <button onClick={() => onClose()}
            style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
            {dirtyRef.current ? "Cancel" : "Close"}
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