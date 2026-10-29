import React, { useState, useMemo, useEffect } from "react";
import { stripCurrency, parseSheetDate, toSheetDateFormat, calculatePaymentDate } from "../utils/helpers";
import { useAuth } from "../hooks/useAuth";
import DateInput from "./DateInput";

export default function InvoicesNewJobModal({
  newJobData,
  invoicesClient,
  onClose,
  onSuccess,
  onMarkPullPending
}) {
  const auth = useAuth?.() || {};
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.role === "Admin");
  const { inv } = newJobData;

  const defaultDaysFallback = typeof invoicesClient?.defaultDaysToPay === "number" && !isNaN(invoicesClient.defaultDaysToPay)
    ? invoicesClient.defaultDaysToPay
    : 30;

  const { calculatedDays, hasExplicitOrDiff } = useMemo(() => {
    if (inv.daysToPay !== undefined && inv.daysToPay !== null && inv.daysToPay !== "") {
      const s = String(inv.daysToPay).trim();
      if (!/^[0-9]{4}[-/]/.test(s) && !/[A-Za-z]{3}/.test(s)) {
        const p = parseInt(s.replace(/[^\d-]/g, ""), 10);
        if (!isNaN(p) && p >= 0 && p <= 365) return { calculatedDays: p, hasExplicitOrDiff: true };
      }
    }
    if (inv.sentDate && inv.dueDate) {
      const s = parseSheetDate(inv.sentDate);
      const d = parseSheetDate(inv.dueDate);
      if (s && d) {
        const diff = Math.round((d.getTime() - s.getTime()) / 86400000);
        if (!isNaN(diff) && diff > 0) return { calculatedDays: diff, hasExplicitOrDiff: true };
        if (!isNaN(diff) && inv.status?.toLowerCase() === "paid") return { calculatedDays: 0, hasExplicitOrDiff: true };
      }
    }
    return { calculatedDays: defaultDaysFallback, hasExplicitOrDiff: false };
  }, [inv, defaultDaysFallback]);

  const { initialStartDate, initialEndDate } = useMemo(() => {
    if (inv.sentDate) {
      const s = parseSheetDate(inv.sentDate);
      if (s) {
        const y = s.getFullYear();
        const m = s.getMonth();
        const firstDay = new Date(y, m, 1);
        const lastDay = new Date(y, m + 1, 0);
        return {
          initialStartDate: toSheetDateFormat(firstDay),
          initialEndDate: toSheetDateFormat(lastDay),
        };
      }
    }
    return {
      initialStartDate: inv.sentDate || "",
      initialEndDate: inv.dueDate || "",
    };
  }, [inv.sentDate, inv.dueDate]);

  const [jobName, setJobName] = useState(inv.job || "");
  const [projectCode, setProjectCode] = useState("");
  const [revenue, setRevenue] = useState(stripCurrency(inv.amount));
  const [directCosts, setDirectCosts] = useState("0");
  const [vatYesNo, setVatYesNo] = useState(inv.vatAmount > 0 ? "Yes" : "No");
  const [projectType, setProjectType] = useState("Project");
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [noEndDate, setNoEndDate] = useState(false);
  const [daysToPay, setDaysToPay] = useState(calculatedDays);
  const [clientDefaultDays, setClientDefaultDays] = useState(defaultDaysFallback);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch client's default days to pay from DataChgAlert!B52 (Master Sheet)
  useEffect(() => {
    let isMounted = true;
    const fetchDefaultDays = async () => {
      if (!invoicesClient?.clientSheetId && !invoicesClient?.masterSheetId) return;
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_default_days_to_pay",
            clientSheetId: invoicesClient?.clientSheetId,
            masterSheetId: invoicesClient?.masterSheetId,
            clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          }),
        });
        const data = await res.json();
        if (isMounted && data?.success && typeof data.defaultDaysToPay === "number") {
          setClientDefaultDays(data.defaultDaysToPay);
          if (!hasExplicitOrDiff) {
            setDaysToPay(data.defaultDaysToPay);
          }
        }
      } catch (e) {
        console.warn("Could not fetch client default days to pay:", e.message);
      }
    };
    fetchDefaultDays();
    return () => { isMounted = false; };
  }, [invoicesClient, hasExplicitOrDiff]);

  const close = () => { if (!saving) onClose(); };

  const save = async () => {
    if (!jobName.trim()) { setError("Please enter a job name"); return; }
    const isRetainerNoEnd = projectType === "Retainer" && noEndDate;
    if (projectType === "Retainer" && !isRetainerNoEnd && !endDate) {
      setError("Please enter an end date or tick 'No end date'");
      return;
    }
    setSaving(true);
    try {
      const parsedDays = parseInt(String(daysToPay).replace(/[^\d-]/g, ""), 10);
      const safeDaysToPay = !isNaN(parsedDays) && parsedDays >= 0 && parsedDays <= 365 ? parsedDays : clientDefaultDays;

      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_job_from_invoice",
          clientSheetId: invoicesClient?.clientSheetId,
          masterSheetId: invoicesClient?.masterSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          jobName: jobName.trim(), projectCode: projectCode.trim(),
          revenue: parseFloat(revenue) || 0, directCosts: parseFloat(directCosts) || 0,
          vatYesNo, projectType, startDate,
          endDate: isRetainerNoEnd ? "31-Dec-2050" : endDate,
          noEndDate: isRetainerNoEnd,
          daysToPay: safeDaysToPay,
          invoice: { ...inv, daysToPay: safeDaysToPay },
          automationCommanderSheetId: invoicesClient?.automationCommanderSheetId,
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
    } catch (e) { setError(e.message); setSaving(false); }
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
          <strong>Invoice to place:</strong> #{inv.invoiceNo} - £{inv.amount.toFixed(2)}<br />
          {inv.client}{inv.job ? ` - ${inv.job}` : ""} · {inv.sentDate}
        </div>

        <div style={{ display: "grid", gap: "12px" }}>
          <div>
            <label style={labelStyle}>Client{isAdmin ? " (col A)" : ""}</label>
            <input style={{ ...inputStyle, background: "#f5f5f5", color: "#888" }} value={inv.client || ""} disabled />
          </div>
          <div>
            <label style={labelStyle}>Job name{isAdmin ? " (col B)" : ""} *</label>
            <input style={inputStyle} value={jobName} onChange={e => setJobName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Project code{isAdmin ? " (col C)" : ""}</label>
            <input style={inputStyle} value={projectCode} onChange={e => setProjectCode(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Revenue (£{isAdmin ? ", col AG" : ""})</label>
              <input style={inputStyle} type="number" step="0.01" value={revenue} onChange={e => setRevenue(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Direct costs (£{isAdmin ? ", col AH" : ""})</label>
              <input style={inputStyle} type="number" step="0.01" value={directCosts} onChange={e => setDirectCosts(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>VAT?{isAdmin ? " (col AI)" : ""}</label>
              <select style={inputStyle} value={vatYesNo} onChange={e => setVatYesNo(e.target.value)}>
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Type{isAdmin ? " (col AJ)" : ""}</label>
              <select
                style={inputStyle}
                value={projectType}
                onChange={e => {
                  const nextType = e.target.value;
                  setProjectType(nextType);
                  if (nextType === "Retainer" && endDate === initialEndDate) {
                    setEndDate("");
                  } else if (nextType === "Project") {
                    setNoEndDate(false);
                    if (!endDate && initialEndDate) setEndDate(initialEndDate);
                  }
                }}
              >
                <option value="Project">Project</option>
                <option value="Retainer">Retainer</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Start date{isAdmin ? " (col AL)" : ""}</label>
              <DateInput style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>End date{isAdmin ? " (col AM)" : ""}</label>
                {projectType === "Retainer" && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: "600", color: "#475569", cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={noEndDate}
                      onChange={e => setNoEndDate(e.target.checked)}
                      style={{ margin: 0, cursor: "pointer" }}
                    />
                    No end date
                  </label>
                )}
              </div>
              {projectType === "Retainer" && noEndDate ? (
                <input
                  type="text"
                  style={{ ...inputStyle, background: "#f8fafc", color: "#64748b", cursor: "not-allowed" }}
                  value="No end date"
                  disabled
                />
              ) : (
                <DateInput style={inputStyle} value={endDate} onChange={e => setEndDate(e.target.value)} min={startDate || undefined} />
              )}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Days to pay{isAdmin ? " (col AS)" : ""}</label>
            <input
              style={inputStyle}
              type="number"
              min="0"
              max="365"
              step="1"
              value={daysToPay}
              onChange={e => setDaysToPay(e.target.value)}
            />
            {calculatePaymentDate(inv.sentDate, daysToPay) && (
              <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                Payment date: <strong style={{ color: "#0f172a", fontWeight: "600" }}>{calculatePaymentDate(inv.sentDate, daysToPay)}</strong>
              </div>
            )}
          </div>
        </div>

        {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginTop: "12px" }}>{error}</div>}
        <p style={{ fontSize: "11px", color: "#999", margin: "12px 0 0" }}>
          {isAdmin
            ? "A new job will be added to Pulse confirmed jobs, and this invoice will be written into slot 1."
            : "A new job will be added to Pulse confirmed jobs, and this invoice will be attached to it."}
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