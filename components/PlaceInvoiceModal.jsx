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
 * Supports single or multiple invoices, synced line-item breakdown (info-only by default,
 * interactive when "Includes recharged expenses?" is checked), "of which recharged" + cost month
 * allocation, billable budget overrun prompts, and client/job name mismatch resolution.
 */
export default function PlaceInvoiceModal({
  isOpen,
  onClose,
  onConfirm,
  isSaving = false,
  error = "",
  job,
  invoice,
  invoices = null,
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
  const invoiceList = useMemo(
    () => (Array.isArray(invoices) && invoices.length > 0 ? invoices : invoice ? [invoice] : []),
    [invoices, invoice]
  );
  const isMulti = invoiceList.length > 1;

  const getInvKey = (inv, idx) => `${String(inv?.invoiceNo || "").trim()}__${idx}`;

  const invoiceAmount = useMemo(
    () => round2(invoiceList.reduce((sum, inv) => sum + parseMoney(inv?.amount), 0)),
    [invoiceList]
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
          !isMulti &&
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
  }, [job, isMulti, createNewRow, targetRowNum, targetSlotNum]);

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
  const mismatchInv = useMemo(
    () =>
      invoiceList.find((inv) => {
        const c = String(inv?.client || "").trim();
        return Boolean(sheetClientName && c && sheetClientName.toLowerCase() !== c.toLowerCase());
      }) || null,
    [invoiceList, sheetClientName]
  );
  const invoiceClientName = String(mismatchInv?.client || invoiceList[0]?.client || "").trim();
  const hasClientMismatch = Boolean(mismatchInv);

  const [perInvoiceRech, setPerInvoiceRech] = useState(() => ({}));
  const [excessChoice, setExcessChoice] = useState("increase_revenue");
  const [rechargedUpdateMode, setRechargedUpdateMode] = useState("increase_recharged");
  const [remainingExcessChoice, setRemainingExcessChoice] = useState("increase_revenue");
  const [updateClientName, setUpdateClientName] = useState(hasClientMismatch);
  const [updateJobName, setUpdateJobName] = useState(false);
  const [newJobName, setNewJobName] = useState(String(job?.jobName || ""));
  const [validationError, setValidationError] = useState("");

  const invoiceInitKey = useMemo(
    () => invoiceList.map((inv, idx) => `${inv?.invoiceNo || ""}:${inv?.amount || ""}:${idx}`).join("|"),
    [invoiceList]
  );

  useEffect(() => {
    if (!isOpen) return;
    const initMap = {};
    invoiceList.forEach((inv, idx) => {
      const key = getInvKey(inv, idx);
      const invLineItems = Array.isArray(inv?.lineItems) ? inv.lineItems : [];
      const invAmt = round2(parseMoney(inv?.amount));
      const invDetected = round2(parseMoney(inv?.detectedRechargedAmount ?? inv?.rechargedAmount));
      const initSet = new Set();
      let lineSum = 0;
      invLineItems.forEach((li, liIdx) => {
        if (li.isRecharged) {
          initSet.add(liIdx);
          if ((Number(li.amountGbp) || 0) > 0) lineSum += Number(li.amountGbp) || 0;
        }
      });
      const rawInitRech =
        initSet.size > 0
          ? Math.min(round2(lineSum), invAmt)
          : invDetected > 0
            ? Math.min(invDetected, invAmt)
            : 0;
      const initRech = round2(rawInitRech);
      initMap[key] = {
        selectedLineIndices: initSet,
        hasRechargedExpenses: initRech > 0.005,
        ofWhichRechgd: initRech > 0.005 ? initRech.toFixed(2) : "",
        costMonth: "",
      };
    });

    setPerInvoiceRech(initMap);
    setExcessChoice("increase_revenue");
    setRechargedUpdateMode("increase_recharged");
    setRemainingExcessChoice("increase_revenue");
    setUpdateClientName(hasClientMismatch);
    setUpdateJobName(false);
    setNewJobName(String(invoiceList[0]?.job || job?.jobName || ""));
    setValidationError("");
  }, [isOpen, invoiceInitKey, job?.jobName, job?.client, hasClientMismatch, invoiceList]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !isSaving) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen || !job || invoiceList.length === 0) return null;

  const getInvState = (inv, idx) => {
    const key = getInvKey(inv, idx);
    return (
      perInvoiceRech[key] || {
        selectedLineIndices: new Set(),
        hasRechargedExpenses: false,
        ofWhichRechgd: "",
        costMonth: "",
      }
    );
  };

  const updateInvState = (inv, idx, updater) => {
    const key = getInvKey(inv, idx);
    setPerInvoiceRech((prev) => {
      const current = prev[key] || {
        selectedLineIndices: new Set(),
        hasRechargedExpenses: false,
        ofWhichRechgd: "",
        costMonth: "",
      };
      const nextVal = typeof updater === "function" ? updater(current) : { ...current, ...updater };
      return { ...prev, [key]: nextVal };
    });
  };

  const ofWhichNum = round2(
    invoiceList.reduce((sum, inv, idx) => {
      const st = getInvState(inv, idx);
      if (!st.hasRechargedExpenses) return sum;
      return sum + Math.max(0, round2(parseMoney(st.ofWhichRechgd)));
    }, 0)
  );
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

  const handleToggleLineItem = (inv, invIdx, lineIdx) => {
    const invLineItems = Array.isArray(inv?.lineItems) ? inv.lineItems : [];
    const invAmt = round2(parseMoney(inv?.amount));
    updateInvState(inv, invIdx, (cur) => {
      if (!cur.hasRechargedExpenses) return cur;
      const nextSet = new Set(cur.selectedLineIndices);
      if (nextSet.has(lineIdx)) nextSet.delete(lineIdx);
      else nextSet.add(lineIdx);

      let sum = 0;
      nextSet.forEach((i) => {
        const amt = Number(invLineItems[i]?.amountGbp) || 0;
        if (amt > 0) sum += amt;
      });
      const clamped = Math.min(round2(sum), invAmt);
      return {
        ...cur,
        selectedLineIndices: nextSet,
        ofWhichRechgd: clamped > 0.005 ? clamped.toFixed(2) : "",
      };
    });
    setValidationError("");
  };

  const handleSelectTreatExcessAsRecharged = () => {
    if (isMulti) return;
    const primaryInv = invoiceList[0];
    const primaryAmt = round2(parseMoney(primaryInv?.amount));
    const excess = Math.min(Math.max(0, initialExcessOverBillable), primaryAmt);
    setExcessChoice("treat_as_recharged");
    updateInvState(primaryInv, 0, (cur) => ({
      ...cur,
      hasRechargedExpenses: excess > 0.005,
      ofWhichRechgd: excess > 0.005 ? excess.toFixed(2) : "",
    }));
    setRechargedUpdateMode("increase_recharged");
    setValidationError("");
  };

  const handleConfirmClick = () => {
    setValidationError("");

    for (let idx = 0; idx < invoiceList.length; idx++) {
      const inv = invoiceList[idx];
      const st = getInvState(inv, idx);
      const invAmt = round2(parseMoney(inv?.amount));
      const invRechNum = st.hasRechargedExpenses ? Math.max(0, round2(parseMoney(st.ofWhichRechgd))) : 0;
      const label = inv?.invoiceNo ? `#${inv.invoiceNo}` : `invoice ${idx + 1}`;

      if (invRechNum > invAmt + 0.01) {
        setValidationError(`Of which recharged for ${label} (${fmtGBP(invRechNum)}) cannot exceed the invoice amount (${fmtGBP(invAmt)}).`);
        return;
      }

      if (invRechNum > 0.005 && String(st.costMonth || "").trim().toLowerCase().startsWith("[split]")) {
        const entries = extractSplitMonths(st.costMonth);
        const splitSum = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        if (Math.abs(splitSum - invRechNum) > 0.02) {
          setValidationError(`Split cost months for ${label} (${fmtGBP(splitSum)}) must equal the invoice recharged amount (${fmtGBP(invRechNum)}).`);
          return;
        }
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

    const invoiceConfigs = invoiceList.map((inv, idx) => {
      const st = getInvState(inv, idx);
      const invRechNum = st.hasRechargedExpenses ? Math.max(0, round2(parseMoney(st.ofWhichRechgd))) : 0;
      return {
        invoiceNo: inv?.invoiceNo || "",
        ofWhichRechgd: invRechNum > 0.005 ? invRechNum : "",
        costMonth: invRechNum > 0.005 ? String(st.costMonth || "").trim() : "",
      };
    });

    const primaryConfig = invoiceConfigs[0] || { ofWhichRechgd: "", costMonth: "" };

    onConfirm?.({
      ofWhichRechgd: primaryConfig.ofWhichRechgd,
      costMonth: primaryConfig.costMonth,
      invoiceConfigs,
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
    !isMulti &&
      slot &&
      (slot.ref || (slot.amount && parseMoney(slot.amount) > 0)) &&
      !isPlaceholderInvoice(slot.ref, slot.status)
  );

  const displayedError = validationError || error;

  const renderInvoiceRechargedSection = (inv, invIdx, showTopSummary = false) => {
    const invLineItems = Array.isArray(inv?.lineItems) ? inv.lineItems : [];
    const invAmt = round2(parseMoney(inv?.amount));
    const invDetectedRech = round2(parseMoney(inv?.detectedRechargedAmount ?? inv?.rechargedAmount));
    const st = getInvState(inv, invIdx);
    const invOfWhichNum = st.hasRechargedExpenses ? Math.max(0, round2(parseMoney(st.ofWhichRechgd))) : 0;
    const allocatedElsewhere = invoiceList.reduce((sum, otherInv, oIdx) => {
      if (oIdx === invIdx) return sum;
      const oSt = getInvState(otherInv, oIdx);
      return sum + (oSt.hasRechargedExpenses ? Math.max(0, round2(parseMoney(oSt.ofWhichRechgd))) : 0);
    }, 0);
    const remainingUnallocatedForThisInv = Math.max(0, round2(unallocatedJobRecharged - allocatedElsewhere));

    return (
      <div
        key={getInvKey(inv, invIdx)}
        style={
          showTopSummary
            ? {
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                padding: "10px 12px",
                background: "#ffffff",
              }
            : undefined
        }
      >
        {showTopSummary && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "12.5px", color: "#0f172a" }}>
              <strong>#{inv.invoiceNo || "N/A"}</strong>
              {inv.sentDate && <span style={{ color: "#64748b", marginLeft: "6px" }}>· {inv.sentDate}</span>}
              {inv.status && <span style={{ color: "#64748b", marginLeft: "6px" }}>· {inv.status}</span>}
            </div>
            <strong style={{ fontSize: "13px", color: "#16a34a" }}>{fmtGBP(invAmt)}</strong>
          </div>
        )}

        {/* Synced invoice line items (info-only by default; checkboxes revealed when "Includes recharged expenses?" is checked) */}
        {invLineItems.length > 0 && (
          <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "10px 12px", marginBottom: showTopSummary ? "8px" : "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "8px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a" }}>
                {st.hasRechargedExpenses
                  ? "Invoice line items (tick any recharged expenses)"
                  : "Invoice line items"}
              </span>
              <span style={{ fontSize: "11px", color: "#64748b", whiteSpace: "nowrap" }}>
                {invLineItems.length} {invLineItems.length === 1 ? "line" : "lines"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "170px", overflowY: "auto" }}>
              {invLineItems.map((li, liIdx) => {
                const isChecked = st.hasRechargedExpenses && st.selectedLineIndices.has(liIdx);
                const matchesExcess =
                  !isMulti &&
                  !li.isRecharged &&
                  initialExcessOverBillable > 0.01 &&
                  Math.abs((Number(li.amountGbp) || 0) - initialExcessOverBillable) <= 0.02;

                const rowContent = (
                  <>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", minWidth: 0 }}>
                      {st.hasRechargedExpenses && (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleLineItem(inv, invIdx, liIdx)}
                          style={{ marginTop: "2px", accentColor: "#2563eb", cursor: "pointer" }}
                        />
                      )}
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
                          {st.hasRechargedExpenses && li.isRecharged && (
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
                  </>
                );

                const commonStyle = {
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "6px 8px",
                  borderRadius: "6px",
                  background: isChecked ? "#eff6ff" : "#ffffff",
                  border: `1px solid ${isChecked ? "#93c5fd" : matchesExcess ? "#fcd34d" : "#e2e8f0"}`,
                  fontSize: "12px",
                };

                if (!st.hasRechargedExpenses) {
                  return (
                    <div key={liIdx} style={{ ...commonStyle, cursor: "default" }}>
                      {rowContent}
                    </div>
                  );
                }

                return (
                  <label key={liIdx} style={{ ...commonStyle, cursor: "pointer" }}>
                    {rowContent}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Recharged expenses toggle & amount */}
        <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "10px 12px", marginBottom: showTopSummary ? 0 : "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12.5px", fontWeight: "600", color: "#0f172a", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={st.hasRechargedExpenses}
                onChange={(e) => {
                  const checked = e.target.checked;
                  updateInvState(inv, invIdx, (cur) => {
                    if (!checked) {
                      return {
                        selectedLineIndices: new Set(),
                        hasRechargedExpenses: false,
                        ofWhichRechgd: "",
                        costMonth: "",
                      };
                    }
                    const nextRech = !cur.ofWhichRechgd && invDetectedRech > 0
                      ? Math.min(invDetectedRech, invAmt).toFixed(2)
                      : cur.ofWhichRechgd;
                    return {
                      ...cur,
                      hasRechargedExpenses: true,
                      ofWhichRechgd: nextRech,
                    };
                  });
                  if (!checked && excessChoice === "treat_as_recharged") {
                    setExcessChoice("increase_revenue");
                  }
                  setValidationError("");
                }}
                style={{ accentColor: "#2563eb", cursor: "pointer" }}
              />
              <span>Includes recharged expenses?</span>
            </label>

            {!st.hasRechargedExpenses && remainingUnallocatedForThisInv > 0.01 && (
              <button
                type="button"
                onClick={() => {
                  const fill = Math.min(remainingUnallocatedForThisInv, invAmt);
                  updateInvState(inv, invIdx, (cur) => ({
                    ...cur,
                    hasRechargedExpenses: true,
                    ofWhichRechgd: fill.toFixed(2),
                  }));
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
                Allocate {fmtGBP(Math.min(remainingUnallocatedForThisInv, invAmt))} unallocated job recharged
              </button>
            )}
          </div>

          {st.hasRechargedExpenses && (
            <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div>
                <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "4px" }}>
                  Of which recharged (excl. VAT{isAdmin ? ", col R & invoice" : ""})
                </label>
                <input
                  className="pma-place-modal-input"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={st.ofWhichRechgd}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    updateInvState(inv, invIdx, (cur) => ({ ...cur, ofWhichRechgd: nextVal }));
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

              {invOfWhichNum > 0.005 && (
                <InvoiceCostMonthControl
                  value={st.costMonth}
                  onChange={(nextCm) => updateInvState(inv, invIdx, (cur) => ({ ...cur, costMonth: nextCm }))}
                  totalAmount={invOfWhichNum}
                  invoiceSentDate={inv.sentDate || ""}
                  jobStartDate={job?.rows?.[0]?.startDate || job?.startDate || ""}
                  compact={true}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const primaryInv = invoiceList[0];

  return (
    <div
      className="pma-place-modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 2200,
        padding: "16px",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose?.();
      }}
    >
      <style>{`
        @media (max-width: 768px) {
          .pma-place-modal-backdrop {
            padding: 10px !important;
          }
          .pma-place-modal-card {
            width: 100% !important;
            padding: 16px !important;
            max-height: calc(100dvh - 20px) !important;
          }
          .pma-place-modal-input {
            font-size: 16px !important;
          }
        }
      `}</style>
      <div
        className="pma-place-modal-card"
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: isMulti ? "min(94vw, 620px)" : "min(94vw, 560px)",
          maxHeight: "calc(100dvh - 32px)",
          overflowY: "auto",
          margin: "auto 0",
          padding: "22px 24px",
          boxShadow: "0 25px 60px rgba(0,0,0,0.3)",
          border: "1px solid #e2e8f0",
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
              {isMulti ? `Place ${invoiceList.length} invoices on job` : "Place invoice on job"}
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

            {!isMulti ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Invoice number</span>
                  <div style={{ fontWeight: "700", color: "#0f172a" }}>#{primaryInv.invoiceNo || "N/A"}</div>
                </div>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Amount (excl. VAT)</span>
                  <div style={{ fontWeight: "700", color: "#16a34a" }}>{fmtGBP(invoiceAmount)}</div>
                </div>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Sent date</span>
                  <div style={{ fontWeight: "500", color: "#334155" }}>{primaryInv.sentDate || "Not recorded"}</div>
                </div>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Status</span>
                  <div style={{ fontWeight: "500", color: "#334155" }}>{primaryInv.status || "Sent"}</div>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Selected invoices</span>
                  <div style={{ fontWeight: "700", color: "#0f172a" }}>{invoiceList.length} invoices</div>
                </div>
                <div>
                  <span style={{ color: "#64748b", fontSize: "12px" }}>Total (excl. VAT)</span>
                  <div style={{ fontWeight: "700", color: "#16a34a" }}>{fmtGBP(invoiceAmount)}</div>
                </div>
              </div>
            )}
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
                    className="pma-place-modal-input"
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

        {/* Per-invoice line items & recharged expenses */}
        {!isMulti ? (
          renderInvoiceRechargedSection(primaryInv, 0, false)
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "14px", maxHeight: "340px", overflowY: "auto", paddingRight: "2px" }}>
            {invoiceList.map((inv, idx) => renderInvoiceRechargedSection(inv, idx, true))}
          </div>
        )}

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

              {!isMulti && initialExcessOverBillable <= invoiceAmount + 0.01 && (
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
            ) : isMulti ? (
              `Confirm and place ${invoiceList.length} invoices`
            ) : (
              "Confirm and place"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
