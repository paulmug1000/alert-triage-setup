import React, { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "../Spinner";
import { calculateUkTieredCorpTax } from "../../utils/helpers";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(raw) {
  if (raw === "" || raw === null || raw === undefined) return 0;
  const parsed = parseFloat(String(raw).replace(/[£$€,\s]/g, ""));
  return Number.isFinite(parsed) ? round2(parsed) : 0;
}

function formatMoney(val, currency = "GBP", decimals = 2) {
  const num = Number(val) || 0;
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

export default function InitialTaxPaymentsModal({
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

  // Editable UK tiered Corp Tax rate parameters
  const [smallRatePct, setSmallRatePct] = useState("19");
  const [mainRatePct, setMainRatePct] = useState("25");
  const [lowerLimit, setLowerLimit] = useState("50000");
  const [upperLimit, setUpperLimit] = useState("250000");

  // Confirmed user inputs
  const [corpTaxAmount, setCorpTaxAmount] = useState("0");
  const [vatAmountsByKey, setVatAmountsByKey] = useState({});

  const abortRef = useRef(null);
  const reqIdRef = useRef(0);

  const hydrate = (payload) => {
    setData(payload);
    setCorpTaxAmount(String(round2(payload?.corpTax?.recommendedAmount ?? 0)));
    const nextVat = {};
    (payload?.vatSlots || []).forEach((s) => {
      nextVat[s.slotKey] = String(round2(s.recommendedAmount ?? 0));
    });
    setVatAmountsByKey(nextVat);
  };

  const loadTaxEstimates = async () => {
    if (!clientName || !masterSheetId) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++reqIdRef.current;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/initial-tax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "load_initial_tax",
          clientName,
          masterSheetId,
        }),
      });
      const json = await res.json();
      if (reqId !== reqIdRef.current) return;
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to load initial tax estimates." });
      } else {
        hydrate(json);
      }
    } catch (err) {
      if (err?.name === "AbortError" || reqId !== reqIdRef.current) return;
      setFeedback({ type: "error", message: err?.message || "Failed to load initial tax estimates." });
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadTaxEstimates();
    } else if (abortRef.current) {
      abortRef.current.abort();
    }
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clientName, masterSheetId]);

  const liveTieredCorpTax = useMemo(() => {
    const taxableProfit = data?.corpTax?.year0?.taxableProfit ?? 0;
    return calculateUkTieredCorpTax(taxableProfit, {
      smallRatePct: parseNum(smallRatePct),
      mainRatePct: parseNum(mainRatePct),
      lowerLimit: parseNum(lowerLimit),
      upperLimit: parseNum(upperLimit),
    });
  }, [data?.corpTax?.year0?.taxableProfit, smallRatePct, mainRatePct, lowerLimit, upperLimit]);

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    setFeedback(null);
    try {
      const vatSlotsPayload = (data.vatSlots || []).map((slot) => ({
        slotKey: slot.slotKey,
        cashCol: slot.cashCol,
        vatCol: slot.vatCol,
        f6Num: slot.f6Num,
        paymentMonthShort: slot.paymentMonthShort,
        amount: parseNum(vatAmountsByKey[slot.slotKey]),
      }));

      const res = await fetch("/api/setup/initial-tax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_initial_tax",
          clientName,
          masterSheetId,
          corpTaxAmount: parseNum(corpTaxAmount),
          vatSlots: vatSlotsPayload,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save initial tax payment amounts." });
      } else {
        setFeedback({ type: "success", message: "Initial tax payment estimates saved." });
        if (typeof onCompleted === "function") onCompleted(json);
        onClose();
      }
    } catch (err) {
      setFeedback({ type: "error", message: err?.message || "Failed to save initial tax payment amounts." });
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const currency = data?.currency || "GBP";
  const canSave = Boolean(data && !loading && !saving);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update initial tax payment amounts"
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
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "min(960px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0F172A" }}>
              Update initial tax payment amounts — {clientName}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
              Review and confirm the initial Year 0 corporation tax payment and opening quarter VAT payment estimate(s) for the cash forecast.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={loadTaxEstimates}
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
              {loading ? "Refreshing..." : "Refresh estimates"}
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

        {/* Scrollable Body */}
        <div style={{ padding: "18px 24px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          {loading && !data ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 0", gap: "12px" }}>
              <Spinner size="md" />
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                Estimating initial corporation tax and VAT figures...
              </div>
            </div>
          ) : data ? (
            <>
              {/* Summary Strip */}
              <div
                style={{
                  display: "flex",
                  gap: "12px",
                  flexWrap: "wrap",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  backgroundColor: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  fontSize: "12px",
                  color: "#334155",
                }}
              >
                <div><strong>Tax method:</strong> {data.taxPaymentMethod}</div>
                <div>·</div>
                <div><strong>VAT scheme:</strong> {data.vatScheme} ({Math.round((data.vatRate || 0.2) * 100)}%)</div>
                <div>·</div>
                <div><strong>VAT quarters:</strong> {data.vatQuarters}</div>
                {data.accountingTool && (
                  <>
                    <div>·</div>
                    <div><strong>Accounting source:</strong> {data.accountingTool}</div>
                  </>
                )}
              </div>

              {/* ── 1. CORPORATION TAX CARD ───────────────────────────────── */}
              <div style={{ border: "1px solid #CBD5E1", borderRadius: "10px", overflow: "hidden" }}>
                <div
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#F1F5F9",
                    borderBottom: "1px solid #E2E8F0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#0F172A" }}>
                      1. Initial corporation tax payment
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748B" }}>
                      Due {data.corpTax?.paymentMonthLabel} (deadline {data.corpTax?.deadlineLabel})
                      {isAdmin ? " · Cash!J19 & Cash!J61" : ""}
                    </div>
                  </div>
                  {data.corpTax?.hasExistingCustomValue && (
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "#047857", backgroundColor: "#DCFCE7", padding: "3px 8px", borderRadius: "999px" }}>
                      Saved value loaded ({formatMoney(data.corpTax.existingAmount, currency)})
                    </span>
                  )}
                </div>

                <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
                  {/* Reference sources */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px" }}>
                    {/* Balance Sheet Provision */}
                    <div style={{ padding: "12px 14px", borderRadius: "8px", backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "8px" }}>
                      <div>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>
                          Balance sheet provision ({data.corpTax?.bsAsOfDate})
                        </div>
                        <div style={{ fontSize: "18px", fontWeight: 700, color: "#0F172A", marginTop: "4px" }}>
                          {data.corpTax?.bsProvision !== null && data.corpTax?.bsProvision !== undefined
                            ? formatMoney(data.corpTax.bsProvision, currency)
                            : "Unavailable"}
                        </div>
                        <div style={{ fontSize: "11px", color: "#64748B", marginTop: "4px" }}>
                          {(data.corpTax?.bsMatchedAccounts || []).length > 0
                            ? data.corpTax.bsMatchedAccounts.map((a) => `${a.name}: ${formatMoney(a.balance, currency)}`).join(" · ")
                            : "No corporation tax provision account found at Year 0 end."}
                        </div>
                      </div>
                      {data.corpTax?.bsProvision !== null && data.corpTax?.bsProvision !== undefined && (
                        <button
                          type="button"
                          onClick={() => setCorpTaxAmount(String(round2(data.corpTax.bsProvision)))}
                          style={{
                            alignSelf: "flex-start",
                            padding: "5px 10px",
                            borderRadius: "6px",
                            border: "1px solid #CBD5E1",
                            backgroundColor: "#FFFFFF",
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "#023f98",
                            cursor: "pointer",
                          }}
                        >
                          Use balance sheet figure
                        </button>
                      )}
                    </div>

                    {/* Year 0 P&L UK Tiered Estimate */}
                    <div style={{ padding: "12px 14px", borderRadius: "8px", backgroundColor: "#EFF6FF", border: "1px solid #BFDBFE", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "8px" }}>
                      <div>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "#1E3A8A" }}>
                          Year 0 P&amp;L UK tiered estimate
                        </div>
                        <div style={{ fontSize: "18px", fontWeight: 700, color: "#1E40AF", marginTop: "4px" }}>
                          {formatMoney(liveTieredCorpTax.tax, currency)}
                        </div>
                        <div style={{ fontSize: "11px", color: "#1E40AF", marginTop: "4px" }}>
                          {liveTieredCorpTax.bandLabel} on {formatMoney(data.corpTax?.year0?.taxableProfit || 0, currency)} taxable profit
                        </div>
                        <div style={{ fontSize: "11px", color: "#475569", marginTop: "4px" }}>
                          Revenue {formatMoney(data.corpTax?.year0?.revenue || 0, currency, 0)} − Staff {formatMoney(data.corpTax?.year0?.staffCosts || 0, currency, 0)} − Other costs {formatMoney(data.corpTax?.year0?.nonStaffCosts || 0, currency, 0)}
                          {(data.corpTax?.year0?.dividendsAddedBack || 0) > 0
                            ? ` (excl. ${formatMoney(data.corpTax.year0.dividendsAddedBack, currency, 0)} dividends in lieu)`
                            : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCorpTaxAmount(String(liveTieredCorpTax.tax))}
                        style={{
                          alignSelf: "flex-start",
                          padding: "5px 10px",
                          borderRadius: "6px",
                          border: "1px solid #2563EB",
                          backgroundColor: "#FFFFFF",
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "#1D4ED8",
                          cursor: "pointer",
                        }}
                      >
                        Use UK tiered estimate
                      </button>
                    </div>
                  </div>

                  {/* Editable UK Tiered Rates */}
                  <div style={{ padding: "10px 12px", borderRadius: "8px", backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#475569", marginBottom: "8px" }}>
                      UK corporation tax rate tiers (editable)
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                      {[
                        { label: "Small profits rate (%)", value: smallRatePct, onChange: setSmallRatePct, step: "0.5" },
                        { label: "Main rate (%)", value: mainRatePct, onChange: setMainRatePct, step: "0.5" },
                        { label: `Lower limit (${data.currencySymbol})`, value: lowerLimit, onChange: setLowerLimit, step: "1000" },
                        { label: `Upper limit (${data.currencySymbol})`, value: upperLimit, onChange: setUpperLimit, step: "1000" },
                      ].map((f) => (
                        <div key={f.label}>
                          <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#475569", marginBottom: "3px" }}>
                            {f.label}
                          </label>
                          <input
                            type="number"
                            step={f.step}
                            min="0"
                            value={f.value}
                            onChange={(e) => f.onChange(e.target.value)}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Confirmed Corporation Tax Input */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", paddingTop: "6px", borderTop: "1px solid #F1F5F9" }}>
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#0F172A" }}>
                        Confirmed corporation tax payment
                      </div>
                      <div style={{ fontSize: "11px", color: "#64748B" }}>
                        Enter positive amount owed (saved as an outflow in {data.corpTax?.paymentMonthShort}).
                      </div>
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#475569" }}>{data.currencySymbol}</span>
                      <input
                        type="number"
                        step="0.01"
                        value={corpTaxAmount}
                        onChange={(e) => setCorpTaxAmount(e.target.value)}
                        style={{
                          width: "150px",
                          padding: "7px 10px",
                          borderRadius: "6px",
                          border: "1px solid #2563EB",
                          fontSize: "13px",
                          fontWeight: 700,
                          textAlign: "right",
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 2. INITIAL VAT PAYMENT CARD(S) ────────────────────────── */}
              {(data.vatSlots || []).map((slot) => (
                <div key={slot.slotKey} style={{ border: "1px solid #CBD5E1", borderRadius: "10px", overflow: "hidden" }}>
                  <div
                    style={{
                      padding: "12px 16px",
                      backgroundColor: "#F1F5F9",
                      borderBottom: "1px solid #E2E8F0",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#0F172A" }}>
                        {data.vatSlots.length > 1
                          ? `2.${slot.slotNumber}. Initial VAT payment (${slot.paymentMonthLabel})`
                          : `2. Initial VAT payment (${slot.paymentMonthLabel})`}
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748B" }}>
                        Covers return period {slot.periodLabel}
                        {isAdmin ? ` · Cash!${slot.cashCol}21 (via VAT!${slot.vatCol}32:${slot.vatCol}35)` : ""}
                      </div>
                    </div>
                    {slot.hasExistingCustomValue && (
                      <span style={{ fontSize: "11px", fontWeight: 600, color: "#047857", backgroundColor: "#DCFCE7", padding: "3px 8px", borderRadius: "999px" }}>
                        Saved value loaded ({formatMoney(slot.existingAmount, currency)})
                      </span>
                    )}
                  </div>

                  <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px" }}>
                      {/* Actual Recorded Payment (when already paid in accounting tool) */}
                      {slot.actualPayment && (
                        <div style={{ padding: "10px 12px", borderRadius: "8px", backgroundColor: "#ECFDF5", border: "1px solid #6EE7B7", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
                          <div>
                            <div style={{ fontSize: "11px", fontWeight: 700, color: "#065F46" }}>
                              Actual VAT payment made
                            </div>
                            <div style={{ fontSize: "16px", fontWeight: 700, color: "#047857", marginTop: "3px" }}>
                              {formatMoney(slot.actualPayment.amount, currency)}
                            </div>
                            <div style={{ fontSize: "11px", color: "#065F46", marginTop: "3px" }}>
                              Paid {slot.actualPayment.date} · {slot.actualPayment.contactName}
                              {!slot.actualPayment.inExpectedMonth ? ` (expected ${slot.paymentMonthShort})` : ""}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setVatAmountsByKey((prev) => ({ ...prev, [slot.slotKey]: String(round2(slot.actualPayment.amount)) }))}
                            style={{ alignSelf: "flex-start", padding: "4px 9px", borderRadius: "6px", border: "1px solid #059669", backgroundColor: "#FFFFFF", fontSize: "11px", fontWeight: 600, color: "#047857", cursor: "pointer" }}
                          >
                            Use actual amount paid
                          </button>
                        </div>
                      )}

                      {/* Transactions Estimate */}
                      <div style={{ padding: "10px 12px", borderRadius: "8px", backgroundColor: slot.actualPayment ? "#F8FAFC" : "#EFF6FF", border: slot.actualPayment ? "1px solid #E2E8F0" : "1px solid #BFDBFE", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
                        <div>
                          <div style={{ fontSize: "11px", fontWeight: 700, color: slot.actualPayment ? "#334155" : "#1E3A8A" }}>
                            Accounting transactions + forecast
                          </div>
                          <div style={{ fontSize: "16px", fontWeight: 700, color: slot.actualPayment ? "#0F172A" : "#1E40AF", marginTop: "3px" }}>
                            {slot.txnEstimate !== null ? formatMoney(slot.txnEstimate, currency) : "Unavailable"}
                          </div>
                        </div>
                        {slot.txnEstimate !== null && (
                          <button
                            type="button"
                            onClick={() => setVatAmountsByKey((prev) => ({ ...prev, [slot.slotKey]: String(round2(slot.txnEstimate)) }))}
                            style={{ alignSelf: "flex-start", padding: "4px 9px", borderRadius: "6px", border: slot.actualPayment ? "1px solid #CBD5E1" : "1px solid #2563EB", backgroundColor: "#FFFFFF", fontSize: "11px", fontWeight: 600, color: slot.actualPayment ? "#023f98" : "#1D4ED8", cursor: "pointer" }}
                          >
                            Use this estimate
                          </button>
                        )}
                      </div>

                      {/* Balance Sheet VAT Control */}
                      <div style={{ padding: "10px 12px", borderRadius: "8px", backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
                        <div>
                          <div style={{ fontSize: "11px", fontWeight: 700, color: "#334155" }}>
                            Balance sheet VAT control ({slot.bsAsOfDate})
                          </div>
                          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0F172A", marginTop: "3px" }}>
                            {slot.bsEstimate !== null ? formatMoney(slot.bsEstimate, currency) : "Unavailable"}
                          </div>
                        </div>
                        {slot.bsEstimate !== null && (
                          <button
                            type="button"
                            onClick={() => setVatAmountsByKey((prev) => ({ ...prev, [slot.slotKey]: String(round2(slot.bsEstimate)) }))}
                            style={{ alignSelf: "flex-start", padding: "4px 9px", borderRadius: "6px", border: "1px solid #CBD5E1", backgroundColor: "#FFFFFF", fontSize: "11px", fontWeight: 600, color: "#023f98", cursor: "pointer" }}
                          >
                            Use balance sheet figure
                          </button>
                        )}
                      </div>

                      {/* Year 0 P&L Fallback Estimate */}
                      <div style={{ padding: "10px 12px", borderRadius: "8px", backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "6px" }}>
                        <div>
                          <div style={{ fontSize: "11px", fontWeight: 700, color: "#334155" }}>
                            P&amp;L × VAT proxy (fallback)
                          </div>
                          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0F172A", marginTop: "3px" }}>
                            {formatMoney(slot.pnlEstimate, currency)}
                          </div>
                          {slot.pnlBreakdown && (
                            <div style={{ fontSize: "10.5px", color: "#64748B", marginTop: "3px", lineHeight: 1.35 }}>
                              {Math.round((data.vatRate || 0.2) * 100)}% × (Rev {formatMoney(slot.pnlBreakdown.revenue, currency, 0)} − Non-staff {formatMoney(slot.pnlBreakdown.nonStaffCosts, currency, 0)}). Rough proxy only — ignores cash timing &amp; non-VAT items.
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setVatAmountsByKey((prev) => ({ ...prev, [slot.slotKey]: String(round2(slot.pnlEstimate)) }))}
                          style={{ alignSelf: "flex-start", padding: "4px 9px", borderRadius: "6px", border: "1px solid #CBD5E1", backgroundColor: "#FFFFFF", fontSize: "11px", fontWeight: 600, color: "#023f98", cursor: "pointer" }}
                        >
                          Use P&amp;L estimate
                        </button>
                      </div>
                    </div>

                    {/* Month-by-month breakdown */}
                    <div style={{ border: "1px solid #E2E8F0", borderRadius: "6px", overflow: "hidden" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                        <thead>
                          <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0", color: "#475569" }}>
                            <th style={{ textAlign: "left", padding: "5px 10px" }}>Month in return</th>
                            <th style={{ textAlign: "left", padding: "5px 10px" }}>Source</th>
                            <th style={{ textAlign: "right", padding: "5px 10px" }}>Estimated net VAT</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(slot.monthBreakdown || []).map((mb) => (
                            <tr key={mb.monthKey} style={{ borderBottom: "1px solid #F1F5F9" }}>
                              <td style={{ padding: "5px 10px", fontWeight: 600, color: "#1E293B" }}>
                                {mb.shortLabel} {mb.isYear0 ? "(Year 0)" : "(FY1)"}
                              </td>
                              <td style={{ padding: "5px 10px", color: "#64748B" }}>{mb.sourceLabel}</td>
                              <td style={{ padding: "5px 10px", textAlign: "right", fontWeight: 600, color: "#0F172A" }}>
                                {formatMoney(mb.estimatedNetVat, currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Confirmed VAT Slot Input */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", paddingTop: "6px", borderTop: "1px solid #F1F5F9" }}>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0F172A" }}>
                          Confirmed VAT payment ({slot.paymentMonthShort})
                        </div>
                        <div style={{ fontSize: "11px", color: "#64748B" }}>
                          Positive = payment owed to HMRC (enter negative if a VAT refund is due).
                        </div>
                      </div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 700, color: "#475569" }}>{data.currencySymbol}</span>
                        <input
                          type="number"
                          step="0.01"
                          value={vatAmountsByKey[slot.slotKey] ?? "0"}
                          onChange={(e) =>
                            setVatAmountsByKey((prev) => ({ ...prev, [slot.slotKey]: e.target.value }))
                          }
                          style={{
                            width: "150px",
                            padding: "7px 10px",
                            borderRadius: "6px",
                            border: "1px solid #2563EB",
                            fontSize: "13px",
                            fontWeight: 700,
                            textAlign: "right",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : null}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 24px",
            borderTop: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
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
            disabled={!canSave}
            style={{
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: canSave ? "#047857" : "#94A3B8",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: 700,
              cursor: canSave ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Saving tax estimates..." : "Save tax estimates"}
          </button>
        </div>
      </div>
    </div>
  );
}
