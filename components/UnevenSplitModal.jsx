import React, { useState, useEffect } from "react";

export default function UnevenSplitModal({ editSplit, client, tabName, onClose, onUpdateJobsData }) {
  const { jobRow } = editSplit;
  const [isActive, setIsActive] = useState(String(jobRow.unevenSplit || "").toLowerCase().startsWith("[split]"));
  const [lockedMonths, setLockedMonths] = useState({});
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const parseJobDate = (d) => {
    if (!d) return null;
    const m = String(d).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (!m) return null;
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return new Date(yr, months[m[2].toLowerCase()], 1);
  };

  const startDate = parseJobDate(jobRow.startDate);
  const endDate = parseJobDate(jobRow.endDate);
  const totalRev = parseFloat(String(jobRow.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;

  useEffect(() => {
    if (isActive) {
      const parsed = {};
      const parts = String(jobRow.unevenSplit || "").split(",");
      parts.forEach(p => {
        const m = p.match(/([a-zA-Z]{3}-\d{2})\s*:\s*([^,]+)/);
        if (m) parsed[m[1].toLowerCase().trim()] = parseFloat(m[2]) || 0;
      });
      setLockedMonths(parsed);
    }
  }, [jobRow.unevenSplit, isActive]);

  const getMonthsArray = () => {
    if (!startDate || !endDate || startDate > endDate) return [];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const m = [];
    let curr = new Date(startDate);
    while (curr <= endDate) {
      m.push(`${monthNames[curr.getMonth()]}-${String(curr.getFullYear()).slice(-2)}`);
      curr.setMonth(curr.getMonth() + 1);
    }
    return m;
  };

  const months = getMonthsArray();
  
  const validLocked = {};
  let lockedSum = 0;
  let lockedCount = 0;
  months.forEach(m => {
    const k = m.toLowerCase();
    if (lockedMonths[k] !== undefined) {
      validLocked[k] = lockedMonths[k];
      lockedSum += lockedMonths[k];
      lockedCount++;
    }
  });

  const remaining = totalRev - lockedSum;
  const unlockedCount = months.length - lockedCount;
  const evenSplit = unlockedCount > 0 ? (remaining / unlockedCount) : 0;

  let validationError = "";
  if (!startDate || !endDate) validationError = "Please ensure Start Date and End Date are set to split revenue.";
  else if (totalRev <= 0) validationError = "Total Revenue must be greater than zero.";
  else if (lockedSum > totalRev + 0.05) validationError = "Allocated revenue exceeds total job revenue.";
  else if (unlockedCount === 0 && Math.abs(remaining) > 0.05) validationError = "Total allocated revenue does not perfectly match the job revenue.";

  useEffect(() => { setErrorMsg(validationError); }, [validationError]);

  const handleSave = async () => {
    if (isActive && errorMsg) return;
    setSaving(true);
    try {
      let splitStr = "";
      if (isActive) {
        splitStr = "[Split]";
        months.forEach(m => {
          const val = validLocked[m.toLowerCase()] !== undefined ? validLocked[m.toLowerCase()] : evenSplit;
          splitStr += `,${m}:${Number.isInteger(val) ? val : val.toFixed(2)}`;
        });
      }
      
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_job_field", clientSheetId: client.clientSheetId, tabName, cellRef: `AE${jobRow.rowNum}`, value: splitStr })
      });
      
      onUpdateJobsData(jobRow.rowNum, splitStr);
      onClose();
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 600px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>Uneven Revenue Split</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>
        
        <div style={{ marginBottom: "16px", fontSize: "13px", color: "#555" }}>
          <strong>Job:</strong> {jobRow.jobName} <br/>
          <strong>Revenue:</strong> £{totalRev.toFixed(2)} | <strong>Dates:</strong> {jobRow.startDate || "?"} to {jobRow.endDate || "?"}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "600", fontSize: "14px", marginBottom: "16px", cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ width: "16px", height: "16px" }} />
          Enable custom revenue split across months
        </label>

        {isActive && (
          <div style={{ padding: "16px", background: "#f8fafc", border: `1px solid ${errorMsg ? '#ef4444' : '#e2e8f0'}`, borderRadius: "8px" }}>
            {errorMsg ? (
              <div style={{ color: "#ef4444", fontSize: "13px", fontWeight: "600", marginBottom: "12px" }}>{errorMsg}</div>
            ) : (
              <div style={{ color: "#0f172a", fontSize: "13px", marginBottom: "12px" }}>
                Remaining £{remaining.toFixed(2)} auto-distributed across {unlockedCount} unlocked months (£{evenSplit.toFixed(2)}/mo).
              </div>
            )}
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "10px" }}>
              {months.map(m => {
                const mKey = m.toLowerCase();
                const isLocked = validLocked[mKey] !== undefined;
                const val = isLocked ? validLocked[mKey] : evenSplit;
                return (
                  <div key={m} style={{ background: "#fff", padding: "8px", borderRadius: "6px", border: `1px solid ${isLocked ? '#0066cc' : '#e2e8f0'}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: isLocked ? "#0066cc" : "#64748b", fontWeight: "600", marginBottom: "4px" }}>
                      <span>{m}</span><span>{isLocked ? "🔒" : "Auto"}</span>
                    </div>
                    <div style={{ position: "relative" }}>
                      <span style={{ position: "absolute", left: "6px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: "12px" }}>£</span>
                      <input 
                        type="number" step="0.01" 
                        value={isLocked ? validLocked[mKey] : (Number.isInteger(val) ? val : val.toFixed(2))}
                        placeholder="Auto"
                        onChange={e => {
                          const v = e.target.value;
                          setLockedMonths(prev => {
                            const next = { ...prev };
                            if (v === "") delete next[mKey];
                            else next[mKey] = parseFloat(v);
                            return next;
                          });
                        }}
                        style={{ width: "100%", padding: "6px 6px 6px 16px", border: "none", background: "#f8fafc", borderRadius: "4px", fontSize: "13px", boxSizing: "border-box", color: isLocked ? "#000" : "#64748b" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", marginTop: "20px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || (isActive && !!errorMsg)} style={{ padding: "8px 22px", background: (saving || (isActive && !!errorMsg)) ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}