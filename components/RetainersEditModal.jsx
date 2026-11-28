import React from "react";
import Spinner from "./Spinner";
import DateInput from "./DateInput";
import { isPlaceholderInvoice, NO_END_DATE_SHEET_VALUE, isNoEndDateSentinel, getRetainerRowMonthLabel, stripCurrency, validateDateRange, MIN_INPUT_MONTH, MAX_INPUT_MONTH } from "../utils/helpers";

// Converts a sheet-formatted date string like "15-Mar-26" (or a few other common
// shapes) to ISO "YYYY-MM-DD" for use with a native <input type="date">.
const RET_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Converts ISO "YYYY-MM-DD" back to the sheet's "DD-Mon-YY" display format
function isoToSheetDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d}-${months[m - 1]}-${y}`;
}

export default function RetainersEditModal({ job, clientName, clientSheetId, masterSheetId, onClose, onRenamedInPlace, onNeedsReload }) {
  const isVarRet = Boolean(job?.isVariableRetainer);
  const initialNoEndDate = isVarRet
    ? Boolean(job.noEndDate || isNoEndDateSentinel(job.endDate))
    : isNoEndDateSentinel(job.rows[0]?.endDate);
  const jobStartISO = sheetDateToISO(isVarRet ? (job.startDate || job.rows[0]?.startDate) : job.rows[0]?.startDate);
  const jobEndISO = initialNoEndDate ? "" : sheetDateToISO(isVarRet ? (job.endDate || job.rows[0]?.endDate) : job.rows[0]?.endDate);

  const hasRealInvoices = React.useMemo(() => {
    if (!job || !job.rows) return false;
    return job.rows.some(r =>
      (r.invoiceSlots || []).some(s => {
        const ref = String(s.ref || "").trim();
        const status = String(s.status || "").trim().toLowerCase();
        return (ref && !isPlaceholderInvoice(ref)) || status.includes("sent") || status.includes("paid");
      })
    );
  }, [job]);

  const { minSplitMonth, latestInvoicedMonthLabel, minSplitMonthLabel } = React.useMemo(() => {
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const fmtMonthLabel = (ym) => {
      if (!ym) return "";
      const [y, m] = ym.split("-").map(Number);
      if (!y || !m) return ym;
      return `${monthNames[m - 1]} ${y}`;
    };

    let latestMonth = jobStartISO ? jobStartISO.slice(0, 7) : "";
    let latestSentMonth = "";
    if (job?.rows) {
      for (const r of job.rows) {
        for (const s of (r.invoiceSlots || [])) {
          const ref = String(s.ref || "").trim();
          const status = String(s.status || "").trim().toLowerCase();
          if ((ref && !isPlaceholderInvoice(ref)) || status.includes("sent") || status.includes("paid")) {
            const sentISO = sheetDateToISO(s.sentDate);
            if (sentISO) {
              const ym = sentISO.slice(0, 7);
              if (ym > latestMonth) latestMonth = ym;
              if (ym > latestSentMonth) latestSentMonth = ym;
            }
          }
        }
      }
    }
    if (!latestMonth) {
      return { minSplitMonth: "", latestInvoicedMonthLabel: "", minSplitMonthLabel: "" };
    }
    const [y, m] = latestMonth.split("-").map(Number);
    const nextDate = new Date(y, m, 1);
    const computedMin = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;
    return {
      minSplitMonth: computedMin,
      latestInvoicedMonthLabel: fmtMonthLabel(latestSentMonth),
      minSplitMonthLabel: fmtMonthLabel(computedMin),
    };
  }, [job, jobStartISO]);

  const currentRevenueClean = String(job.revenue || "").replace(/[^\d.-]/g, "");

  const [jobName, setJobName] = React.useState(job.jobName || "");
  const [startDate, setStartDate] = React.useState(jobStartISO);
  const [endDate, setEndDate] = React.useState(jobEndISO);
  const [noEndDate, setNoEndDate] = React.useState(initialNoEndDate);
  const [wholeRetainerAmount, setWholeRetainerAmount] = React.useState(currentRevenueClean);

  const [changingAmount, setChangingAmount] = React.useState(false);
  const [newAmount, setNewAmount] = React.useState("");
  const [changeMonth, setChangeMonth] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [savingMessage, setSavingMessage] = React.useState("");
  const [error, setError] = React.useState("");

  // Variable retainer editing state
  const [varTab, setVarTab] = React.useState("series");
  const [varBaseRev, setVarBaseRev] = React.useState(String(job.baseRevenue ?? (currentRevenueClean || "")));
  const [varBaseDc, setVarBaseDc] = React.useState(String(job.baseDirectCosts ?? (String(job.directCosts || "0").replace(/[^\d.-]/g, "") || "0")));
  const [varSendDay, setVarSendDay] = React.useState(String(job.sendDay || 28));
  const [varEffectiveMonth, setVarEffectiveMonth] = React.useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [monthDrafts, setMonthDrafts] = React.useState(() => {
    const init = {};
    (job.rows || []).forEach((mr) => {
      init[mr.rowNum] = {
        revenue: String(parseFloat(stripCurrency(mr.revenue)) || 0),
        directCosts: String(parseFloat(stripCurrency(mr.directCosts)) || 0),
      };
    });
    return init;
  });
  const [savingMonthRow, setSavingMonthRow] = React.useState(null);

  const close = () => { if (!saving && !deleting) onClose(); };

  const handleDeleteRetainer = async () => {
    if (hasRealInvoices) {
      setError("Cannot delete retainer: Job has real invoices.");
      return;
    }
    const ok = window.confirm(`Are you sure you want to delete this retainer ("${job.jobName}")?\n\nThis will permanently remove all monthly entries for this retainer from Confirmed jobs.`);
    if (!ok) return;

    setError("");
    setDeleting(true);
    setSavingMessage("Deleting retainer...");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_retainer",
          clientSheetId,
          masterSheetId,
          parentRowNum: job.parentRowNum || job.rows?.[0]?.rowNum,
          jobName: job.jobName,
          clientName: clientName || job.client,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to delete retainer");
      }
      onNeedsReload();
      onClose();
    } catch (err) {
      console.error("Delete retainer error:", err);
      setError(err.message);
    } finally {
      setDeleting(false);
      setSavingMessage("");
    }
  };

  const saveNameAndDate = async () => {
    setError("");
    const nameChanged = jobName.trim() !== job.jobName;
    const startChanged = startDate !== jobStartISO;
    const endChanged = (noEndDate !== initialNoEndDate) || (!noEndDate && endDate !== jobEndISO);
    const effectiveNewEndSheet = noEndDate ? NO_END_DATE_SHEET_VALUE : isoToSheetDate(endDate);

    const parsedWholeAmount = parseFloat(wholeRetainerAmount);
    const originalRevenueNum = parseFloat(currentRevenueClean) || 0;
    const amountChanged = !hasRealInvoices && !isNaN(parsedWholeAmount) && parsedWholeAmount > 0 && Math.abs(parsedWholeAmount - originalRevenueNum) > 0.001;

    if (!jobName.trim()) { setError("Job name cannot be blank."); return; }
    const dateCheck = validateDateRange(startDate, endDate, {
      allowNoEndDate: noEndDate,
      requireStart: true,
      requireEnd: !noEndDate,
    });
    if (!dateCheck.valid) {
      setError(noEndDate ? "Please enter a valid start date." : (dateCheck.error || "Please enter valid dates."));
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
            clientName: clientName || "",
            clientSheetId, oldClient: job.client, oldJobName: job.jobName, newJobName: jobName.trim(),
            parentRowNum: job.parentRowNum,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to rename job"); setSaving(false); setSavingMessage(""); return; }
      }

      if (startChanged) {
        setSavingMessage("Updating start date and adjusting billing periods...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_start_date",
            clientName: clientName || "",
            clientSheetId, masterSheetId,
            client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            newStartDate: isoToSheetDate(startDate),
            newEndDate: endChanged ? effectiveNewEndSheet : undefined,
            noEndDate,
            newMonthlyAmount: amountChanged ? parsedWholeAmount : undefined,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to change start date"); setSaving(false); setSavingMessage(""); return; }
        onClose();
        if (onNeedsReload) onNeedsReload();
        return;
      }

      if (endChanged) {
        setSavingMessage("Updating end date - this can take a little while if billing periods need to be added or removed...");
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_end_date",
            clientName: clientName || "",
            clientSheetId, masterSheetId,
            client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            newEndDate: effectiveNewEndSheet,
            noEndDate,
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
            clientName: clientName || "",
            clientSheetId, client: job.client, jobName: nameChanged ? jobName.trim() : job.jobName, parentRowNum: job.parentRowNum,
            changeWholeRetainer: true,
            newMonthlyAmount: parsedWholeAmount,
          }),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || "Failed to change monthly amount"); setSaving(false); setSavingMessage(""); return; }
      }

      if (endChanged || amountChanged) {
        onClose();
        if (onNeedsReload) onNeedsReload();
        return;
      }

      if (nameChanged) {
        onRenamedInPlace(jobName.trim());
      }
      onClose();
    } catch (e) { setError(e.message); setSaving(false); setSavingMessage(""); }
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
      setError("The change month is after the job's current end date - please pick an earlier month, or extend the end date first.");
      return;
    }
    setSaving(true);
    try {
      setSavingMessage("Splitting the retainer at the new amount - this can take a little while...");
      const [yr, mo] = changeMonth.split("-").map(Number);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "change_retainer_monthly_amount",
          clientName: clientName || "",
          clientSheetId, client: job.client, jobName: job.jobName, parentRowNum: job.parentRowNum,
          changeMonth: mo - 1, changeYear: yr, newMonthlyAmount: parsedAmount,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to change monthly amount"); setSaving(false); setSavingMessage(""); return; }
      onClose();
      if (onNeedsReload) onNeedsReload();
    } catch (e) { setError(e.message); setSaving(false); setSavingMessage(""); }
  };

  const saveVariableSeriesSettings = async () => {
    setError("");
    if (!jobName.trim()) { setError("Job name cannot be blank."); return; }
    const parsedRev = parseFloat(varBaseRev);
    const parsedDc = varBaseDc === "" ? 0 : parseFloat(varBaseDc);
    const parsedSendDay = parseInt(varSendDay, 10) || 28;
    if (isNaN(parsedRev) || parsedRev <= 0) { setError("Base monthly revenue must be greater than zero."); return; }
    if (isNaN(parsedDc) || parsedDc < 0) { setError("Base monthly direct costs cannot be negative."); return; }
    if (parsedSendDay < 1 || parsedSendDay > 28) { setError("Invoice send day must be between 1 and 28."); return; }
    const varDateCheck = validateDateRange(jobStartISO, endDate, {
      allowNoEndDate: noEndDate,
      requireStart: false,
      requireEnd: !noEndDate,
    });
    if (!varDateCheck.valid) {
      setError(varDateCheck.error || "Please enter a valid end date or tick 'No end date'.");
      return;
    }

    setSaving(true);
    try {
      const nameChanged = jobName.trim() !== job.jobName;
      if (nameChanged) {
        setSavingMessage("Renaming variable retainer series...");
        const renameRes = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "rename_retainer_job",
            clientName: clientName || "",
            clientSheetId,
            oldClient: job.client,
            oldJobName: job.jobName,
            newJobName: jobName.trim(),
            parentRowNum: job.parentRowNum,
          }),
        });
        const renameData = await renameRes.json();
        if (!renameData.success) {
          setError(renameData.error || "Failed to rename series.");
          setSaving(false);
          setSavingMessage("");
          return;
        }
      }

      setSavingMessage("Updating base forecasts and runway...");
      const [effY, effM] = String(varEffectiveMonth || "").split("-").map(Number);
      const effectiveEnd = noEndDate ? NO_END_DATE_SHEET_VALUE : isoToSheetDate(endDate);
      const baseRes = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_variable_retainer_base",
          clientName: clientName || "",
          clientSheetId,
          masterSheetId,
          client: job.client,
          seriesName: nameChanged ? jobName.trim() : job.jobName,
          effectiveYear: effY || undefined,
          effectiveMonth: effM ? effM - 1 : undefined,
          baseRevenue: parsedRev,
          baseDirectCosts: parsedDc,
          sendDay: parsedSendDay,
          endDate: effectiveEnd,
          noEndDate,
        }),
      });
      const baseData = await baseRes.json();
      if (!baseData.success) {
        setError(baseData.error || "Failed to update base forecasts.");
        setSaving(false);
        setSavingMessage("");
        return;
      }
      onClose();
      if (onNeedsReload) onNeedsReload();
    } catch (e) {
      setError(e.message);
      setSaving(false);
      setSavingMessage("");
    }
  };

  const saveVariableMonthOverride = async (mr, resetToBase = false) => {
    setError("");
    const draft = monthDrafts[mr.rowNum] || {};
    const revVal = parseFloat(draft.revenue);
    const dcVal = parseFloat(draft.directCosts);
    if (!resetToBase && (isNaN(revVal) || revVal < 0 || isNaN(dcVal) || dcVal < 0)) {
      setError("Monthly revenue and direct costs must be zero or greater.");
      return;
    }
    setSavingMonthRow(mr.rowNum);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_variable_retainer_month",
          clientName: clientName || "",
          clientSheetId,
          masterSheetId,
          rowNum: mr.rowNum,
          revenue: resetToBase ? undefined : revVal,
          directCosts: resetToBase ? undefined : dcVal,
          resetToBase,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to update month.");
        return;
      }
      setMonthDrafts((prev) => ({
        ...prev,
        [mr.rowNum]: {
          revenue: String(data.revenue ?? revVal),
          directCosts: String(data.directCosts ?? dcVal),
        },
      }));
      if (onNeedsReload) onNeedsReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingMonthRow(null);
    }
  };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "15px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: isVarRet ? "min(94vw, 680px)" : "min(92vw, 520px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Edit retainer - {job.client}</h3>
            {isVarRet && (
              <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "999px", background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd", fontWeight: "600" }}>
                Variable
              </span>
            )}
          </div>
          {!saving && <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>}
        </div>

        {isVarRet ? (
          saving ? (
            <div style={{ padding: "30px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
              <Spinner size={32} color="#0284c7" />
              <div style={{ fontSize: "14px", color: "#0369a1", fontWeight: "600" }}>{savingMessage || "Saving..."}</div>
              <div style={{ fontSize: "12px", color: "#999" }}>Please don&apos;t close this window until it&apos;s done.</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e2e8f0", paddingBottom: "8px" }}>
                <button
                  type="button"
                  onClick={() => { setVarTab("series"); setError(""); }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "none",
                    background: varTab === "series" ? "#e0f2fe" : "transparent",
                    color: varTab === "series" ? "#0369a1" : "#64748b",
                    fontSize: "12.5px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  Series settings
                </button>
                <button
                  type="button"
                  onClick={() => { setVarTab("months"); setError(""); }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "none",
                    background: varTab === "months" ? "#e0f2fe" : "transparent",
                    color: varTab === "months" ? "#0369a1" : "#64748b",
                    fontSize: "12.5px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  Monthly overrides ({(job.rows || []).length})
                </button>
              </div>

              {varTab === "series" ? (
                <>
                  <div style={{ display: "grid", gap: "12px" }}>
                    <div>
                      <label style={labelStyle}>Job name</label>
                      <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                      <div>
                        <label style={labelStyle}>Start date</label>
                        <DateInput outputFormat="iso" style={{ ...inputStyle, background: "#f9fafb", color: "#64748b", cursor: "not-allowed" }} value={jobStartISO} disabled />
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                          <label style={{ ...labelStyle, marginBottom: 0 }}>End date</label>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: "600", color: "#475569", cursor: "pointer", userSelect: "none" }}>
                            <input type="checkbox" checked={noEndDate} onChange={e => setNoEndDate(e.target.checked)} style={{ margin: 0, cursor: "pointer" }} />
                            No end date
                          </label>
                        </div>
                        {noEndDate ? (
                          <input type="text" style={{ ...inputStyle, background: "#f8fafc", color: "#64748b", cursor: "not-allowed" }} value="No end date" disabled />
                        ) : (
                          <DateInput outputFormat="iso" style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={jobStartISO || undefined} />
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: "14px", padding: "14px", background: "#f0f9ff", borderRadius: "8px", border: "1px solid #bae6fd" }}>
                    <div style={{ fontSize: "13px", fontWeight: "600", color: "#0369a1", marginBottom: "8px" }}>Base forecasts from selected month onward</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                      <div>
                        <label style={labelStyle}>Base monthly revenue (£)</label>
                        <input type="number" step="0.01" style={inputStyle} value={varBaseRev} onChange={e => setVarBaseRev(e.target.value)} />
                      </div>
                      <div>
                        <label style={labelStyle}>Base monthly direct costs (£)</label>
                        <input type="number" step="0.01" style={inputStyle} value={varBaseDc} onChange={e => setVarBaseDc(e.target.value)} />
                      </div>
                      <div>
                        <label style={labelStyle}>Update base rates from</label>
                        <input type="month" min={MIN_INPUT_MONTH} max={MAX_INPUT_MONTH} style={inputStyle} value={varEffectiveMonth} onChange={e => setVarEffectiveMonth(e.target.value)} />
                      </div>
                      <div>
                        <label style={labelStyle}>Invoice send day (1–28)</label>
                        <input type="number" min="1" max="28" style={inputStyle} value={varSendDay} onChange={e => setVarSendDay(e.target.value)} />
                      </div>
                    </div>
                    <div style={{ fontSize: "11px", color: "#475569", marginTop: "8px", lineHeight: 1.4 }}>
                      Applies to uninvoiced, non-overridden months from the selected month onward. Months with sent invoices or manual overrides keep their values.
                    </div>
                  </div>

                  {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}

                  <div style={{ display: "flex", gap: "8px", marginTop: "18px", alignItems: "center", justifyContent: "space-between" }}>
                    {!hasRealInvoices && (
                      <button
                        type="button"
                        onClick={handleDeleteRetainer}
                        disabled={saving || deleting}
                        style={{
                          padding: "8px 14px",
                          background: "#fff",
                          border: "1px solid #fca5a5",
                          color: "#dc2626",
                          borderRadius: "6px",
                          cursor: saving || deleting ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: "600",
                        }}
                      >
                        {deleting ? "Deleting..." : "Delete retainer"}
                      </button>
                    )}
                    <div style={{ marginLeft: !hasRealInvoices ? "0" : "auto", display: "flex", gap: "8px" }}>
                      <button onClick={close} disabled={saving || deleting}
                        style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                      <button onClick={saveVariableSeriesSettings} disabled={saving || deleting}
                        style={{ padding: "8px 20px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                        Save changes
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ maxHeight: "420px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
                    {(job.rows || []).map((mr, mIdx) => {
                      const monthLabel = getRetainerRowMonthLabel(mr, mIdx, job);
                      const draft = monthDrafts[mr.rowNum] || { revenue: "0", directCosts: "0" };
                      const isRowSaving = savingMonthRow === mr.rowNum;
                      const isOverridden = Boolean(mr.isRevOverridden || mr.isDcOverridden);
                      const hasRealInv = (mr.invoiceSlots || []).some((s) => {
                        const r = String(s.ref || "").trim();
                        const st = String(s.status || "").trim().toLowerCase();
                        return (r && !isPlaceholderInvoice(r, st)) || st.includes("sent") || st.includes("paid");
                      });
                      const realBills = (mr.expenseSlots || []).filter((es) => {
                        const amt = parseFloat(stripCurrency(es.amount)) || 0;
                        const desc = String(es.description || "").trim().toLowerCase();
                        const tid = String(es.transactionId || "").trim().toLowerCase();
                        const st = String(es.status || "").trim().toLowerCase();
                        return amt > 0 && ((!tid.startsWith("place-exp") && !desc.startsWith("placeholder")) || st === "paid" || st === "received");
                      });
                      return (
                        <div key={mr.rowNum || mIdx} style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid #e2e8f0", background: "#f8fafc", display: "grid", gridTemplateColumns: "110px 1fr 1fr auto", gap: "8px", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: "12.5px", fontWeight: "700", color: "#0f172a" }}>{monthLabel}</div>
                            <div style={{ fontSize: "10px", color: hasRealInv ? "#15803d" : (isOverridden ? "#b45309" : "#64748b"), fontWeight: "600" }}>
                              {hasRealInv ? "Invoiced" : (isOverridden ? "Overridden" : "Base forecast")}
                            </div>
                            {realBills.length > 0 && (
                              <div style={{ fontSize: "10px", color: "#64748b" }}>{realBills.length} {realBills.length === 1 ? "bill" : "bills"}</div>
                            )}
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: "2px" }}>Revenue (£)</label>
                            <input
                              type="number"
                              step="0.01"
                              style={{ ...inputStyle, fontSize: "13px", padding: "5px 7px" }}
                              value={draft.revenue}
                              disabled={isRowSaving}
                              onChange={e => setMonthDrafts(prev => ({ ...prev, [mr.rowNum]: { ...draft, revenue: e.target.value } }))}
                            />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: "2px" }}>Direct costs (£)</label>
                            <input
                              type="number"
                              step="0.01"
                              style={{ ...inputStyle, fontSize: "13px", padding: "5px 7px" }}
                              value={draft.directCosts}
                              disabled={isRowSaving}
                              onChange={e => setMonthDrafts(prev => ({ ...prev, [mr.rowNum]: { ...draft, directCosts: e.target.value } }))}
                            />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "14px" }}>
                            <button
                              type="button"
                              disabled={isRowSaving}
                              onClick={() => saveVariableMonthOverride(mr, false)}
                              style={{ padding: "5px 10px", borderRadius: "5px", border: "none", background: "#0284c7", color: "#fff", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
                            >
                              {isRowSaving ? "Saving..." : "Save"}
                            </button>
                            {isOverridden && (
                              <button
                                type="button"
                                disabled={isRowSaving}
                                onClick={() => saveVariableMonthOverride(mr, true)}
                                style={{ padding: "3px 8px", borderRadius: "5px", border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: "10px", fontWeight: "600", cursor: "pointer" }}
                              >
                                Reset to base
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "10px" }}>{error}</div>}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
                    <button onClick={close} style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Close</button>
                  </div>
                </>
              )}
            </>
          )
        ) : saving ? (
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
                <DateInput
                  outputFormat="iso"
                  style={inputStyle}
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  max={endDate || undefined}
                />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>End date</label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: "600", color: "#475569", cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={noEndDate}
                      onChange={e => setNoEndDate(e.target.checked)}
                      style={{ margin: 0, cursor: "pointer" }}
                    />
                    No end date
                  </label>
                </div>
                {noEndDate ? (
                  <input
                    type="text"
                    style={{ ...inputStyle, background: "#f8fafc", color: "#64748b", cursor: "not-allowed" }}
                    value="No end date"
                    disabled
                  />
                ) : (
                  <DateInput outputFormat="iso" style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate || undefined} />
                )}
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

            <div style={{ display: "flex", gap: "8px", marginTop: "20px", alignItems: "center", justifyContent: "space-between" }}>
              {!hasRealInvoices && (
                <button
                  type="button"
                  onClick={handleDeleteRetainer}
                  disabled={saving || deleting}
                  style={{
                    padding: "8px 14px",
                    background: "#fff",
                    border: "1px solid #fca5a5",
                    color: "#dc2626",
                    borderRadius: "6px",
                    cursor: saving || deleting ? "not-allowed" : "pointer",
                    fontSize: "13px",
                    fontWeight: "600",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    transition: "all 0.15s ease"
                  }}
                  title="Delete this retainer (only available when there are no real invoices)"
                >
                  {deleting ? <><Spinner size={12} color="#dc2626" /> Deleting...</> : "🗑️ Delete retainer"}
                </button>
              )}
              <div style={{ marginLeft: !hasRealInvoices ? "0" : "auto", display: "flex", gap: "8px" }}>
                <button onClick={close} disabled={saving || deleting}
                  style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                <button onClick={saveNameAndDate} disabled={saving || deleting}
                  style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving || deleting ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving || deleting ? 0.8 : 1 }}>
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
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
                  min={minSplitMonth || MIN_INPUT_MONTH}
                  max={jobEndISO ? jobEndISO.slice(0, 7) : MAX_INPUT_MONTH}
                />
                {latestInvoicedMonthLabel && minSplitMonthLabel ? (
                  <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "5px", lineHeight: 1.4 }}>
                    Note: Months up to and including <strong>{latestInvoicedMonthLabel}</strong> cannot be selected because an invoice has already been sent for {latestInvoicedMonthLabel}. The earliest month you can split from is <strong>{minSplitMonthLabel}</strong>.
                  </div>
                ) : minSplitMonthLabel ? (
                  <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "5px", lineHeight: 1.4 }}>
                    Note: Splitting takes effect from <strong>{minSplitMonthLabel}</strong> onwards. To change the monthly amount from the very start of the retainer, go back and edit the monthly amount directly.
                  </div>
                ) : null}
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