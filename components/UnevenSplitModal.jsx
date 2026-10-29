import React, { useState, useEffect, useMemo, useRef } from "react";
import SplitMonthCard from "./SplitMonthCard";
import { parseSplitString, formatSplitString } from "../services/splitHelper";

export default function UnevenSplitModal({ editSplit, client, tabName, onClose, onUpdateJobsData }) {
  const { jobRow } = editSplit;
  const [isActive, setIsActive] = useState(String(jobRow.unevenSplit || "").toLowerCase().startsWith("[split]"));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");

  const parseJobDate = (d) => {
    if (!d) return null;
    if (d instanceof Date) return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const s = String(d).trim();
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    // 1. ISO format: YYYY-MM-DD
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    }

    // 2. DD-Mon-YY or DD-Mon-YYYY
    const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) {
      const mIdx = months[m[2].toLowerCase()];
      if (mIdx !== undefined) {
        let yr = parseInt(m[3], 10);
        if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
        return new Date(yr, mIdx, parseInt(m[1], 10));
      }
    }

    // 3. Mon-YY or Mon-YYYY
    const myMatch = s.match(/^([A-Za-z]{3})[-/\s](\d{2,4})$/);
    if (myMatch) {
      const mIdx = months[myMatch[1].toLowerCase()];
      if (mIdx !== undefined) {
        let yr = parseInt(myMatch[2], 10);
        if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
        return new Date(yr, mIdx, 1);
      }
    }

    // 4. DD/MM/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
      let yr = parseInt(slashMatch[3], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
    }

    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  };

  const formatToSheet = (d) => {
    if (!d) return "";
    const parsed = parseJobDate(d);
    if (!parsed) return String(d).trim();
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const yy = String(parsed.getFullYear()).slice(-2);
    return `${parsed.getDate()}-${monthNames[parsed.getMonth()]}-${yy}`;
  };

  const totalRev = useMemo(() => {
    return parseFloat(String(jobRow.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
  }, [jobRow.revenue]);

  const { startDate, endDate, months } = useMemo(() => {
    const sDate = parseJobDate(jobRow.startDate);
    const eDate = parseJobDate(jobRow.endDate);
    if (!sDate || !eDate || sDate > eDate) {
      return { startDate: sDate, endDate: eDate, months: [] };
    }
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const m = [];
    let curr = new Date(sDate.getFullYear(), sDate.getMonth(), 1);
    const last = new Date(eDate.getFullYear(), eDate.getMonth(), 1);
    while (curr <= last) {
      m.push(`${monthNames[curr.getMonth()]}-${String(curr.getFullYear()).slice(-2)}`);
      curr.setMonth(curr.getMonth() + 1);
    }
    return { startDate: sDate, endDate: eDate, months: m };
  }, [jobRow.startDate, jobRow.endDate]);

  const [lockedMonths, setLockedMonths] = useState(() => {
    const sDate = parseJobDate(jobRow.startDate);
    const eDate = parseJobDate(jobRow.endDate);
    const mList = [];
    if (sDate && eDate && sDate <= eDate) {
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      let curr = new Date(sDate.getFullYear(), sDate.getMonth(), 1);
      const last = new Date(eDate.getFullYear(), eDate.getMonth(), 1);
      while (curr <= last) {
        mList.push(`${monthNames[curr.getMonth()]}-${String(curr.getFullYear()).slice(-2)}`);
        curr.setMonth(curr.getMonth() + 1);
      }
    }
    const rev = parseFloat(String(jobRow.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
    return parseSplitString(jobRow.unevenSplit, mList, rev);
  });

  const lockedMonthsRef = useRef(lockedMonths);
  lockedMonthsRef.current = lockedMonths;

  const lastRowNumRef = useRef(jobRow.rowNum);
  useEffect(() => {
    if (lastRowNumRef.current !== jobRow.rowNum) {
      lastRowNumRef.current = jobRow.rowNum;
      const rev = parseFloat(String(jobRow.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
      const parsed = parseSplitString(jobRow.unevenSplit, months, rev);
      setLockedMonths(parsed);
      lockedMonthsRef.current = parsed;
      setIsActive(String(jobRow.unevenSplit || "").toLowerCase().startsWith("[split]"));
      setServerError("");
    }
  }, [jobRow.rowNum, jobRow.unevenSplit, months, jobRow.revenue]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saving, onClose]);

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
  if (!startDate || !endDate) validationError = "Please ensure start date and end date are set to split revenue.";
  else if (totalRev <= 0) validationError = "Total Revenue must be greater than zero.";
  else if (lockedSum > totalRev + 0.05) validationError = "Allocated revenue exceeds total job revenue.";
  else if (unlockedCount === 0 && Math.abs(remaining) > 0.05) validationError = "Total allocated revenue does not perfectly match the job revenue.";

  const errorMsg = serverError || validationError;

  const handleSave = async () => {
    if (isActive && errorMsg) return;
    setSaving(true);
    setServerError("");
    try {
      let splitStr = "";
      if (isActive) {
        const curLocked = lockedMonthsRef.current || {};
        const saveLocked = {};
        let saveSum = 0;
        let saveCount = 0;
        months.forEach(m => {
          const k = m.toLowerCase();
          if (curLocked[k] !== undefined) {
            saveLocked[k] = curLocked[k];
            saveSum += curLocked[k];
            saveCount++;
          }
        });
        const rem = totalRev - saveSum;
        const uCount = months.length - saveCount;
        const eSplit = uCount > 0 ? (rem / uCount) : 0;
        splitStr = formatSplitString(months, saveLocked, eSplit);
      }

      const updates = [
        {
          colLetter: "AE",
          rowNum: jobRow.rowNum,
          cellRef: `AE${jobRow.rowNum}`,
          fieldName: "Revenue split",
          value: splitStr
        }
      ];

      if (jobRow.hasDraftDates) {
        if (jobRow.startDate) {
          updates.push({
            colLetter: "AL",
            rowNum: jobRow.rowNum,
            cellRef: `AL${jobRow.rowNum}`,
            fieldName: "Start date",
            value: formatToSheet(jobRow.startDate)
          });
        }
        if (jobRow.endDate) {
          updates.push({
            colLetter: "AM",
            rowNum: jobRow.rowNum,
            cellRef: `AM${jobRow.rowNum}`,
            fieldName: "End date",
            value: formatToSheet(jobRow.endDate)
          });
        }
      }

      if (jobRow.hasDraftRevenue && jobRow.revenue !== undefined) {
        updates.push({
          colLetter: "AG",
          rowNum: jobRow.rowNum,
          cellRef: `AG${jobRow.rowNum}`,
          fieldName: "Revenue",
          value: parseFloat(String(jobRow.revenue).replace(/[£$€,\s]/g, "")) || 0
        });
      }

      await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId: client?.clientSheetId,
          clientName: client?.clientName || client?.name || "",
          tabName,
          rowNum: jobRow.rowNum,
          endClientName: jobRow.client,
          jobName: jobRow.jobName,
          updates
        })
      });

      onUpdateJobsData(jobRow.rowNum, splitStr, {
        startDate: jobRow.hasDraftDates && jobRow.startDate ? formatToSheet(jobRow.startDate) : undefined,
        endDate: jobRow.hasDraftDates && jobRow.endDate ? formatToSheet(jobRow.endDate) : undefined,
        revenue: jobRow.hasDraftRevenue && jobRow.revenue !== undefined ? parseFloat(String(jobRow.revenue).replace(/[£$€,\s]/g, "")) || 0 : undefined
      });
      onClose();
    } catch (e) {
      setServerError(e.message || "Failed to save revenue split");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 600px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>Uneven Revenue Split</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>

        <div style={{ marginBottom: "16px", fontSize: "13px", color: "#555" }}>
          <strong>Job:</strong> {jobRow.jobName} <br />
          <strong>Revenue:</strong> £{totalRev.toFixed(2)} | <strong>Dates:</strong> {formatToSheet(jobRow.startDate) || "?"} to {formatToSheet(jobRow.endDate) || "?"}
          {jobRow.hasDraftDates && (
            <span style={{ marginLeft: "8px", fontSize: "11px", color: "#b45309", background: "#fef3c7", border: "1px solid #fde68a", padding: "2px 7px", borderRadius: "4px", fontWeight: "600" }}>
              Using adjusted dates
            </span>
          )}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "600", fontSize: "14px", marginBottom: "16px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={e => {
              const checked = e.target.checked;
              setIsActive(checked);
              if (!checked) {
                setLockedMonths({});
                lockedMonthsRef.current = {};
              } else {
                const parsed = parseSplitString(jobRow.unevenSplit, months, totalRev);
                setLockedMonths(parsed);
                lockedMonthsRef.current = parsed;
              }
            }}
            style={{ width: "16px", height: "16px" }}
          />
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
                const valStr = Number.isInteger(val) ? String(val) : val.toFixed(2);
                return (
                  <SplitMonthCard
                    key={m}
                    month={m}
                    mKey={mKey}
                    isLocked={isLocked}
                    displayVal={valStr}
                    currencySymbol="£"
                    onCommit={(k, newVal) => {
                      setLockedMonths(prev => {
                        const next = { ...prev };
                        if (newVal === null || newVal === undefined || isNaN(newVal)) {
                          delete next[k];
                        } else {
                          next[k] = newVal;
                        }
                        lockedMonthsRef.current = next;
                        return next;
                      });
                    }}
                  />
                );
              })}
            </div>
            <div style={{ marginTop: "10px", fontSize: "11px", color: "#64748b", textAlign: "right", fontStyle: "italic" }}>
              Click 🔒 Locked to unlock, or delete an amount to return that month to automatic allocation.
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