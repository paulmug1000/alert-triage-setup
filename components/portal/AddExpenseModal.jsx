import React, { useState } from "react";
import Spinner from "../Spinner";

export default function AddExpenseModal({ clientSheetId, clientName, onClose, onSuccess }) {
  const [name, setName] = useState("");
  const [expenseType, setExpenseType] = useState("delivery"); // 'delivery' | 'non-delivery'
  const [vat, setVat] = useState("Yes");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError("Please enter the expense category name");
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
          section: "expense",
          name: name.trim(),
          vat,
          invoiceTiming: "Curr", // As instructed: assume "Curr" for columns C and D
          paymentTiming: "Curr",
          deliveryPct: expenseType === "delivery" ? "100%" : "0%",
          isDelivery: expenseType === "delivery",
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to add expense category");
      }

      if (onSuccess) {
        onSuccess(resData.item);
      }
      onClose();
    } catch (err) {
      console.error("Add expense error:", err);
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
          maxWidth: "460px",
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
              Add New Expense
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
            {/* Category Name */}
            <div>
              <label style={labelStyle}>
                Category Name <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Software Subscriptions or Freelance Production"
                autoFocus
                style={inputStyle}
              />
            </div>

            {/* Delivery vs Non-delivery */}
            <div>
              <label style={labelStyle}>Expense Type</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "9px 12px",
                    borderRadius: "6px",
                    border: `1.5px solid ${expenseType === "delivery" ? "#0047AB" : "#cbd5e1"}`,
                    background: expenseType === "delivery" ? "rgba(0, 71, 171, 0.05)" : "#ffffff",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: expenseType === "delivery" ? "#0047AB" : "#334155",
                    transition: "all 0.15s ease",
                  }}
                >
                  <input
                    type="radio"
                    name="expenseType"
                    value="delivery"
                    checked={expenseType === "delivery"}
                    onChange={() => setExpenseType("delivery")}
                    style={{ accentColor: "#0047AB" }}
                  />
                  <span>Delivery expense</span>
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "9px 12px",
                    borderRadius: "6px",
                    border: `1.5px solid ${expenseType === "non-delivery" ? "#0047AB" : "#cbd5e1"}`,
                    background: expenseType === "non-delivery" ? "rgba(0, 71, 171, 0.05)" : "#ffffff",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: expenseType === "non-delivery" ? "#0047AB" : "#334155",
                    transition: "all 0.15s ease",
                  }}
                >
                  <input
                    type="radio"
                    name="expenseType"
                    value="non-delivery"
                    checked={expenseType === "non-delivery"}
                    onChange={() => setExpenseType("non-delivery")}
                    style={{ accentColor: "#0047AB" }}
                  />
                  <span>Non-delivery expense</span>
                </label>
              </div>
            </div>

            {/* VAT Incurred */}
            <div>
              <label style={labelStyle}>Will transactions incur VAT?</label>
              <select value={vat} onChange={(e) => setVat(e.target.value)} style={selectStyle}>
                <option value="Yes">Yes — transactions will incur VAT</option>
                <option value="No">No — exempt or zero-rated (No VAT)</option>
              </select>
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
              <span>{isSubmitting ? "Saving..." : "Save Expense"}</span>
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
