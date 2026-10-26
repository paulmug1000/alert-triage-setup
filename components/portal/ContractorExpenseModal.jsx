import React, { useState } from "react";
import Spinner from "../Spinner";
import PlaceholderPill, { isAutoPlaceholder } from "../PlaceholderPill";
import { isPlaceholderExpense, toSheetDateFormat, toInputDateFormat } from "../../utils/helpers";

function generateAutoPlaceholderId(contractorName, dateStr) {
  const cleanName = String(contractorName || "Row").trim().replace(/[^a-zA-Z0-9]/g, "");
  const shortCode = cleanName.slice(0, 5) || "Vend";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PLACE-EXP-${dateStr || "Entry"}-${shortCode}-${rand}`;
}

function generateManualPlaceholderId(contractorName, dateStr) {
  const cleanName = String(contractorName || "Row").trim().replace(/[^a-zA-Z0-9]/g, "");
  const shortCode = cleanName.slice(0, 5) || "Vend";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `MANUAL-EXP-${dateStr || "Entry"}-${shortCode}-${rand}`;
}

export default function ContractorExpenseModal({
  isOpen,
  item = null, // null for new, or existing item object
  contractor,
  colLetter,
  monthLabel,
  allBlocks = [],
  clientSheetId,
  clientName,
  onClose,
  onSaveSuccess,
}) {
  const isNew = !item;
  const [currentAppId, setCurrentAppId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState("Yes");
  const [recDate, setRecDate] = useState("");
  const [payDate, setPayDate] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    if (isOpen && contractor) {
      setDescription(item?.description || item?.rawDesc || "");
      setAmount(item?.amount !== undefined ? String(item.amount) : "");
      setVat(item?.vat || contractor?.vatSetting || "Yes");
      setRecDate(item?.recDate ? toInputDateFormat(item.recDate) : "");
      setPayDate(item?.payDate ? toInputDateFormat(item.payDate) : "");
      const dateMatch = String(monthLabel || "").match(/([a-zA-Z]{3})[\s\-]?(\d{2,4})/);
      const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2].slice(-2)}` : "Entry";
      setCurrentAppId(item?.appId !== undefined ? item.appId : generateManualPlaceholderId(contractor.name, dateStr));
      setError(null);
      setIsSaving(false);
      setIsDeleting(false);
    }
  }, [isOpen, item, contractor, monthLabel]);

  if (!isOpen || !contractor) return null;

  const isPlaceholder = isNew || isPlaceholderExpense(currentAppId, description, item?.status);
  const isAuto = isPlaceholder && isAutoPlaceholder(currentAppId || description);
  const isAutoLocked = isPlaceholder && isAuto;
  const isLocked = !isNew && !isPlaceholder && Boolean(currentAppId && String(currentAppId).trim() !== "");
  const isPaid = !isNew && String(item?.status || "").toLowerCase() === "paid";
  const isFieldLocked = isLocked || isAutoLocked;

  const lockTooltip = isAutoLocked
    ? "Automatic placeholder. Convert to manual placeholder to edit."
    : isLocked
      ? "Synced from accounting software. To modify description, amount, VAT, or date, update directly in your accounting software."
      : undefined;

  const handleSave = async (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (isSaving || isDeleting || isFieldLocked) return;

    const parsedAmt = parseFloat(String(amount).replace(/[£$€,\s]/g, ""));
    if (isNaN(parsedAmt) || parsedAmt <= 0) {
      setError("Please enter a valid amount greater than 0.");
      return;
    }

    setIsSaving(true);
    setError(null);

    const formattedRecDate = recDate ? toSheetDateFormat(recDate) : "";
    const formattedPayDate = payDate ? toSheetDateFormat(payDate) : "";

    let updatedBlocks = [];
    if (isNew) {
      const dateMatch = String(monthLabel || "").match(/([a-zA-Z]{3})[\s\-]?(\d{2,4})/);
      const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2].slice(-2)}` : "Entry";
      const finalAppId = currentAppId || generateManualPlaceholderId(contractor.name, dateStr);
      const newBlock = {
        appId: finalAppId,
        amount: parsedAmt,
        status: "",
        recDate: formattedRecDate,
        payDate: formattedPayDate,
        description: description.trim() || `${contractor.name} expense`,
        vat,
      };
      updatedBlocks = [...allBlocks, newBlock];
    } else {
      updatedBlocks = allBlocks.map((b) => {
        if (b.appId === item.appId) {
          return {
            ...b,
            appId: currentAppId || b.appId,
            amount: isFieldLocked ? b.amount : parsedAmt,
            description: isFieldLocked ? b.description : (description.trim() || `${contractor.name} expense`),
            vat: isFieldLocked ? b.vat : vat,
            recDate: isFieldLocked ? b.recDate : formattedRecDate,
            payDate: isPaid ? b.payDate : formattedPayDate,
          };
        }
        return b;
      });
    }

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId,
          clientName,
          contractorName: contractor.name,
          sheetRow: contractor.rowNumber || contractor.sheetRow,
          colLetter,
          blocks: updatedBlocks,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update contractor expense");
      }

      if (onSaveSuccess) {
        onSaveSuccess(updatedBlocks, colLetter);
      }
      onClose();
    } catch (err) {
      console.error("Contractor expense save error:", err);
      setError(err.message || "Failed to save changes");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isFieldLocked) return;
    if (!window.confirm("Are you sure you want to delete this expense item?")) return;

    setIsDeleting(true);
    setError(null);

    const updatedBlocks = allBlocks.filter((b) => b.appId !== item.appId);

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId,
          clientName,
          contractorName: contractor.name,
          sheetRow: contractor.rowNumber || contractor.sheetRow,
          colLetter,
          blocks: updatedBlocks,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to delete contractor expense");
      }

      if (onSaveSuccess) {
        onSaveSuccess(updatedBlocks, colLetter);
      }
      onClose();
    } catch (err) {
      console.error("Contractor expense delete error:", err);
      setError(err.message || "Failed to delete item");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving && !isDeleting) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "500px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1.25rem 1.5rem",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
              {isNew ? "Add contractor expense" : "Edit contractor expense"}
            </h3>
            <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "2px" }}>
              <strong>{contractor.name}</strong> · {monthLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || isDeleting}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: "20px",
              lineHeight: 1,
              padding: "4px",
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSave} style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {error && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "6px",
                padding: "8px 12px",
                color: "#991b1b",
                fontSize: "12px",
              }}
            >
              {error}
            </div>
          )}

          {isLocked && (
            <div
              style={{
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: "6px",
                padding: "8px 12px",
                color: "#1e40af",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="17 4 21 8 17 12" />
                <path d="M21 8H9a4 4 0 0 0-4 4v1" />
                <polyline points="7 20 3 16 7 12" />
                <path d="M3 16h12a4 4 0 0 0 4-4v-1" />
              </svg>
              <span>This expense is synced from your accounting software and core financial details are locked.</span>
            </div>
          )}

          {isAutoLocked && (
            <div
              style={{
                background: "#f5f3ff",
                border: "1px solid #ddd6fe",
                borderRadius: "6px",
                padding: "8px 12px",
                color: "#6b21a8",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                lineHeight: "1.4",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>This is an automatic placeholder expense, and the details are locked. To enable editing, click the &quot;Placeholder - auto&quot; button to convert it to a manual placeholder.</span>
            </div>
          )}

          {/* Description */}
          <div title={lockTooltip}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Description *</label>
              {isPlaceholder && (
                <PlaceholderPill
                  isAuto={isAuto}
                  onToggle={(targetAuto) => {
                    const dateMatch = String(monthLabel || "").match(/([a-zA-Z]{3})[\s\-]?(\d{2,4})/);
                    const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2].slice(-2)}` : "Entry";
                    if (targetAuto) {
                      setCurrentAppId(generateAutoPlaceholderId(contractor.name, dateStr));
                    } else {
                      setCurrentAppId(generateManualPlaceholderId(contractor.name, dateStr));
                    }
                  }}
                />
              )}
            </div>
            <input
              type="text"
              required
              disabled={isFieldLocked || isSaving || isDeleting}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Design sprint consulting"
              style={{
                ...inputStyle,
                ...(isFieldLocked ? lockedInputStyle : {}),
              }}
            />
          </div>

          {/* Amount & VAT */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
            <div title={lockTooltip}>
              <label style={labelStyle}>Amount (excl. VAT) *</label>
              <input
                type="text"
                required
                disabled={isFieldLocked || isSaving || isDeleting}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 1500"
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? lockedInputStyle : {}),
                }}
              />
            </div>
            <div title={lockTooltip}>
              <label style={labelStyle}>VAT?</label>
              <select
                disabled={isFieldLocked || isSaving || isDeleting}
                value={vat}
                onChange={(e) => setVat(e.target.value)}
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? lockedInputStyle : {}),
                }}
              >
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
          </div>

          {/* Receive date & Pay date */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div title={lockTooltip}>
              <label style={labelStyle}>Received date</label>
              <input
                type="date"
                disabled={isFieldLocked || isSaving || isDeleting}
                value={recDate}
                onChange={(e) => setRecDate(e.target.value)}
                style={{
                  ...inputStyle,
                  ...(isFieldLocked ? lockedInputStyle : {}),
                }}
              />
            </div>
            <div title={isPaid ? "Pay date is determined once a bill is marked as paid." : undefined}>
              <label style={labelStyle}>Pay date</label>
              <input
                type="date"
                disabled={isPaid || isSaving || isDeleting}
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                style={{
                  ...inputStyle,
                  ...(isPaid ? lockedInputStyle : {}),
                }}
              />
            </div>
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: !isNew && !isFieldLocked ? "space-between" : "flex-end",
              marginTop: "0.5rem",
              paddingTop: "1rem",
              borderTop: "1px solid #f1f5f9",
            }}
          >
            {!isNew && !isFieldLocked && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={isSaving || isDeleting}
                style={{
                  background: "transparent",
                  border: "1px solid #fecaca",
                  color: "#dc2626",
                  borderRadius: "6px",
                  padding: "6px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {isDeleting ? "Deleting..." : "Delete expense"}
              </button>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isSaving || isDeleting}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "6px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || isDeleting || isFieldLocked}
                style={{
                  background: isFieldLocked ? "#94a3b8" : "#0047AB",
                  border: "none",
                  borderRadius: "6px",
                  padding: "6px 16px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: "#ffffff",
                  cursor: isFieldLocked ? "not-allowed" : isSaving ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {isSaving && <Spinner size={13} color="#ffffff" />}
                <span>{isSaving ? "Saving..." : "Save changes"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: "11px",
  fontWeight: 700,
  color: "#475569",
  marginBottom: "4px",
};

const inputStyle = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  fontSize: "13px",
  outline: "none",
  boxSizing: "border-box",
  background: "#ffffff",
  color: "#0f172a",
};

const lockedInputStyle = {
  background: "#f8fafc",
  color: "#64748b",
  cursor: "not-allowed",
  borderColor: "#e2e8f0",
};
