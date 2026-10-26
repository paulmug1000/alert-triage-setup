import React from "react";
import { formatCurrency } from "../utils/helpers";

export default function PlaceholderChoiceModal({
  isOpen,
  type = "invoice", // "invoice" | "expense"
  job,
  itemToPlace,
  manualPlaceholders = [],
  onReplaceManual,
  onUseAuto,
  onClose,
}) {
  if (!isOpen || !job || !itemToPlace) return null;

  const isInvoice = type === "invoice";
  const itemTitle = isInvoice
    ? `Invoice #${itemToPlace.invoiceNo || itemToPlace.ref || ""}`
    : (itemToPlace.description || (itemToPlace.transactionId ? `#${itemToPlace.transactionId}` : "Expense"));
  const itemAmt = formatCurrency(itemToPlace.amount);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(2px)",
        zIndex: 1300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(94vw, 480px)",
          boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid #f1f5f9",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Placeholder choice
            </h3>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
              {job.client} · {job.jobName}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "20px",
              cursor: "pointer",
              color: "#94a3b8",
              lineHeight: 1,
              padding: "2px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
            Placing <strong>{itemTitle}</strong> ({itemAmt}). This job contains existing manual placeholder(s). How would you like to proceed?
          </div>

          {/* Option 1: Replace a manual placeholder */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.03em", color: "#475569" }}>
              Option 1: Replace a manual placeholder
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {manualPlaceholders.map((p, idx) => {
                const label = isInvoice
                  ? (p.ref || "Manual placeholder")
                  : (p.description || (p.transactionId ? `#${p.transactionId}` : "Manual placeholder"));
                const pAmt = formatCurrency(p.amount);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => onReplaceManual(p)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "10px 12px",
                      borderRadius: "7px",
                      border: "1px solid #bfdbfe",
                      background: "#f0fdf4",
                      color: "#1e3a8a",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "all 0.15s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#2563eb";
                      e.currentTarget.style.background = "#dbeafe";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "#bfdbfe";
                      e.currentTarget.style.background = "#f0fdf4";
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span style={{ fontSize: "13px", fontWeight: "600", color: "#1e293b" }}>
                        Replace {label}
                      </span>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        Current placeholder amount: {pAmt}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "600",
                        padding: "3px 8px",
                        borderRadius: "5px",
                        background: "#2563eb",
                        color: "#ffffff",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Select
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Option 2: Use auto placeholder / add new */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingTop: "6px", borderTop: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.03em", color: "#475569" }}>
              Option 2: Keep manual placeholders
            </div>
            <button
              type="button"
              onClick={onUseAuto}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "2px",
                padding: "10px 12px",
                borderRadius: "7px",
                border: "1px solid #e2e8f0",
                background: "#f8fafc",
                color: "#1e293b",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#94a3b8";
                e.currentTarget.style.background = "#f1f5f9";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#e2e8f0";
                e.currentTarget.style.background = "#f8fafc";
              }}
            >
              <span style={{ fontSize: "13px", fontWeight: "600" }}>
                Use automatic placeholder / add as new
              </span>
              <span style={{ fontSize: "11px", color: "#64748b" }}>
                Leaves your manual placeholder(s) intact and automatically adjusts remaining revenue/budget.
              </span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 22px",
            borderTop: "1px solid #f1f5f9",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#475569",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
