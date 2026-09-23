import React from "react";
import Spinner from "./Spinner";

export default function RetainerSplitInvoiceModal({ alertMeta, alertKey, automationCommanderSheetId, clientSheetId, masterSheetId, onClose, onResolved }) {
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
            action: "compute_retainer_split_invoice_preview",
            clientSheetId,
            client: alertMeta.endClientName, jobName: alertMeta.jobName, parentRowNum: alertMeta.confirmedRow,
            lastInvoiceDate: alertMeta.lastInvoiceDate,
            possibleMatchSentDate: alertMeta.possibleMatchSentDate,
            possibleMatchAmount: alertMeta.possibleMatchAmount,
            possibleMatchInvoiceNo: alertMeta.possibleMatchInvoiceNo,
            possibleMatchVatAmount: alertMeta.possibleMatchVatAmount,
            possibleMatchStatus: alertMeta.possibleMatchStatus,
            possibleMatchConfirmedRow: alertMeta.possibleMatchConfirmedRow,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.success) { setError(data.error || "Could not compute the split."); setLoading(false); return; }
        setPreview(data);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [alertMeta, clientSheetId]);

  const close = () => { if (!applying) onClose(); };

  const handleConfirm = async () => {
    if (!preview) return;
    setApplying(true); setError("");
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply_retainer_split_invoice",
          clientSheetId, masterSheetId,
          client: alertMeta.endClientName, jobName: alertMeta.jobName, parentRowNum: alertMeta.confirmedRow,
          missingRowNum: preview.missingRowNum,
          standardMonthlyAmount: preview.standardMonthlyAmount,
          altAmount: preview.altAmount, altSentDate: preview.altSentDate, altInvoiceNo: preview.altInvoiceNo, altStatus: preview.altStatus,
          vatAmount: preview.vatAmount, difference: preview.difference,
          extraJobName: preview.extraJobName, extraJobMonth: preview.extraJobMonth, extraJobYear: preview.extraJobYear,
          existingConfirmedRow: preview.existingJobInfo?.confirmedRow,
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || "Failed to apply the split."); setApplying(false); return; }

      if (alertKey && automationCommanderSheetId) {
        try {
          await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "resolve_proactive_alert",
              automationCommanderSheetId, alertKey,
              clientName: alertMeta?.clientName || alertMeta?.endClientName || "",
              resolution: "Invoice split between retainer and extra revenue job",
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
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 500px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700" }}>Split invoice — {alertMeta.endClientName}</h3>
          {!applying && <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>}
        </div>

        {(loading || applying) ? (
          <div style={{ padding: "30px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
            <Spinner size={32} color="#0891b2" />
            <div style={{ fontSize: "14px", color: "#0e7490", fontWeight: "600" }}>
              {applying ? "Applying the split — this can take a little while..." : "Working out the split..."}
            </div>
            {applying && <div style={{ fontSize: "12px", color: "#999" }}>Please don&apos;t close this window until it&apos;s done.</div>}
          </div>
        ) : error && !preview ? (
          <div style={{ fontSize: "13px", color: "#d32f2f", background: "#fff5f5", padding: "12px", borderRadius: "6px" }}>{error}</div>
        ) : preview && (
          <>
            <div style={{ fontSize: "13px", color: "#333", marginBottom: "16px" }}>
              <div><strong>Job:</strong> {alertMeta.jobName}</div>
              <div style={{ marginTop: "8px", padding: "10px", background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: "6px" }}>
                The retainer&apos;s <strong>{preview.missingRowPeriodLabel}</strong> invoice (row {preview.missingRowNum}) will be recorded at the standard <strong>£{preview.standardMonthlyAmount.toFixed(2)}</strong>, using invoice #{preview.altInvoiceNo} sent {preview.altSentDate}.
              </div>
              <div style={{ marginTop: "8px", padding: "10px", background: preview.difference >= 0 ? "#f5f3ff" : "#fff7ed", border: `1px solid ${preview.difference >= 0 ? "#ddd6fe" : "#fed7aa"}`, borderRadius: "6px" }}>
                The invoice was actually for <strong>£{preview.altAmount.toFixed(2)}</strong> — a difference of <strong>{preview.difference >= 0 ? "+" : ""}£{preview.difference.toFixed(2)}</strong>.{" "}
                {preview.existingJobInfo ? (
                  <>This will be applied to the existing job on row <strong>{preview.existingJobInfo.confirmedRow}</strong> ({preview.existingJobInfo.jobName}), which will be renamed to <strong>&quot;{preview.extraJobName}&quot;</strong> and its revenue set to {preview.difference >= 0 ? "" : "-"}£{Math.abs(preview.difference).toFixed(2)}.</>
                ) : (
                  <>A new standalone job called <strong>&quot;{preview.extraJobName}&quot;</strong> will be created, with revenue {preview.difference >= 0 ? "" : "-"}£{Math.abs(preview.difference).toFixed(2)}.</>
                )}
              </div>
            </div>

            {error && <div style={{ fontSize: "12px", color: "#d32f2f", background: "#fff5f5", padding: "8px", borderRadius: "4px", marginBottom: "12px" }}>{error}</div>}

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={close} disabled={applying}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={handleConfirm} disabled={applying}
                style={{ padding: "8px 22px", background: "#0891b2", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Confirm split
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}