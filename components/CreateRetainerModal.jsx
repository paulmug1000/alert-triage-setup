import React from "react";
import Spinner from "./Spinner";

export default function CreateRetainerModal({ clientName: agencyClientName, clientSheetId, masterSheetId, onClose, onCreated }) {
  const [endClientName, setEndClientName] = React.useState("");
  const [jobName, setJobName] = React.useState("");
  const [monthlyRevenue, setMonthlyRevenue] = React.useState("");
  const [monthlyDirectCosts, setMonthlyDirectCosts] = React.useState("");
  const [vat, setVat] = React.useState("No");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [invoiceFrequency, setInvoiceFrequency] = React.useState("monthly");
  const [invoiceSendDay, setInvoiceSendDay] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [savingMessage, setSavingMessage] = React.useState("");
  const [error, setError] = React.useState("");

  const close = () => { if (!saving) onClose(); };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  const handleCreate = async () => {
    setError("");
    if (!endClientName.trim()) { setError("Please enter the end client's name."); return; }
    if (!jobName.trim()) { setError("Please enter a job name."); return; }
    const revenue = parseFloat(monthlyRevenue);
    if (!monthlyRevenue || isNaN(revenue) || revenue <= 0) { setError("Please enter a monthly revenue amount greater than zero."); return; }
    const directCosts = monthlyDirectCosts === "" ? 0 : parseFloat(monthlyDirectCosts);
    if (isNaN(directCosts) || directCosts < 0) { setError("Direct costs must be zero or a positive number."); return; }
    if (!startDate) { setError("Please enter a start date."); return; }
    if (!endDate) { setError("Please enter an end date."); return; }
    if (endDate < startDate) { setError("End date can't be before start date."); return; }
    const sendDay = parseInt(invoiceSendDay, 10);
    if (!invoiceSendDay || isNaN(sendDay) || sendDay < 1 || sendDay > 31) { setError("Please enter a valid day of the month (1-31) for invoices to be sent on."); return; }

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const isoToSheetDate = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      return `${d}-${months[m-1]}-${y}`;
    };

    setSaving(true);
    setSavingMessage("Creating the retainer and its invoice schedule — this can take a little while...");
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_retainer_job",
          clientSheetId, masterSheetId,
          clientName: agencyClientName || "",
          client: endClientName.trim(), jobName: jobName.trim(),
          monthlyRevenue: revenue, monthlyDirectCosts: directCosts, vat,
          startDate: isoToSheetDate(startDate), endDate: isoToSheetDate(endDate),
          invoiceFrequency, invoiceSendDay: sendDay,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to create retainer"); setSaving(false); setSavingMessage(""); return; }
      setSavingMessage("Refreshing job list...");
      await onCreated();
      onClose();
    } catch (e) { setError(e.message); setSaving(false); setSavingMessage(""); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 520px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Create retainer — {agencyClientName}</h3>
          {!saving && <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>}
        </div>

        {saving ? (
          <div style={{ padding: "30px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
            <Spinner size={32} color="#7c3aed" />
            <div style={{ fontSize: "14px", color: "#5b21b6", fontWeight: "600" }}>{savingMessage || "Saving..."}</div>
            <div style={{ fontSize: "12px", color: "#999" }}>Please don&apos;t close this window until it&apos;s done.</div>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label style={labelStyle}>End client name</label>
                <input style={inputStyle} value={endClientName} onChange={e => setEndClientName(e.target.value)} placeholder="e.g. Gong cha Ltd" />
              </div>
              <div>
                <label style={labelStyle}>Job name</label>
                <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} placeholder="e.g. Campaign retainer" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>Monthly revenue (£)</label>
                  <input type="number" step="0.01" style={inputStyle} value={monthlyRevenue} onChange={e => setMonthlyRevenue(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Monthly direct costs (£)</label>
                  <input type="number" step="0.01" style={inputStyle} value={monthlyDirectCosts} onChange={e => setMonthlyDirectCosts(e.target.value)} placeholder="0" />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>VAT?</label>
                  <select style={inputStyle} value={vat} onChange={e => setVat(e.target.value)}>
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Invoicing frequency</label>
                  <select style={inputStyle} value={invoiceFrequency} onChange={e => setInvoiceFrequency(e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={labelStyle}>Start date</label>
                  <input type="date" style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>End date</label>
                  <input type="date" style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate || undefined} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Day of the month invoices are sent</label>
                <input type="number" min="1" max="31" style={inputStyle} value={invoiceSendDay} onChange={e => setInvoiceSendDay(e.target.value)} placeholder="e.g. 1 or 28" />
              </div>
            </div>

            {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}

            <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "flex-end" }}>
              <button onClick={close} disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={handleCreate} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Creating..." : "Create retainer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}