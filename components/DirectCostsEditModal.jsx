import React, { useState, useMemo } from "react";
import Spinner from "./Spinner";
import {
  stripCurrency,
  isPlaceholderExpense,
  hasActiveAccountingIntegration,
  EXPENSE_STATUS_OPTIONS,
  canonicalizeExpenseStatus,
} from "../utils/helpers";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import DateInput from "./DateInput";
import PlaceholderPill, { isAutoPlaceholder, generatePlaceholderExpenseId } from "./PlaceholderPill";

function generateManualPlaceholderExpenseId(dateStr) {
  const d = dateStr ? String(dateStr).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) : "Entry";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `MANUAL-EXP-${d}-${rand}`;
}

export default function DirectCostsEditModal({
  editSlot,
  client,
  onClose,
  onMarkPullPending,
  onUpdateJobs,
  isAdmin: propIsAdmin,
}) {
  const auth = useAuth();
  const { allClientsMap } = useAppGlobals();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));
  const { rowNum, slotNum, slot, jobName, jobClient, tabName } = editSlot;
  const [description, setDescription] = useState(slot.description || "");
  const [amount, setAmount] = useState(stripCurrency(slot.amount));
  const [vat, setVat] = useState(/^[£$€]?\d/.test(String(slot.vat || "")) ? "" : (slot.vat || "No"));
  const [date, setDate] = useState(slot.date || "");
  const [daysToPay, setDaysToPay] = useState(slot.daysToPay || 30);
  const [status, setStatus] = useState(slot.status || "");
  const [transactionId, setTransactionId] = useState(slot.transactionId || "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Accounting integration status and locking
  const hasAccounting = useMemo(() => {
    if (client?.hasAccountingIntegration) return true;
    if (hasActiveAccountingIntegration(client?.accountingTool)) return true;
    if (editSlot?.hasAccountingIntegration) return true;
    const clientName = client?.clientName || client?.name || jobClient || editSlot?.jobClient;
    if (clientName && allClientsMap) {
      const match = allClientsMap[clientName] || Object.values(allClientsMap).find(c => String(c.clientName || "").toLowerCase() === String(clientName).toLowerCase());
      if (match?.hasAccountingIntegration) return true;
      if (hasActiveAccountingIntegration(match?.accountingTool)) return true;
    }
    return false;
  }, [client, editSlot, jobClient, allClientsMap]);

  const isPlaceholder = useMemo(() => {
    return isPlaceholderExpense(slot?.transactionId || transactionId, slot?.description || description, slot?.status || status);
  }, [slot, transactionId, description, status]);

  const isAuto = isPlaceholder && isAutoPlaceholder(transactionId || slot?.transactionId || description || slot?.description);
  const isAutoLocked = isPlaceholder && isAuto;

  const isLocked = Boolean(
    hasAccounting &&
    !isPlaceholder &&
    (((slot?.transactionId || transactionId) && String(slot?.transactionId || transactionId).trim() !== "") ||
      ((slot?.description || description) && String(slot?.description || description).trim() !== ""))
  );
  const isFieldLocked = isLocked || isAutoLocked;

  const canonicalStatus = canonicalizeExpenseStatus(slot?.status || status);
  const isPaid = canonicalStatus === "Paid" || canonicalStatus === "Part-paid (paid)";

  const fieldLockTitle = isAutoLocked
    ? "Automatic placeholder. Convert to manual placeholder to edit."
    : isLocked
      ? "Synced from accounting software. To modify description, amount, VAT, or date, update directly in your accounting software."
      : undefined;

  const close = React.useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);

  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saving, close]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_expense_slot",
          clientSheetId: client?.clientSheetId,
          clientName: client?.clientName || client?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum, slotNum,
          expense: {
            description: isLocked ? (slot.description || description) : description,
            amount: isLocked ? (parseFloat(slot.amount) || parseFloat(amount) || 0) : (parseFloat(amount) || 0),
            vat: isLocked ? (slot.vat || vat) : vat,
            date: isLocked ? (slot.date || date) : date,
            daysToPay: isPaid ? (parseInt(slot.daysToPay, 10) || parseInt(daysToPay, 10) || 30) : (parseInt(daysToPay, 10) || 30),
            status: isLocked ? (slot.status || status) : status,
            transactionId: isLocked ? (slot.transactionId || transactionId) : transactionId,
          },
        }),
      });
      const data = await res.json();
      if (client?.masterSheetId) {
        onMarkPullPending(client.masterSheetId);
      }
      onUpdateJobs(rowNum, slotNum, {
        description: isLocked ? (slot.description || description) : description,
        amount: isLocked ? (parseFloat(slot.amount) || parseFloat(amount) || 0) : (parseFloat(amount) || 0),
        vat: isLocked ? (slot.vat || vat) : vat,
        date: isLocked ? (slot.date || date) : date,
        daysToPay: isPaid ? (parseInt(slot.daysToPay, 10) || parseInt(daysToPay, 10) || 30) : (parseInt(daysToPay, 10) || 30),
        status: isLocked ? (slot.status || status) : status,
        transactionId: isLocked ? (slot.transactionId || transactionId) : transactionId,
      }, data);
      close();
    } catch (e) { console.error("update_expense_slot save error:", e); }
    finally { setSaving(false); }
  };

  const doDelete = async () => {
    if (isLocked) return;
    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_expense_slot",
          clientSheetId: client?.clientSheetId,
          clientName: client?.clientName || client?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum, slotNum, deleteSlot: true,
        }),
      });
      const data = await res.json();
      if (client?.masterSheetId) {
        onMarkPullPending(client.masterSheetId);
      }
      onUpdateJobs(rowNum, slotNum, {
        description: "", amount: "", vat: "", date: "", daysToPay: "", status: "", transactionId: ""
      }, data);
      close();
    } catch (e) { console.error("update_expense_slot delete error:", e); }
    finally { setSaving(false); }
  };

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "14px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
              {jobName
                ? `${jobName} · ${isAdmin ? (editSlot.slotLabel || `Slot ${slotNum}`) : (editSlot.slotLabel ? editSlot.slotLabel.replace(/\s*\(Row\s*\d+\)/gi, "").replace(/\bRow\s*\d+\b,?\s*/gi, "").trim() : `Slot ${slotNum}`)}`
                : `Edit expense - ${isAdmin
                  ? (editSlot.slotLabel ? `${editSlot.slotLabel} (Row ${rowNum})` : `Row ${rowNum}, Slot ${slotNum}`)
                  : (editSlot.slotLabel ? editSlot.slotLabel.replace(/\s*\(Row\s*\d+\)/gi, "").replace(/\bRow\s*\d+\b,?\s*/gi, "").trim() : `Slot ${slotNum}`)}`}
            </h3>
            {jobClient && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Client: <strong>{jobClient}</strong>{isAdmin ? ` · Row ${rowNum}` : ""}</div>}
          </div>
          <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
        </div>

        {isAutoLocked && (
          <div style={{
            fontSize: "12px",
            color: "#4338ca",
            background: "#f5f3ff",
            border: "1px solid #ddd6fe",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: "1.4"
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>This is an automatic placeholder expense, and the details are locked. To enable editing, click the &quot;Placeholder - auto&quot; button to convert it to a manual placeholder.</span>
          </div>
        )}

        {isLocked && (
          <div style={{
            fontSize: "12px",
            color: "#334155",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: "1.4"
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>This direct cost is synced from accounting software. The vendor, amount, VAT, date, and status are locked here to prevent sync conflicts{isPaid ? ", and days to pay is locked because the bill is paid." : ", but days to pay remains editable."}</span>
          </div>
        )}

        <div style={{ display: "grid", gap: "12px" }}>
          <div style={{ padding: "10px 12px", background: isFieldLocked ? "#f8fafc" : "#ffffff", borderRadius: "8px", border: isFieldLocked ? "1px solid #e2e8f0" : "1.5px solid #cbd5e1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <label style={{ ...labelStyle, color: "#1e293b", fontSize: "12px", letterSpacing: "0.02em", marginBottom: 0 }}>Item description</label>
              {isPlaceholder && (
                <PlaceholderPill
                  isAuto={isAuto}
                  onToggle={(targetAuto) => {
                    if (targetAuto) {
                      setTransactionId(generatePlaceholderExpenseId(date));
                    } else {
                      setTransactionId(generateManualPlaceholderExpenseId(date));
                    }
                  }}
                />
              )}
            </div>
            <input
              style={{
                ...inputStyle,
                fontSize: "14px",
                fontWeight: "600",
                color: isFieldLocked ? "#64748b" : "#0f172a",
                border: "1px solid #94a3b8",
                ...(isFieldLocked ? { background: "#f8fafc", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
              }}
              placeholder="e.g. Photography & Studio hire"
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={isFieldLocked}
              title={fieldLockTitle}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Amount (£)</label>
              <input
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                }}
                type="number"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                disabled={isFieldLocked}
                title={fieldLockTitle}
              />
            </div>
            <div>
              <label style={labelStyle}>VAT charged?</label>
              <select
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                }}
                value={vat}
                onChange={e => setVat(e.target.value)}
                disabled={isFieldLocked}
                title={fieldLockTitle || (isLocked ? "VAT treatment is determined upstream in your accounting software." : undefined)}
              >
                <option value="No">No</option>
                <option value="Yes">Yes</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={labelStyle}>Date</label>
              <DateInput
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                }}
                value={date}
                onChange={e => setDate(e.target.value)}
                disabled={isFieldLocked}
                title={fieldLockTitle}
              />
            </div>
            <div>
              <label style={labelStyle}>Days to pay</label>
              <input
                style={{
                  ...inputStyle,
                  ...(isPaid || isAutoLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                }}
                type="number"
                value={daysToPay}
                onChange={e => setDaysToPay(e.target.value)}
                disabled={isPaid || isAutoLocked}
                title={isAutoLocked ? "Automatic placeholder. Convert to manual placeholder to edit." : (isPaid ? "Days to pay is determined once a bill is marked as paid." : undefined)}
              />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Status</label>
            <select
              style={{
                ...inputStyle,
                ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
              }}
              value={canonicalStatus}
              onChange={e => setStatus(e.target.value)}
              disabled={isFieldLocked}
              title={fieldLockTitle}
            >
              <option value="">Select...</option>
              {EXPENSE_STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
              {canonicalStatus && !EXPENSE_STATUS_OPTIONS.includes(canonicalStatus) && (
                <option value={canonicalStatus}>{canonicalStatus}</option>
              )}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Transaction ID</label>
            <input
              style={{
                ...inputStyle,
                ...(isLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
              }}
              value={transactionId}
              onChange={e => setTransactionId(e.target.value)}
              disabled={isLocked}
            />
          </div>
        </div>

        {confirmingDelete ? (
          <div style={{ marginTop: "18px", padding: "12px", background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "8px" }}>
            <div style={{ fontSize: "13px", color: "#991b1b", marginBottom: "10px" }}>Delete this expense? This clears all 7 fields for this slot and can&apos;t be undone from here.</div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmingDelete(false)} disabled={saving}
                style={{ padding: "7px 14px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={doDelete} disabled={saving}
                style={{ padding: "7px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Deleting..." : "Yes, delete"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "20px" }}>
            {isLocked ? (
              <span style={{ fontSize: "11px", color: "#94a3b8", display: "inline-flex", alignItems: "center", gap: "4px" }} title="Actual synced bills cannot be deleted directly from Pulse.">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Synced bill cannot be deleted
              </span>
            ) : (
              <button onClick={() => setConfirmingDelete(true)} disabled={saving}
                style={{ padding: "8px 16px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Delete expense
              </button>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={close} disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              <button onClick={save} disabled={saving}
                style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1 }}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}