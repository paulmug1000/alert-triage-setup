import React, { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "../Spinner";

function normalizeName(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
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

function formatAccountRef(acc) {
  if (acc?.code) return String(acc.code).trim();
  const num = String(acc?.accountNumber || "").trim();
  if (!num) return "—";
  if (num.length > 8 && /^\d+$/.test(num)) return `••••${num.slice(-4)}`;
  return num;
}

export default function SelectBankAccountsModal({
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
  const [searchQuery, setSearchQuery] = useState("");
  const [roleByKey, setRoleByKey] = useState({}); // key -> "cash" | "non_cash" | "ignore"

  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  const accountKey = (acc) => acc.id || acc.name;

  const hydrate = (payload) => {
    setData(payload);
    const cashList = payload?.selectedCashAccounts || [];
    const nonCashList = payload?.selectedNonCashAccounts || [];
    const nextRoles = {};

    const matchIn = (acc, list) =>
      list.some(
        (item) =>
          (item.id && acc.id && item.id.toLowerCase() === acc.id.toLowerCase()) ||
          normalizeName(item.name) === normalizeName(acc.name)
      );

    for (const acc of payload?.accounts || []) {
      const k = accountKey(acc);
      if (matchIn(acc, cashList)) nextRoles[k] = "cash";
      else if (matchIn(acc, nonCashList)) nextRoles[k] = "non_cash";
      else nextRoles[k] = "ignore";
    }
    setRoleByKey(nextRoles);
  };

  const loadAccounts = async () => {
    if (!clientName) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++reqIdRef.current;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "load_bank_accounts",
          clientName,
          masterSheetId,
        }),
      });
      const json = await res.json();
      if (reqId !== reqIdRef.current) return;
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to fetch bank accounts." });
      } else {
        hydrate(json);
      }
    } catch (err) {
      if (err?.name === "AbortError" || reqId !== reqIdRef.current) return;
      setFeedback({ type: "error", message: err?.message || "Failed to fetch bank accounts." });
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !clientName) return;
    setSearchQuery("");
    loadAccounts();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, masterSheetId]);

  const accounts = useMemo(() => data?.accounts || [], [data]);
  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        String(a.name || "").toLowerCase().includes(q) ||
        String(a.code || "").toLowerCase().includes(q) ||
        String(a.type || "").toLowerCase().includes(q) ||
        String(a.currency || "").toLowerCase().includes(q)
    );
  }, [accounts, searchQuery]);

  const cashCount = useMemo(
    () => accounts.filter((a) => roleByKey[accountKey(a)] === "cash").length,
    [accounts, roleByKey]
  );
  const nonCashCount = useMemo(
    () => accounts.filter((a) => roleByKey[accountKey(a)] === "non_cash").length,
    [accounts, roleByKey]
  );

  const handleSetRole = (acc, nextRole) => {
    const k = accountKey(acc);
    if (nextRole === "cash" && roleByKey[k] !== "cash" && cashCount >= 10) {
      setFeedback({ type: "error", message: "Maximum of 10 cash bank accounts allowed." });
      return;
    }
    if (nextRole === "non_cash" && roleByKey[k] !== "non_cash" && nonCashCount >= 6) {
      setFeedback({ type: "error", message: "Maximum of 6 non-cash bank accounts allowed." });
      return;
    }
    setFeedback(null);
    setRoleByKey((prev) => ({ ...prev, [k]: nextRole }));
  };

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const cashAccounts = accounts
        .filter((a) => roleByKey[accountKey(a)] === "cash")
        .slice(0, 10)
        .map((a) => ({ name: a.name, id: a.id || "" }));
      const nonCashAccounts = accounts
        .filter((a) => roleByKey[accountKey(a)] === "non_cash")
        .slice(0, 6)
        .map((a) => ({ name: a.name, id: a.id || "" }));

      const res = await fetch("/api/setup/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_bank_accounts",
          clientName,
          masterSheetId,
          cashAccounts,
          nonCashAccounts,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save bank accounts." });
      } else {
        setFeedback({ type: "success", message: "Bank accounts saved successfully." });
        if (typeof onCompleted === "function") onCompleted(json);
        onClose();
      }
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to save bank accounts." });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select bank accounts"
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
          maxWidth: "1120px",
          maxHeight: "90vh",
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
              Select bank accounts — {clientName}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
              Choose which accounts are tracked as cash bank accounts (for cash opening balances &amp; cash flow) and which are non-cash accounts (such as credit cards or loan accounts).
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={loadAccounts}
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
              {loading ? "Loading accounts..." : "Refresh accounts"}
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
                Loading available bank accounts...
              </div>
            </div>
          ) : data ? (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "12px",
                  marginBottom: "12px",
                }}
              >
                <div style={{ display: "flex", gap: "10px", alignItems: "center", fontSize: "12px" }}>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", backgroundColor: "#ECFDF5", color: "#047857", fontWeight: 700, border: "1px solid #A7F3D0" }}>
                    Cash: {cashCount} / 10{isAdmin ? " (H12:I21)" : ""}
                  </span>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", backgroundColor: "#EFF6FF", color: "#1E40AF", fontWeight: 700, border: "1px solid #BFDBFE" }}>
                    Non-cash: {nonCashCount} / 6{isAdmin ? " (H23:I28)" : ""}
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="Filter accounts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: "6px",
                    border: "1px solid #CBD5E1",
                    fontSize: "12px",
                    minWidth: "220px",
                  }}
                />
              </div>

              <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                      <th style={{ textAlign: "left", padding: "8px 12px" }}>Account name</th>
                      <th style={{ textAlign: "left", padding: "8px 10px", width: "86px" }}>Type</th>
                      <th style={{ textAlign: "left", padding: "8px 10px", width: "110px" }}>Code / Acct #</th>
                      <th style={{ textAlign: "left", padding: "8px 10px", width: "68px" }}>Curr</th>
                      <th style={{ textAlign: "right", padding: "8px 10px", width: "115px", whiteSpace: "nowrap" }}>
                        {data.prev1Label || "Last mo"} txns
                      </th>
                      <th style={{ textAlign: "right", padding: "8px 10px", width: "118px", whiteSpace: "nowrap" }}>
                        {data.prev2Label || "2m ago"} close
                      </th>
                      <th style={{ textAlign: "right", padding: "8px 10px", width: "118px", whiteSpace: "nowrap" }}>
                        {data.prev1Label || "Prev mo"} close
                      </th>
                      <th style={{ textAlign: "right", padding: "8px 12px", width: "225px" }}>Classification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAccounts.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: "24px", textAlign: "center", color: "#64748B" }}>
                          No bank accounts found in {data.accountingTool || "your accounting tool"}.
                        </td>
                      </tr>
                    ) : (
                      filteredAccounts.map((acc) => {
                        const k = accountKey(acc);
                        const role = roleByKey[k] || "ignore";
                        const isArchived = String(acc.status || "").toUpperCase() === "ARCHIVED";
                        const txCount = Number(acc.lastMonthTxnCount) || 0;
                        const c2 = Number(acc.closingPrev2) || 0;
                        const c1 = Number(acc.closingPrev1) || 0;
                        const acctCurr = acc.currency || data.currency || "GBP";
                        return (
                          <tr key={k} style={{ borderBottom: "1px solid #F1F5F9", opacity: isArchived ? 0.65 : 1 }}>
                            <td style={{ padding: "8px 12px", fontWeight: 600, color: "#0F172A" }}>
                              <div>{acc.name}</div>
                              {isArchived && (
                                <span style={{ fontSize: "10px", color: "#B45309", fontWeight: 600 }}>Archived</span>
                              )}
                            </td>
                            <td style={{ padding: "8px 10px", color: "#475569" }}>
                              {acc.type === "CREDIT_CARD" ? "Credit card" : acc.type || "Bank"}
                            </td>
                            <td style={{ padding: "8px 10px", color: "#64748B" }} title={acc.accountNumber || acc.code || ""}>
                              {formatAccountRef(acc)}
                            </td>
                            <td style={{ padding: "8px 10px", color: "#475569" }}>{acc.currency || "—"}</td>
                            <td style={{ padding: "8px 10px", textAlign: "right" }}>
                              {txCount > 0 ? (
                                <span style={{ padding: "2px 8px", borderRadius: "999px", backgroundColor: "#ECFDF5", color: "#047857", fontWeight: 700, fontSize: "11px" }}>
                                  {txCount} active
                                </span>
                              ) : (
                                <span style={{ color: "#94A3B8", fontSize: "11px" }}>0</span>
                              )}
                            </td>
                            <td style={{ padding: "8px 10px", textAlign: "right", color: Math.abs(c2) < 0.01 ? "#94A3B8" : "#0F172A", fontWeight: Math.abs(c2) >= 0.01 ? 600 : 400 }}>
                              {formatMoney(c2, acctCurr)}
                            </td>
                            <td style={{ padding: "8px 10px", textAlign: "right", color: Math.abs(c1) < 0.01 ? "#94A3B8" : "#0F172A", fontWeight: Math.abs(c1) >= 0.01 ? 600 : 400 }}>
                              {formatMoney(c1, acctCurr)}
                            </td>
                            <td style={{ padding: "6px 12px", textAlign: "right" }}>
                              <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #CBD5E1" }}>
                                {[
                                  { id: "cash", label: "Cash", activeBg: "#047857", activeFg: "#FFFFFF" },
                                  { id: "non_cash", label: "Non-cash", activeBg: "#023f98", activeFg: "#FFFFFF" },
                                  { id: "ignore", label: "Ignore", activeBg: "#475569", activeFg: "#FFFFFF" },
                                ].map((opt, oIdx) => {
                                  const selected = role === opt.id;
                                  return (
                                    <button
                                      key={opt.id}
                                      type="button"
                                      onClick={() => handleSetRole(acc, opt.id)}
                                      style={{
                                        padding: "4px 10px",
                                        border: "none",
                                        borderLeft: oIdx > 0 ? "1px solid #CBD5E1" : "none",
                                        backgroundColor: selected ? opt.activeBg : "#FFFFFF",
                                        color: selected ? opt.activeFg : "#475569",
                                        fontSize: "11px",
                                        fontWeight: selected ? 700 : 500,
                                        cursor: "pointer",
                                      }}
                                    >
                                      {opt.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
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
            disabled={loading || saving || !data}
            style={{
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: loading || saving || !data ? "#94A3B8" : "#047857",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: 700,
              cursor: loading || saving || !data ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving bank accounts..." : "Save bank accounts"}
          </button>
        </div>
      </div>
    </div>
  );
}
