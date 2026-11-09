import React, { useState } from "react";
import Spinner from "./Spinner";

export default function OutgoingsEditVendorModal({
  contractor,
  outgoingsClient,
  onClose,
  onUpdated
}) {
  const [vendorName, setVendorName] = useState(contractor?.name || "");
  const [vatFlag, setVatFlag] = useState(
    String(contractor?.vatFlag || "").toLowerCase().startsWith("n") ? "No" : "Yes"
  );
  const [invTiming, setInvTiming] = useState(
    String(contractor?.invTiming || "").toLowerCase().startsWith("cur") ? "Curr" : "Next"
  );
  const [payTiming, setPayTiming] = useState(
    String(contractor?.payTiming || "").toLowerCase().startsWith("cur") ? "Curr" : "Next"
  );
  const [deliveryPct, setDeliveryPct] = useState(() => {
    const raw = String(contractor?.deliveryPct || "100").replace(/%/g, "").trim();
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? String(parsed) : "100";
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!contractor) return null;

  const handleSave = async (e) => {
    e?.preventDefault();
    const cleanName = vendorName.trim();
    if (!cleanName) {
      setError("Please enter a contractor name");
      return;
    }

    const pctNum = parseFloat(deliveryPct);
    if (isNaN(pctNum) || pctNum < 0 || pctNum > 100) {
      setError("Delivery % must be between 0 and 100");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoings_vendor",
          clientSheetId: outgoingsClient?.clientSheetId,
          masterSheetId: outgoingsClient?.masterSheetId,
          clientName: outgoingsClient?.clientName || outgoingsClient?.name || "",
          sheetRow: contractor.sheetRow,
          vendorName: cleanName,
          vatFlag,
          invTiming,
          payTiming,
          deliveryPct: pctNum,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to update contractor");
        setSaving(false);
        return;
      }

      const updatedVendor = data.vendor || {
        sheetRow: contractor.sheetRow,
        name: cleanName,
        vatFlag,
        invTiming,
        payTiming,
        deliveryPct: `${pctNum}%`,
      };

      if (typeof onUpdated === "function") {
        try {
          await onUpdated(updatedVendor);
        } catch (callbackErr) {
          console.warn("onUpdated callback error:", callbackErr);
        }
      }

      onClose();
    } catch (err) {
      console.error("Failed to update contractor:", err);
      setError(err.message || "Failed to save contractor details");
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        backdropFilter: "blur(2px)",
        zIndex: 2500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(92vw, 460px)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
          fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "16px",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
              Edit contractor
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
              Update details and timings for this contractor
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              background: "none",
              border: "none",
              fontSize: "22px",
              cursor: saving ? "default" : "pointer",
              color: "#94a3b8",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "4px" }}>
              Contractor name *
            </label>
            <input
              type="text"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              required
              style={{
                width: "100%",
                padding: "8px 11px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "4px" }}>
                VAT registered?
              </label>
              <select
                value={vatFlag}
                onChange={(e) => setVatFlag(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  background: "#ffffff",
                  boxSizing: "border-box",
                }}
              >
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "4px" }}>
                Delivery %
              </label>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={deliveryPct}
                  onChange={(e) => setDeliveryPct(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 24px 8px 11px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    boxSizing: "border-box",
                  }}
                />
                <span style={{ position: "absolute", right: "10px", fontSize: "12px", color: "#94a3b8" }}>
                  %
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "4px" }}>
                Invoice month
              </label>
              <select
                value={invTiming}
                onChange={(e) => setInvTiming(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  background: "#ffffff",
                  boxSizing: "border-box",
                }}
              >
                <option value="Next">Next month</option>
                <option value="Curr">Current month</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "4px" }}>
                Payment month
              </label>
              <select
                value={payTiming}
                onChange={(e) => setPayTiming(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  background: "#ffffff",
                  boxSizing: "border-box",
                }}
              >
                <option value="Next">Next month</option>
                <option value="Curr">Current month</option>
              </select>
            </div>
          </div>

          {error && (
            <div
              style={{
                fontSize: "12px",
                color: "#b91c1c",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                padding: "8px 12px",
                borderRadius: "6px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", marginTop: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "8px 16px",
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: saving ? "default" : "pointer",
                fontSize: "13px",
                fontWeight: "500",
                color: "#475569",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !vendorName.trim()}
              style={{
                padding: "8px 20px",
                background: saving || !vendorName.trim() ? "#94a3b8" : "#2563eb",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                cursor: saving || !vendorName.trim() ? "default" : "pointer",
                fontSize: "13px",
                fontWeight: "600",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {saving ? (
                <>
                  <Spinner size={12} color="#ffffff" /> Saving...
                </>
              ) : (
                "Save changes"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
