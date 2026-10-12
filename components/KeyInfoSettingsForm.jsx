import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";

export default function KeyInfoSettingsForm({ masterSheetId, clientName, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Form Fields
  const [startDate, setStartDate] = useState("");
  const [vatQuarters, setVatQuarters] = useState("Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec");
  const [vatMonths, setVatMonths] = useState("Feb, May, Aug, Nov");
  const [vatScheme, setVatScheme] = useState("Cash");
  const [vatRate, setVatRate] = useState("20%");
  const [payeCycle, setPayeCycle] = useState("Monthly");
  const [revenueFocus, setRevenueFocus] = useState("Income");
  const [profitShare, setProfitShare] = useState("0%");
  const [contractorMethod, setContractorMethod] = useState("Notes metadata");

  useEffect(() => {
    if (!masterSheetId) return;
    let isMounted = true;
    setLoading(true);

    fetch(`/api/setup/keyinfo?masterSheetId=${encodeURIComponent(masterSheetId)}&clientName=${encodeURIComponent(clientName || "")}`)
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.success && data.settings) {
          const s = data.settings;
          if (s.startDate) setStartDate(s.startDate);
          if (s.vatQuarters) setVatQuarters(s.vatQuarters);
          if (s.vatMonths) setVatMonths(s.vatMonths);
          if (s.vatScheme) setVatScheme(s.vatScheme);
          if (s.vatRate) setVatRate(s.vatRate);
          if (s.payeCycle) setPayeCycle(s.payeCycle);
          if (s.revenueFocus) setRevenueFocus(s.revenueFocus);
          if (s.profitShare) setProfitShare(s.profitShare);
          if (s.contractorMethod) setContractorMethod(s.contractorMethod);
        }
      })
      .catch((err) => {
        if (isMounted) console.error("Error loading KeyInfo settings:", err);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [masterSheetId, clientName]);

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!masterSheetId) return;
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/keyinfo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterSheetId,
          clientName,
          settings: {
            startDate,
            vatQuarters,
            vatMonths,
            vatScheme,
            vatRate,
            payeCycle,
            revenueFocus,
            profitShare,
            contractorMethod
          }
        })
      });

      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: "KeyInfo financial parameters saved to Master Sheet successfully." });
        if (onSaved) onSaved(data.settings);
      } else {
        throw new Error(data.error || "Failed to save KeyInfo settings.");
      }
    } catch (err) {
      console.error("Save KeyInfo error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "24px" }}>
        <Spinner size={24} color="#023f98" />
        <p style={{ marginTop: "8px", fontSize: "12px", color: "#64748B" }}>Loading Master Sheet KeyInfo settings...</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave}>
      {feedback && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            marginBottom: "14px",
            fontSize: "13px",
            fontWeight: "500",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: feedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
            border: `1px solid ${feedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
            color: feedback.type === "success" ? "#065F46" : "#991B1B"
          }}
        >
          <span>{feedback.type === "success" ? "✓" : "⚠️"}</span>
          <span>{feedback.message}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px", marginBottom: "16px" }}>
        {/* Start Date */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Tracker Start Date (B2)
          </label>
          <input
            type="text"
            placeholder="e.g. 1-Apr-2025"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* VAT Scheme */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            VAT Scheme (B8)
          </label>
          <select
            value={vatScheme}
            onChange={(e) => setVatScheme(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Cash">Cash</option>
            <option value="Accrual">Accrual</option>
          </select>
        </div>

        {/* VAT Rate */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            VAT Rate (B9)
          </label>
          <input
            type="text"
            placeholder="e.g. 20%"
            value={vatRate}
            onChange={(e) => setVatRate(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* VAT Months */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            VAT Payment Months (B7)
          </label>
          <input
            type="text"
            placeholder="e.g. Feb, May, Aug, Nov"
            value={vatMonths}
            onChange={(e) => setVatMonths(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* PAYE Cycle */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            PAYE Cycle (B12)
          </label>
          <select
            value={payeCycle}
            onChange={(e) => setPayeCycle(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Monthly">Monthly</option>
            <option value="Quarterly">Quarterly</option>
          </select>
        </div>

        {/* Revenue Focus */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Revenue / Income Focus (B15)
          </label>
          <select
            value={revenueFocus}
            onChange={(e) => setRevenueFocus(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Income">Income (Default)</option>
            <option value="Revenue">Revenue</option>
          </select>
        </div>

        {/* Profit Share % */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Profit Share % (F11)
          </label>
          <input
            type="text"
            placeholder="e.g. 0%"
            value={profitShare}
            onChange={(e) => setProfitShare(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* Contractors Method */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Contractors Method (B20)
          </label>
          <select
            value={contractorMethod}
            onChange={(e) => setContractorMethod(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Notes metadata">Notes metadata (Default)</option>
            <option value="Cell value">Cell value</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "8px 18px",
            borderRadius: "6px",
            border: "none",
            background: "#023f98",
            color: "#FFFFFF",
            fontWeight: "700",
            fontSize: "13px",
            cursor: saving ? "wait" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px"
          }}
        >
          {saving && <Spinner size={14} color="#FFFFFF" />}
          <span>{saving ? "Saving KeyInfo..." : "Save KeyInfo Settings"}</span>
        </button>
      </div>
    </form>
  );
}
