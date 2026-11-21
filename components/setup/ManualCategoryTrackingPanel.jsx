import React, { useState, useEffect, useCallback } from "react";
import Spinner from "../Spinner";

function ProgressiveCategoryDropdowns({
  items,
  max,
  options,
  emptyOptionText,
  onChange
}) {
  const active = (items || []).filter((v) => v !== undefined && String(v).trim() !== "");
  const slotCount = Math.min(max, active.length + 1);
  const usedSet = new Set(active);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%", minWidth: 0 }}>
      {Array.from({ length: slotCount }, (_, i) => {
        const val = active[i] || "";
        const baseOpts = options.filter((opt) => opt === val || !usedSet.has(opt));
        const availableOpts = val && !baseOpts.includes(val) ? [val, ...baseOpts] : baseOpts;

        return (
          <div key={i} style={{ display: "flex", gap: "6px", alignItems: "center", width: "100%", minWidth: 0 }}>
            <select
              value={val}
              onChange={(e) => {
                const newVal = e.target.value;
                if (!newVal) {
                  onChange(active.filter((_, idx) => idx !== i));
                } else {
                  const next = [...active];
                  next[i] = newVal;
                  onChange(next);
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "7px 10px",
                borderRadius: "6px",
                border: "1px solid #CBD5E1",
                fontSize: "12.5px",
                background: "#FFFFFF",
                color: val ? "#0F172A" : "#64748B",
                boxSizing: "border-box"
              }}
            >
              <option value="">{emptyOptionText}</option>
              {availableOpts.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            {val && (
              <button
                type="button"
                title="Remove selection"
                onClick={() => onChange(active.filter((_, idx) => idx !== i))}
                style={{
                  border: "1px solid #E2E8F0",
                  background: "#F8FAFC",
                  color: "#64748B",
                  borderRadius: "6px",
                  padding: "6px 8px",
                  fontSize: "11px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ManualCategoryTrackingPanel({
  clientName,
  masterSheetId,
  isAdmin = false,
  onSaved
}) {
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [chartOfAccounts, setChartOfAccounts] = useState([]);
  const [contractorsManual, setContractorsManual] = useState([]);
  const [passThroughManual, setPassThroughManual] = useState([]);
  const [showPassThrough, setShowPassThrough] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const loadSettings = useCallback(async () => {
    if (!clientName || !masterSheetId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/client-settings?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId)}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load Chart of Accounts settings.");
      }
      const s = data.settings || {};
      const acc = s.accounting || {};
      const cust = s.customisation || {};
      setChartOfAccounts(Array.isArray(acc.chartOfAccounts) ? acc.chartOfAccounts : []);
      setContractorsManual(Array.isArray(acc.contractorsManual) ? acc.contractorsManual : []);
      setPassThroughManual(Array.isArray(acc.passThroughManual) ? acc.passThroughManual : []);
      setShowPassThrough(
        (cust.revenueFocus || "Revenue") === "Income" || cust.directCostsMode === "Pass-through"
      );
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [clientName, masterSheetId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handlePullChartOfAccounts = async () => {
    if (!clientName || !masterSheetId) return;
    setPulling(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh_chart_of_accounts",
          clientName,
          masterSheetId
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to pull chart of accounts.");
      }

      const accounts = Array.isArray(data.chartOfAccounts) ? data.chartOfAccounts : [];
      setChartOfAccounts(accounts);
      if (accounts.length === 0) {
        setFeedback({
          type: "warning",
          message: "No accounts returned. Check that the accounting tool is selected and connected in Pulse Vault."
        });
      } else {
        setFeedback({
          type: "success",
          message: `Pulled ${accounts.length} account(s) from Chart of Accounts.`
        });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setPulling(false);
    }
  };

  const handleSave = async () => {
    if (!clientName || !masterSheetId) return;
    setSaving(true);
    setFeedback(null);

    try {
      const accountingPayload = {
        contractorsManual: contractorsManual.slice(0, 19)
      };
      if (showPassThrough) {
        accountingPayload.passThroughManual = passThroughManual.slice(0, 17);
      }

      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          settings: {
            accounting: accountingPayload
          }
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save manual categories.");
      }

      setFeedback({
        type: "success",
        message: isAdmin
          ? "Manual tracking categories saved to KeyInfo!AT4:AT40."
          : "Manual tracking categories saved."
      });
      if (onSaved) onSaved();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "20px", textAlign: "center", background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0" }}>
        <Spinner size={22} color="#023f98" />
        <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748B" }}>
          Loading chart of accounts and manual categories...
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "14px" }}>
        <div>
          <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B" }}>
            Manual category tracking
          </span>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
            {showPassThrough
              ? "Pull the Chart of Accounts and select categories to manually track contractors and other pass-through outgoings."
              : "Pull the Chart of Accounts and select categories to manually track contractor outgoings."}
          </p>
        </div>

        <button
          type="button"
          onClick={handlePullChartOfAccounts}
          disabled={pulling || saving}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "7px 14px",
            borderRadius: "6px",
            border: "1px solid #023f98",
            background: "#EFF6FF",
            color: "#023f98",
            fontSize: "12px",
            fontWeight: "700",
            cursor: pulling || saving ? "wait" : "pointer",
            opacity: pulling ? 0.8 : 1
          }}
        >
          {pulling && <Spinner size={12} color="#023f98" />}
          <span>
            {pulling
              ? "Pulling chart of accounts..."
              : chartOfAccounts.length > 0
                ? "Refresh chart of accounts"
                : "Pull chart of accounts"}
          </span>
        </button>
      </div>

      {feedback && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            marginBottom: "12px",
            fontSize: "12px",
            fontWeight: "500",
            background:
              feedback.type === "error"
                ? "#FEF2F2"
                : feedback.type === "warning"
                  ? "#FFFBEB"
                  : "#ECFDF5",
            border: `1px solid ${
              feedback.type === "error"
                ? "#FECACA"
                : feedback.type === "warning"
                  ? "#FDE68A"
                  : "#A7F3D0"
            }`,
            color:
              feedback.type === "error"
                ? "#991B1B"
                : feedback.type === "warning"
                  ? "#92400E"
                  : "#065F46"
          }}
        >
          {feedback.message}
        </div>
      )}

      {chartOfAccounts.length === 0 ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            marginBottom: "14px",
            fontSize: "12px",
            background: "#F8FAFC",
            border: "1px dashed #CBD5E1",
            color: "#475569"
          }}
        >
          No Chart of Accounts entries loaded yet. Click <strong>Pull chart of accounts</strong> above to fetch accounts from your connected accounting tool.
        </div>
      ) : (
        <div style={{ fontSize: "11px", color: "#64748B", marginBottom: "12px" }}>
          {chartOfAccounts.length} account(s) available in Chart of Accounts.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: "16px", marginBottom: "14px" }}>
        <div style={{ background: "#F8FAFC", padding: "12px 14px", borderRadius: "8px", border: "1px solid #E2E8F0", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
            <label style={{ fontSize: "12px", fontWeight: "700", color: "#1E293B" }}>
              Contractors (max 19)
            </label>
            {isAdmin && (
              <code style={{ fontSize: "10px", background: "#E2E8F0", color: "#475569", padding: "1px 5px", borderRadius: "4px" }}>
                KeyInfo!AT4:AT22
              </code>
            )}
          </div>
          <ProgressiveCategoryDropdowns
            items={contractorsManual}
            max={19}
            options={chartOfAccounts}
            emptyOptionText="-- Select contractor account --"
            onChange={setContractorsManual}
          />
        </div>

        {showPassThrough && (
          <div style={{ background: "#F8FAFC", padding: "12px 14px", borderRadius: "8px", border: "1px solid #E2E8F0", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
              <label style={{ fontSize: "12px", fontWeight: "700", color: "#1E293B" }}>
                Other pass-through (max 17)
              </label>
              {isAdmin && (
                <code style={{ fontSize: "10px", background: "#E2E8F0", color: "#475569", padding: "1px 5px", borderRadius: "4px" }}>
                  KeyInfo!AT24:AT40
                </code>
              )}
            </div>
            <ProgressiveCategoryDropdowns
              items={passThroughManual}
              max={17}
              options={chartOfAccounts}
              emptyOptionText="-- Select pass-through account --"
              onChange={setPassThroughManual}
            />
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || pulling}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "#023f98",
            color: "#FFFFFF",
            fontSize: "12px",
            fontWeight: "700",
            cursor: saving || pulling ? "wait" : "pointer"
          }}
        >
          {saving && <Spinner size={12} color="#FFFFFF" />}
          <span>{saving ? "Saving categories..." : "Save manual categories"}</span>
        </button>
      </div>
    </div>
  );
}
