import React, { useState } from "react";

export default function OutgoingsNewVendorModal({ newVendorData, outgoingsClient, onClose, onCreated }) {
  const { exp } = newVendorData;
  const [vendorName, setVendorName] = useState(exp.description || exp.accountName || "");
  const [vatFlag, setVatFlag] = useState("Yes");
  const [invTiming, setInvTiming] = useState("Next");
  const [payTiming, setPayTiming] = useState("Next");
  const [deliveryPct, setDeliveryPct] = useState("100");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!vendorName.trim()) { setError("Please enter a vendor name"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_outgoings_vendor",
          clientSheetId: outgoingsClient?.clientSheetId,
          vendorName: vendorName.trim(),
          vatFlag, invTiming, payTiming, deliveryPct: parseFloat(deliveryPct) || 100,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to create vendor"); setSaving(false); return; }
      
      await onCreated();
      onClose();
    } catch(e) { setError(e.message); setSaving(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 440px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Create new vendor</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>
        <div style={{ fontSize: "12px", color: "#888", background: "#f8f8f8", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
          <strong>Expense to place:</strong> {exp.description || exp.accountName} — £{exp.amount}<br/>
          <span style={{ fontFamily: "monospace", fontSize: "10px" }}>{exp.appId}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px" }}>Vendor name (col A) *</label>
            <input type="text" value={vendorName} onChange={e => setVendorName(e.target.value)} autoFocus
              style={{ width: "100%", padding: "9px 11px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "16px", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>VAT?</label>
              <select value={vatFlag} onChange={e => setVatFlag(e.target.value)}
                style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px" }}>
                <option>Yes</option><option>No</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Delivery %</label>
              <input type="number" value={deliveryPct} onChange={e => setDeliveryPct(e.target.value)}
                style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Inv timing</label>
              <select value={invTiming} onChange={e => setInvTiming(e.target.value)}
                style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px" }}>
                <option>Next</option><option>Curr</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "3px" }}>Pay timing</label>
              <select value={payTiming} onChange={e => setPayTiming(e.target.value)}
                style={{ width: "100%", padding: "7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px" }}>
                <option>Next</option><option>Curr</option>
              </select>
            </div>
          </div>
          {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px" }}>{error}</div>}
        </div>
        <p style={{ fontSize: "11px", color: "#999", margin: "12px 0 0" }}>
          A new row will be inserted in the Contractors section of the Outgoings tab. You can then place the expense in the correct month cell.
        </p>
        <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
          <button onClick={save} disabled={saving || !vendorName.trim()}
            style={{ padding: "8px 22px", background: saving || !vendorName.trim() ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
            {saving ? "Creating..." : "Create vendor"}
          </button>
        </div>
      </div>
    </div>
  );
}