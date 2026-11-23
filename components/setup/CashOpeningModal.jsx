import React, { useEffect, useRef, useState } from "react";
import Spinner from "../Spinner";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(raw) {
  if (raw === "" || raw === null || raw === undefined) return 0;
  const parsed = parseFloat(String(raw).replace(/[£$€,\s]/g, ""));
  return Number.isFinite(parsed) ? round2(parsed) : 0;
}

function formatMoney(val, currency = "GBP") {
  const num = Number(val) || 0;
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

export default function CashOpeningModal({
  clientName,
  masterSheetId,
  isAdmin = false,
  isOpen,
  onClose,
  onCompleted,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [data, setData] = useState(null);
  const [entries, setEntries] = useState([]);

  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  const recomputeEntryTotals = (entry, nextBasis = null) => {
    const accounts = entry.accounts || [];
    const active = accounts.filter((a) => a.included);
    const hasStatement = active.some((a) => a.hasStatementBalance);
    const statementTotal = round2(
      active.reduce(
        (s, a) => s + (a.hasStatementBalance ? Number(a.statementBalance || 0) : Number(a.closingXeroBalance || 0)),
        0
      )
    );
    const ledgerTotal = round2(
      active.reduce((s, a) => s + Number(a.closingXeroBalance || 0), 0)
    );
    const unreconciledTotal = round2(statementTotal - ledgerTotal);
    const basis = nextBasis || entry.selectedBasis || (hasStatement ? "statement" : "ledger");
    const suggested = active.length > 0 ? (basis === "statement" ? statementTotal : ledgerTotal) : entry.amount;
    return {
      ...entry,
      selectedBasis: basis,
      statementTotal,
      ledgerTotal,
      unreconciledTotal,
      amount: suggested,
    };
  };

  const loadBalances = async () => {
    if (!clientName) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++reqIdRef.current;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/cash-opening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "detect_balances",
          clientName,
          masterSheetId,
        }),
      });
      const json = await res.json();
      if (reqId !== reqIdRef.current) return;
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to detect cash opening balances." });
      } else {
        setData(json);
        setEntries(
          (json.entries || []).map((e) => ({
            ...e,
            selectedBasis: e.preferredBasis || "statement",
            amount: e.suggestedAmount ?? 0,
            manualOverride: false,
          }))
        );
      }
    } catch (err) {
      if (err?.name === "AbortError" || reqId !== reqIdRef.current) return;
      setFeedback({ type: "error", message: err?.message || "Failed to load cash opening balances." });
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !clientName) return;
    loadBalances();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, masterSheetId]);

  const handleToggleAccount = (entryIdx, accountId) => {
    setEntries((prev) =>
      prev.map((ent, idx) => {
        if (idx !== entryIdx) return ent;
        const nextAccounts = (ent.accounts || []).map((a) =>
          a.accountId === accountId ? { ...a, included: !a.included } : a
        );
        return recomputeEntryTotals({ ...ent, accounts: nextAccounts });
      })
    );
  };

  const handleSelectBasis = (entryIdx, basis) => {
    setEntries((prev) =>
      prev.map((ent, idx) =>
        idx === entryIdx ? recomputeEntryTotals(ent, basis) : ent
      )
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const updates = entries.map((e) => ({
        role: e.role,
        openingMonthKey: e.openingMonthKey,
        ...(e.targetColLetter ? { targetColLetter: e.targetColLetter, targetRow: e.targetRow } : {}),
        amount: parseNum(e.amount),
      }));
      const res = await fetch("/api/setup/cash-opening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_balances",
          clientName,
          masterSheetId,
          updates,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save cash opening figures." });
      } else {
        setFeedback({ type: "success", message: "Cash opening figures saved." });
        if (typeof onCompleted === "function") onCompleted(json);
        onClose();
      }
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to save cash opening figures." });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const currency = data?.currency || "GBP";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add cash opening figure"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        style={{
          width: "94vw",
          maxWidth: "960px",
          maxHeight: "92vh",
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0F172A" }}>
              Add cash opening figure — {clientName}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
              Confirm or adjust the opening bank balances for the previous and current calendar months. Statement balance is preferred when a live bank feed is connected so unreconciled items do not distort cash.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={loadBalances}
              disabled={loading || saving}
              style={{
                padding: "7px 14px",
                borderRadius: "8px",
                border: "1px solid #2563EB",
                backgroundColor: "#EFF6FF",
                color: "#1D4ED8",
                fontWeight: 600,
                fontSize: "12px",
                cursor: loading || saving ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Checking bank balances..." : "Re-detect bank balances"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              style={{
                border: "none",
                background: "transparent",
                fontSize: "20px",
                lineHeight: 1,
                color: "#64748B",
                cursor: "pointer",
                padding: "4px 6px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Feedback */}
        {feedback && (
          <div
            style={{
              padding: "10px 24px",
              fontSize: "13px",
              fontWeight: 500,
              backgroundColor: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
              color: feedback.type === "error" ? "#B91C1C" : "#047857",
              borderBottom: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
            }}
          >
            {feedback.message}
          </div>
        )}

        {/* Body */}
        <div style={{ padding: "16px 24px", overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
          {loading && !data ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 0", gap: "12px" }}>
              <Spinner size="md" />
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                Fetching month-end bank statement and ledger balances...
              </div>
            </div>
          ) : data ? (
            <>
              {data.hasConfiguredCashAccounts ? (
                <div
                  style={{
                    marginBottom: "14px",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    backgroundColor: "#ECFDF5",
                    border: "1px solid #A7F3D0",
                    color: "#047857",
                    fontSize: "12px",
                  }}
                >
                  Using configured cash bank accounts: <strong>{(data.configuredCashAccountNames || []).join(", ")}</strong>. Any non-cash accounts are excluded automatically.
                </div>
              ) : (
                <div
                  style={{
                    marginBottom: "14px",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    backgroundColor: "#EFF6FF",
                    border: "1px solid #BFDBFE",
                    color: "#1E40AF",
                    fontSize: "12px",
                  }}
                >
                  No cash bank accounts are saved yet — run &ldquo;Select bank accounts&rdquo; first or uncheck any non-cash accounts below.
                </div>
              )}
              {data.accountingTool === "QuickBooks" && (
                <div
                  style={{
                    marginBottom: "14px",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    backgroundColor: "#FFFBEB",
                    border: "1px solid #FDE68A",
                    color: "#92400E",
                    fontSize: "12px",
                  }}
                >
                  <strong>QuickBooks ledger note:</strong> QuickBooks Online only exposes the Balance Sheet ledger cash balance (not external bank feed statement balances). If there are unreconciled bank lines at month-end, verify and update the closing figure to match your bank statement.
                </div>
              )}

              {data.integrationNote && (
                <div
                  style={{
                    marginBottom: "14px",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    backgroundColor: "#FEF2F2",
                    border: "1px solid #FECACA",
                    color: "#991B1B",
                    fontSize: "12px",
                  }}
                >
                  {data.integrationNote}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {entries.map((entry, idx) => {
                  const hasAccounts = (entry.accounts || []).length > 0;
                  const hasDiff = Math.abs(entry.unreconciledTotal || 0) >= 0.01;
                  return (
                    <div
                      key={`${entry.role}-${entry.openingMonthKey}`}
                      style={{
                        border: "1px solid #E2E8F0",
                        borderRadius: "10px",
                        overflow: "hidden",
                        backgroundColor: "#FFFFFF",
                      }}
                    >
                      <div
                        style={{
                          padding: "12px 16px",
                          backgroundColor: "#F8FAFC",
                          borderBottom: "1px solid #E2E8F0",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "12px",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0F172A" }}>
                            {entry.openingMonthLabel} opening balance
                          </div>
                          <div style={{ fontSize: "12px", color: "#64748B", marginTop: "2px" }}>
                            Bank balance as of {entry.asOfLabel}
                            {isAdmin && ` · Saves to ${entry.targetCellRef}`}
                            {entry.existingValue !== null &&
                              ` · Currently stored: ${formatMoney(entry.existingValue, currency)}`}
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                          {hasAccounts && data.accountingTool === "Xero" && (
                            <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                              <button
                                type="button"
                                onClick={() => handleSelectBasis(idx, "statement")}
                                style={{
                                  padding: "5px 10px",
                                  border: "none",
                                  backgroundColor: entry.selectedBasis === "statement" ? "#023f98" : "#FFFFFF",
                                  color: entry.selectedBasis === "statement" ? "#FFFFFF" : "#334155",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                }}
                              >
                                Statement ({formatMoney(entry.statementTotal, currency)})
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSelectBasis(idx, "ledger")}
                                style={{
                                  padding: "5px 10px",
                                  border: "none",
                                  borderLeft: "1px solid #CBD5E1",
                                  backgroundColor: entry.selectedBasis === "ledger" ? "#023f98" : "#FFFFFF",
                                  color: entry.selectedBasis === "ledger" ? "#FFFFFF" : "#334155",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                }}
                              >
                                Ledger ({formatMoney(entry.ledgerTotal, currency)})
                              </button>
                            </div>
                          )}
                          <input
                            type="number"
                            step="0.01"
                            aria-label={`Opening balance for ${entry.openingMonthLabel}`}
                            value={entry.amount ?? 0}
                            onChange={(e) => {
                              const rawVal = e.target.value;
                              setEntries((prev) =>
                                prev.map((it, i) =>
                                  i === idx ? { ...it, amount: rawVal, manualOverride: true } : it
                                )
                              );
                            }}
                            style={{
                              width: "130px",
                              textAlign: "right",
                              padding: "7px 10px",
                              borderRadius: "7px",
                              border: "1px solid #023f98",
                              fontSize: "14px",
                              fontWeight: 700,
                              color: "#0F172A",
                            }}
                          />
                        </div>
                      </div>

                      {hasAccounts && (
                        <div style={{ padding: "10px 16px" }}>
                          {hasDiff && (
                            <div style={{ marginBottom: "8px", fontSize: "12px", color: "#B45309", fontWeight: 600 }}>
                              Unreconciled difference detected: Statement total is {formatMoney(entry.statementTotal, currency)} vs Ledger total {formatMoney(entry.ledgerTotal, currency)} ({entry.unreconciledTotal >= 0 ? "+" : ""}{formatMoney(entry.unreconciledTotal, currency)} unreconciled).
                            </div>
                          )}
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                            <thead>
                              <tr style={{ borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                                <th style={{ textAlign: "left", padding: "5px 6px", width: "56px" }}>Include</th>
                                <th style={{ textAlign: "left", padding: "5px 8px" }}>Bank account</th>
                                <th style={{ textAlign: "right", padding: "5px 8px" }}>Statement balance</th>
                                <th style={{ textAlign: "right", padding: "5px 8px" }}>Ledger balance</th>
                                <th style={{ textAlign: "right", padding: "5px 8px" }}>Unreconciled diff</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entry.accounts.map((acc) => {
                                const accDiff = Number(acc.difference) || 0;
                                const isAccDiff = acc.hasStatementBalance && Math.abs(accDiff) >= 0.01;
                                return (
                                  <tr key={acc.accountId} style={{ borderBottom: "1px solid #F1F5F9" }}>
                                    <td style={{ padding: "5px 6px" }}>
                                      <input
                                        type="checkbox"
                                        checked={Boolean(acc.included)}
                                        onChange={() => handleToggleAccount(idx, acc.accountId)}
                                      />
                                    </td>
                                    <td style={{ padding: "5px 8px", fontWeight: 600, color: acc.included ? "#0F172A" : "#94A3B8" }}>
                                      {acc.accountName}
                                      {!acc.hasStatementBalance && data.accountingTool === "Xero" && (
                                        <span style={{ marginLeft: "6px", fontSize: "10px", color: "#64748B", fontWeight: 500 }}>
                                          (no feed — ledger used)
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ padding: "5px 8px", textAlign: "right", color: acc.included ? "#0F172A" : "#94A3B8" }}>
                                      {acc.hasStatementBalance ? formatMoney(acc.statementBalance, currency) : "—"}
                                    </td>
                                    <td style={{ padding: "5px 8px", textAlign: "right", color: acc.included ? "#0F172A" : "#94A3B8" }}>
                                      {formatMoney(acc.closingXeroBalance, currency)}
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        textAlign: "right",
                                        fontWeight: isAccDiff ? 700 : 500,
                                        color: !acc.hasStatementBalance
                                          ? "#64748B"
                                          : isAccDiff
                                            ? "#B45309"
                                            : "#047857",
                                      }}
                                    >
                                      {acc.hasStatementBalance
                                        ? isAccDiff
                                          ? `${accDiff >= 0 ? "+" : ""}${formatMoney(accDiff, currency)}`
                                          : "Reconciled"
                                        : "—"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: "1px solid #CBD5E1",
              backgroundColor: "#FFFFFF",
              color: "#334155",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving || entries.length === 0}
            style={{
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: loading || saving || entries.length === 0 ? "#94A3B8" : "#047857",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: 700,
              cursor: loading || saving || entries.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving cash balances..." : "Save cash opening figures"}
          </button>
        </div>
      </div>
    </div>
  );
}
