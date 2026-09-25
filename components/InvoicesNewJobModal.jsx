import React, { useState } from "react";

export default function InvoicesNewJobModal({ 
  newJobData, 
  invoicesClient, 
  onClose, 
  onSuccess, 
  onMarkPullPending 
}) {
  const { inv } = newJobData;
  const [jobName, setJobName] = useState(inv.job || "");
  const [projectCode, setProjectCode] = useState("");
  const [revenue, setRevenue] = useState(String(inv.amount || ""));
  const [directCosts, setDirectCosts] = useState("0");
  const [vatYesNo, setVatYesNo] = useState(inv.vatAmount > 0 ? "Yes" : "No");
  const [projectType, setProjectType] = useState("Project");
  const [startDate, setStartDate] = useState(inv.sentDate || "");
  const [endDate, setEndDate] = useState(inv.dueDate || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const close = () => { if (!saving) onClose(); };

  const save = async () => {
    if (!jobName.trim()) { setError("Please enter a job name"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_job_from_invoice",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          jobName: jobName.trim(), projectCode: projectCode.trim(),
          revenue: parseFloat(revenue) || 0, directCosts: parseFloat(directCosts) || 0,
          vatYesNo, projectType, startDate, endDate,
          invoice: inv,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to create job"); setSaving(false); return; }
      
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      
      // Trigger all the state updates back in the parent component
      onSuccess(inv);
      close();
    } catch(e) { setError(e.message); setSaving(false); }
  };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Create new job</h3>
          <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>
        <div style={{ fontSize: "12px", color: "#888", background: "#f8f8f8", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
          <strong>Invoice to place:</strong> #{inv.invoiceNo} — £{inv.amount.toFixed(2)}<br/>
          {inv.client}{inv.job ? ` — ${inv.job}` : ""} · {inv.sentDate}
        </div>

        <div style={{ display: "grid", gap: "12px" }}>
          <div>
            <label style={labelStyle}>Client (col A)</label>
            <input style={{ ...inputStyle, background: "#f5f5f5", color: "#888" }} value={inv.client || ""} disabled />
          </div>
          <div>
            <label style={labelStyle}>Job name (col B) *</label>
            <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Project code (col C)</label>
            <input style={inputStyle} value={projectCode} onChange={e => setProjectCode(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Revenue (£, AG)</label>
              <input style={inputStyle} type="number" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Direct costs (£, AH)</label>
              <input style={inputStyle} type="number" step="0.01" value={directCosts} onChange={e => setDirectCosts(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>VAT? (AI)</label>
              <select style={inputStyle} value={vatYesNo} onChange={e => setVatYesNo(e.target.value)}>
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Type (AJ)</label>
              <select style={inputStyle} value={projectType} onChange={e => setProjectType(e.target.value)}>
                <option value="Project">Project</option>
                <option value="Retainer">Retainer</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Start date (AL)</label>
              <input style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} placeholder="DD-Mon-YY" />
            </div>
            <div>
              <label style={labelStyle}>End date (AM)</label>
              <input style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} placeholder="DD-Mon-YY" />
            </div>
          </div>
        </div>

        {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}
        <p style={{ fontSize: "11px", color: "#999", margin: "12px 0 0" }}>
          A new row will be added at the end of the Confirmed tab, and this invoice will be written into slot 1.
        </p>
        <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
          <button onClick={close} disabled={saving}
            style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
          <button onClick={save} disabled={saving || !jobName.trim()}
            style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
            {saving ? "Creating..." : "Create job"}
          </button>
        </div>
      </div>
    </div>
  );
}