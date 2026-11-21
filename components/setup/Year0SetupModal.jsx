import React, { useEffect, useMemo, useState } from "react";
import Spinner from "../Spinner";
import {
  roundYear0 as round2,
  toYear0InputStrings as toInputStrings,
  parseYear0InputsToNumbers as parseInputsToNumbers,
  computeYear0PnL,
} from "../../utils/year0Calc";

function formatMoney(val, currency = "GBP") {
  const num = Number(val) || 0;
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

export default function Year0SetupModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onCompleted,
}) {
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [data, setData] = useState(null);

  // Editable Year 0 state
  const [deliveryPct, setDeliveryPct] = useState("0");
  const [dividendInputs, setDividendInputs] = useState(() => Array(12).fill(""));
  const [applyAllDividendsVal, setApplyAllDividendsVal] = useState("");
  const [revAdjInputs, setRevAdjInputs] = useState(() => Array(12).fill(""));
  const [cosAdjInputs, setCosAdjInputs] = useState(() => Array(12).fill(""));
  const [ohAdjInputs, setOhAdjInputs] = useState(() => Array(12).fill(""));

  // Expandable nominal category breakdowns
  const [expandedSections, setExpandedSections] = useState({
    revenue: false,
    cos: false,
    overheads: false,
  });

  // Detected Dividends / Directors' Loan Account state from Xero or QuickBooks
  const [detectingDividends, setDetectingDividends] = useState(false);
  const [dividendHints, setDividendHints] = useState(null);
  const [detectDividendsError, setDetectDividendsError] = useState("");

  const hydrateFromPayload = (payload) => {
    setData(payload);
    setDeliveryPct(String(round2(payload?.dividends?.deliveryPct ?? 0)));
    setDividendInputs(toInputStrings(payload?.dividends?.monthly));
    setRevAdjInputs(toInputStrings(payload?.adjustments?.revenue));
    setCosAdjInputs(toInputStrings(payload?.adjustments?.costOfSales));
    setOhAdjInputs(toInputStrings(payload?.adjustments?.overheads));
  };

  useEffect(() => {
    if (!isOpen || !clientName) return;
    let active = true;
    setLoading(true);
    setFeedback(null);
    setApplyAllDividendsVal("");
    setDividendHints(null);
    setDetectDividendsError("");

    const params = new URLSearchParams({ clientName });
    if (masterSheetId) params.set("masterSheetId", masterSheetId);

    fetch(`/api/setup/year0?${params.toString()}`)
      .then((r) => r.json())
      .then((res) => {
        if (!active) return;
        if (!res.success) {
          setFeedback({ type: "error", message: res.error || "Failed to load Year 0 data." });
        } else {
          hydrateFromPayload(res);
        }
      })
      .catch((err) => {
        if (active) setFeedback({ type: "error", message: err.message || "Failed to load Year 0 data." });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, clientName, masterSheetId]);

  const handlePullYear0PL = async () => {
    setPulling(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "pull_year0_pl",
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to pull Year 0 profit & loss." });
      } else {
        hydrateFromPayload(json);
        setFeedback({
          type: "success",
          message: "Year 0 profit & loss pulled successfully.",
        });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to pull Year 0 profit & loss." });
    } finally {
      setPulling(false);
    }
  };

  const handleApplyAllDividends = () => {
    const trimmed = String(applyAllDividendsVal || "").trim();
    const cleaned = trimmed.replace(/[£$€,\s]/g, "");
    const num = parseFloat(cleaned);
    const valStr = trimmed === "" || !Number.isFinite(num) || num === 0 ? "" : String(round2(num));
    setDividendInputs(Array(12).fill(valStr));
  };

  const handleDetectDividends = async () => {
    if (!clientName) return;
    setDetectingDividends(true);
    setDetectDividendsError("");
    try {
      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "detect_dividends",
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setDetectDividendsError(json.error || "Could not extract dividend accounts.");
      } else {
        setDividendHints({
          accountingTool: json.accountingTool,
          candidates: json.candidates || [],
        });
      }
    } catch (err) {
      setDetectDividendsError(err.message || "Could not extract dividend accounts.");
    } finally {
      setDetectingDividends(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !data?.hasYear0PL || !data?.accountingTool || dividendHints !== null || detectingDividends) return;
    handleDetectDividends();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, data?.hasYear0PL, data?.accountingTool]);

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const pctNum = Math.max(0, Math.min(100, parseFloat(String(deliveryPct || "0")) || 0));
      const monthlyDividends = parseInputsToNumbers(dividendInputs);
      const categoryAdjustments = {
        revenue: parseInputsToNumbers(revAdjInputs),
        costOfSales: parseInputsToNumbers(cosAdjInputs),
        overheads: parseInputsToNumbers(ohAdjInputs),
      };

      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "save_year0_adjustments",
          deliveryPct: pctNum,
          monthlyDividends,
          categoryAdjustments,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to save Year 0 setup." });
      } else {
        hydrateFromPayload(json);
        setFeedback({ type: "success", message: "Year 0 setup saved." });
        if (onCompleted) onCompleted(json);
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to save Year 0 setup." });
    } finally {
      setSaving(false);
    }
  };

  // Compute live P&L metrics across all 12 months
  const computed = useMemo(
    () =>
      computeYear0PnL({
        data,
        deliveryPct,
        dividendInputs,
        revAdjInputs,
        cosAdjInputs,
        ohAdjInputs,
      }),
    [data, deliveryPct, dividendInputs, revAdjInputs, cosAdjInputs, ohAdjInputs]
  );

  if (!isOpen) return null;

  const currency = data?.currency || "GBP";
  const revLabel = data?.revOrInc || "Revenue";

  const updateMonthArray = (setter, index, rawVal) => {
    setter((prev) => {
      const next = [...prev];
      next[index] = rawVal;
      return next;
    });
  };

  const renderNumberInputRow = ({
    label,
    subtitle,
    values,
    onChange,
    totalValue,
    accentBg = "#FFFBEB",
    borderColor = "#FDE68A",
    leftExtra = null,
  }) => (
    <tr style={{ backgroundColor: accentBg, borderTop: `1px solid ${borderColor}`, borderBottom: `1px solid ${borderColor}` }}>
      <td
        style={{
          position: "sticky",
          left: 0,
          zIndex: 2,
          backgroundColor: accentBg,
          padding: "7px 10px",
          borderRight: "1px solid #E2E8F0",
          width: "215px",
          minWidth: "215px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#1E293B" }}>{label}</div>
            {subtitle && <div style={{ fontSize: "11px", color: "#64748B", marginTop: "1px" }}>{subtitle}</div>}
          </div>
          {leftExtra}
        </div>
      </td>
      {computed.months.map((m, idx) => (
        <td key={idx} style={{ padding: "5px 3px", textAlign: "right", minWidth: "70px" }}>
          <input
            type="text"
            inputMode="decimal"
            value={values[idx] ?? ""}
            onChange={(e) => onChange(idx, e.target.value)}
            placeholder="0"
            aria-label={`${label} ${m.shortLabel}`}
            style={{
              width: "100%",
              padding: "4px 4px",
              fontSize: "11.5px",
              textAlign: "right",
              borderRadius: "6px",
              border: "1px solid #CBD5E1",
              backgroundColor: "#FFFFFF",
              color: "#0F172A",
              fontWeight: values[idx] ? 600 : 400,
            }}
          />
        </td>
      ))}
      <td
        style={{
          padding: "8px 12px",
          textAlign: "right",
          fontWeight: 700,
          fontSize: "12px",
          color: "#0F172A",
          borderLeft: "1px solid #CBD5E1",
          backgroundColor: accentBg,
          whiteSpace: "nowrap",
        }}
      >
        {formatMoney(totalValue, currency)}
      </td>
    </tr>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px",
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "96vw",
          maxWidth: "1540px",
          maxHeight: "94vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
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
            backgroundColor: "#F8FAFC",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0F172A" }}>
              Check Year 0 setup
            </h2>
            <p style={{ margin: "3px 0 0 0", fontSize: "12px", color: "#64748B" }}>
              {clientName}
              {data?.months?.length === 12
                ? ` · ${data.months[0].shortLabel} to ${data.months[11].shortLabel}`
                : ""}
              {data?.startDate ? ` · Start date: ${data.startDate}` : ""}
              {data?.basis ? ` · Basis: ${data.basis}` : ""}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={handlePullYear0PL}
              disabled={pulling || loading}
              style={{
                padding: "7px 14px",
                borderRadius: "8px",
                border: "1px solid #2563EB",
                backgroundColor: "#EFF6FF",
                color: "#1D4ED8",
                fontWeight: 600,
                fontSize: "12px",
                cursor: pulling || loading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {pulling ? "Pulling Year 0 P&L..." : data?.hasYear0PL ? "Refresh Year 0 P&L" : "Pull Year 0 P&L"}
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

        {/* Feedback banner */}
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
        <div
          style={{
            padding: "16px 20px",
            overflowY: "auto",
            overflowX: "auto",
            flex: "1 1 auto",
            minHeight: 0,
            maxHeight: "calc(94vh - 140px)",
          }}
        >
          {loading || (!data?.hasYear0PL && pulling) ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 0", gap: "12px" }}>
              <Spinner size="md" />
              <div style={{ fontSize: "13px", color: "#64748B" }}>
                {pulling ? "Pulling 12 months of Year 0 profit & loss figures..." : "Loading Year 0 profit & loss figures..."}
              </div>
            </div>
          ) : !data?.hasYear0PL ? (
            <div
              style={{
                textAlign: "center",
                padding: "44px 20px",
                border: "1px dashed #CBD5E1",
                borderRadius: "12px",
                backgroundColor: "#F8FAFC",
              }}
            >
              <div style={{ fontSize: "15px", fontWeight: 700, color: "#0F172A", marginBottom: "6px" }}>
                No Year 0 profit & loss figures loaded yet
              </div>
              <p style={{ fontSize: "13px", color: "#64748B", maxWidth: "520px", margin: "0 auto 18px auto" }}>
                Pull the 12 months of historical profit & loss leading up to {data?.startDate || "the system start date"} from{" "}
                {data?.accountingTool || "the accounting tool"}, then review and add dividends in lieu of salary or monthly adjustments.
              </p>
              <button
                type="button"
                onClick={handlePullYear0PL}
                disabled={pulling}
                style={{
                  padding: "9px 18px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Pull Year 0 P&L
              </button>
            </div>
          ) : (
            <>
            <div style={{ border: "1px solid #E2E8F0", borderRadius: "10px", overflow: "visible" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ backgroundColor: "#F1F5F9", borderBottom: "1px solid #CBD5E1" }}>
                    <th
                      style={{
                        position: "sticky",
                        left: 0,
                        top: 0,
                        zIndex: 4,
                        backgroundColor: "#F1F5F9",
                        textAlign: "left",
                        padding: "9px 10px",
                        fontWeight: 700,
                        color: "#334155",
                        borderRight: "1px solid #E2E8F0",
                        width: "215px",
                        minWidth: "215px",
                      }}
                    >
                      Category
                    </th>
                    {computed.months.map((m, idx) => (
                      <th
                        key={idx}
                        style={{
                          position: "sticky",
                          top: 0,
                          zIndex: 3,
                          backgroundColor: "#F1F5F9",
                          textAlign: "right",
                          padding: "9px 6px",
                          fontWeight: 700,
                          color: "#334155",
                          minWidth: "70px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.shortLabel}
                      </th>
                    ))}
                    <th
                      style={{
                        position: "sticky",
                        top: 0,
                        zIndex: 3,
                        backgroundColor: "#F1F5F9",
                        textAlign: "right",
                        padding: "9px 10px",
                        fontWeight: 700,
                        color: "#0F172A",
                        borderLeft: "1px solid #CBD5E1",
                        whiteSpace: "nowrap",
                        minWidth: "86px",
                      }}
                    >
                      Year 0 total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* REVENUE */}
                  <tr style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #F1F5F9" }}>
                    <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#FFFFFF", padding: "8px 12px", borderRight: "1px solid #E2E8F0" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedSections((p) => ({ ...p, revenue: !p.revenue }))}
                        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontWeight: 600, color: "#1E293B", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}
                      >
                        <span>{expandedSections.revenue ? "▾" : "▸"}</span>
                        <span>{revLabel} (imported)</span>
                      </button>
                    </td>
                    {computed.baseRev.map((val, idx) => (
                      <td key={idx} style={{ padding: "8px", textAlign: "right", color: "#334155" }}>
                        {formatMoney(val, currency)}
                      </td>
                    ))}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#0F172A", borderLeft: "1px solid #E2E8F0" }}>
                      {formatMoney(computed.totals.baseRev, currency)}
                    </td>
                  </tr>

                  {expandedSections.revenue &&
                    (data?.breakdown?.revenue || []).map((line) => (
                      <tr key={`rev-${line.rowNum}`} style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #F1F5F9", color: "#64748B" }}>
                        <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#F8FAFC", padding: "5px 12px 5px 28px", borderRight: "1px solid #E2E8F0", fontSize: "11px" }}>
                          {line.label}
                        </td>
                        {line.monthly.map((v, idx) => (
                          <td key={idx} style={{ padding: "5px 8px", textAlign: "right", fontSize: "11px" }}>
                            {formatMoney(v, currency)}
                          </td>
                        ))}
                        <td style={{ padding: "5px 12px", textAlign: "right", fontSize: "11px", borderLeft: "1px solid #E2E8F0" }}>
                          {formatMoney(line.total, currency)}
                        </td>
                      </tr>
                    ))}

                  {renderNumberInputRow({
                    label: `${revLabel} adjustment (+/-)`,
                    subtitle: "Optional monthly adjustment up or down",
                    values: revAdjInputs,
                    onChange: (idx, v) => updateMonthArray(setRevAdjInputs, idx, v),
                    totalValue: computed.totals.revAdj,
                    accentBg: "#F8FAFC",
                    borderColor: "#E2E8F0",
                  })}

                  <tr style={{ backgroundColor: "#EFF6FF", borderBottom: "2px solid #BFDBFE" }}>
                    <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#EFF6FF", padding: "9px 12px", fontWeight: 700, color: "#1E3A8A", borderRight: "1px solid #E2E8F0" }}>
                      Total {revLabel.toLowerCase()}
                    </td>
                    {computed.revenueTotal.map((val, idx) => (
                      <td key={idx} style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700, color: "#1E3A8A" }}>
                        {formatMoney(val, currency)}
                      </td>
                    ))}
                    <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, color: "#1E3A8A", borderLeft: "1px solid #BFDBFE" }}>
                      {formatMoney(computed.totals.revenue, currency)}
                    </td>
                  </tr>

                  {/* COSTS OF SALE (if delivery/non-delivery split is enabled) */}
                  {computed.splitDelivery && (
                    <>
                      <tr style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #F1F5F9" }}>
                        <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#FFFFFF", padding: "8px 12px", borderRight: "1px solid #E2E8F0" }}>
                          <button
                            type="button"
                            onClick={() => setExpandedSections((p) => ({ ...p, cos: !p.cos }))}
                            style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontWeight: 600, color: "#1E293B", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}
                          >
                            <span>{expandedSections.cos ? "▾" : "▸"}</span>
                            <span>Costs of sale (imported + delivery dividends)</span>
                          </button>
                        </td>
                        {computed.months.map((_, idx) => {
                          const baseCosMonth = (computed.baseCosStaff[idx] || 0) + (computed.baseCosOther[idx] || 0) + (computed.cosDiv[idx] || 0);
                          return (
                            <td key={idx} style={{ padding: "8px", textAlign: "right", color: "#334155" }}>
                              {formatMoney(baseCosMonth, currency)}
                            </td>
                          );
                        })}
                        <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#0F172A", borderLeft: "1px solid #E2E8F0" }}>
                          {formatMoney(computed.totals.cosTotal - computed.totals.cosAdj, currency)}
                        </td>
                      </tr>

                      {expandedSections.cos && (
                        <>
                          {[...(data?.breakdown?.cosStaff || []), ...(data?.breakdown?.otherCos || [])].map((line) => (
                            <tr key={`cos-${line.rowNum}`} style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #F1F5F9", color: "#64748B" }}>
                              <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#F8FAFC", padding: "5px 12px 5px 28px", borderRight: "1px solid #E2E8F0", fontSize: "11px" }}>
                                {line.label}
                              </td>
                              {line.monthly.map((v, idx) => (
                                <td key={idx} style={{ padding: "5px 8px", textAlign: "right", fontSize: "11px" }}>
                                  {formatMoney(v, currency)}
                                </td>
                              ))}
                              <td style={{ padding: "5px 12px", textAlign: "right", fontSize: "11px", borderLeft: "1px solid #E2E8F0" }}>
                                {formatMoney(line.total, currency)}
                              </td>
                            </tr>
                          ))}
                          {computed.totals.cosDiv > 0 && (
                            <tr style={{ backgroundColor: "#FFFBEB", borderBottom: "1px solid #FDE68A", color: "#92400E" }}>
                              <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#FFFBEB", padding: "5px 12px 5px 28px", borderRight: "1px solid #E2E8F0", fontSize: "11px", fontWeight: 600 }}>
                                Dividends in lieu of salary ({deliveryPct || 0}% delivery share)
                              </td>
                              {computed.cosDiv.map((v, idx) => (
                                <td key={idx} style={{ padding: "5px 8px", textAlign: "right", fontSize: "11px", fontWeight: 600 }}>
                                  {formatMoney(v, currency)}
                                </td>
                              ))}
                              <td style={{ padding: "5px 12px", textAlign: "right", fontSize: "11px", fontWeight: 600, borderLeft: "1px solid #E2E8F0" }}>
                                {formatMoney(computed.totals.cosDiv, currency)}
                              </td>
                            </tr>
                          )}
                        </>
                      )}

                      {renderNumberInputRow({
                        label: "Cost of sales adjustment (+/-)",
                        subtitle: "Optional monthly adjustment up or down",
                        values: cosAdjInputs,
                        onChange: (idx, v) => updateMonthArray(setCosAdjInputs, idx, v),
                        totalValue: computed.totals.cosAdj,
                        accentBg: "#F8FAFC",
                        borderColor: "#E2E8F0",
                      })}

                      <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #CBD5E1" }}>
                        <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#F8FAFC", padding: "8px 12px", fontWeight: 700, color: "#1E293B", borderRight: "1px solid #E2E8F0" }}>
                          Total costs of sale
                        </td>
                        {computed.cosTotal.map((val, idx) => (
                          <td key={idx} style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: "#1E293B" }}>
                            {formatMoney(val, currency)}
                          </td>
                        ))}
                        <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "#1E293B", borderLeft: "1px solid #CBD5E1" }}>
                          {formatMoney(computed.totals.cosTotal, currency)}
                        </td>
                      </tr>

                      <tr style={{ backgroundColor: "#ECFDF5", borderBottom: "2px solid #A7F3D0" }}>
                        <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#ECFDF5", padding: "9px 12px", fontWeight: 700, color: "#065F46", borderRight: "1px solid #E2E8F0" }}>
                          Gross profit
                        </td>
                        {computed.grossProfit.map((val, idx) => (
                          <td key={idx} style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700, color: val < 0 ? "#B91C1C" : "#065F46" }}>
                            {formatMoney(val, currency)}
                          </td>
                        ))}
                        <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, color: computed.totals.grossProfit < 0 ? "#B91C1C" : "#065F46", borderLeft: "1px solid #A7F3D0" }}>
                          {formatMoney(computed.totals.grossProfit, currency)}
                        </td>
                      </tr>
                    </>
                  )}

                  {/* OVERHEADS */}
                  <tr style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #F1F5F9" }}>
                    <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#FFFFFF", padding: "8px 12px", borderRight: "1px solid #E2E8F0" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedSections((p) => ({ ...p, overheads: !p.overheads }))}
                        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontWeight: 600, color: "#1E293B", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}
                      >
                        <span>{expandedSections.overheads ? "▾" : "▸"}</span>
                        <span>Overheads (imported + non-delivery dividends)</span>
                      </button>
                    </td>
                    {computed.months.map((_, idx) => {
                      const baseOhMonth =
                        (computed.baseNonCosStaff[idx] || 0) +
                        (computed.nonCosDiv[idx] || 0) +
                        (!computed.splitDelivery ? (computed.baseCosStaff[idx] || 0) + (computed.cosDiv[idx] || 0) : 0) +
                        (computed.baseOhOther[idx] || 0);
                      return (
                        <td key={idx} style={{ padding: "8px", textAlign: "right", color: "#334155" }}>
                          {formatMoney(baseOhMonth, currency)}
                        </td>
                      );
                    })}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#0F172A", borderLeft: "1px solid #E2E8F0" }}>
                      {formatMoney(computed.totals.overheadsTotal - computed.totals.ohAdj, currency)}
                    </td>
                  </tr>

                  {expandedSections.overheads && (
                    <>
                      {[...(data?.breakdown?.nonCosStaff || []), ...(data?.breakdown?.overheads || [])].map((line) => (
                        <tr key={`oh-${line.rowNum}`} style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #F1F5F9", color: "#64748B" }}>
                          <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#F8FAFC", padding: "5px 12px 5px 28px", borderRight: "1px solid #E2E8F0", fontSize: "11px" }}>
                            {line.label}
                          </td>
                          {line.monthly.map((v, idx) => (
                            <td key={idx} style={{ padding: "5px 8px", textAlign: "right", fontSize: "11px" }}>
                              {formatMoney(v, currency)}
                            </td>
                          ))}
                          <td style={{ padding: "5px 12px", textAlign: "right", fontSize: "11px", borderLeft: "1px solid #E2E8F0" }}>
                            {formatMoney(line.total, currency)}
                          </td>
                        </tr>
                      ))}
                      {computed.totals.nonCosDiv > 0 && (
                        <tr style={{ backgroundColor: "#FFFBEB", borderBottom: "1px solid #FDE68A", color: "#92400E" }}>
                          <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#FFFBEB", padding: "5px 12px 5px 28px", borderRight: "1px solid #E2E8F0", fontSize: "11px", fontWeight: 600 }}>
                            Dividends in lieu of salary ({round2(100 - (parseFloat(deliveryPct) || 0))}% non-delivery share)
                          </td>
                          {computed.nonCosDiv.map((v, idx) => (
                            <td key={idx} style={{ padding: "5px 8px", textAlign: "right", fontSize: "11px", fontWeight: 600 }}>
                              {formatMoney(v, currency)}
                            </td>
                          ))}
                          <td style={{ padding: "5px 12px", textAlign: "right", fontSize: "11px", fontWeight: 600, borderLeft: "1px solid #E2E8F0" }}>
                            {formatMoney(computed.totals.nonCosDiv, currency)}
                          </td>
                        </tr>
                      )}
                    </>
                  )}

                  {renderNumberInputRow({
                    label: "Overheads adjustment (+/-)",
                    subtitle: "Optional monthly adjustment up or down",
                    values: ohAdjInputs,
                    onChange: (idx, v) => updateMonthArray(setOhAdjInputs, idx, v),
                    totalValue: computed.totals.ohAdj,
                    accentBg: "#F8FAFC",
                    borderColor: "#E2E8F0",
                  })}

                  <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #CBD5E1" }}>
                    <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#F8FAFC", padding: "8px 12px", fontWeight: 700, color: "#1E293B", borderRight: "1px solid #E2E8F0" }}>
                      Total overheads
                    </td>
                    {computed.overheadsTotal.map((val, idx) => (
                      <td key={idx} style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: "#1E293B" }}>
                        {formatMoney(val, currency)}
                      </td>
                    ))}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "#1E293B", borderLeft: "1px solid #CBD5E1" }}>
                      {formatMoney(computed.totals.overheadsTotal, currency)}
                    </td>
                  </tr>

                  {/* OPERATING PROFIT */}
                  <tr style={{ backgroundColor: "#0F172A", color: "#FFFFFF" }}>
                    <td style={{ position: "sticky", left: 0, zIndex: 2, backgroundColor: "#0F172A", padding: "10px 12px", fontWeight: 700, borderRight: "1px solid #334155" }}>
                      Operating profit
                    </td>
                    {computed.operatingProfit.map((val, idx) => (
                      <td key={idx} style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: val < 0 ? "#FCA5A5" : "#6EE7B7" }}>
                        {formatMoney(val, currency)}
                      </td>
                    ))}
                    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: computed.totals.operatingProfit < 0 ? "#FCA5A5" : "#6EE7B7", borderLeft: "1px solid #334155" }}>
                      {formatMoney(computed.totals.operatingProfit, currency)}
                    </td>
                  </tr>

                  {/* DIVIDENDS IN LIEU OF SALARY ENTRY ROW */}
                  {renderNumberInputRow({
                    label: "Dividends in lieu of salary",
                    subtitle: "Allocated between delivery and non-delivery costs below",
                    values: dividendInputs,
                    onChange: (idx, v) => updateMonthArray(setDividendInputs, idx, v),
                    totalValue: computed.totals.dividends,
                    accentBg: "#FFFBEB",
                    borderColor: "#F59E0B",
                    leftExtra: (
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "2px" }}>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, color: "#92400E" }}>
                          <span>Delivery %</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="1"
                            value={deliveryPct}
                            onChange={(e) => setDeliveryPct(e.target.value)}
                            aria-label="Delivery percentage for dividends in lieu of salary"
                            style={{
                              width: "54px",
                              padding: "3px 5px",
                              fontSize: "12px",
                              borderRadius: "6px",
                              border: "1px solid #F59E0B",
                              backgroundColor: "#FFFFFF",
                              textAlign: "right",
                              fontWeight: 600,
                            }}
                          />
                        </label>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={applyAllDividendsVal}
                            onChange={(e) => setApplyAllDividendsVal(e.target.value)}
                            placeholder="All months"
                            aria-label="Dividends amount for all months"
                            style={{
                              width: "76px",
                              padding: "3px 6px",
                              fontSize: "11px",
                              borderRadius: "6px",
                              border: "1px solid #CBD5E1",
                              backgroundColor: "#FFFFFF",
                              textAlign: "right",
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleApplyAllDividends}
                            style={{
                              padding: "3px 8px",
                              fontSize: "11px",
                              fontWeight: 600,
                              borderRadius: "6px",
                              border: "1px solid #D97706",
                              backgroundColor: "#FEF3C7",
                              color: "#92400E",
                              cursor: "pointer",
                            }}
                          >
                            Apply to all
                          </button>
                        </div>
                      </div>
                    ),
                  })}
                </tbody>
              </table>
            </div>

            {/* Accounting Tool Dividend & Drawings Reference */}
            {data?.accountingTool && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "12px 16px",
                  borderRadius: "10px",
                  border: "1px solid #E2E8F0",
                  backgroundColor: "#F8FAFC",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#0F172A" }}>
                      Dividends &amp; director drawings detected in {data.accountingTool}
                    </div>
                    <div style={{ fontSize: "11.5px", color: "#64748B", marginTop: "2px" }}>
                      Extracted from equity dividend accounts and directors&apos; loan / drawings accounts over Year 0. Choose a source to populate above or enter manually.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleDetectDividends}
                    disabled={detectingDividends}
                    style={{
                      padding: "5px 11px",
                      borderRadius: "6px",
                      border: "1px solid #CBD5E1",
                      backgroundColor: "#FFFFFF",
                      color: "#334155",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: detectingDividends ? "wait" : "pointer",
                    }}
                  >
                    {detectingDividends ? "Checking..." : `Refresh from ${data.accountingTool}`}
                  </button>
                </div>

                {detectDividendsError && (
                  <div style={{ marginTop: "8px", fontSize: "11.5px", color: "#B91C1C" }}>
                    {detectDividendsError}
                  </div>
                )}

                {dividendHints?.candidates?.length === 0 && !detectingDividends && (
                  <div style={{ marginTop: "8px", fontSize: "12px", color: "#64748B" }}>
                    No equity dividend or directors&apos; loan accounts found in {data.accountingTool}.
                  </div>
                )}

                {dividendHints?.candidates?.length > 0 && (
                  <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    {dividendHints.candidates.map((cand) => {
                      const hasMovement = Math.abs(cand.annualTotal) >= 1;
                      return (
                        <div
                          key={cand.accountId}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "10px",
                            padding: "8px 12px",
                            borderRadius: "8px",
                            backgroundColor: "#FFFFFF",
                            border: "1px solid #E2E8F0",
                          }}
                        >
                          <div>
                            <div style={{ fontSize: "12px", fontWeight: 700, color: "#1E293B", display: "flex", alignItems: "center", gap: "8px" }}>
                              <span>{cand.code ? `${cand.code} · ${cand.name}` : cand.name}</span>
                              <span
                                style={{
                                  fontSize: "10.5px",
                                  fontWeight: 600,
                                  padding: "1px 7px",
                                  borderRadius: "999px",
                                  backgroundColor: cand.kind === "dividend" ? "#EFF6FF" : "#FEF3C7",
                                  color: cand.kind === "dividend" ? "#1D4ED8" : "#92400E",
                                }}
                              >
                                {cand.kind === "dividend" ? "Dividends account" : "Director loan / drawings"}
                              </span>
                            </div>
                            <div style={{ fontSize: "11.5px", color: "#475569", marginTop: "2px" }}>
                              Year 0 net movement: <strong>{formatMoney(cand.annualTotal, currency)}</strong>
                              {hasMovement ? ` (avg ${formatMoney(cand.monthlyAverage, currency)}/mo)` : " (no in-year movement recorded)"}
                            </div>
                          </div>

                          {hasMovement && (
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                              <button
                                type="button"
                                onClick={() => {
                                  setDividendInputs(
                                    cand.monthly.map((v) => {
                                      const clamped = round2(Math.max(0, v));
                                      return clamped > 0 ? String(clamped) : "";
                                    })
                                  );
                                }}
                                style={{
                                  padding: "5px 10px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  borderRadius: "6px",
                                  border: "1px solid #93C5FD",
                                  backgroundColor: "#EFF6FF",
                                  color: "#1D4ED8",
                                  cursor: "pointer",
                                }}
                              >
                                Use monthly figures
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const avg = round2(Math.max(0, cand.monthlyAverage));
                                  const str = avg > 0 ? String(avg) : "";
                                  setApplyAllDividendsVal(str);
                                  setDividendInputs(Array(12).fill(str));
                                }}
                                style={{
                                  padding: "5px 10px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  backgroundColor: "#F8FAFC",
                                  color: "#334155",
                                  cursor: "pointer",
                                }}
                              >
                                Use monthly average
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "12px", color: "#64748B" }}>
            {computed.totals.dividends > 0
              ? `Dividends split: ${formatMoney(computed.totals.cosDiv, currency)} delivery (${deliveryPct || 0}%) · ${formatMoney(computed.totals.nonCosDiv, currency)} non-delivery`
              : "Enter monthly dividends in lieu of salary or category adjustments above, then save."}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid #CBD5E1",
                backgroundColor: "#FFFFFF",
                color: "#334155",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || pulling}
              style={{
                padding: "8px 18px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#2563EB",
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: "13px",
                cursor: saving || loading || pulling ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving..." : "Save Year 0 setup"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
