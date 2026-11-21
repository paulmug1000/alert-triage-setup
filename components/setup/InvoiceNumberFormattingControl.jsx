import React from "react";
import {
  INVOICE_NUMBER_FORMATTING_OPTIONS,
  formatInvoiceNumber,
} from "../../utils/helpers";

export default function InvoiceNumberFormattingControl({
  value = "StripPre",
  onChange,
  sampleInvoiceNumbers = [],
  isAdmin = false,
  showCellRef = false,
}) {
  const effectiveSetting = value || "StripPre";
  const samples = Array.isArray(sampleInvoiceNumbers) && sampleInvoiceNumbers.length > 0
    ? sampleInvoiceNumbers
    : ["INV-1065", "INV-5067"];
  const hasLiveSamples = Array.isArray(sampleInvoiceNumbers) && sampleInvoiceNumbers.length > 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: "20px", alignItems: "start" }}>
      <div>
        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "6px" }}>
          Formatting rule{isAdmin && !showCellRef ? " (InvAppList!F1)" : ""}
        </label>
        <select
          value={effectiveSetting}
          onChange={(e) => onChange?.(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid #CBD5E1",
            fontSize: "13px",
            color: "#0F172A",
            background: "#FFFFFF",
            boxSizing: "border-box",
          }}
        >
          {INVOICE_NUMBER_FORMATTING_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {isAdmin && showCellRef && (
          <div style={{ fontSize: "11px", color: "#64748B", marginTop: "6px" }}>
            Stored in Master Sheet cell{" "}
            <code style={{ background: "#F1F5F9", padding: "1px 4px", borderRadius: "4px" }}>InvAppList!F1</code>
          </div>
        )}
      </div>

      <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: "8px", padding: "14px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <span style={{ fontSize: "12px", fontWeight: "700", color: "#334155" }}>
            Live preview
          </span>
          {hasLiveSamples ? (
            <span style={{ fontSize: "11px", color: "#166534", background: "#DCFCE7", border: "1px solid #86EFAC", padding: "2px 8px", borderRadius: "10px", fontWeight: "600" }}>
              Live client invoices
            </span>
          ) : (
            <span style={{ fontSize: "11px", color: "#475569", background: "#E2E8F0", padding: "2px 8px", borderRadius: "10px" }}>
              Illustrative preview
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {samples.map((rawInv, idx) => {
            const formatted = formatInvoiceNumber(rawInv, effectiveSetting);
            return (
              <div key={idx} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", fontFamily: "monospace" }}>
                <span style={{ color: "#475569", fontWeight: "600", minWidth: "95px" }}>{rawInv}</span>
                <span style={{ color: "#0066CC", fontWeight: "700" }}>→</span>
                <span style={{ color: "#0F172A", fontWeight: "700", background: "#EFF6FF", padding: "3px 8px", borderRadius: "4px", border: "1px solid #BFDBFE" }}>
                  {formatted || "—"}
                </span>
              </div>
            );
          })}
        </div>

        {!hasLiveSamples && (
          <div style={{ fontSize: "11px", color: "#64748B", marginTop: "10px", fontStyle: "italic", borderTop: "1px dashed #CBD5E1", paddingTop: "8px" }}>
            Live invoices from your accounting tool will appear here once connected and synced.
          </div>
        )}
      </div>
    </div>
  );
}
