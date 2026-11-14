import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import { useAppGlobals } from "../hooks/useAppGlobals";

export default function DeleteExpenseFromPulseModal({
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

  const resolvedMasterSheetId = useMemo(() => {
    if (target?.masterSheetId) return target.masterSheetId;
    if (target?.clientInfo?.masterSheetId) return target.clientInfo.masterSheetId;
    const cName = target?.clientName || target?.alert?.clientName;
    if (cName && allClientsMap) {
      const match = allClientsMap[cName] || Object.values(allClientsMap).find(c => c.clientName?.toLowerCase() === cName.toLowerCase());
      if (match?.masterSheetId) return match.masterSheetId;
    }
    return null;
  }, [target, allClientsMap]);

  const {
    alert,
    clientName,
    confirmedRow,
    slotNum,
    expRef,
    jobName,
    endClientName,
    description,
    amount,
    recDate,
  } = target || {};

  useEffect(() => {
    if (!isOpen || !target || !resolvedClientSheetId || !expRef) {
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
            action: "verify_expense_in_pulse",
            clientSheetId: resolvedClientSheetId,
            expRef,
            rowNum: confirmedRow || null,
            slotNum: slotNum || null,
            endClientName: endClientName || "",
            jobName: jobName || "",
          }),
        });
        const data = await res.json();
        if (!isMounted) return;

        if (data.success) {
          setLiveCheck(data);
        } else {
          setLiveCheck(
            confirmedRow
              ? { found: true, locationType: "confirmed", liveRowNum: confirmedRow, liveSlotNum: slotNum || 1, unverified: true }
              : { found: false }
          );
        }
      } catch (err) {
        if (!isMounted) return;
        setLiveCheck(
          confirmedRow
            ? { found: true, locationType: "confirmed", liveRowNum: confirmedRow, liveSlotNum: slotNum || 1, unverified: true }
            : { found: false }
        );
      } finally {
        if (isMounted) setVerifying(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isOpen, target, resolvedClientSheetId, expRef, confirmedRow, slotNum, endClientName, jobName]);

  if (!isOpen || !target) return null;

  const isAlreadyGone = liveCheck && liveCheck.found === false;
  const locationType = liveCheck?.locationType || (confirmedRow ? "confirmed" : "outgoings");
  const isOutgoingsLocation = locationType === "outgoings";

  const effectiveRowNum = liveCheck?.liveRowNum || confirmedRow;
  const effectiveSlotNum = liveCheck?.liveSlotNum || slotNum;
  const effectiveClient = liveCheck?.liveClient || endClientName;
  const effectiveJob = liveCheck?.liveJobName || jobName;
  const effectiveDescription = liveCheck?.liveDescription || liveCheck?.removedBlock?.description || description;
  const effectiveAmount = liveCheck?.liveAmount || liveCheck?.removedBlock?.amount || amount;
  const effectiveDate = liveCheck?.liveDate || liveCheck?.removedBlock?.recDate || recDate;
  const effectiveCategory = liveCheck?.categoryName || jobName || "Overhead expense";
  const effectiveMonthLabel = liveCheck?.monthLabel || "";

  const parsedAmt = parseFloat(String(effectiveAmount || "").replace(/[£$€,\s]/g, ""));
  const hasValidAmt = !isNaN(parsedAmt) && parsedAmt > 0;

  const handleConfirmAction = async () => {
    setDeleting(true);
    setError("");

    try {
      if (!isAlreadyGone) {
        if (!resolvedClientSheetId) {
          throw new Error(isAdmin ? "Unable to find client spreadsheet ID for this client." : "Unable to find client configuration in Pulse.");
        }

        if (locationType === "confirmed") {
          const updateRes = await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update_expense_slot",
              clientSheetId: resolvedClientSheetId,
              masterSheetId: resolvedMasterSheetId || "",
              clientName: clientName || "",
              tabName: "Confirmed",
              rowNum: effectiveRowNum,
              slotNum: effectiveSlotNum,
              deleteSlot: true,
              jobClient: effectiveClient || "",
              jobName: effectiveJob || "",
              automationCommanderSheetId: automationCommanderSheetId || "",
            }),
          });
          const updateData = await updateRes.json();
          if (!updateData.success) {
            throw new Error(updateData.error || "Failed to delete expense from Pulse.");
          }
        } else {
          const updateRes = await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update_outgoing_note",
              clientSheetId: resolvedClientSheetId,
              clientName: clientName || "",
              contractorName: effectiveCategory,
              sheetRow: liveCheck.sheetRow,
              colLetter: liveCheck.colLetter,
              blocks: liveCheck.remainingBlocks || [],
              topNote: liveCheck.topNote ?? "",
              automationCommanderSheetId: automationCommanderSheetId || "",
            }),
          });
          const updateData = await updateRes.json();
          if (!updateData.success) {
            throw new Error(updateData.error || "Failed to delete expense from Pulse.");
          }
        }

        if (resolvedMasterSheetId) {
          fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fire_outgoings_pull",
              masterSheetId: resolvedMasterSheetId,
              clientName: clientName || effectiveClient || "",
            }),
          }).catch(() => {});
        }
      }

      const alertKey = alert?.alertKey;
      if (alertKey && automationCommanderSheetId) {
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "resolve_proactive_alert",
            automationCommanderSheetId,
            alertKey,
            clientName: clientName || effectiveClient || "",
            sessionId: sessionId || "",
            resolution: isAlreadyGone
              ? "Expense already removed from Pulse"
              : "Deleted expense from Pulse",
          }),
        }).catch((resolveErr) => {
          console.warn("Failed to mark proactive alert as resolved:", resolveErr);
        });
      }

      if (onDeleted) {
        onDeleted(alertKey, alert?.rowIndex);
      }
      onClose();
    } catch (err) {
      console.error("Error deleting expense from Pulse:", err);
      setError(err.message || "Failed to delete expense from Pulse.");
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
        padding: "16px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
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
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              {isAlreadyGone ? "Resolve alert (already removed)" : "Delete expense from Pulse"}
            </h3>
            {expRef && (
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Expense reference: <strong>{expRef}</strong>
              </div>
            )}
          </div>
          {!deleting && (
            <button
              type="button"
              onClick={close}
              style={{
                background: "none",
                border: "none",
                fontSize: "20px",
                lineHeight: "1",
                cursor: "pointer",
                color: "#94a3b8",
                padding: "4px",
              }}
              title="Close"
            >
              ×
            </button>
          )}
        </div>

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
              gap: "8px",
            }}
          >
            <Spinner size={13} color="#0284c7" />
            <span>Checking expense in Pulse...</span>
          </div>
        ) : isAlreadyGone ? (
          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "14px",
              fontSize: "12px",
              color: "#1e40af",
              lineHeight: "1.45",
            }}
          >
            <strong>Live check result:</strong> This expense reference was not found in Pulse. It appears to have already been removed or voided. You can dismiss this alert now.
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
              lineHeight: "1.4",
            }}
          >
            <div>
              <strong>Live verified:</strong>{" "}
              {isAdmin
                ? (isOutgoingsLocation
                    ? `Expense located on Outgoings cell ${liveCheck.colLetter}${liveCheck.sheetRow}`
                    : `Expense located on Confirmed tab at Row ${effectiveRowNum}, slot ${effectiveSlotNum}`)
                : (isOutgoingsLocation
                    ? "Expense located in monthly overhead / contractor costs"
                    : "Expense located in job direct costs")}
            </div>
            {isAdmin && !isOutgoingsLocation && liveCheck.rowShifted && (
              <div style={{ marginTop: "3px", color: "#15803d", fontSize: "11px" }}>
                Row moved from row {confirmedRow} to row {effectiveRowNum} since the alert was raised. The live entry will be targeted.
              </div>
            )}
          </div>
        ) : null}

        {!isAlreadyGone && (
          <div
            style={{
              background: "#fff5f5",
              border: "1px solid #fecaca",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "16px",
              fontSize: "12px",
              color: "#991b1b",
              lineHeight: "1.45",
            }}
          >
            This expense reference was not found in the accounting system (it may have been deleted or voided in Xero). Deleting it from Pulse will remove the entry and resolve this alert. This action cannot be undone.
          </div>
        )}

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
            gap: "6px",
          }}
        >
          {isOutgoingsLocation ? (
            <>
              {effectiveCategory && (
                <div>
                  <strong style={{ color: "#475569" }}>Category:</strong> {effectiveCategory}
                </div>
              )}
              {effectiveMonthLabel && (
                <div>
                  <strong style={{ color: "#475569" }}>Month:</strong> {effectiveMonthLabel}
                </div>
              )}
            </>
          ) : (
            <>
              {effectiveClient && (
                <div>
                  <strong style={{ color: "#475569" }}>Client:</strong> {effectiveClient}
                </div>
              )}
              {effectiveJob && (
                <div>
                  <strong style={{ color: "#475569" }}>Job:</strong> {effectiveJob}
                </div>
              )}
            </>
          )}
          {expRef && (
            <div>
              <strong style={{ color: "#475569" }}>Reference:</strong>{" "}
              <span style={{ fontFamily: "monospace", fontWeight: "600", color: "#0f172a" }}>{expRef}</span>
            </div>
          )}
          {effectiveDescription && (
            <div>
              <strong style={{ color: "#475569" }}>Description:</strong> {effectiveDescription}
            </div>
          )}
          {hasValidAmt && (
            <div>
              <strong style={{ color: "#475569" }}>Amount:</strong> £{parsedAmt.toFixed(2)}
            </div>
          )}
          {effectiveDate && (
            <div>
              <strong style={{ color: "#475569" }}>Date:</strong> {effectiveDate}
            </div>
          )}
          {isAdmin && !isAlreadyGone && (
            <div>
              <strong style={{ color: "#475569" }}>Location:</strong>{" "}
              {isOutgoingsLocation
                ? (liveCheck?.colLetter && liveCheck?.sheetRow ? `Outgoings cell ${liveCheck.colLetter}${liveCheck.sheetRow}` : "Outgoings")
                : (effectiveRowNum ? `Confirmed row ${effectiveRowNum}${effectiveSlotNum ? `, slot ${effectiveSlotNum}` : ""}` : "Confirmed")}
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
              marginBottom: "16px",
            }}
          >
            {error}
          </div>
        )}

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
              opacity: deleting ? 0.6 : 1,
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
              background: isAlreadyGone ? "#1976d2" : "#dc2626",
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
              boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
            }}
          >
            {deleting ? (
              <>
                <Spinner size={13} color="#fff" />
                <span>{isAlreadyGone ? "Dismissing alert..." : "Deleting expense..."}</span>
              </>
            ) : isAlreadyGone ? (
              "Dismiss alert"
            ) : (
              "Delete expense from Pulse"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
