import React, { useState, useEffect, useMemo } from "react";
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
  const [verifying, setVerifying] = useState(true);
  const [liveCheck, setLiveCheck] = useState(null);
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

  const { alert, clientName, confirmedRow, slotNum, invoiceRef, jobName, endClientName, projectCode, amount, sentDate } = target || {};

  // Live check on open: scan the spreadsheet live to verify where the invoiceRef actually lives right now
  useEffect(() => {
    if (!isOpen || !target || !resolvedClientSheetId || !invoiceRef) {
      setVerifying(false);
      return;
    }

    let isMounted = true;
    setVerifying(true);
    setLiveCheck(null);
    setError("");

    (async () => {
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify_invoice_slot",
            clientSheetId: resolvedClientSheetId,
            rowNum: confirmedRow,
            slotNum: slotNum,
            invoiceRef: invoiceRef,
            tabName: "Confirmed"
          })
        });

        const data = await res.json();
        if (!isMounted) return;

        if (data.success) {
          setLiveCheck(data);
        } else {
          console.warn("Live invoice verification returned error:", data.error);
          setLiveCheck({ found: true, liveRowNum: confirmedRow, liveSlotNum: slotNum, unverified: true });
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn("Live invoice check fetch failed:", err);
        setLiveCheck({ found: true, liveRowNum: confirmedRow, liveSlotNum: slotNum, unverified: true });
      } finally {
        if (isMounted) setVerifying(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isOpen, target, resolvedClientSheetId, invoiceRef, confirmedRow, slotNum]);

  if (!isOpen || !target) return null;

  const effectiveRowNum = liveCheck?.liveRowNum || confirmedRow;
  const effectiveSlotNum = liveCheck?.liveSlotNum || slotNum;
  const effectiveAmount = liveCheck?.liveAmount || amount;
  const effectiveSentDate = liveCheck?.liveSentDate || sentDate;
  const effectiveClient = liveCheck?.liveClient || endClientName;
  const effectiveJob = liveCheck?.liveJobName || jobName;
  const isInvoiceAlreadyGone = liveCheck && liveCheck.found === false;

  const handleConfirmAction = async () => {
    setDeleting(true);
    setError("");

    try {
      // 1. If invoice was found on the sheet, clear the live slot on the Confirmed tab
      if (!isInvoiceAlreadyGone) {
        if (!resolvedClientSheetId) {
          throw new Error("Unable to find client spreadsheet ID for this client.");
        }

        const updateRes = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_invoice_slot",
            clientSheetId: resolvedClientSheetId,
            clientName: clientName || "",
            tabName: "Confirmed",
            rowNum: effectiveRowNum,
            slotNum: effectiveSlotNum,
            invoiceRef: invoiceRef,
            jobClient: effectiveClient || "",
            jobName: effectiveJob || "",
            deleteSlot: true,
            automationCommanderSheetId: automationCommanderSheetId || ""
          })
        });

        const updateData = await updateRes.json();
        if (!updateData.success && !updateData.alreadyDeleted) {
          throw new Error(updateData.error || "Failed to clear invoice slot from sheet.");
        }
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
              clientName: clientName || effectiveClient || "",
              sessionId: sessionId || "",
              resolution: isInvoiceAlreadyGone
                ? "Resolved alert (invoice reference already removed from Confirmed tab)"
                : "Deleted invoice from Pulse"
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
              {isInvoiceAlreadyGone ? "Resolve alert (already removed)" : "Delete invoice from Pulse"}
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

        {/* Live check indicator */}
        {verifying ? (
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "10px 14px",
              marginBottom: "14px",
              fontSize: "12px",
              color: "#64748b",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <Spinner size={13} color="#0284c7" />
            <span>Checking live spreadsheet to verify invoice reference location...</span>
          </div>
        ) : isInvoiceAlreadyGone ? (
          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "14px",
              fontSize: "12px",
              color: "#1e40af",
              lineHeight: "1.45"
            }}
          >
            <strong>Live check result:</strong> This invoice reference was not found anywhere on the Confirmed tab. It appears to have already been removed or voided. You can safely resolve this alert now without modifying the sheet.
          </div>
        ) : liveCheck?.found ? (
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "8px",
              padding: "10px 14px",
              marginBottom: "14px",
              fontSize: "12px",
              color: "#166534",
              lineHeight: "1.4"
            }}
          >
            <div>
              ✓ <strong>Live verified:</strong> Invoice located on Confirmed tab {isAdmin ? `at Row ${effectiveRowNum}, slot ${effectiveSlotNum}` : `in slot ${effectiveSlotNum}`}
            </div>
            {liveCheck.rowShifted && (
              <div style={{ marginTop: "3px", color: "#15803d", fontSize: "11px" }}>
                ℹ Row shifted from row {confirmedRow} to row {effectiveRowNum} since the alert was raised. The live row will be targeted.
              </div>
            )}
          </div>
        ) : null}

        {/* Warning callout for active deletion */}
        {!isInvoiceAlreadyGone && (
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
            This invoice reference was not found in the accounting system (it may have been deleted or voided in Xero). Deleting it from Pulse will clear all fields for this invoice slot on the Confirmed tab and resolve this alert. This action cannot be undone.
          </div>
        )}

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
          {effectiveClient && (
            <div>
              <strong style={{ color: "#475569" }}>End client:</strong> {effectiveClient}
            </div>
          )}
          {effectiveJob && (
            <div>
              <strong style={{ color: "#475569" }}>Job:</strong> {effectiveJob}{projectCode ? ` [${projectCode}]` : ""}
            </div>
          )}
          {invoiceRef && (
            <div>
              <strong style={{ color: "#475569" }}>Invoice reference:</strong> <span style={{ fontFamily: "monospace", fontWeight: "600", color: "#0f172a" }}>{invoiceRef}</span>
            </div>
          )}
          {effectiveAmount && (
            <div>
              <strong style={{ color: "#475569" }}>Amount:</strong> £{parseFloat(String(effectiveAmount).replace(/[£,\s]/g, "")).toFixed(2)}
            </div>
          )}
          {effectiveSentDate && (
            <div>
              <strong style={{ color: "#475569" }}>Sent date:</strong> {effectiveSentDate}
            </div>
          )}
          {isAdmin && effectiveRowNum && (
            <div>
              <strong style={{ color: "#475569" }}>Confirmed tab location:</strong> Row {effectiveRowNum}{effectiveSlotNum ? `, slot ${effectiveSlotNum}` : ""}
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
            onClick={handleConfirmAction}
            disabled={deleting || verifying}
            style={{
              padding: "8px 18px",
              background: isInvoiceAlreadyGone ? "#1976d2" : "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: deleting || verifying ? "default" : "pointer",
              fontSize: "13px",
              fontWeight: "600",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              opacity: deleting || verifying ? 0.8 : 1,
              boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)"
            }}
          >
            {deleting ? (
              <>
                <Spinner size={13} color="#fff" />
                <span>{isInvoiceAlreadyGone ? "Resolving alert..." : "Deleting invoice..."}</span>
              </>
            ) : isInvoiceAlreadyGone ? (
              "Resolve alert"
            ) : (
              "Delete invoice from Pulse"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
