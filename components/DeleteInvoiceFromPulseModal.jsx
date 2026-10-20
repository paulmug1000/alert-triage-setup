import React, { useState, useMemo } from "react";
import Spinner from "./Spinner";
import { useAppGlobals } from "../hooks/useAppGlobals";

export default function DeleteInvoiceFromPulseModal({
  isOpen,
  target,
  automationCommanderSheetId,
  sessionId,
  isAdmin = false,
  onClose,
  onDeleted
}) {
  const { allClientsMap } = useAppGlobals();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const resolvedClientSheetId = useMemo(() => {
    if (target?.clientSheetId) return target.clientSheetId;
    if (target?.clientInfo?.clientSheetId) return target.clientInfo.clientSheetId;
    const cName = target?.clientName || target?.alert?.clientName;
    if (cName && allClientsMap) {
      const match = allClientsMap[cName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === cName.toLowerCase());
      if (match?.clientSheetId) return match.clientSheetId;
    }
    return null;
  }, [target, allClientsMap]);

  if (!isOpen || !target) return null;

  const { alert, clientName, confirmedRow, slotNum, invoiceRef, jobName, endClientName, projectCode, amount, sentDate } = target;

  const handleConfirmDelete = async () => {
    if (!resolvedClientSheetId) {
      setError("Unable to find client spreadsheet ID for this client.");
      return;
    }

    setDeleting(true);
    setError("");

    try {
      // 1. Clear the invoice slot on the Confirmed tab in Pulse
      const updateRes = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: resolvedClientSheetId,
          clientName: clientName || "",
          tabName: "Confirmed",
          rowNum: confirmedRow,
          slotNum: slotNum,
          invoiceRef: invoiceRef,
          jobClient: endClientName || "",
          jobName: jobName || "",
          deleteSlot: true,
          automationCommanderSheetId: automationCommanderSheetId || ""
        })
      });

      const updateData = await updateRes.json();
      if (!updateData.success) {
        throw new Error(updateData.error || "Failed to clear invoice slot from sheet.");
      }

      // 2. Resolve the proactive alert in AlertMemory & Redis
      const alertKey = alert?.alertKey;
      if (alertKey && automationCommanderSheetId) {
        try {
          await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "resolve_proactive_alert",
              automationCommanderSheetId,
              alertKey,
              clientName: clientName || endClientName || "",
              sessionId: sessionId || "",
              resolution: "Deleted invoice from Pulse"
            })
          });
        } catch (resolveErr) {
          console.warn("Failed to mark proactive alert as resolved:", resolveErr);
        }
      }

      // 3. Notify parent component to update UI state
      if (onDeleted) {
        onDeleted(alertKey, alert?.rowIndex);
      }
      onClose();
    } catch (err) {
      console.error("Error deleting invoice from Pulse:", err);
      setError(err.message || "Failed to delete invoice from Pulse.");
      setDeleting(false);
    }
  };

  const close = () => {
    if (!deleting) onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(2px)",
        zIndex: 1050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px"
      }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(92vw, 480px)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          border: "1px solid #e2e8f0"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Delete invoice from Pulse
            </h3>
            {invoiceRef && (
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Invoice reference: <strong>{invoiceRef}</strong>
              </div>
            )}
          </div>
          {!deleting && (
            <button
              onClick={close}
              style={{
                background: "none",
                border: "none",
                fontSize: "20px",
                lineHeight: "1",
                cursor: "pointer",
                color: "#94a3b8",
                padding: "4px"
              }}
              title="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* Warning callout */}
        <div
          style={{
            background: "#fff5f5",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "16px",
            fontSize: "12px",
            color: "#991b1b",
            lineHeight: "1.45"
          }}
        >
          This invoice reference appears on the Confirmed tab in Pulse but was not found in the accounting system (it may have been deleted or voided in Xero). Deleting it from Pulse will clear all fields for this invoice slot on the Confirmed tab and resolve this alert. This action cannot be undone.
        </div>

        {/* Invoice details summary card */}
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "16px",
            fontSize: "12px",
            color: "#334155",
            display: "flex",
            flexDirection: "column",
            gap: "6px"
          }}
        >
          {endClientName && (
            <div>
              <strong style={{ color: "#475569" }}>End client:</strong> {endClientName}
            </div>
          )}
          {jobName && (
            <div>
              <strong style={{ color: "#475569" }}>Job:</strong> {jobName}{projectCode ? ` [${projectCode}]` : ""}
            </div>
          )}
          {invoiceRef && (
            <div>
              <strong style={{ color: "#475569" }}>Invoice reference:</strong> <span style={{ fontFamily: "monospace", fontWeight: "600", color: "#0f172a" }}>{invoiceRef}</span>
            </div>
          )}
          {amount && (
            <div>
              <strong style={{ color: "#475569" }}>Amount:</strong> £{parseFloat(String(amount).replace(/[£,\s]/g, "")).toFixed(2)}
            </div>
          )}
          {sentDate && (
            <div>
              <strong style={{ color: "#475569" }}>Sent date:</strong> {sentDate}
            </div>
          )}
          {isAdmin && confirmedRow && (
            <div>
              <strong style={{ color: "#475569" }}>Confirmed tab location:</strong> Row {confirmedRow}{slotNum ? `, slot ${slotNum}` : ""}
            </div>
          )}
        </div>

        {error && (
          <div
            style={{
              fontSize: "12px",
              color: "#b91c1c",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              padding: "10px 12px",
              borderRadius: "6px",
              marginBottom: "16px"
            }}
          >
            {error}
          </div>
        )}

        {/* Modal actions */}
        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", alignItems: "center" }}>
          <button
            type="button"
            onClick={close}
            disabled={deleting}
            style={{
              padding: "8px 16px",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: deleting ? "default" : "pointer",
              fontSize: "13px",
              color: "#334155",
              fontWeight: "500",
              opacity: deleting ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmDelete}
            disabled={deleting}
            style={{
              padding: "8px 18px",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: deleting ? "default" : "pointer",
              fontSize: "13px",
              fontWeight: "600",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              opacity: deleting ? 0.8 : 1,
              boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)"
            }}
          >
            {deleting ? (
              <>
                <Spinner size={13} color="#fff" />
                <span>Deleting invoice...</span>
              </>
            ) : (
              "Delete invoice from Pulse"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
