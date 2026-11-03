import React, { useState } from "react";
import Spinner from "./Spinner";
import { useAppGlobals } from "../hooks/useAppGlobals";

export default function RetainerChangeSendDatesModal({
  isOpen,
  target,
  automationCommanderSheetId,
  onClose,
  onUpdated
}) {
  const { allClientsMap, user } = useAppGlobals();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin");

  const [sendDay, setSendDay] = useState("28");
  const [customDay, setCustomDay] = useState("");
  const [applyTo, setApplyTo] = useState("placeholders");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen || !target) return null;

  const effectiveClientName = target.clientName || target.alert?.clientName || "";
  const resolvedClientSheetId = target.clientSheetId
    || target.client?.clientSheetId
    || (effectiveClientName && allClientsMap?.[effectiveClientName]?.clientSheetId)
    || (effectiveClientName && Object.values(allClientsMap || {}).find(c => c.clientName?.toLowerCase() === effectiveClientName.toLowerCase())?.clientSheetId);
  const resolvedMasterSheetId = target.masterSheetId
    || target.client?.masterSheetId
    || (effectiveClientName && allClientsMap?.[effectiveClientName]?.masterSheetId)
    || (effectiveClientName && Object.values(allClientsMap || {}).find(c => c.clientName?.toLowerCase() === effectiveClientName.toLowerCase())?.masterSheetId);

  const jobName = target.jobName || target.alert?.jobName || target.alert?.metadata?.jobName || "";
  const endClientName = target.endClientName || target.client || target.alert?.endClientName || target.alert?.metadata?.endClientName || "";
  const parentRowNum = target.confirmedRow || target.rowNum || target.alert?.confirmedRow || target.alert?.metadata?.confirmedRow;

  const handlePresetChange = (preset) => {
    setSendDay(preset);
    if (preset !== "custom") setCustomDay("");
  };

  const handleSave = async () => {
    if (!resolvedClientSheetId) {
      setError(isAdmin ? "Could not find client spreadsheet ID." : "Could not find client configuration in Pulse.");
      return;
    }
    const finalDay = sendDay === "custom" ? parseInt(customDay, 10) : (sendDay === "end" ? "end" : parseInt(sendDay, 10));
    if (finalDay !== "end" && (isNaN(finalDay) || finalDay < 1 || finalDay > 31)) {
      setError("Please choose a valid day of the month between 1 and 31.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "change_retainer_send_dates",
          clientSheetId: resolvedClientSheetId,
          masterSheetId: resolvedMasterSheetId,
          automationCommanderSheetId: automationCommanderSheetId || "",
          clientName: effectiveClientName,
          client: endClientName,
          jobName,
          parentRowNum,
          newSendDay: finalDay,
          applyTo
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update retainer send dates.");
      }

      if (typeof onUpdated === "function") {
        await onUpdated(data);
      }
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 2500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(92vw, 460px)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
            Change expected send dates
          </h3>
          {!saving && (
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#94a3b8" }}
            >
              ×
            </button>
          )}
        </div>

        <div style={{ fontSize: "12px", color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px", marginBottom: "18px" }}>
          <div><strong>Client:</strong> {endClientName || effectiveClientName}</div>
          <div><strong>Job:</strong> {jobName}</div>
        </div>

        {error && (
          <div style={{ fontSize: "12px", color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
              Expected invoice send day each month
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginBottom: "8px" }}>
              {[
                { label: "1st", val: "1" },
                { label: "15th", val: "15" },
                { label: "25th", val: "25" },
                { label: "28th", val: "28" },
                { label: "Last day", val: "end" },
                { label: "Custom", val: "custom" },
              ].map(preset => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() => handlePresetChange(preset.val)}
                  style={{
                    padding: "7px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: sendDay === preset.val ? "600" : "500",
                    border: sendDay === preset.val ? "2px solid #0284c7" : "1px solid #cbd5e1",
                    background: sendDay === preset.val ? "#f0f9ff" : "#ffffff",
                    color: sendDay === preset.val ? "#0369a1" : "#475569",
                    cursor: "pointer"
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {sendDay === "custom" && (
              <div style={{ marginTop: "6px" }}>
                <label style={{ display: "block", fontSize: "11px", color: "#64748b", marginBottom: "3px" }}>
                  Day of month (1 - 31)
                </label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={customDay}
                  onChange={e => setCustomDay(e.target.value)}
                  placeholder="e.g. 5 or 20"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px", boxSizing: "border-box" }}
                  autoFocus
                />
              </div>
            )}
          </div>

          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
              Apply to
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="applyTo"
                  value="placeholders"
                  checked={applyTo === "placeholders"}
                  onChange={() => setApplyTo("placeholders")}
                  style={{ marginTop: "2px" }}
                />
                <div>
                  <div style={{ fontWeight: "600" }}>Unsent placeholder invoices only (recommended)</div>
                  <div style={{ fontSize: "11px", color: "#64748b" }}>Preserves actual send dates for invoices already sent or paid.</div>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "#334155", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="applyTo"
                  value="all"
                  checked={applyTo === "all"}
                  onChange={() => setApplyTo("all")}
                  style={{ marginTop: "2px" }}
                />
                <div>
                  <div style={{ fontWeight: "600" }}>All recurring invoices on this job</div>
                  <div style={{ fontSize: "11px", color: "#64748b" }}>Updates every invoice slot on this retainer to the chosen day.</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "24px", paddingTop: "14px", borderTop: "1px solid #e2e8f0" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#475569",
              fontSize: "12px",
              fontWeight: "600",
              cursor: saving ? "not-allowed" : "pointer"
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "7px 16px",
              borderRadius: "6px",
              border: "none",
              background: "#0284c7",
              color: "#ffffff",
              fontSize: "12px",
              fontWeight: "600",
              cursor: saving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            {saving ? <><Spinner size={13} color="#ffffff" /> Saving...</> : "Save send dates"}
          </button>
        </div>
      </div>
    </div>
  );
}

