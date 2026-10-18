import React, { useState, useEffect } from "react";
import Spinner from "../Spinner";

const VAT_QUARTERS_OPTIONS = [
  "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec",
  "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan",
  "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb"
];

const VAT_PAYMENT_SCHEME_OPTIONS = ["Accrual", "Cash"];
const PAYE_CYCLE_OPTIONS = ["Monthly", "Quarterly"];
const CURRENCY_OPTIONS = ["GBP", "EUR", "USD"];

export default function AccountingSettingsSuggestionModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onApplied
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [feedback, setFeedback] = useState(null);

  // Form values
  const [startDate, setStartDate] = useState("");
  const [vatQuarters, setVatQuarters] = useState(VAT_QUARTERS_OPTIONS[0]);
  const [vatScheme, setVatScheme] = useState("Accrual");
  const [vatRate, setVatRate] = useState("20%");
  const [payeCycle, setPayeCycle] = useState("Monthly");
  const [primaryCurrency, setPrimaryCurrency] = useState("GBP");

  useEffect(() => {
    if (!isOpen || !clientName) return;

    let isMounted = true;
    setLoading(true);
    setFeedback(null);

    fetch(`/api/setup/suggest-accounting-settings?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`)
      .then(res => res.json())
      .then(result => {
        if (!isMounted) return;
        if (result.success) {
          setData(result);
          if (result.suggestions) {
            setStartDate(result.suggestions.startDate || "");
            setVatQuarters(result.suggestions.vatQuarters || VAT_QUARTERS_OPTIONS[0]);
            setVatScheme(result.suggestions.vatScheme || "Accrual");
            setVatRate(result.suggestions.vatRate || "20%");
            setPayeCycle(result.suggestions.payeCycle || "Monthly");
            setPrimaryCurrency(result.suggestions.primaryCurrency || "GBP");
          }
        } else {
          setFeedback({ type: "error", message: result.error || "Failed to load accounting suggestions." });
        }
      })
      .catch(err => {
        if (!isMounted) return;
        setFeedback({ type: "error", message: err.message });
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, clientName, masterSheetId]);

  if (!isOpen) return null;

  const handleApply = async () => {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/suggest-accounting-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          settings: {
            startDate,
            vatQuarters,
            vatScheme,
            vatRate,
            payeCycle,
            primaryCurrency
          }
        })
      });

      const resData = await res.json();
      if (resData.success) {
        if (onApplied) onApplied({ startDate, vatQuarters, vatScheme, payeCycle });
        onClose();
      } else {
        throw new Error(resData.error || "Failed to apply accounting settings.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          overflow: "hidden"
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#F8FAFC"
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
              Auto-suggest accounting initial settings
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748B" }}>
              Inspecting {clientName} financial configuration and connected accounting data
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              cursor: saving ? "not-allowed" : "pointer",
              color: "#94A3B8",
              padding: "4px"
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: "40px 0", textAlign: "center" }}>
              <Spinner size={32} color="#023f98" />
              <p style={{ marginTop: "12px", fontSize: "13px", color: "#64748B" }}>
                Reading accounting tool settings and transaction history...
              </p>
            </div>
          ) : (
            <div>
              {/* Feedback Alert */}
              {feedback && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "6px",
                    marginBottom: "16px",
                    fontSize: "12px",
                    background: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
                    border: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
                    color: feedback.type === "error" ? "#991B1B" : "#065F46"
                  }}
                >
                  {feedback.message}
                </div>
              )}

              {/* Flat Rate Scheme Warning Banner */}
              {data?.flatRateWarning && (
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: "8px",
                    marginBottom: "16px",
                    fontSize: "12px",
                    background: "#FFFBEB",
                    border: "1px solid #FDE68A",
                    color: "#92400E"
                  }}
                >
                  <strong style={{ display: "block", marginBottom: "4px" }}>Attention: Flat rate scheme detected</strong>
                  {data.flatRateWarning}
                </div>
              )}

              {/* Inspection Info Callout */}
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  marginBottom: "18px",
                  fontSize: "12px",
                  background: "#F1F5F9",
                  border: "1px solid #E2E8F0",
                  color: "#334155"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px", color: "#0F172A" }}>
                  Connected source: {data?.detectedTool || "None"}
                </div>
                {(data?.inspectionNotes || []).map((note, idx) => (
                  <div key={idx} style={{ marginTop: "2px", color: "#475569" }}>
                    • {note}
                  </div>
                ))}
                {data?.payeInspectionEvidence && (
                  <div style={{ marginTop: "4px", fontStyle: "italic", color: "#0284C7" }}>
                    PAYE inspection: {data.payeInspectionEvidence}
                  </div>
                )}
              </div>

              {/* Form Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                {/* Tracker Start Date */}
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    Pulse tracker start date (KeyInfo!B2)
                  </label>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <input
                      type="text"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      placeholder="e.g. 1-Apr-26"
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        borderRadius: "6px",
                        border: "1px solid #CBD5E1",
                        fontSize: "13px"
                      }}
                    />
                    <span style={{ fontSize: "11px", color: "#64748B", background: "#F1F5F9", padding: "6px 10px", borderRadius: "6px", whiteSpace: "nowrap" }}>
                      1st of current financial year
                    </span>
                  </div>
                </div>

                {/* VAT Quarters */}
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    VAT quarters (KeyInfo!B6)
                  </label>
                  <select
                    value={vatQuarters}
                    onChange={(e) => setVatQuarters(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px"
                    }}
                  >
                    {VAT_QUARTERS_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* VAT Payment Scheme */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    VAT payment scheme (KeyInfo!B8)
                  </label>
                  <select
                    value={vatScheme}
                    onChange={(e) => setVatScheme(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px"
                    }}
                  >
                    {VAT_PAYMENT_SCHEME_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* VAT Rate */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    VAT rate (KeyInfo!B9)
                  </label>
                  <input
                    type="text"
                    value={vatRate}
                    onChange={(e) => setVatRate(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px"
                    }}
                  />
                </div>

                {/* PAYE Cycle */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    PAYE cycle (KeyInfo!B12)
                  </label>
                  <select
                    value={payeCycle}
                    onChange={(e) => setPayeCycle(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px"
                    }}
                  >
                    {PAYE_CYCLE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Primary Currency */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#1E293B", marginBottom: "4px" }}>
                    Primary currency (KeyInfo!B17)
                  </label>
                  <select
                    value={primaryCurrency}
                    onChange={(e) => setPrimaryCurrency(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px"
                    }}
                  >
                    {CURRENCY_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "flex-end",
            gap: "12px",
            background: "#F8FAFC"
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid #CBD5E1",
              background: "#FFFFFF",
              color: "#475569",
              fontSize: "13px",
              fontWeight: "600",
              cursor: saving ? "not-allowed" : "pointer"
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={loading || saving}
            style={{
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              background: "#023f98",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: "700",
              cursor: loading || saving ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            {saving && <Spinner size={14} color="#FFFFFF" />}
            <span>{saving ? "Applying settings..." : "Apply settings to master sheet"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
