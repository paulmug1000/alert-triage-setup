import React, { useEffect, useState } from "react";
import Spinner from "../Spinner";
import AutomationSettingsPanel from "../AutomationSettingsPanel";

export default function SetupAutomationFlagsPanel({
  clientName,
  masterSheetId,
  clientSheetId,
  isAdmin = false,
  onSaved,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [automation, setAutomation] = useState(null);

  useEffect(() => {
    if (!isAdmin || !clientName || !masterSheetId) return;
    let active = true;
    setLoading(true);
    setFeedback(null);

    const qs = new URLSearchParams({
      clientName,
      masterSheetId,
      clientSheetId: clientSheetId || "",
      bypassCache: "true",
    });

    fetch(`/api/client-settings?${qs.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (data.success && data.settings?.automation) {
          setAutomation(data.settings.automation);
        } else {
          throw new Error(data.error || "Failed to load automation settings.");
        }
      })
      .catch((err) => {
        if (active) {
          setFeedback({ type: "error", message: err.message || "Failed to load automation settings." });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clientName, masterSheetId, clientSheetId, isAdmin]);

  if (!isAdmin) {
    return (
      <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", fontSize: "12px", color: "#475569" }}>
        Administrator privileges are required to view and modify automation flags and discrepancy rules.
      </div>
    );
  }

  const handleSave = async () => {
    if (!automation || !clientName || !masterSheetId) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          clientSheetId: clientSheetId || "",
          settings: { automation },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save automation settings.");
      }
      setFeedback({ type: "success", message: "Automation flags and discrepancy rules saved successfully." });
      onSaved?.();
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to save automation settings." });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "24px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0", textAlign: "center" }}>
        <Spinner size={24} color="#023f98" />
        <p style={{ marginTop: "8px", fontSize: "12px", color: "#64748B" }}>
          Loading automation flags and tolerances...
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
      {feedback && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            marginBottom: "14px",
            fontSize: "13px",
            fontWeight: "500",
            background: feedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
            border: `1px solid ${feedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
            color: feedback.type === "success" ? "#065F46" : "#991B1B",
          }}
        >
          {feedback.message}
        </div>
      )}

      {automation && (
        <>
          <AutomationSettingsPanel
            automation={automation}
            onUpdateAutomation={(updater) => setAutomation((prev) => updater(prev || {}))}
            isAdmin={isAdmin}
            showCellRefs={isAdmin}
            showHeader
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #E2E8F0" }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: "8px 18px",
                borderRadius: "6px",
                border: "none",
                background: "#023f98",
                color: "#FFFFFF",
                fontWeight: "700",
                fontSize: "13px",
                cursor: saving ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {saving && <Spinner size={14} color="#FFFFFF" />}
              <span>{saving ? "Saving automation flags..." : "Save automation flags"}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
