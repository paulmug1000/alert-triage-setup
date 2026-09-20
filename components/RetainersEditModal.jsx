import React from "react";
import Spinner from "./Spinner";

export default function RetainersEditModal({ job, clientSheetId, masterSheetId, onClose, onRenamedInPlace, onNeedsReload }) {
  // Converts a sheet-formatted date string like "15-Mar-26" (or a few other common
  // shapes) to ISO "YYYY-MM-DD" for use with a native <input type="date">.
  const RET_MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const sheetDateToISO = (val) => {
    if (!val) return "";
    const s = String(val).trim();
    const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) {
      const mi = RET_MONTHS[m[2].toLowerCase()];
      if (mi === undefined) return "";
      // Pivot-aware century guess for a 2-digit year, matching common spreadsheet
      // convention: 00-69 -> 20XX, 70-99 -> 19XX. Retainer dates are essentially
      // never in the 1900s, but this is more robust than always assuming 20XX.
      let yr;
      if (m[3].length === 2) {
        const twoDigit = parseInt(m[3], 10);
        yr = (twoDigit <= 69 ? 2000 : 1900) + twoDigit;
      } else {
        yr = parseInt(m[3], 10);
      }
      const dd = String(parseInt(m[1], 10)).padStart(2, "0");
      const mm = String(mi + 1).padStart(2, "0");
      return `${yr}-${mm}-${dd}`;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  };
  // Converts ISO "YYYY-MM-DD" back to the sheet's "DD-Mon-YY" display format
  const isoToSheetDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return "";
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d}-${months[m-1]}-${y}`;
  };

  const jobStartISO = sheetDateToISO(job.rows[0]?.startDate);
  const jobEndISO = sheetDateToISO(job.rows[0]?.endDate);

  const [jobName, setJobName] = React.useState(job.jobName || "");
  const [endDate, setEndDate] = React.useState(jobEndISO); 
  const [changingAmount, setChangingAmount] = React.useState(false);
  const [newAmount, setNewAmount] = React.useState("");
  const [changeMonth, setChangeMonth] = React.useState(""); 
  const [saving, setSaving] = React.useState(false);
  const [savingMessage, setSavingMessage] = React.useState("");
  const [error, setError] = React.useState("");

  const close = () => { if (!saving) onClose(); };

  const saveNameAndDate = async () => {
    setError("");
    const nameChanged = jobName !== job.jobName;
    const dateChanged = endDate !== jobEndISO;

    if (!jobName.trim()) { setError("Job name can&apost be blank."); return; }
    if (dateChanged) {
      if (!endDate) { setError("Please enter a valid end date."); return; }
      if (jobStartISO && endDate < jobStartISO) { setError("End date can&apost be before the job&aposs start date."); return; }
    }

    setSaving(true);
    try {
      if (nameChanged) {
        setSavingMessage("Renaming job...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "rename_retainer_job",
            clientSheetId, oldClient: job.client, oldJobName: job.jobName, newJobName: jobName,
            parentRowNum: job.parentRowNum,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to rename job"); setSaving(false); setSavingMessage(""); return; }
      }
      if (dateChanged) {
        setSavingMessage("Updating end date — this can take a little while if rows need to be added or removed...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_end_date",
            clientSheetId, masterSheetId,
            client: job.client, jobName: jobName, parentRowNum: job.parentRowNum,
            newEndDate: isoToSheetDate(endDate),
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || (data.blocked ? data.error : "Failed to change end date")); setSaving(false); setSavingMessage(""); return; }
        setSavingMessage("Refreshing job list...");
        await onNeedsReload();
        onClose();
        return;
      }
      if (nameChanged) {
        onRenamedInPlace(jobName);
      }
      onClose();
    } catch(e) { setError(e.message); setSaving(false); setSavingMessage(""); }
  };

  const saveAmountChange = async () => {
    setError("");
    if (!changeMonth) { setError("Please select the month the change takes effect."); return; }
    const parsedAmount = parseFloat(newAmount);
    if (!newAmount || isNaN(parsedAmount) || parsedAmount <= 0) { setError("Please enter a new monthly amount greater than zero."); return; }
    if (jobStartISO && changeMonth < jobStartISO.slice(0, 7)) {
      setError("The change month can&apost be before the job&aposs start date.");
      return;
    }
    if (jobEndISO && changeMonth > jobEndISO.slice(0, 7)) {
      setError("The change month is after the job&aposs current end date — please pick an earlier month, or extend the end date first.");
      return;
    }
    setSaving(true);
    try {
      setSavingMessage("Splitting the retainer at the new amount — this can take a little while...");
      const [yr, mo] = changeMonth.split("-").map(Number);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "change_retainer_monthly_amount",
          clientSheetId, client: job.client, jobName: job.jobName, parentRowNum: job.parentRowNum,
          changeMonth: mo - 1, changeYear: yr, newMonthlyAmount: parsedAmount,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to change monthly amount"); setSaving(false); setSavingMessage(""); return; }
      setSavingMessage("Refreshing job list...");
      await onNeedsReload();
      onClose();
    } catch(e) { setError(e.message); setSaving(false); setSavingMessage(""); }
  };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "16px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 520px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Edit retainer — {job.client}</h3>
          {!saving && <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>}
        </div>

        {saving ? (
          <div style={{ padding: "30px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
            <Spinner size={32} color="#7c3aed" />
            <div style={{ fontSize: "14px", color: "#5b21b6", fontWeight: "600" }}>{savingMessage || "Saving..."}</div>
            <div style={{ fontSize: "12px", color: "#999" }}>Please don&apos;t close this window until it&apos;s done.</div>
          </div>
        ) : !changingAmount ? (
          <>
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Job name</label>
                <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>End date</label>
                <input type="date" style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={jobStartISO || undefined} />
              </div>
            </div>

            <div style={{ marginTop: "16px", padding: "12px", background: "#f5f3ff", borderRadius: "8px", border: "1px solid #ddd6fe" }}>
              <div style={{ fontSize: "13px", fontWeight: "600", color: "#5b21b6", marginBottom: "6px" }}>Monthly amount</div>
              <div style={{ fontSize: "13px", color: "#333", marginBottom: "8px" }}>Current: {/^[£$€]/.test(String(job.revenue)) ? job.revenue : `£${job.revenue}`}/month</div>
              <button onClick={() => setChangingAmount(true)}
                style={{ padding: "7px 14px", background: "#fff", border: "1px solid #7c3aed", color: "#7c3aed", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Change monthly amount…
              </button>
            </div>

            {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}

            <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "flex-end" }}>
              <button onClick={close} disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={saveNameAndDate} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: "13px", color: "#666", marginBottom: "14px" }}>
              This will end the current retainer at the end of the month before your chosen month, and start a new retainer job from that month at the new amount.
            </div>
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Month the change takes effect</label>
                <input type="month" style={inputStyle} value={changeMonth} onChange={e => setChangeMonth(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>New monthly amount (£)</label>
                <input type="number" step="0.01" style={inputStyle} value={newAmount} onChange={e => setNewAmount(e.target.value)} />
              </div>
            </div>

            {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}

            <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "space-between" }}>
              <button onClick={() => { setChangingAmount(false); setError(""); }} disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>← Back</button>
              <button onClick={saveAmountChange} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#7c3aed", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Applying..." : "Apply change"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}