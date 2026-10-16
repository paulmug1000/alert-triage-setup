import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";
import { formatCurrency, JobDateInput, toSheetDateFormat } from "./JobsView";

export default function OutgoingsDetailModal({
  isOpen,
  target,
  onClose,
  isAdmin = false
}) {
  const [description, setDescription] = useState("");
  const [amountVal, setAmountVal] = useState("");
  const [recDateVal, setRecDateVal] = useState("");
  const [payDateVal, setPayDateVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen || !target) {
      setDescription("");
      setAmountVal("");
      setRecDateVal("");
      setPayDateVal("");
      setSavedSuccess(false);
      return;
    }

    setDescription(target.description || target.contractor || "");
    setAmountVal(target.amount || "");
    setRecDateVal(target.recDate || "");
    setPayDateVal(target.payDate || "");
    setSavedSuccess(false);
  }, [isOpen, target]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !target) return null;

  const cellCoord = target.cellCoord || (target.rowNum ? `Row ${target.rowNum}` : "");
  const colLetterMatch = String(cellCoord).match(/^([A-Za-z]+)(\d+)$/);
  const colLetter = colLetterMatch ? colLetterMatch[1].toUpperCase() : "";
  const sheetRow = colLetterMatch ? parseInt(colLetterMatch[2], 10) : (target.rowNum ? parseInt(target.rowNum, 10) : null);

  const canSave = Boolean(target.client?.clientSheetId && colLetter && sheetRow);

  const handleSaveOutgoings = async () => {
    if (!canSave) return;
    setSaving(true);
    setSavedSuccess(false);

    try {
      const parsedAmount = parseFloat(String(amountVal).replace(/[£$€,\s]/g, "")) || 0;
      const formattedRec = recDateVal ? toSheetDateFormat(recDateVal) : "";
      const formattedPay = payDateVal ? toSheetDateFormat(payDateVal) : "";

      const blocks = [
        {
          appId: target.appId || "UNRECON-GAP",
          amount: parsedAmount,
          description: description.trim() || target.contractor || "Expense",
          recDate: formattedRec,
          payDate: formattedPay,
          status: "pending"
        }
      ];

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId: target.client.clientSheetId,
          clientName: target.client.clientName || target.client.name || "",
          cellRef: `${colLetter}${sheetRow}`,
          colLetter,
          sheetRow,
          cellTotal: parsedAmount,
          contractorName: target.contractor || description,
          blocks
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update outgoings entry");

      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3500);
    } catch (err) {
      alert("Error saving outgoings entry: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(94vw, 680px)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
          overflow: "hidden"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #e2e8f0",
            background: "#ffffff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "10px",
                  fontSize: "11px",
                  fontWeight: "700",
                  background: "#fef3c7",
                  color: "#92400e",
                  border: "1px solid #fde68a"
                }}
              >
                Outgoings Entry
              </span>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                {target.contractor || "Contractor / Overhead Expense"}
              </h2>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
              Outgoings tab{target.month ? ` · ${target.month}` : ""}{cellCoord ? ` · ${cellCoord.includes("Cell") ? cellCoord : `Cell ${cellCoord}`}` : ""}
              {target.client?.clientName ? ` (${target.client.clientName})` : ""}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: "#f1f5f9",
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              padding: "6px 14px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#475569",
              cursor: "pointer"
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Overdue / Alert notice */}
          {target.weeksAgo && (
            <div
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: "8px",
                padding: "12px 14px",
                display: "flex",
                alignItems: "flex-start",
                gap: "10px"
              }}
            >
              <span style={{ fontSize: "18px" }}>⚠️</span>
              <div style={{ fontSize: "13px", color: "#92400e", lineHeight: "1.4" }}>
                <strong>Stale UNRECON-GAP expense overdue</strong>
                <div>
                  This gap expense has received date <strong>{target.recDate || "overdue"}</strong> ({target.weeksAgo} weeks ago — more than 6 weeks overdue without reconciliation).
                </div>
              </div>
            </div>
          )}

          {target.changes && target.changes.length > 0 && (
            <div
              style={{
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: "8px",
                padding: "12px 14px"
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: "700", color: "#0369a1", marginBottom: "6px" }}>
                Date Movement Updates
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {target.changes.map((ch, idx) => (
                  <span
                    key={idx}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: "600",
                      background: "#ffffff",
                      color: "#0369a1",
                      border: "1px solid #bae6fd"
                    }}
                  >
                    {ch.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Details Overview Card */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "16px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.04em", color: "#64748b", marginBottom: "12px" }}>
              Expense Details
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Contractor / Description
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{
                    width: "100%", padding: "6px 8px", borderRadius: "5px",
                    border: "1px solid #cbd5e1", fontSize: "13px", fontWeight: "500",
                    outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Amount
                </label>
                <input
                  type="text"
                  value={amountVal}
                  onChange={(e) => setAmountVal(e.target.value)}
                  placeholder="0.00"
                  style={{
                    width: "100%", padding: "6px 8px", borderRadius: "5px",
                    border: "1px solid #cbd5e1", fontSize: "13px", fontWeight: "600",
                    outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Received Date
                </label>
                <JobDateInput
                  value={recDateVal}
                  onChange={(val) => setRecDateVal(val)}
                  defaultBorder="1px solid #cbd5e1"
                  defaultBg="#ffffff"
                  style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Pay Date
                </label>
                <JobDateInput
                  value={payDateVal}
                  onChange={(val) => setPayDateVal(val)}
                  defaultBorder="1px solid #cbd5e1"
                  defaultBg="#ffffff"
                  style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                />
              </div>
            </div>

            {target.appId && (
              <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #f1f5f9", fontSize: "11px", color: "#64748b" }}>
                <strong>App ID / Identifier:</strong>{" "}
                <span style={{ fontFamily: "monospace", color: "#334155" }}>{target.appId}</span>
              </div>
            )}

            {target.rawText && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#64748b" }}>
                <strong>Original Note:</strong> {target.rawText}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px"
          }}
        >
          <div>
            {savedSuccess ? (
              <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: "700" }}>
                ✓ Outgoings cell updated successfully
              </span>
            ) : (
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                {canSave ? "Edit fields above and click Save to update Outgoings sheet" : "Viewing expense record"}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {target.client?.clientSheetId && (
              <button
                type="button"
                onClick={() => {
                  window.open(`https://docs.google.com/spreadsheets/d/${target.client.clientSheetId}/edit`, "_blank");
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #93c5fd",
                  background: "#ffffff",
                  color: "#1d4ed8",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                📊 Open Outgoings Sheet
              </button>
            )}

            {canSave && (
              <button
                type="button"
                onClick={handleSaveOutgoings}
                disabled={saving}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: saving ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {saving ? <><Spinner size={12} color="#ffffff" /> Saving...</> : "💾 Save Expense"}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                fontSize: "12px",
                fontWeight: "600",
                cursor: "pointer"
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
