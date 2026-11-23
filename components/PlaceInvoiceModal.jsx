import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import InvoiceCostMonthControl from "./InvoiceCostMonthControl";
import { extractSplitMonths } from "../services/splitHelper";
import { isPlaceholderInvoice, isDraftInvoice } from "../utils/helpers";

const parseMoney = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[£$€,\s]/g, ""));
  return isNaN(n) ? 0 : n;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const fmtGBP = (n) =>
  "£" + (Number(n) || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Unified invoice placement confirmation modal used across PMA > Alerts and PMA > Invoices.
 * Supports synced line-item breakdown selection, "of which recharged" + cost month allocation,
 * billable budget overrun prompts, and client/job name mismatch resolution.
 */
export default function PlaceInvoiceModal({
  isOpen,
  onClose,
  onConfirm,
  isSaving = false,
  error = "",
  job,
  invoice,
  targetRowNum = null,
  targetSlotNum = null,
  slot = null,
  slotLabel = "",
  isRetainer = false,
  monthLabel = "",
  createNewRow = false,
  isAdmin = false,
  allowJobNameEdit = false,
}) {
  const lineItems = useMemo(
    () => (Array.isArray(invoice?.lineItems) ? invoice.lineItems : []),
    [invoice]
  );

  const invoiceAmount = useMemo(() => round2(parseMoney(invoice?.amount)), [invoice?.amount]);
  const detectedRecharged = useMemo(
    () => round2(parseMoney(invoice?.detectedRechargedAmount ?? invoice?.rechargedAmount)),
    [invoice?.detectedRechargedAmount, invoice?.rechargedAmount]
  );

  const jobFeeRevenue = useMemo(
    () => round2(parseMoney(job?.rows?.[0]?.revenue ?? job?.revenue)),
    [job]
  );
  const jobRecharged = useMemo(
    () => round2(parseMoney(job?.rows?.[0]?.rechargedExpenses ?? job?.rechargedExpenses)),
    [job]
  );
  const jobBillable = useMemo(() => round2(jobFeeRevenue + jobRecharged), [jobFeeRevenue, jobRecharged]);

  const { currentRealInvoiced, otherNonAutoRechgd } = useMemo(() => {
    let realInv = 0;
    let otherRech = 0;
    const rows = Array.isArray(job?.rows) ? job.rows : [];
    for (const r of rows) {
      for (const sl of r.invoiceSlots || []) {
        const isTargetSlot =
          !createNewRow &&
          targetRowNum != null &&
          targetSlotNum != null &&
          Number(r.rowNum) === Number(targetRowNum) &&
          Number(sl.slotNum) === Number(targetSlotNum);
        if (isTargetSlot) continue;

        const refStr = String(sl.ref || "").trim();
        const amt = parseMoney(sl.amount);
        const rech = parseMoney(sl.ofWhichRechgd);
        if (refStr && !isPlaceholderInvoice(refStr, sl.status) && !isDraftInvoice(refStr, sl.status)) {
          realInv += amt;
        }
        const isAuto = refStr.toUpperCase().startsWith("PLACE-INV-");
        if (!isAuto && (refStr || Math.abs(amt) >= 0.005 || Math.abs(rech) >= 0.005)) {
          otherRech += rech;
        }
      }
    }
    return {
      currentRealInvoiced: round2(realInv),
      otherNonAutoRechgd: round2(otherRech),
    };
  }, [job, createNewRow, targetRowNum, targetSlotNum]);

  const unallocatedJobRecharged = useMemo(
    () => Math.max(0, round2(jobRecharged - otherNonAutoRechgd)),
    [jobRecharged, otherNonAutoRechgd]
  );

  const projectedTotalInvoiced = useMemo(
    () => round2(currentRealInvoiced + invoiceAmount),
    [currentRealInvoiced, invoiceAmount]
  );
  const initialExcessOverBillable = useMemo(
    () => round2(projectedTotalInvoiced - jobBillable),
    [projectedTotalInvoiced, jobBillable]
  );

  const sheetClientName = String(job?.client || "").trim();
  const invoiceClientName = String(invoice?.client || "").trim();
  const hasClientMismatch = Boolean(
    sheetClientName && invoiceClientName && sheetClientName.toLowerCase() !== invoiceClientName.toLowerCase()
  );

  const [selectedLineIndices, setSelectedLineIndices] = useState(() => new Set());
  const [hasRechargedExpenses, setHasRechargedExpenses] = useState(false);
  const [ofWhichRechgd, setOfWhichRechgd] = useState("");
  const [costMonth, setCostMonth] = useState("");
  const [excessChoice, setExcessChoice] = useState("increase_revenue");
  const [rechargedUpdateMode, setRechargedUpdateMode] = useState("increase_recharged");
  const [remainingExcessChoice, setRemainingExcessChoice] = useState("increase_revenue");
  const [updateClientName, setUpdateClientName] = useState(hasClientMismatch);
  const [updateJobName, setUpdateJobName] = useState(false);
  const [newJobName, setNewJobName] = useState(String(job?.jobName || ""));
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const initSet = new Set();
    let lineSum = 0;
    lineItems.forEach((li, idx) => {
      if (li.isRecharged) {
        initSet.add(idx);
        if ((Number(li.amountGbp) || 0) > 0) lineSum += Number(li.amountGbp) || 0;
      }
    });
    const rawInitRech =
      initSet.size > 0
        ? Math.min(round2(lineSum), invoiceAmount)
        : detectedRecharged > 0
          ? Math.min(detectedRecharged, invoiceAmount)
          : 0;
    const initRech = round2(rawInitRech);

    setSelectedLineIndices(initSet);
    setHasRechargedExpenses(initRech > 0.005);
    setOfWhichRechgd(initRech > 0.005 ? initRech.toFixed(2) : "");
    setCostMonth("");
    setExcessChoice("increase_revenue");
    setRechargedUpdateMode("increase_recharged");
    setRemainingExcessChoice("increase_revenue");
    setUpdateClientName(hasClientMismatch);
    setUpdateJobName(false);
    setNewJobName(String(invoice?.job || job?.jobName || ""));
    setValidationError("");
  }, [isOpen, invoice?.invoiceNo, job?.jobName, job?.client, lineItems, detectedRecharged, invoiceAmount, hasClientMismatch, invoice?.job]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !isSaving) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen || !job || !invoice) return null;

  const ofWhichNum = hasRechargedExpenses ? Math.max(0, round2(parseMoney(ofWhichRechgd))) : 0;
  const totalNonAutoRechgd = round2(otherNonAutoRechgd + ofWhichNum);
  const rechargedNeedsIncrease = ofWhichNum > 0.005 && totalNonAutoRechgd > jobRecharged + 0.01;
  const deltaRech = round2(totalNonAutoRechgd - jobRecharged);
  const canReclassifyFee =
    rechargedNeedsIncrease &&
    deltaRech > 0.005 &&
    jobFeeRevenue >= deltaRech &&
    projectedTotalInvoiced <= jobBillable + 0.01;

  const effectiveJobFee =
    rechargedNeedsIncrease && rechargedUpdateMode === "reclassify_fee" && canReclassifyFee
      ? round2(jobFeeRevenue - deltaRech)
      : jobFeeRevenue;
  const effectiveJobRecharged =
    rechargedNeedsIncrease && rechargedUpdateMode !== "keep_recharged"
      ? totalNonAutoRechgd
      : jobRecharged;
  const effectiveBillable = round2(effectiveJobFee + effectiveJobRecharged);

  const hasInitialExcessWithoutRecharged =
    ofWhichNum <= 0.005 && jobBillable > 0 && projectedTotalInvoiced > jobBillable + 0.01;
  const hasRemainingExcessWithRecharged =
    ofWhichNum > 0.005 && jobBillable > 0 && projectedTotalInvoiced > effectiveBillable + 0.01;
  const remainingExcessAmt = Math.max(0, round2(projectedTotalInvoiced - effectiveBillable));
  const newFeeAfterRemainingExcess = round2(effectiveJobFee + remainingExcessAmt);

  const handleToggleLineItem = (idx) => {
    const next = new Set(selectedLineIndices);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedLineIndices(next);

    let sum = 0;
    next.forEach((i) => {
      const amt = Number(lineItems[i]?.amountGbp) || 0;
      if (amt > 0) sum += amt;
    });
    const clamped = Math.min(round2(sum), invoiceAmount);
    setHasRechargedExpenses(clamped > 0.005);
    setOfWhichRechgd(clamped > 0.005 ? clamped.toFixed(2) : "");
    setValidationError("");
  };

  const handleSelectTreatExcessAsRecharged = () => {
    const excess = Math.min(Math.max(0, initialExcessOverBillable), invoiceAmount);
    setExcessChoice("treat_as_recharged");
    setHasRechargedExpenses(excess > 0.005);
    setOfWhichRechgd(excess > 0.005 ? excess.toFixed(2) : "");
    setRechargedUpdateMode("increase_recharged");
    setValidationError("");
  };

  const handleConfirmClick = () => {
    setValidationError("");

    if (ofWhichNum > invoiceAmount + 0.01) {
      setValidationError(`Of which recharged (${fmtGBP(ofWhichNum)}) cannot exceed the invoice amount (${fmtGBP(invoiceAmount)}).`);
      return;
    }

    if (ofWhichNum > 0.005 && String(costMonth || "").trim().toLowerCase().startsWith("[split]")) {
      const entries = extractSplitMonths(costMonth);
      const splitSum = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      if (Math.abs(splitSum - ofWhichNum) > 0.02) {
        setValidationError(`Split cost months (${fmtGBP(splitSum)}) must equal the invoice recharged amount (${fmtGBP(ofWhichNum)}).`);
        return;
      }
    }

    if (allowJobNameEdit && updateJobName && !String(newJobName || "").trim()) {
      setValidationError("Please enter a job name or untick the option to update it.");
      return;
    }

    let updateJobRecharged = false;
    let newJobRecharged = undefined;
    let updateJobRevenue = false;
    let newJobRevenue = undefined;

    if (ofWhichNum <= 0.005) {
      if (hasInitialExcessWithoutRecharged && excessChoice === "increase_revenue") {
        updateJobRevenue = true;
        newJobRevenue = projectedTotalInvoiced;
      }
    } else {
      if (rechargedNeedsIncrease && rechargedUpdateMode !== "keep_recharged") {
        updateJobRecharged = true;
        newJobRecharged = totalNonAutoRechgd;
      }

      let targetFee = jobFeeRevenue;
      let feeChanged = false;
      if (hasRemainingExcessWithRecharged && remainingExcessChoice === "increase_revenue") {
        targetFee = newFeeAfterRemainingExcess;
        feeChanged = true;
      } else if (rechargedNeedsIncrease && rechargedUpdateMode === "reclassify_fee" && canReclassifyFee) {
        targetFee = effectiveJobFee;
        feeChanged = true;
      }

      if (feeChanged) {
        updateJobRevenue = true;
        // Backend handlers subtract Col R (rechargedExp) from newJobRevenue before writing pure fee revenue
        newJobRevenue = round2(targetFee + effectiveJobRecharged);
      }
    }

    onConfirm?.({
      ofWhichRechgd: ofWhichNum > 0.005 ? ofWhichNum : "",
      costMonth: ofWhichNum > 0.005 ? String(costMonth || "").trim() : "",
      updateJobRecharged,
      newJobRecharged,
      updateJobRevenue,
      newJobRevenue,
      updateClientName: Boolean(hasClientMismatch && updateClientName),
      newClientName: hasClientMismatch && updateClientName ? invoiceClientName : undefined,
      updateJobName: Boolean(allowJobNameEdit && updateJobName && String(newJobName || "").trim()),
      newJobName: allowJobNameEdit && updateJobName ? String(newJobName || "").trim() : undefined,
    });
  };

  const displayTargetMonth =
    isRetainer &&
    (monthLabel || slotLabel) &&
    !isPlaceholderInvoice(monthLabel || slotLabel) &&
    !String(monthLabel || slotLabel).toLowerCase().includes("invoice") &&
    !String(monthLabel || slotLabel).toLowerCase().includes("entry") &&
    !String(monthLabel || slotLabel).toLowerCase().includes("placeholder")
      ? monthLabel || slotLabel
      : "";

  const isReplacingRealSlot = Boolean(
    slot &&
      (slot.ref || (slot.amount && parseMoney(slot.amount) > 0)) &&
      !isPlaceholderInvoice(slot.ref, slot.status)
  );

  const displayedError = validationError || error;

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
        zIndex: 2200,
        padding: "20px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose?.();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(94vw, 560px)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "22px 24px",
          boxShadow: "0 25px 60px rgba(0,0,0,0.3)",
          border: "1px solid #e2e8f0",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
              Place invoice on job
            </h3>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
              Confirm placement details and any revenue or recharged expense updates.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !isSaving && onClose?.()}
            disabled={isSaving}
            style={{ background: "none", border: "none", fontSize: "22px", lineHeight: 1, cursor: isSaving ? "default" : "pointer", color: "#94a3b8" }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Target job + invoice summary */}
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px", fontSize: "13px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div>
              <span style={{ color: "#64748b" }}>Target job: </span>
              <strong style={{ color: "#0f172a" }}>{job.jobName}</strong>
              {sheetClientName && <span style={{ color: "#64748b" }}> ({sheetClientName})</span>}
            </div>

            {displayTargetMonth && (
              <div>
                <span style={{ color: "#64748b" }}>Target month: </span>
                <span style={{ display: "inline-block", background: "#f0fdf4", border: "1px solid #86efac", padding: "1px 8px", borderRadius: "4px", fontWeight: "600", color: "#166534", fontSize: "12px" }}>
                  {displayTargetMonth}
                </span>
              </div>
            )}

            {isReplacingRealSlot && (
              <div style={{ padding: "6px 10px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", fontSize: "12px", color: "#92400e" }}>
                <strong>Notice:</strong> This entry currently holds invoice #{slot.ref || "(no number)"} ({fmtGBP(parseMoney(slot.amount))}). Confirming will overwrite it.
              </div>
            )}

            <div style={{ height: "1px", background: "#e2e8f0", margin: "4px 0" }} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              <div>
                <span style={{ color: "#64748b", fontSize: "12px" }}>Invoice number</span>
                <div style={{ fontWeight: "700", color: "#0f172a" }}>#{invoice.invoiceNo || "N/A"}</div>
              </div>
              <div>
                <span style={{ color: "#64748b", fontSize: "12px" }}>Amount (excl. VAT)</span>
                <div style={{ fontWeight: "700", color: "#16a34a" }}>{fmtGBP(invoiceAmount)}</div>
              </div>
              <div>
                <span style={{ color: "#64748b", fontSize: "12px" }}>Sent date</span>
                <div style={{ fontWeight: "500", color: "#334155" }}>{invoice.sentDate || "Not recorded"}</div>
              </div>
              <div>
                <span style={{ color: "#64748b", fontSize: "12px" }}>Status</span>
                <div style={{ fontWeight: "500", color: "#334155" }}>{invoice.status || "Sent"}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Client / job name mismatch */}
        {hasClientMismatch && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "10px 12px", marginBottom: "14px", fontSize: "12.5px", color: "#1e3a8a" }}>
            <div style={{ fontWeight: "600", marginBottom: "6px" }}>
              Client name differs ({sheetClientName} vs {invoiceClientName})
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={updateClientName}
                onChange={(e) => setUpdateClientName(e.target.checked)}
                style={{ marginTop: "2px", accentColor: "#2563eb", cursor: "pointer" }}
              />
              <span>
                Update job client name from <strong>&ldquo;{sheetClientName}&rdquo;</strong> to <strong>&ldquo;{invoiceClientName}&rdquo;</strong>
              </span>
            </label>
            {allowJobNameEdit && (
              <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #dbeafe" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontWeight: "600" }}>
                  <input
                    type="checkbox"
                    checked={updateJobName}
                    onChange={(e) => setUpdateJobName(e.target.checked)}
                    style={{ accentColor: "#2563eb", cursor: "pointer" }}
                  />
                  <span>Also update job name</span>
                </label>
                {updateJobName && (
                  <input
                    type="text"
                    value={newJobName}
                    onChange={(e) => setNewJobName(e.target.value)}
                    placeholder="Enter new job name"
                    style={{
                      marginTop: "6px",
                      width: "100%",
                      padding: "7px 10px",
                      border: "1px solid #93c5fd",
                      borderRadius: "6px",
                      fontSize: "13px",
                      boxSizing: "border-box",
                      backgroundColor: "#ffffff",
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {/* Synced invoice line items (when available from accounting sync) */}
        {lineItems.length > 0 && (
          <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a" }}>
                Invoice line items (tick any recharged expenses)
              </span>
              <span style={{ fontSize: "11px", color: "#64748b" }}>
                {lineItems.length} {lineItems.length === 1 ? "line" : "lines"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "170px", overflowY: "auto" }}>
              {lineItems.map((li, idx) => {
                const isChecked = selectedLineIndices.has(idx);
                const matchesExcess =
                  !li.isRecharged &&
                  initialExcessOverBillable > 0.01 &&
                  Math.abs((Number(li.amountGbp) || 0) - initialExcessOverBillable) <= 0.02;
                return (
                  <label
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "10px",
                      padding: "6px 8px",
                      borderRadius: "6px",
                      background: isChecked ? "#eff6ff" : "#ffffff",
                      border: `1px solid ${isChecked ? "#93c5fd" : matchesExcess ? "#fcd34d" : "#e2e8f0"}`,
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", minWidth: 0 }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleLineItem(idx)}
                        style={{ marginTop: "2px", accentColor: "#2563eb", cursor: "pointer" }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: "600", color: "#0f172a", wordBreak: "break-word" }}>
                          {li.description || "(No description)"}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "2px", alignItems: "center" }}>
                          {(li.accountName || li.accountCode) && (
                            <span style={{ fontSize: "11px", color: "#64748b" }}>
                              {li.accountCode ? `${li.accountCode} · ` : ""}{li.accountName}
                            </span>
                          )}
                          {li.isRecharged && (
                            <span style={{ fontSize: "10px", fontWeight: "600", background: "#dbeafe", color: "#1d4ed8", padding: "1px 6px", borderRadius: "10px" }}>
                              Auto-detected
                            </span>
                          )}
                          {matchesExcess && (
                            <span style={{ fontSize: "10px", fontWeight: "600", background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: "10px" }}>
                              Matches excess
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <strong style={{ color: "#0f172a", whiteSpace: "nowrap" }}>
                      {fmtGBP(li.amountGbp)}
                    </strong>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Recharged expenses toggle & amount */}
        <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12.5px", fontWeight: "600", color: "#0f172a", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={hasRechargedExpenses}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHasRechargedExpenses(checked);
                  if (!checked) {
                    setOfWhichRechgd("");
                    setCostMonth("");
                    setSelectedLineIndices(new Set());
                    if (excessChoice === "treat_as_recharged") setExcessChoice("increase_revenue");
                  } else if (!ofWhichRechgd && detectedRecharged > 0) {
                    setOfWhichRechgd(Math.min(detectedRecharged, invoiceAmount).toFixed(2));
                  }
                  setValidationError("");
                }}
                style={{ accentColor: "#2563eb", cursor: "pointer" }}
              />
              <span>Includes recharged expenses?</span>
            </label>

            {!hasRechargedExpenses && unallocatedJobRecharged > 0.01 && (
              <button
                type="button"
                onClick={() => {
                  const fill = Math.min(unallocatedJobRecharged, invoiceAmount);
                  setHasRechargedExpenses(true);
                  setOfWhichRechgd(fill.toFixed(2));
                  setValidationError("");
                }}
                style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  border: "1px solid #93c5fd",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  cursor: "pointer",
                }}
              >
                Allocate {fmtGBP(Math.min(unallocatedJobRecharged, invoiceAmount))} unallocated job recharged
              </button>
            )}
          </div>

          {hasRechargedExpenses && (
            <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div>
                <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "4px" }}>
                  Of which recharged (excl. VAT{isAdmin ? ", col R & invoice" : ""})
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={ofWhichRechgd}
                  onChange={(e) => {
                    setOfWhichRechgd(e.target.value);
                    setValidationError("");
                  }}
                  style={{
                    width: "100%",
                    padding: "7px 10px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    boxSizing: "border-box",
                    backgroundColor: "#ffffff",
                  }}
                />
              </div>

              {ofWhichNum > 0.005 && (
                <InvoiceCostMonthControl
                  value={costMonth}
                  onChange={setCostMonth}
                  totalAmount={ofWhichNum}
                  invoiceSentDate={invoice.sentDate || ""}
                  jobStartDate={job?.rows?.[0]?.startDate || job?.startDate || ""}
                  compact={true}
                />
              )}
            </div>
          )}
        </div>

        {/* Scenario A: Exceeds job billable budget and no recharged amount specified yet */}
        {hasInitialExcessWithoutRecharged && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px", fontSize: "12.5px" }}>
            <div style={{ fontWeight: "700", color: "#1e3a8a", marginBottom: "6px" }}>
              Total invoiced exceeds job {jobRecharged > 0 ? "billable budget" : "revenue"}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px", color: "#475569" }}>
              <span>Current {jobRecharged > 0 ? "billable budget" : "revenue"}:</span>
              <strong style={{ color: "#0f172a" }}>{fmtGBP(jobBillable)}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px", color: "#1d4ed8" }}>
              <span>Projected total invoiced:</span>
              <strong>
                {fmtGBP(projectedTotalInvoiced)} (+{fmtGBP(initialExcessOverBillable)})
              </strong>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#0f172a" }}>
                <input
                  type="radio"
                  name="place_inv_excess"
                  checked={excessChoice === "increase_revenue"}
                  onChange={() => setExcessChoice("increase_revenue")}
                  style={{ accentColor: "#2563eb" }}
                />
                <span>
                  Increase job {jobRecharged > 0 ? "fee revenue" : "revenue"} to{" "}
                  <strong>{fmtGBP(round2(jobFeeRevenue + initialExcessOverBillable))}</strong>
                </span>
              </label>

              {initialExcessOverBillable <= invoiceAmount + 0.01 && (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#0f172a" }}>
                  <input
                    type="radio"
                    name="place_inv_excess"
                    checked={excessChoice === "treat_as_recharged"}
                    onChange={handleSelectTreatExcessAsRecharged}
                    style={{ accentColor: "#2563eb" }}
                  />
                  <span>
                    Treat <strong>{fmtGBP(initialExcessOverBillable)}</strong> excess as recharged expenses
                  </span>
                </label>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#475569" }}>
                <input
                  type="radio"
                  name="place_inv_excess"
                  checked={excessChoice === "keep_unchanged"}
                  onChange={() => setExcessChoice("keep_unchanged")}
                  style={{ accentColor: "#2563eb" }}
                />
                <span>Keep job revenue as {fmtGBP(jobFeeRevenue)}</span>
              </label>
            </div>
          </div>
        )}

        {/* Scenario B: Recharged amount entered — job recharged / remaining revenue updates */}
        {ofWhichNum > 0.005 && (rechargedNeedsIncrease || hasRemainingExcessWithRecharged) && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px", fontSize: "12.5px" }}>
            {rechargedNeedsIncrease && (
              <div style={{ marginBottom: hasRemainingExcessWithRecharged ? "10px" : 0 }}>
                <div style={{ fontWeight: "700", color: "#1e3a8a", marginBottom: "6px" }}>
                  Update job recharged expenses?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#0f172a" }}>
                    <input
                      type="radio"
                      name="place_inv_rech_mode"
                      checked={rechargedUpdateMode === "increase_recharged"}
                      onChange={() => setRechargedUpdateMode("increase_recharged")}
                      style={{ accentColor: "#2563eb" }}
                    />
                    <span>
                      Increase job recharged expenses from {fmtGBP(jobRecharged)} to{" "}
                      <strong>{fmtGBP(totalNonAutoRechgd)}</strong>
                    </span>
                  </label>

                  {canReclassifyFee && (
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#0f172a" }}>
                      <input
                        type="radio"
                        name="place_inv_rech_mode"
                        checked={rechargedUpdateMode === "reclassify_fee"}
                        onChange={() => setRechargedUpdateMode("reclassify_fee")}
                        style={{ accentColor: "#2563eb" }}
                      />
                      <span>
                        Reclassify {fmtGBP(deltaRech)} from fee revenue to recharged expenses (keeps billable budget at{" "}
                        <strong>{fmtGBP(jobBillable)}</strong>)
                      </span>
                    </label>
                  )}

                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#475569" }}>
                    <input
                      type="radio"
                      name="place_inv_rech_mode"
                      checked={rechargedUpdateMode === "keep_recharged"}
                      onChange={() => setRechargedUpdateMode("keep_recharged")}
                      style={{ accentColor: "#2563eb" }}
                    />
                    <span>Keep job recharged expenses as {fmtGBP(jobRecharged)}</span>
                  </label>
                </div>
              </div>
            )}

            {hasRemainingExcessWithRecharged && (
              <div style={rechargedNeedsIncrease ? { paddingTop: "10px", borderTop: "1px solid #bfdbfe" } : undefined}>
                <div style={{ fontWeight: "700", color: "#1e3a8a", marginBottom: "6px" }}>
                  Remaining excess over billable budget (+{fmtGBP(remainingExcessAmt)})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#0f172a" }}>
                    <input
                      type="radio"
                      name="place_inv_rem_excess"
                      checked={remainingExcessChoice === "increase_revenue"}
                      onChange={() => setRemainingExcessChoice("increase_revenue")}
                      style={{ accentColor: "#2563eb" }}
                    />
                    <span>
                      Increase job fee revenue from {fmtGBP(effectiveJobFee)} to{" "}
                      <strong>{fmtGBP(newFeeAfterRemainingExcess)}</strong>
                    </span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#475569" }}>
                    <input
                      type="radio"
                      name="place_inv_rem_excess"
                      checked={remainingExcessChoice === "keep_unchanged"}
                      onChange={() => setRemainingExcessChoice("keep_unchanged")}
                      style={{ accentColor: "#2563eb" }}
                    />
                    <span>Keep job fee revenue as {fmtGBP(effectiveJobFee)}</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {displayedError && (
          <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#dc2626", fontSize: "12.5px" }}>
            {displayedError}
          </div>
        )}

        {/* Footer actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "4px" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#475569",
              fontSize: "13px",
              fontWeight: "600",
              cursor: isSaving ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmClick}
            disabled={isSaving}
            style={{
              padding: "8px 18px",
              borderRadius: "6px",
              border: "1px solid #15803d",
              background: "#16a34a",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: "600",
              cursor: isSaving ? "default" : "pointer",
              opacity: isSaving ? 0.7 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {isSaving ? (
              <>
                <Spinner size={12} color="#ffffff" />
                <span>Placing...</span>
              </>
            ) : (
              "Confirm and place"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
