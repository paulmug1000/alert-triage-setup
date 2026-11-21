import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";
import { AUTOMATION_FREQUENCY_OPTIONS } from "../utils/helpers";
import InvoiceNumberFormattingControl from "./setup/InvoiceNumberFormattingControl";

const VAT_QUARTERS_OPTIONS = [
  "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec",
  "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan",
  "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb",
];

function deriveVatMonthsFromQuarters(vatQuarters) {
  const q = String(vatQuarters || "").trim().toLowerCase();
  if (!q) return "";
  if (q === "jan-mar, apr-jun, jul-sep, oct-dec") return "Feb, May, Aug, Nov, Feb";
  if (q === "feb-apr, may-jul, aug-oct, nov-jan") return "Mar, Jun, Sep, Dec";
  return "Jan, Apr, Jul, Oct";
}

export default function KeyInfoSettingsForm({ masterSheetId, clientName, onSaved, isAdmin = false }) {
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
  const [invoiceMethod, setInvoiceMethod] = useState("Lines");
  const [directCostsMode, setDirectCostsMode] = useState("Contractors");
  const [profitShare, setProfitShare] = useState("0%");
  const [contractorMethod, setContractorMethod] = useState("Notes metadata");
  const [rechargedExpensesDeliveryPct, setRechargedExpensesDeliveryPct] = useState("100%");
  const [invoiceNumberFormatting, setInvoiceNumberFormatting] = useState("StripPre");
  const [sampleInvoiceNumbers, setSampleInvoiceNumbers] = useState([]);
  const [invoicesFrequency, setInvoicesFrequency] = useState("");
  const [crmFrequency, setCrmFrequency] = useState("");
  const [expensesFrequency, setExpensesFrequency] = useState("");

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
          if (s.vatQuarters) {
            setVatQuarters(s.vatQuarters);
            setVatMonths(deriveVatMonthsFromQuarters(s.vatQuarters) || s.vatMonths || "");
          } else if (s.vatMonths) {
            setVatMonths(s.vatMonths);
          }
          if (s.vatScheme) setVatScheme(s.vatScheme);
          if (s.vatRate) setVatRate(s.vatRate);
          if (s.payeCycle) setPayeCycle(s.payeCycle);
          if (s.revenueFocus) setRevenueFocus(s.revenueFocus);
          if (s.invoiceMethod) setInvoiceMethod(s.invoiceMethod);
          if (s.directCostsMode) setDirectCostsMode(s.revenueFocus === "Income" ? "Pass-through" : s.directCostsMode);
          if (s.profitShare) setProfitShare(s.profitShare);
          if (s.contractorMethod) setContractorMethod(s.contractorMethod);
          if (s.rechargedExpensesDeliveryPct) setRechargedExpensesDeliveryPct(s.rechargedExpensesDeliveryPct);
          if (s.invoiceNumberFormatting) setInvoiceNumberFormatting(s.invoiceNumberFormatting);
          if (Array.isArray(s.sampleInvoiceNumbers)) setSampleInvoiceNumbers(s.sampleInvoiceNumbers);
          if (s.invoicesFrequency !== undefined) setInvoicesFrequency(s.invoicesFrequency);
          if (s.crmFrequency !== undefined) setCrmFrequency(s.crmFrequency);
          if (s.expensesFrequency !== undefined) setExpensesFrequency(s.expensesFrequency);
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
            invoiceMethod,
            directCostsMode: revenueFocus === "Income" ? "Pass-through" : directCostsMode,
            profitShare,
            contractorMethod,
            rechargedExpensesDeliveryPct,
            invoiceNumberFormatting,
            invoicesFrequency,
            crmFrequency,
            expensesFrequency
          }
        })
      });

      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: isAdmin ? "KeyInfo financial parameters saved to Master Sheet successfully." : "Financial settings saved successfully." });
        if (onSaved) onSaved(data.settings);
      } else {
        throw new Error(data.error || "Failed to save settings.");
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
        <p style={{ marginTop: "8px", fontSize: "12px", color: "#64748B" }}>{isAdmin ? "Loading Master Sheet KeyInfo settings..." : "Loading financial settings..."}</p>
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
            Tracker start date{isAdmin ? " (B2)" : ""}
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
            VAT scheme{isAdmin ? " (B8)" : ""}
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
            VAT rate{isAdmin ? " (B9)" : ""}
          </label>
          <input
            type="text"
            placeholder="e.g. 20%"
            value={vatRate}
            onChange={(e) => setVatRate(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* VAT Quarters */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            VAT quarters{isAdmin ? " (B6)" : ""}
          </label>
          <select
            value={VAT_QUARTERS_OPTIONS.includes(vatQuarters) ? vatQuarters : VAT_QUARTERS_OPTIONS[0]}
            onChange={(e) => {
              const nextQ = e.target.value;
              setVatQuarters(nextQ);
              setVatMonths(deriveVatMonthsFromQuarters(nextQ));
            }}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            {VAT_QUARTERS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>

        {/* VAT Months (derived from VAT quarters) */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            VAT payment months{isAdmin ? " (B7)" : ""}
          </label>
          <input
            type="text"
            readOnly
            value={deriveVatMonthsFromQuarters(vatQuarters) || vatMonths}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#F8FAFC", color: "#475569", boxSizing: "border-box" }}
          />
        </div>

        {/* PAYE Cycle */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            PAYE cycle{isAdmin ? " (B12)" : ""}
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
            Revenue / income focus{isAdmin ? " (B15)" : ""}
          </label>
          <select
            value={revenueFocus}
            onChange={(e) => {
              const nextVal = e.target.value;
              setRevenueFocus(nextVal);
              if (nextVal === "Income") setDirectCostsMode("Pass-through");
            }}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Income">Income (Default)</option>
            <option value="Revenue">Revenue</option>
          </select>
        </div>

        {/* Direct Costs Considered As */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Direct costs considered as{isAdmin ? " (D8)" : ""}
          </label>
          <select
            value={revenueFocus === "Income" ? "Pass-through" : directCostsMode}
            disabled={revenueFocus === "Income"}
            onChange={(e) => setDirectCostsMode(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "6px",
              border: "1px solid #CBD5E1",
              fontSize: "13px",
              background: revenueFocus === "Income" ? "#F1F5F9" : "#FFFFFF",
              color: revenueFocus === "Income" ? "#64748B" : "#0F172A",
              boxSizing: "border-box"
            }}
          >
            <option value="Contractors" disabled={revenueFocus === "Income"}>Contractors</option>
            <option value="Pass-through">Pass-through</option>
          </select>
        </div>

        {/* Profit Share % */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Profit share %{isAdmin ? " (F11)" : ""}
          </label>
          <input
            type="text"
            placeholder="e.g. 0%"
            value={profitShare}
            onChange={(e) => setProfitShare(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
          />
        </div>

        {/* Invoice Type */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Invoice type{isAdmin ? " (F8)" : ""}
          </label>
          <select
            value={invoiceMethod}
            onChange={(e) => setInvoiceMethod(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Lines">Lines</option>
            <option value="Whole">Whole</option>
          </select>
        </div>

        {/* Contractors Method */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Contractors handling{isAdmin ? " (B20)" : ""}
          </label>
          <select
            value={contractorMethod}
            onChange={(e) => setContractorMethod(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="Notes metadata">Metadata notes (Default)</option>
            <option value="Cell value">Cell values</option>
          </select>
        </div>

        {/* Recharged expenses handling */}
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
            Recharged expenses handling{isAdmin ? " (D21)" : ""}
          </label>
          <select
            value={rechargedExpensesDeliveryPct}
            onChange={(e) => setRechargedExpensesDeliveryPct(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
          >
            <option value="100%">100% — Cost of sales (default)</option>
            <option value="0%">0% — Overhead categories</option>
          </select>
        </div>
      </div>

      {/* Invoice number formatting + Live preview */}
      <div style={{ paddingTop: "14px", marginBottom: "16px", borderTop: "1px solid #E2E8F0" }}>
        <div style={{ marginBottom: "10px" }}>
          <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B" }}>
            Invoice number formatting
          </div>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
            Configure how invoice reference numbers are formatted for comparison and display in Pulse.
          </p>
        </div>
        <InvoiceNumberFormattingControl
          value={invoiceNumberFormatting}
          onChange={setInvoiceNumberFormatting}
          sampleInvoiceNumbers={sampleInvoiceNumbers}
          isAdmin={isAdmin}
          showCellRef={isAdmin}
        />
      </div>

      {/* Automation cadences */}
      <div style={{ paddingTop: "14px", marginBottom: "16px", borderTop: "1px solid #E2E8F0" }}>
        <div style={{ marginBottom: "10px" }}>
          <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B" }}>
            Automation cadences
          </div>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
            Choose how frequently automated invoice, CRM, and expense syncs will run once client setup is completed (live mode).
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
          {[
            { label: "Invoices frequency", cell: "DataChgAlert!Y2", value: invoicesFrequency, onChange: setInvoicesFrequency },
            { label: "CRM frequency", cell: "DataChgAlert!Y3", value: crmFrequency, onChange: setCrmFrequency },
            { label: "Expenses frequency", cell: "DataChgAlert!Y4", value: expensesFrequency, onChange: setExpensesFrequency },
          ].map((item) => (
            <div key={item.label}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                {item.label}{isAdmin ? ` (${item.cell})` : ""}
              </label>
              <select
                value={item.value}
                onChange={(e) => item.onChange(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", boxSizing: "border-box" }}
              >
                <option value="">-- Not scheduled --</option>
                {AUTOMATION_FREQUENCY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          ))}
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
          <span>{saving ? (isAdmin ? "Saving KeyInfo..." : "Saving...") : (isAdmin ? "Save KeyInfo settings" : "Save settings")}</span>
        </button>
      </div>
    </form>
  );
}
