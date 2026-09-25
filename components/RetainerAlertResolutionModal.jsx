import React from "react";
import Spinner from "./Spinner";

export default function RetainerAlertResolutionModal({ resolutionType, alertMeta, alertKey, automationCommanderSheetId, clientSheetId, masterSheetId, onClose, onResolved }) {
  const [loading, setLoading] = React.useState(true);
  const [preview, setPreview] = React.useState(null);
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "compute_retainer_alert_resolution",
            clientSheetId, masterSheetId,
            client: alertMeta.endClientName, jobName: alertMeta.jobName, parentRowNum: alertMeta.confirmedRow,
            resolutionType,
            lastInvoiceDate: alertMeta.lastInvoiceDate,
            possibleMatchSentDate: alertMeta.possibleMatchSentDate,
            possibleMatchAmount: alertMeta.possibleMatchAmount,
            possibleMatchInvoiceNo: alertMeta.possibleMatchInvoiceNo,
            possibleMatchConfirmedRow: alertMeta.possibleMatchConfirmedRow,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.success) { setError(data.error || "Could not compute the resolution."); setLoading(false); return; }
        setPreview(data);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [alertMeta, clientSheetId, masterSheetId, resolutionType]);

  const close = () => { if (!applying) onClose(); };

  const handleConfirm = async () => {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      let res, data;
      if (resolutionType === "end") {
        res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_end_date",
            clientSheetId, masterSheetId,
            clientName: alertMeta?.clientName || "",
            client: alertMeta.endClientName, jobName: alertMeta.jobName, parentRowNum: alertMeta.confirmedRow,
            newEndDate: preview.computedEndDate,
          }),
        });
      } else {
        res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "change_retainer_monthly_amount",
            clientSheetId,
            clientName: alertMeta?.clientName || "",
            client: alertMeta.endClientName, jobName: alertMeta.jobName, parentRowNum: alertMeta.confirmedRow,
            changeMonth: preview.changeMonth, changeYear: preview.changeYear, newMonthlyAmount: preview.newMonthlyAmount,
            sourceInvoiceRef: preview.sourceInvoiceRef,
            sourceInvoiceSentDate: preview.sourceInvoiceSentDate,
            sourceInvoiceDaysToPay: preview.sourceRowInfo?.daysToPay,
            sourceInvoiceStatus: preview.sourceRowInfo?.status,
            sourceConfirmedRow: preview.sourceRowInfo?.confirmedRow,
          }),
        });
      }
      data = await res.json();
      if (!data.success) { setError(data.error || (data.blocked ? data.error : "Failed to apply the change.")); setApplying(false); return; }
      
      if (alertKey && automationCommanderSheetId) {
        try {
          await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "resolve_proactive_alert",
              automationCommanderSheetId, alertKey,
              clientName: alertMeta?.clientName || alertMeta?.endClientName || "",
              resolution: resolutionType === "end" ? "Retainer ended" : "Retainer amount changed",
            }),
          });
        } catch (resolveErr) {
          console.error("Failed to mark alert resolved:", resolveErr);
        }
      }
      await onResolved();
      onClose();
    } catch (e) { setError(e.message); setApplying(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>
            {resolutionType === "end" ? "End retainer" : "Change retainer amount"} — {alertMeta.endClientName}
          </h3>
          {!applying && <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>}
        </div>

        {(loading || applying) ? (
          <div style={{ padding: "30px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
            <Spinner size={32} color="#7c3aed" />
            <div style={{ fontSize: "14px", color: "#5b21b6", fontWeight: "600" }}>
              {applying ? "Applying the change — this can take a little while..." : "Working out what this change would do..."}
            </div>
            {applying && <div style={{ fontSize: "12px", color: "#999" }}>Please don&apos;t close this window until it&apos;s done.</div>}
          </div>
        ) : error && !preview ? (
          <div style={{ fontSize: "13px", color: "#d32f2f", background: "#fff5f5", padding: "12px", borderRadius: "6px" }}>{error}</div>
        ) : preview && (
          <>
            <div style={{ fontSize: "13px", color: "#333", marginBottom: "16px" }}>
              <div><strong>Job:</strong> {alertMeta.jobName}</div>
              {resolutionType === "end" ? (
                <>
                  <div style={{ marginTop: "8px" }}>Last invoice was sent on <strong>{preview.lastInvoiceSentDate}</strong>, covering <strong>{preview.coveredPeriodLabel}</strong>.</div>
                  <div style={{ marginTop: "8px", padding: "10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px" }}>
                    The retainer&apos;s end date will be set to <strong>{preview.computedEndDateLabel}</strong>. Any future invoice rows beyond this date will be removed (only if they contain no real invoice or expense data — otherwise this will be blocked).
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginTop: "8px" }}>An alternative invoice was found for <strong>£{preview.newPerInvoiceAmount.toFixed(2)}</strong>{preview.intervalMonths > 1 ? ` (covering ${preview.intervalMonths} months)` : ""}.</div>
                  <div style={{ marginTop: "8px", padding: "10px", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: "6px" }}>
                    From <strong>{preview.changeMonthLabel}</strong>, the retainer will be split into a new job at <strong>£{preview.newMonthlyAmount.toFixed(2)}/month</strong>{preview.intervalMonths > 1 ? ` (£${preview.newPerInvoiceAmount.toFixed(2)} per ${preview.intervalMonths}-month invoice)` : ""}. The existing job will end the month before. The alternative invoice{preview.sourceInvoiceRef ? ` (#${preview.sourceInvoiceRef})` : ""} will become the new job&apos;s first invoice.
                  </div>
                  {preview.sourceRowInfo && (
                    <div style={{ marginTop: "8px", padding: "10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px" }}>
                      This invoice is currently attached to a different job on row <strong>{preview.sourceRowInfo.confirmedRow}</strong> ({preview.sourceRowInfo.client} — {preview.sourceRowInfo.jobName}). <strong>That job&apos;s data will be permanently cleared</strong> — {preview.sourceRowInfo.totalRowsToClear > 1 ? `all ${preview.sourceRowInfo.totalRowsToClear} of its rows (the parent row plus ${preview.sourceRowInfo.totalRowsToClear - 1} child row${preview.sourceRowInfo.totalRowsToClear - 1 === 1 ? "" : "s"})` : "its one row"} — (client, job, revenue, dates, and all invoice/expense slots) since it&apos;s being relocated onto this retainer.
                    </div>
                  )}
                </>
              )}
            </div>

            {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginBottom: "12px" }}>{error}</div>}

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={close} disabled={applying}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={handleConfirm} disabled={applying}
                style={{ padding: "8px 22px", background: resolutionType === "end" ? "#dc2626" : "#7c3aed", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Confirm {resolutionType === "end" ? "end retainer" : "change amount"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}