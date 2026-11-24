import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import { formatMoney as universalFormatMoney } from "../services/deepDiveHelper";

function normalizeName(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * CashBankBreakdownModal
 * Allows viewing and editing per-bank-account closing balances for a month on PMA Cash.
 */
export default function CashBankBreakdownModal({
  isOpen,
  monthLabel = "",
  monthKey = "",
  colLetter = "",
  isSysAdmin = false,
  currencySymbol = "£",
  configuredBankAccounts = [],
  initialBreakdown = null,
  currentCellNumericValue = null,
  currentFormattedValue = "",
  saving = false,
  error = null,
  onSave,
  onClear,
  onClose,
}) {
  const [rows, setRows] = useState([]);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setLocalError(null);

    const existingAccounts = Array.isArray(initialBreakdown?.accounts) ? initialBreakdown.accounts : [];
    const configured = Array.isArray(configuredBankAccounts) ? configuredBankAccounts : [];
    const labelsInferred = Boolean(initialBreakdown?.labelsInferred);

    const usedExistingIdx = new Set();
    const nextRows = [];

    // 1. Seed configured cash bank accounts first, matching any saved amounts
    configured.forEach((cfg, idx) => {
      const cfgId = String(cfg.accountId || "").trim().toLowerCase();
      const cfgNorm = normalizeName(cfg.name);
      let matchIdx = -1;
      existingAccounts.forEach((ea, eIdx) => {
        if (usedExistingIdx.has(eIdx)) return;
        const eaId = String(ea.accountId || "").trim().toLowerCase();
        const eaNorm = normalizeName(ea.name);
        if ((cfgId && eaId && cfgId === eaId) || (cfgNorm && eaNorm && cfgNorm === eaNorm)) {
          matchIdx = eIdx;
        }
      });

      let amountStr = "";
      if (matchIdx !== -1) {
        usedExistingIdx.add(matchIdx);
        amountStr = String(existingAccounts[matchIdx].amount ?? "");
      } else if (existingAccounts.length === 0 && configured.length === 1 && currentCellNumericValue !== null && currentCellNumericValue !== undefined) {
        amountStr = String(currentCellNumericValue);
      }

      nextRows.push({
        key: `cfg_${idx}_${cfg.name}`,
        name: cfg.name,
        accountId: cfg.accountId || "",
        amount: amountStr,
        isCustom: false,
      });
    });

    // 2. Append any saved/parsed accounts that were not in configuredBankAccounts
    existingAccounts.forEach((ea, eIdx) => {
      if (usedExistingIdx.has(eIdx)) return;
      nextRows.push({
        key: `extra_${eIdx}_${ea.name}`,
        name: ea.name || `Account ${nextRows.length + 1}`,
        accountId: ea.accountId || "",
        amount: String(ea.amount ?? ""),
        isCustom: true || labelsInferred,
      });
    });

    // 3. Fallback when client has no configured accounts and no existing breakdown
    if (nextRows.length === 0) {
      nextRows.push({
        key: "default_0",
        name: "Main bank account",
        accountId: "",
        amount:
          currentCellNumericValue !== null && currentCellNumericValue !== undefined
            ? String(currentCellNumericValue)
            : "",
        isCustom: true,
      });
    }

    setRows(nextRows);
  }, [isOpen, configuredBankAccounts, initialBreakdown, currentCellNumericValue]);

  const liveTotal = useMemo(() => {
    return round2(
      rows.reduce((sum, r) => {
        const cleaned = String(r.amount ?? "").replace(/[£$€,\s]/g, "");
        const n = parseFloat(cleaned);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0)
    );
  }, [rows]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, saving, onClose]);

  if (!isOpen) return null;

  const formatMoney2 = (v) => universalFormatMoney(v, 2, currencySymbol, ",");

  const handleRowChange = (idx, field, val) => {
    setLocalError(null);
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  };

  const handleAddAccount = () => {
    setLocalError(null);
    setRows((prev) => [
      ...prev,
      {
        key: `custom_${Date.now()}_${prev.length}`,
        name: "",
        accountId: "",
        amount: "",
        isCustom: true,
      },
    ]);
  };

  const handleRemoveRow = (idx) => {
    setLocalError(null);
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    setLocalError(null);

    const payloadAccounts = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cleanName = String(r.name || "").trim();
      const rawAmt = String(r.amount ?? "").trim();
      if (!cleanName && !rawAmt) continue;
      if (!cleanName) {
        setLocalError("Please enter a bank account name for every balance entered.");
        return;
      }
      const num = rawAmt === "" ? 0 : parseFloat(rawAmt.replace(/[£$€,\s]/g, ""));
      if (!Number.isFinite(num)) {
        setLocalError(`Please enter a valid number for ${cleanName}.`);
        return;
      }
      payloadAccounts.push({
        name: cleanName,
        accountId: r.accountId || "",
        amount: round2(num),
      });
    }

    if (payloadAccounts.length === 0) {
      setLocalError("Enter at least one bank account balance, or use Clear actual balance.");
      return;
    }

    await onSave(payloadAccounts);
  };

  const hasExistingValue = Boolean(
    (currentFormattedValue && String(currentFormattedValue).trim() !== "") ||
      (currentCellNumericValue !== null && currentCellNumericValue !== undefined) ||
      (initialBreakdown?.accounts?.length > 0)
  );

  const displayError = localError || error;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Actual closing balance breakdown for ${monthLabel || monthKey}`}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.48)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "500px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.18), 0 10px 10px -5px rgba(0, 0, 0, 0.08)",
          border: "1px solid #cbd5e1",
          overflow: "hidden",
          fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc",
          }}
        >
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
              Actual closing balance • {monthLabel || monthKey}
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
              {isSysAdmin && colLetter
                ? `Cell Cash!${colLetter}36 • Enter month-end balances by bank account`
                : "Enter month-end balances by bank account"}
            </div>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label="Close modal"
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              color: "#94a3b8",
              cursor: saving ? "not-allowed" : "pointer",
              padding: "4px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 18px", maxHeight: "65vh", overflowY: "auto" }}>
          {initialBreakdown?.labelsInferred && (
            <div
              style={{
                marginBottom: "12px",
                padding: "8px 10px",
                borderRadius: "6px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                color: "#1e40af",
                fontSize: "12px",
              }}
            >
              Account names were inferred from existing balances. Confirm or update the names below before saving.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {rows.map((r, idx) => (
              <div
                key={r.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div style={{ flex: "1 1 58%", minWidth: 0 }}>
                  {r.isCustom ? (
                    <input
                      type="text"
                      value={r.name}
                      onChange={(e) => handleRowChange(idx, "name", e.target.value)}
                      placeholder="Bank account name"
                      disabled={saving}
                      style={{
                        width: "100%",
                        padding: "7px 10px",
                        fontSize: "13px",
                        fontWeight: 500,
                        color: "#0f172a",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#1e293b",
                        padding: "7px 2px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={r.name}
                    >
                      {r.name}
                    </div>
                  )}
                </div>

                <div style={{ flex: "0 0 140px", position: "relative" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: "10px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: "13px",
                      color: "#64748b",
                      pointerEvents: "none",
                    }}
                  >
                    {currencySymbol}
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    autoFocus={idx === 0}
                    value={r.amount}
                    onChange={(e) => handleRowChange(idx, "amount", e.target.value)}
                    placeholder="0.00"
                    disabled={saving}
                    style={{
                      width: "100%",
                      padding: "7px 10px 7px 24px",
                      fontSize: "13px",
                      fontWeight: 600,
                      textAlign: "right",
                      color: "#0f172a",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      boxSizing: "border-box",
                      fontFamily: "inherit",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  />
                </div>

                {r.isCustom && rows.length > 1 ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => handleRemoveRow(idx)}
                    title="Remove bank account"
                    style={{
                      background: "none",
                      border: "1px solid #e2e8f0",
                      borderRadius: "6px",
                      color: "#64748b",
                      cursor: saving ? "not-allowed" : "pointer",
                      padding: "6px 8px",
                      fontSize: "12px",
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                ) : (
                  <div style={{ width: rows.some((x) => x.isCustom) && rows.length > 1 ? "28px" : "0px" }} />
                )}
              </div>
            ))}
          </div>

          <div style={{ marginTop: "12px" }}>
            <button
              type="button"
              disabled={saving}
              onClick={handleAddAccount}
              style={{
                background: "none",
                border: "none",
                color: "#0047AB",
                fontSize: "12px",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                padding: "2px 0",
              }}
            >
              + Add bank account
            </button>
          </div>

          {/* Total summary */}
          <div
            style={{
              marginTop: "14px",
              paddingTop: "12px",
              borderTop: "1px solid #e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>Total actual closing balance</span>
            <span
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: liveTotal < 0 ? "#dc2626" : "#0047AB",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatMoney2(liveTotal)}
            </span>
          </div>

          {displayError && (
            <div
              style={{
                marginTop: "12px",
                padding: "8px 10px",
                borderRadius: "6px",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                fontSize: "12px",
              }}
            >
              {displayError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <div>
            {hasExistingValue && onClear && (
              <button
                type="button"
                disabled={saving}
                onClick={onClear}
                style={{
                  background: "none",
                  border: "1px solid #fecaca",
                  color: "#dc2626",
                  borderRadius: "6px",
                  padding: "7px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                Clear actual balance
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                color: "#475569",
                borderRadius: "6px",
                padding: "7px 14px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                background: saving ? "#94a3b8" : "#0047AB",
                border: "none",
                color: "#ffffff",
                borderRadius: "6px",
                padding: "7px 16px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {saving ? (
                <>
                  <Spinner size={12} color="#ffffff" />
                  <span>Saving...</span>
                </>
              ) : (
                "Save balances"
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
