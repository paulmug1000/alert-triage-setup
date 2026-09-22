import React from "react";
import Spinner from "./Spinner";

// Converts a sheet-formatted date string like "15-Mar-26" (or a few other common
// shapes) to ISO "YYYY-MM-DD" for use with a native <input type="date">.
const RET_MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function sheetDateToISO(val) {
  if (!val) return "";
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = RET_MONTHS[m[2].toLowerCase()];
    if (mi === undefined) return "";
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
}

// Converts ISO "YYYY-MM-DD" back to the sheet's "DD-Mon-YY" display format
function isoToSheetDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d}-${months[m-1]}-${y}`;
}

export default function RetainersEditModal({ job, clientSheetId, masterSheetId, onClose, onRenamedInPlace, onNeedsReload }) {
  const jobStartISO = sheetDateToISO(job.rows[0]?.startDate);
  const jobEndISO = sheetDateToISO(job.rows[0]?.endDate);

  const hasRealInvoices = React.useMemo(() => {
    if (!job || !job.rows) return false;
    return job.rows.some(r =>
      (r.invoiceSlots || []).some(s => {
        const ref = String(s.ref || "").trim().toUpperCase();
        const status = String(s.status || "").trim().toLowerCase();
        return (ref && !ref.startsWith("MANUAL-INV")) || status.includes("sent") || status.includes("paid");
      })
    );
  }, [job]);

  const minSplitMonth = React.useMemo(() => {
    let latestMonth = jobStartISO ? jobStartISO.slice(0, 7) : "";
    if (job?.rows) {
      for (const r of job.rows) {
        for (const s of (r.invoiceSlots || [])) {
          const ref = String(s.ref || "").trim().toUpperCase();
          const status = String(s.status || "").trim().toLowerCase();
          if ((ref && !ref.startsWith("MANUAL-INV")) || status.includes("sent") || status.includes("paid")) {
            const sentISO = sheetDateToISO(s.sentDate);
            if (sentISO && sentISO.slice(0, 7) > latestMonth) {
              latestMonth = sentISO.slice(0, 7);
            }
          }
        }
      }
    }
    if (!latestMonth) return "";
    const [y, m] = latestMonth.split("-").map(Number);
    const nextDate = new Date(y, m, 1);
    return `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;
  }, [job, jobStartISO]);

  const currentRevenueClean = String(job.revenue || "").replace(/[^\d.-]/g, "");

  const [jobName, setJobName] = React.useState(job.jobName || "");
  const [startDate, setStartDate] = React.useState(jobStartISO);
  const [endDate, setEndDate] = React.useState(jobEndISO);
  const [wholeRetainerAmount, setWholeRetainerAmount] = React.useState(currentRevenueClean);

  const [changingAmount, setChangingAmount] = React.useState(false);
  const [newAmount, setNewAmount] = React.useState("");
  const [changeMonth, setChangeMonth] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [savingMessage, setSavingMessage] = React.useState("");
  const [error, setError] = React.useState("");

  const close = () => { if (!saving) onClose(); };

  const saveNameAndDate = async () => {
    setError("");
    const nameChanged = jobName.trim() !== job.jobName;
    const startChanged = !hasRealInvoices && startDate !== jobStartISO;
    const endChanged = endDate !== jobEndISO;

    const parsedWholeAmount = parseFloat(wholeRetainerAmount);
    const originalRevenueNum = parseFloat(currentRevenueClean) || 0;
    const amountChanged = !hasRealInvoices && !isNaN(parsedWholeAmount) && parsedWholeAmount > 0 && Math.abs(parsedWholeAmount - originalRevenueNum) > 0.001;

    if (!jobName.trim()) { setError("Job name cannot be blank."); return; }
    if (!startDate) { setError("Please enter a valid start date."); return; }
    if (!endDate) { setError("Please enter a valid end date."); return; }
    if (startDate && endDate && startDate > endDate) {
      setError("Start date cannot be after end date.");
      return;
    }
    if (!hasRealInvoices && (!wholeRetainerAmount || isNaN(parsedWholeAmount) || parsedWholeAmount <= 0)) {
      setError("Please enter a valid monthly amount greater than zero.");
      return;
    }

    if (!nameChanged && !startChanged && !endChanged && !amountChanged) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      if (nameChanged) {
        setSavingMessage("Renaming job...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "rename_retainer_job",
            clientSheetId, oldClient: job.client, oldJobName: job.jobName, newJobName: jobName.trim(),
            parentRowNum: job.parentRowNum,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to rename job"); setSaving(false); setSavingMessage(""); return; }
      }

      if (startChanged) {
        setSavingMessage("Updating start date and adjusting rows...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_start_date",
            clientSheetId, masterSheetId,
            client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            newStartDate: isoToSheetDate(startDate),
            newEndDate: endChanged ? isoToSheetDate(endDate) : undefined,
            newMonthlyAmount: amountChanged ? parsedWholeAmount : undefined,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to change start date"); setSaving(false); setSavingMessage(""); return; }
        setSavingMessage("Refreshing job list...");
        await onNeedsReload();
        onClose();
        return;
      }

      if (endChanged) {
        setSavingMessage("Updating end date — this can take a little while if rows need to be added or removed...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_end_date",
            clientSheetId, masterSheetId,
            client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            newEndDate: isoToSheetDate(endDate),
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || (data.blocked ? data.error : "Failed to change end date")); setSaving(false); setSavingMessage(""); return; }
      }

      if (amountChanged && !startChanged) {
        setSavingMessage("Updating monthly amount for the retainer...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_monthly_amount",
            clientSheetId, client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            changeWholeRetainer: true,
            newMonthlyAmount: parsedWholeAmount,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to change monthly amount"); setSaving(false); setSavingMessage(""); return; }
      }

      if (endChanged || amountChanged) {
        setSavingMessage("Refreshing job list...");
        await onNeedsReload();
        onClose();
        return;
      }

      if (nameChanged) {
        onRenamedInPlace(jobName.trim());
      }
      onClose();
    } catch(e) { setError(e.message); setSaving(false); setSavingMessage(""); }
  };

  const saveAmountChange = async () => {
    setError("");
    if (!changeMonth) { setError("Please select the month the change takes effect."); return; }
    const parsedAmount = parseFloat(newAmount);
    if (!newAmount || isNaN(parsedAmount) || parsedAmount <= 0) { setError("Please enter a new monthly amount greater than zero."); return; }
    if (minSplitMonth && changeMonth < minSplitMonth) {
      setError(`The change month must be ${minSplitMonth} or later. To change the whole retainer amount from the beginning, use the previous screen.`);
      return;
    }
    if (jobEndISO && changeMonth > jobEndISO.slice(0, 7)) {
      setError("The change month is after the job's current end date — please pick an earlier month, or extend the end date first.");
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

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "15px", boxSizing: "border-box" };
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
                <label style={labelStyle}>Start date</label>
                <input
                  type="date"
                  style={{ ...inputStyle, ...(hasRealInvoices ? { background: "#f9fafb", color: "#888", cursor: "not-allowed" } : {}) }}
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  disabled={hasRealInvoices}
                  max={endDate || undefined}
                />
                {hasRealInvoices && (
                  <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "3px" }}>
                    🔒 Start date is locked because invoices have already been issued.
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>End date</label>
                <input type="date" style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate || undefined} />
              </div>
            </div>

            <div style={{ marginTop: "16px", padding: "14px", background: "#f5f3ff", borderRadius: "8px", border: "1px solid #ddd6fe" }}>
              <div style={{ fontSize: "13px", fontWeight: "600", color: "#5b21b6", marginBottom: "6px" }}>Monthly amount</div>
              {!hasRealInvoices ? (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "15px", fontWeight: "600", color: "#374151" }}>£</span>
                    <input
                      type="number"
                      step="0.01"
                      style={{ ...inputStyle, width: "160px", padding: "6px 8px" }}
                      value={wholeRetainerAmount}
                      onChange={e => setWholeRetainerAmount(e.target.value)}
                    />
                    <span style={{ fontSize: "13px", color: "#6b7280" }}>/month</span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "10px" }}>
                    Applies to the whole retainer since no invoices have been sent yet.
                  </div>
                  <button
                    type="button"
                    onClick={() => { setChangingAmount(true); setError(""); }}
                    style={{ background: "none", border: "none", color: "#7c3aed", fontSize: "12px", fontWeight: "600", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                  >
                    Or split / change from a future month →
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: "13px", color: "#333", marginBottom: "8px" }}>
                    Current: {/^[£$€]/.test(String(job.revenue)) ? job.revenue : `£${job.revenue}`}/month
                  </div>
                  <button
                    onClick={() => { setChangingAmount(true); setError(""); }}
                    style={{ padding: "7px 14px", background: "#fff", border: "1px solid #7c3aed", color: "#7c3aed", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Change monthly amount (split at future month)…
                  </button>
                </div>
              )}
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
                <input
                  type="month"
                  style={inputStyle}
                  value={changeMonth}
                  onChange={e => setChangeMonth(e.target.value)}
                  min={minSplitMonth || undefined}
                  max={jobEndISO ? jobEndISO.slice(0, 7) : undefined}
                />
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