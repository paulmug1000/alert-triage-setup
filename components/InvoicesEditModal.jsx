import React, { useState } from "react";
import Spinner from "./Spinner";

export default function InvoicesEditModal({ 
  editSlot, 
  invoicesClient, 
  onClose, 
  onUpdateInvoiceJobs, 
  onMarkPullPending 
}) {
  const { rowNum, slotNum, slot } = editSlot;
  const stripCurrency = v => String(v ?? "").replace(/^[£$€]/, "").trim();
  
  const [invoiceNo, setInvoiceNo] = useState(slot.ref || "");
  const [amount, setAmount] = useState(stripCurrency(slot.amount));
  const [sentDate, setSentDate] = useState(slot.sentDate || "");
  const [daysToPay, setDaysToPay] = useState(slot.daysToPay || 30);
  const [status, setStatus] = useState(slot.status || "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const close = () => { if (!saving) onClose(); };

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          rowNum, slotNum,
          invoice: { invoiceNo, amount: parseFloat(amount) || 0, sentDate, daysToPay: parseInt(daysToPay) || 30, status },
        }),
      });
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      onUpdateInvoiceJobs(rowNum, slotNum, { 
        ref: invoiceNo, 
        amount: parseFloat(amount) || 0, 
        sentDate, 
        daysToPay: parseInt(daysToPay) || 30, 
        status 
      });
      close();
    } catch(e) { console.error("update_invoice_slot save error:", e); }
    finally { setSaving(false); }
  };

  const doDelete = async () => {
    setSaving(true);
    try {
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          rowNum, slotNum, deleteSlot: true,
        }),
      });
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      onUpdateInvoiceJobs(rowNum, slotNum, { 
        ref: "", amount: "", sentDate: "", daysToPay: "", status: "" 
      });
      close();
    } catch(e) { console.error("update_invoice_slot delete error:", e); }
    finally { setSaving(false); }
  };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Edit invoice — Row {rowNum}, Slot {slotNum}</h3>
          <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>

        <div style={{ display: "grid", gap: "12px" }}>
          <div>
            <label style={labelStyle}>Invoice number</label>
            <input style={inputStyle} value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Amount (£)</label>
              <input style={inputStyle} type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Days to pay</label>
              <input style={inputStyle} type="number" value={daysToPay} onChange={e => setDaysToPay(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Sent date</label>
            <input style={inputStyle} value={sentDate} onChange={e => setSentDate(e.target.value)} placeholder="DD-Mon-YY" />
          </div>
          <div>
            <label style={labelStyle}>Status</label>
            <input style={inputStyle} value={status} onChange={e => setStatus(e.target.value)} />
          </div>
        </div>

        {confirmingDelete ? (
          <div style={{ marginTop: "18px", padding: "12px", background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "8px" }}>
            <div style={{ fontSize: "13px", color: "#991b1b", marginBottom: "10px" }}>Delete this invoice entry? This clears all 5 fields for this slot and can&apos;t be undone from here.</div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmingDelete(false)} disabled={saving}
                style={{ padding: "7px 14px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={doDelete} disabled={saving}
                style={{ padding: "7px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Deleting..." : "Yes, delete"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
            <button onClick={() => setConfirmingDelete(true)} disabled={saving}
              style={{ padding: "8px 16px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
              Delete invoice
            </button>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={close} disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={save} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}