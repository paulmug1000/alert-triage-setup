import React, { useState } from "react";
import Spinner from "../Spinner";

export default function AddContractorModal({ clientSheetId, clientName, onClose, onSuccess }) {
  const [name, setName] = useState("");
  const [vat, setVat] = useState("Yes");
  const [invoiceTiming, setInvoiceTiming] = useState("Curr"); // 'Curr' | 'Next'
  const [paymentTiming, setPaymentTiming] = useState("Next"); // 'Curr' | 'Next'
  const [workType, setWorkType] = useState("delivery"); // 'delivery' | 'non-delivery'
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError("Please enter the contractor's name");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/portal/add-outgoing-row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          section: "contractor",
          name: name.trim(),
          vat,
          invoiceTiming,
          paymentTiming,
          deliveryPct: workType === "delivery" ? "100%" : "0%",
          isDelivery: workType === "delivery",
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to add contractor");
      }

      if (onSuccess) {
        onSuccess(resData.item);
      }
      onClose();
    } catch (err) {
      console.error("Add contractor error:", err);
      setError(err.message || "An unexpected error occurred");
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(4px)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        fontFamily: "'Kumbh Sans', sans-serif",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "480px",
          boxShadow: "0 20px 40px -10px rgba(0, 0, 0, 0.2)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #f1f5f9",
            background: "#f8fafc",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "6px",
                background: "rgba(0, 71, 171, 0.1)",
                color: "#0047AB",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: "15px",
              }}
            >
              +
            </div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
              Add New Contractor
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              background: "none",
              border: "none",
              fontSize: "20px",
              color: "#94a3b8",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} style={{ padding: "20px" }}>
          {error && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "6px",
                padding: "8px 12px",
                color: "#991b1b",
                fontSize: "12.5px",
                marginBottom: "16px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {/* Contractor Name */}
            <div>
              <label style={labelStyle}>
                Contractor Name <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. John Smith or Acme Consulting"
                autoFocus
                style={inputStyle}
              />
            </div>

            {/* VAT Status & Work Type */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={labelStyle}>VAT Status</label>
                <select value={vat} onChange={(e) => setVat(e.target.value)} style={selectStyle}>
                  <option value="Yes">VAT Registered (Yes)</option>
                  <option value="No">No VAT (No)</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Work Type</label>
                <select value={workType} onChange={(e) => setWorkType(e.target.value)} style={selectStyle}>
                  <option value="delivery">Delivery (100%)</option>
                  <option value="non-delivery">Non-delivery (0%)</option>
                </select>
              </div>
            </div>

            {/* Invoicing Timing & Payment Timing */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Expected Invoice Timing</label>
                <select
                  value={invoiceTiming}
                  onChange={(e) => setInvoiceTiming(e.target.value)}
                  style={selectStyle}
                >
                  <option value="Curr">Current month</option>
                  <option value="Next">Next month</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Expected Payment Timing</label>
                <select
                  value={paymentTiming}
                  onChange={(e) => setPaymentTiming(e.target.value)}
                  style={selectStyle}
                >
                  <option value="Curr">Current month</option>
                  <option value="Next">Next month</option>
                </select>
              </div>
            </div>
          </div>

          {/* Footer Buttons */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "10px",
              marginTop: "24px",
              paddingTop: "16px",
              borderTop: "1px solid #f1f5f9",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                color: "#475569",
                padding: "7px 16px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: isSubmitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              style={{
                background: isSubmitting || !name.trim() ? "#94a3b8" : "#0047AB",
                border: "none",
                color: "#ffffff",
                padding: "7px 20px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 700,
                cursor: isSubmitting || !name.trim() ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                transition: "background-color 0.15s ease",
              }}
            >
              {isSubmitting ? <Spinner size={14} color="#ffffff" /> : null}
              <span>{isSubmitting ? "Saving..." : "Save Contractor"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "5px",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 11px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  fontSize: "13px",
  color: "#0f172a",
  outline: "none",
  fontFamily: "inherit",
};

const selectStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 11px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  fontSize: "13px",
  color: "#0f172a",
  background: "#ffffff",
  outline: "none",
  fontFamily: "inherit",
  cursor: "pointer",
};
