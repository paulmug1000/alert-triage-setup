import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import { stripCurrency, isPlaceholderInvoice, isDraftInvoice, hasActiveAccountingIntegration, INVOICE_STATUS_OPTIONS, canonicalizeInvoiceStatus, calculatePaymentDate, sanitizeSpreadsheetTerms } from "../utils/helpers";
import InvoiceCostMonthControl from "./InvoiceCostMonthControl";
import { extractSplitMonths } from "../services/splitHelper";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import DateInput from "./DateInput";
import InvoicesNewJobModal from "./InvoicesNewJobModal";
import { InvoiceDetailsContent } from "./InvoiceDetailsModal";
import PlaceholderPill, { isAutoPlaceholder, generatePlaceholderInvoiceRef, generateManualPlaceholderInvoiceRef } from "./PlaceholderPill";

export default function InvoicesEditModal({
  editSlot,
  invoicesClient,
  onClose,
  onUpdateInvoiceJobs,
  onMarkPullPending,
  isAdmin: propIsAdmin,
  availableJobs = [],
  onInvoiceMoved,
  hasAccountingIntegration: propHasAccountingIntegration,
}) {
  const auth = useAuth();
  const { allClientsMap } = useAppGlobals();
  const isAdmin = propIsAdmin !== undefined ? propIsAdmin : (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));
  const { rowNum, slotNum, slot, jobClient, jobName, tabName, job } = editSlot;

  const [invoiceNo, setInvoiceNo] = useState(slot.ref || "");
  const [amount, setAmount] = useState(stripCurrency(slot.amount));
  const [sentDate, setSentDate] = useState(slot.sentDate || "");
  const [daysToPay, setDaysToPay] = useState(slot.daysToPay || 30);
  const [status, setStatus] = useState(slot.status || "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showNewJobModal, setShowNewJobModal] = useState(false);
  const [viewingDetails, setViewingDetails] = useState(false);

  // Accounting integration status and locking
  const hasAccounting = useMemo(() => {
    if (propHasAccountingIntegration) return true;
    if (invoicesClient?.hasAccountingIntegration) return true;
    if (hasActiveAccountingIntegration(invoicesClient?.accountingTool)) return true;
    if (job?.hasAccountingIntegration) return true;
    if (editSlot?.hasAccountingIntegration) return true;

    const clientName = invoicesClient?.clientName || invoicesClient?.name || jobClient || editSlot?.jobClient;
    if (clientName && allClientsMap) {
      const match = allClientsMap[clientName] || Object.values(allClientsMap).find(c => String(c.clientName || "").toLowerCase() === String(clientName).toLowerCase());
      if (match?.hasAccountingIntegration) return true;
      if (hasActiveAccountingIntegration(match?.accountingTool)) return true;
    }

    if (propHasAccountingIntegration !== undefined) return Boolean(propHasAccountingIntegration);
    if (invoicesClient?.hasAccountingIntegration !== undefined) return Boolean(invoicesClient.hasAccountingIntegration);
    return false;
  }, [propHasAccountingIntegration, invoicesClient, job, editSlot, jobClient, allClientsMap]);

  const isPlaceholder = useMemo(() => {
    return isPlaceholderInvoice(slot?.ref || invoiceNo, slot?.status || status);
  }, [slot, invoiceNo, status]);

  const isAuto = isPlaceholder && isAutoPlaceholder(invoiceNo || slot?.ref);
  const isAutoLocked = isPlaceholder && isAuto;

  const isLocked = Boolean(
    hasAccounting &&
    !isPlaceholder &&
    (slot?.ref || invoiceNo) &&
    String(slot?.ref || invoiceNo).trim() !== ""
  );
  const isFieldLocked = isLocked || isAutoLocked;
  const isPaid = String(slot?.status || status || "").trim().toLowerCase() === "paid";
  const displayDetailInvoiceNo = String(slot?.ref || invoiceNo || "").replace(/^#/, "").trim();
  const canViewDetails = Boolean(!isPlaceholder && !editSlot?.isNewPlaceholder && !editSlot?.createNewRow && displayDetailInvoiceNo);

  const fieldLockTitle = isAutoLocked
    ? "Automatic placeholder. Convert to manual placeholder to edit."
    : isLocked
      ? "Synced from accounting software. To modify invoice number, amount, or sent date, update directly in your accounting software."
      : undefined;

  const partPaidOverview = useMemo(() => {
    const rawRef = String(slot?.ref || invoiceNo || "").trim();
    if (!rawRef || isPlaceholder) return null;
    const key = rawRef.toUpperCase();

    const siblingSlots = [];
    (job?.rows || []).forEach((r) => {
      (r.invoiceSlots || []).forEach((s) => {
        if (s && String(s.ref || "").trim().toUpperCase() === key) {
          siblingSlots.push({ ...s, rowNum: r.rowNum });
        }
      });
    });

    if (siblingSlots.length < 2) return null;

    let totalAmount = 0;
    let receivedAmount = 0;
    let balanceAmount = 0;
    let balanceSlot = null;
    const receivedSlots = [];

    siblingSlots.forEach((s) => {
      const amt = parseFloat(stripCurrency(s.amount)) || 0;
      totalAmount += amt;
      const st = String(s.status || "").toLowerCase();
      if (st.includes("balance")) {
        balanceAmount += amt;
        balanceSlot = s;
      } else {
        receivedAmount += amt;
        receivedSlots.push(s);
      }
    });

    const allMarkedPaid = siblingSlots.every((s) => {
      const st = String(s.status || "").toLowerCase();
      return st === "paid" || st.includes("paid in full");
    });

    if (allMarkedPaid || (!balanceSlot && balanceAmount <= 0.005)) {
      receivedAmount = totalAmount;
      balanceAmount = 0;
      balanceSlot = null;
    } else if (balanceAmount === 0 && balanceSlot) {
      balanceAmount = Math.max(0, totalAmount - receivedAmount);
    }

    const currentStatus = String(slot?.status || status || "").toLowerCase();
    const isCurrentBalance = currentStatus.includes("balance");
    const isFullyPaid = allMarkedPaid || balanceAmount <= 0.005 || !balanceSlot || String(balanceSlot.status || "").toLowerCase() === "paid";
    const percentPaid = totalAmount > 0 ? Math.min(100, Math.max(0, (receivedAmount / totalAmount) * 100)) : (allMarkedPaid ? 100 : 0);

    return {
      totalAmount,
      receivedAmount,
      balanceAmount,
      isCurrentBalance,
      isFullyPaid,
      siblingSlots,
      receivedSlots,
      balanceSlot,
      percentPaid
    };
  }, [slot, invoiceNo, isPlaceholder, job, status]);

  // Move invoice state
  const [movingInvoice, setMovingInvoice] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobsList, setJobsList] = useState(availableJobs || []);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [selectedTargetJob, setSelectedTargetJob] = useState(null);

  // Revenue prompt state: { type: "save" | "move", projectedTotal, currentRevenue, onConfirm }
  const [revenuePrompt, setRevenuePrompt] = useState(null);
  const isConfirmedTab = (tabName || editSlot?.tabName || "Confirmed") !== "Pipeline";
  const [ofWhichRechgd, setOfWhichRechgd] = useState(() => (isConfirmedTab ? stripCurrency(slot.ofWhichRechgd) : ""));
  const [costMonth, setCostMonth] = useState(() => (isConfirmedTab ? (slot.costMonth || "") : ""));
  const [rechargedPrompt, setRechargedPrompt] = useState(null);

  const close = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  // If availableJobs wasn't passed, load confirmed jobs for this client on demand
  useEffect(() => {
    if (movingInvoice && (!jobsList || jobsList.length === 0) && invoicesClient?.clientSheetId) {
      setLoadingJobs(true);
      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_invoice_jobs",
          clientSheetId: invoicesClient.clientSheetId,
          showAll: true
        })
      })
        .then(res => res.json())
        .then(data => {
          if (data.success && Array.isArray(data.jobs)) {
            setJobsList(data.jobs);
          }
        })
        .catch(err => console.error("Error loading jobs for move:", err))
        .finally(() => setLoadingJobs(false));
    }
  }, [movingInvoice, jobsList, invoicesClient]);

  // Compute current real invoiced total on this job
  const jobRealInvoicedTotal = useMemo(() => {
    if (!job?.rows) return 0;
    let sum = 0;
    job.rows.forEach(r => {
      (r.invoiceSlots || []).forEach(sl => {
        if (sl.ref && !isPlaceholderInvoice(sl.ref, sl.status) && !isDraftInvoice(sl.ref, sl.status)) {
          sum += parseFloat(String(sl.amount).replace(/[£$€,\s]/g, "")) || 0;
        }
      });
    });
    return sum;
  }, [job]);

  const jobRevenue = useMemo(() => {
    if (!job?.rows?.[0]) return 0;
    return parseFloat(String(job.rows[0].revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
  }, [job]);

  const jobRecharged = useMemo(() => {
    if (!isConfirmedTab || !job) return 0;
    return parseFloat(String(job.rows?.[0]?.rechargedExpenses ?? job.rechargedExpenses ?? "0").replace(/[£$€,\s]/g, "")) || 0;
  }, [job, isConfirmedTab]);

  const jobBillable = Math.round((jobRevenue + jobRecharged) * 100) / 100;

  const otherSlotsStats = useMemo(() => {
    if (!job?.rows || !isConfirmedTab) return { otherNonAutoRechgd: 0, otherNonAutoGross: 0 };
    const parseMoney = (v) => parseFloat(String(v ?? "").replace(/[£$€,\s]/g, "")) || 0;
    let otherNonAutoRechgd = 0;
    let otherNonAutoGross = 0;
    job.rows.forEach((r) => {
      (r.invoiceSlots || []).forEach((sl) => {
        if (Number(r.rowNum) === Number(rowNum) && Number(sl.slotNum) === Number(slotNum)) return;
        const refStr = String(sl.ref || "").trim();
        const amt = parseMoney(sl.amount);
        const rech = parseMoney(sl.ofWhichRechgd);
        const isAuto = refStr.toUpperCase().startsWith("PLACE-INV-");
        const isEmpty = !refStr && Math.abs(amt) < 0.005 && Math.abs(rech) < 0.005;
        if (!isAuto && !isEmpty) {
          otherNonAutoRechgd += rech;
          otherNonAutoGross += amt;
        }
      });
    });
    return {
      otherNonAutoRechgd: Math.round(otherNonAutoRechgd * 100) / 100,
      otherNonAutoGross: Math.round(otherNonAutoGross * 100) / 100,
    };
  }, [job, isConfirmedTab, rowNum, slotNum]);

  // Save changes to invoice slot
  const executeSave = async (updateJobRevenue = false, newJobRevenue = undefined, updateJobRecharged = false, newJobRecharged = undefined) => {
    setSaving(true);
    setRevenuePrompt(null);
    setRechargedPrompt(null);
    const rechNum = isConfirmedTab ? (Math.round((parseFloat(ofWhichRechgd) || 0) * 100) / 100) : 0;
    const rechPayload = isConfirmedTab
      ? {
        ofWhichRechgd: rechNum > 0 ? rechNum : "",
        costMonth: rechNum > 0 ? String(costMonth || "").trim() : "",
      }
      : {};
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum, slotNum,
          createNewRow: !!editSlot.createNewRow,
          jobClient, jobName,
          invoice: {
            invoiceNo,
            amount: parseFloat(amount) || 0,
            sentDate,
            daysToPay: parseInt(daysToPay) || 30,
            status,
            ...rechPayload,
          },
          updateJobRevenue,
          newJobRevenue,
          updateJobRecharged,
          newJobRecharged,
          jobRowNums: job?.rows ? job.rows.map(r => r.rowNum) : [rowNum]
        }),
      });
      const data = await res.json();
      if (!data.success) {
        const rawErr = data.error || "Failed to update invoice";
        alert(isAdmin ? rawErr : sanitizeSpreadsheetTerms(rawErr));
        return;
      }
      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      onUpdateInvoiceJobs(rowNum, slotNum, {
        ref: invoiceNo,
        amount: parseFloat(amount) || 0,
        sentDate,
        daysToPay: parseInt(daysToPay) || 30,
        status,
        ...rechPayload,
      }, data);
      onClose();
    } catch (e) { console.error("update_invoice_slot save error:", e); }
    finally { setSaving(false); }
  };

  const handleSaveClick = () => {
    const newAmtNum = parseFloat(amount) || 0;
    const oldAmtNum = parseFloat(stripCurrency(slot.amount)) || 0;
    const ofWhichNum = isConfirmedTab ? (Math.round((parseFloat(ofWhichRechgd) || 0) * 100) / 100) : 0;

    if (isConfirmedTab && ofWhichNum > 0) {
      if (ofWhichNum > newAmtNum + 0.01) {
        alert("Of which recharged cannot exceed the invoice gross amount.");
        return;
      }
      if (String(costMonth || "").trim().toLowerCase().startsWith("[split]")) {
        const splitEntries = extractSplitMonths(costMonth);
        const splitSum = splitEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        if (Math.abs(splitSum - ofWhichNum) > 0.02) {
          alert(`Split cost months (£${splitSum.toFixed(2)}) must add up to the invoice recharged amount (£${ofWhichNum.toFixed(2)}).`);
          return;
        }
      }
    }

    if (isConfirmedTab && job?.rows) {
      const totalNonAutoRechgd = Math.round((otherSlotsStats.otherNonAutoRechgd + ofWhichNum) * 100) / 100;
      const remainingBillableForAuto = Math.max(0, Math.round((jobBillable - (otherSlotsStats.otherNonAutoGross + newAmtNum)) * 100) / 100);
      if (totalNonAutoRechgd > jobRecharged + 0.01 || (remainingBillableForAuto <= 0.01 && Math.abs(totalNonAutoRechgd - jobRecharged) > 0.01)) {
        const deltaRech = Math.round((totalNonAutoRechgd - jobRecharged) * 100) / 100;
        const canAdjustFee = deltaRech > 0 && jobRevenue >= deltaRech && (otherSlotsStats.otherNonAutoGross + newAmtNum) <= jobBillable + 0.01;
        const adjustedFeeRevenue = canAdjustFee ? Math.round((jobRevenue - deltaRech) * 100) / 100 : null;
        setRechargedPrompt({
          currentRecharged: jobRecharged,
          newRecharged: totalNonAutoRechgd,
          adjustedFeeRevenue,
          currentRevenue: jobRevenue,
          onConfirmAdjustBoth: canAdjustFee
            ? () => executeSave(true, Math.round((adjustedFeeRevenue + totalNonAutoRechgd) * 100) / 100, true, totalNonAutoRechgd)
            : null,
          onConfirmUpdateRechargedOnly: () => executeSave(false, undefined, true, totalNonAutoRechgd),
        });
        return;
      }
    }

    if (jobBillable > 0 && newAmtNum !== oldAmtNum) {
      const projectedTotal = Math.round((jobRealInvoicedTotal - oldAmtNum + newAmtNum) * 100) / 100;
      if (projectedTotal > jobBillable + 0.01) {
        setRevenuePrompt({
          type: "save",
          projectedTotal,
          currentRevenue: jobBillable,
          onConfirmYes: () => executeSave(true, projectedTotal),
          onConfirmNo: () => executeSave(false)
        });
        return;
      }
    }
    executeSave(false);
  };

  // Move invoice to destination job
  const executeMove = async (targetJob, updateTargetRevenue = false, newTargetRevenue = undefined) => {
    setSaving(true);
    setRevenuePrompt(null);
    try {
      const targetRows = targetJob.rows || [];
      const targetParentRow = targetRows[0];
      const targetJobLastRow = targetRows[targetRows.length - 1]?.rowNum || targetParentRow?.rowNum;

      // Find first available slot on target job
      let foundTargetRowNum = null;
      let foundTargetSlotNum = null;
      for (const r of targetRows) {
        for (const sl of (r.invoiceSlots || [])) {
          if (!sl.ref || isPlaceholderInvoice(sl.ref, sl.status) || !sl.amount) {
            foundTargetRowNum = r.rowNum;
            foundTargetSlotNum = sl.slotNum;
            break;
          }
        }
        if (foundTargetRowNum) break;
      }

      const createNewRow = !foundTargetRowNum;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move_invoice_to_job",
          clientSheetId: invoicesClient?.clientSheetId,
          masterSheetId: invoicesClient?.masterSheetId || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          sourceRowNum: rowNum,
          sourceSlotNum: slotNum,
          sourceJobClient: jobClient,
          sourceJobName: jobName,
          invoiceRef: invoiceNo,
          targetJobClient: targetJob.client,
          targetJobName: targetJob.jobName,
          targetRowNum: foundTargetRowNum || targetJobLastRow,
          targetSlotNum: foundTargetSlotNum || 1,
          createNewRow,
          targetJobLastRow,
          updateTargetRevenue,
          newTargetRevenue,
          invoice: {
            invoiceNo,
            amount: parseFloat(amount) || 0,
            sentDate,
            daysToPay: parseInt(daysToPay) || 30,
            status: status || "",
            ...(isConfirmedTab ? {
              ofWhichRechgd: parseFloat(ofWhichRechgd) || 0,
              costMonth: (parseFloat(ofWhichRechgd) || 0) > 0 ? costMonth : ""
            } : {})
          }
        })
      });

      const resData = await res.json();
      if (!resData.success) {
        const rawErr = resData.error || "Failed to move invoice";
        alert(isAdmin ? rawErr : sanitizeSpreadsheetTerms(rawErr));
        return;
      }

      if (invoicesClient?.masterSheetId) {
        onMarkPullPending(invoicesClient.masterSheetId);
      }

      if (onInvoiceMoved) {
        onInvoiceMoved({
          sourceRowNum: rowNum,
          sourceSlotNum: slotNum,
          targetJob,
          targetRowNum: resData.targetRowNum,
          targetSlotNum: resData.targetSlotNum,
          invoice: {
            invoiceNo,
            amount: parseFloat(amount) || 0,
            sentDate,
            daysToPay: parseInt(daysToPay) || 30,
            status,
            ...(isConfirmedTab ? {
              ofWhichRechgd: parseFloat(ofWhichRechgd) || 0,
              costMonth: (parseFloat(ofWhichRechgd) || 0) > 0 ? costMonth : ""
            } : {})
          },
          resData
        });
      } else {
        // Fallback: clear invoice slot on current job
        onUpdateInvoiceJobs(rowNum, slotNum, {
          ref: "",
          amount: "",
          sentDate: "",
          daysToPay: "",
          status: "",
          ...(isConfirmedTab ? { ofWhichRechgd: "", costMonth: "" } : {})
        });
      }

      onClose();
    } catch (e) {
      console.error("move_invoice_to_job error:", e);
      const errMsg = "Error moving invoice: " + (e?.message || "Unknown error");
      alert(isAdmin ? errMsg : sanitizeSpreadsheetTerms(errMsg));
    } finally {
      setSaving(false);
    }
  };

  const handleSelectTargetJob = (targetJob) => {
    setSelectedTargetJob(targetJob);
    const invAmtNum = parseFloat(amount) || 0;
    const targetRevenue = parseFloat(String(targetJob.rows?.[0]?.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
    const targetRecharged = isConfirmedTab
      ? (parseFloat(String(targetJob.rows?.[0]?.rechargedExpenses || "0").replace(/[£$€,\s]/g, "")) || 0)
      : 0;
    const targetBillable = Math.round((targetRevenue + targetRecharged) * 100) / 100;

    // Calculate current real invoiced total on target job
    let targetInvoicedTotal = 0;
    (targetJob.rows || []).forEach(r => {
      (r.invoiceSlots || []).forEach(sl => {
        if (sl.ref && !isPlaceholderInvoice(sl.ref, sl.status) && !isDraftInvoice(sl.ref, sl.status)) {
          targetInvoicedTotal += parseFloat(String(sl.amount).replace(/[£$€,\s]/g, "")) || 0;
        }
      });
    });

    const projectedTotal = Math.round((targetInvoicedTotal + invAmtNum) * 100) / 100;
    if (targetBillable > 0 && projectedTotal > targetBillable) {
      setRevenuePrompt({
        type: "move",
        targetJobName: targetJob.jobName,
        projectedTotal,
        currentRevenue: targetBillable,
        onConfirmYes: () => executeMove(targetJob, true, projectedTotal),
        onConfirmNo: () => executeMove(targetJob, false)
      });
      return;
    }

    executeMove(targetJob, false);
  };

  const doDelete = async () => {
    setSaving(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_invoice_slot",
          clientSheetId: invoicesClient?.clientSheetId,
          masterSheetId: invoicesClient?.masterSheetId,
          clientName: invoicesClient?.clientName || invoicesClient?.name || "",
          tabName: tabName || editSlot.tabName || "Confirmed",
          rowNum,
          slotNum,
          deleteSlot: true,
          jobClient,
          jobName,
          jobRowNums: Array.isArray(job?.rows) ? job.rows.map(r => r.rowNum).filter(Boolean) : undefined,
        }),
      });
      const resData = await resp.json().catch(() => ({}));
      if (!resp.ok || !resData.success) {
        const rawErr = resData.error || "Failed to delete invoice";
        alert(isAdmin ? rawErr : sanitizeSpreadsheetTerms(rawErr));
        return;
      }
      if (invoicesClient?.masterSheetId && typeof onMarkPullPending === "function") {
        onMarkPullPending(invoicesClient.masterSheetId);
      }
      const restored = resData.restoredPlaceholderSlot;
      const isRestoredInDeletedSlot =
        restored &&
        Number(restored.rowNum) === Number(rowNum) &&
        Number(restored.slotNum || 1) === Number(slotNum);
      const slotPayload = isRestoredInDeletedSlot
        ? {
          ref: restored.ref || "",
          amount: restored.amount || "",
          sentDate: restored.sentDate || "",
          daysToPay: restored.daysToPay || "",
          status: restored.status || "",
        }
        : { ref: "", amount: "", sentDate: "", daysToPay: "", status: "" };
      onUpdateInvoiceJobs(rowNum, slotNum, slotPayload, resData);
      onClose();
    } catch (e) {
      console.error("update_invoice_slot delete error:", e);
      const errMsg = e?.message || "Failed to delete invoice";
      alert(isAdmin ? errMsg : sanitizeSpreadsheetTerms(errMsg));
    } finally {
      setSaving(false);
    }
  };

  const filteredTargetJobs = useMemo(() => {
    const cleanSearch = jobSearch.trim().toLowerCase();
    return (jobsList || []).filter(j => {
      // Exclude the current job
      if (j.jobName === jobName && (j.client === jobClient || !j.client)) return false;
      if (!cleanSearch) return true;
      return (
        String(j.jobName || "").toLowerCase().includes(cleanSearch) ||
        String(j.client || "").toLowerCase().includes(cleanSearch) ||
        String(j.projectCode || "").toLowerCase().includes(cleanSearch)
      );
    });
  }, [jobsList, jobSearch, jobName, jobClient]);

  const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "14px", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontSize: "11px", fontWeight: "600", color: "#666", marginBottom: "3px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: viewingDetails ? "min(94vw, 680px)" : "min(92vw, 520px)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", gap: "12px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
              {viewingDetails ? (
                `Invoice details · #${displayDetailInvoiceNo}`
              ) : movingInvoice ? (
                `Move invoice #${invoiceNo || slot.ref}`
              ) : editSlot.isNewPlaceholder ? (
                `${jobName ? `${jobName} · ` : ""}New placeholder`
              ) : jobName ? (
                `${jobName} · ${invoiceNo ? `#${invoiceNo}` : (isPlaceholder ? "Placeholder" : "Invoice")}`
              ) : (
                invoiceNo ? `Invoice #${invoiceNo}` : (isPlaceholder ? "Placeholder" : "Edit invoice")
              )}
            </h3>
            {jobClient && (
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Client: <strong>{jobClient}</strong>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
            {viewingDetails && (
              <button
                type="button"
                onClick={() => setViewingDetails(false)}
                style={{
                  padding: "5px 10px",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "#334155",
                }}
              >
                Back to edit
              </button>
            )}
            <button onClick={close} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#999" }}>×</button>
          </div>
        </div>

        {!viewingDetails && !movingInvoice && canViewDetails && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              padding: "8px 12px",
              marginBottom: "14px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
            }}
          >
            <span style={{ fontSize: "12px", color: "#475569" }}>
              Want to inspect the line-by-line accounting breakdown?
            </span>
            <button
              type="button"
              onClick={() => setViewingDetails(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 11px",
                background: "#ffffff",
                border: "1px solid #93c5fd",
                borderRadius: "6px",
                color: "#1d4ed8",
                fontSize: "12px",
                fontWeight: "600",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              View invoice details
            </button>
          </div>
        )}

        {/* RECHARGED EXPENSES TOTAL PROMPT MODAL */}
        {rechargedPrompt && (
          <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13.5px", fontWeight: "600", color: "#0369a1", marginBottom: "6px" }}>
              Update job recharged expenses to match?
            </div>
            <div style={{ fontSize: "12.5px", color: "#334155", lineHeight: "1.5", marginBottom: "12px" }}>
              Saving this invoice gives total invoice recharged expenses of <strong>£{rechargedPrompt.newRecharged.toFixed(2)}</strong>, which does not match the job&apos;s current recharged expenses total of <strong>£{rechargedPrompt.currentRecharged.toFixed(2)}</strong>.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setRechargedPrompt(null)}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", cursor: "pointer", color: "#475569" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={rechargedPrompt.onConfirmUpdateRechargedOnly}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "#334155" }}
              >
                Update job recharged to £{rechargedPrompt.newRecharged.toFixed(2)} (keep fee revenue at £{rechargedPrompt.currentRevenue.toFixed(2)})
              </button>
              {rechargedPrompt.onConfirmAdjustBoth && (
                <button
                  type="button"
                  onClick={rechargedPrompt.onConfirmAdjustBoth}
                  disabled={saving}
                  style={{ padding: "6px 14px", background: "#0284c7", border: "none", borderRadius: "5px", fontSize: "12px", fontWeight: "600", color: "#ffffff", cursor: "pointer" }}
                >
                  Update recharged to £{rechargedPrompt.newRecharged.toFixed(2)} and fee revenue to £{rechargedPrompt.adjustedFeeRevenue.toFixed(2)}
                </button>
              )}
            </div>
          </div>
        )}

        {/* REVENUE INCREASE PROMPT MODAL */}
        {revenuePrompt && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13.5px", fontWeight: "600", color: "#1e40af", marginBottom: "6px" }}>
              Increase job revenue to match?
            </div>
            <div style={{ fontSize: "12.5px", color: "#334155", lineHeight: "1.5", marginBottom: "12px" }}>
              {revenuePrompt.type === "move" ? (
                <>Moving this invoice brings total invoiced on <strong>&ldquo;{revenuePrompt.targetJobName}&rdquo;</strong> to <strong>£{revenuePrompt.projectedTotal.toFixed(2)}</strong>, which exceeds its current revenue of <strong>£{revenuePrompt.currentRevenue.toFixed(2)}</strong>.</>
              ) : (
                <>Saving this invoice brings total invoiced on this job to <strong>£{revenuePrompt.projectedTotal.toFixed(2)}</strong>, which exceeds its current revenue of <strong>£{revenuePrompt.currentRevenue.toFixed(2)}</strong>.</>
              )}
              <br />Would you like to increase the job&apos;s revenue to match?
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setRevenuePrompt(null)}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", cursor: "pointer", color: "#475569" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={revenuePrompt.onConfirmNo}
                disabled={saving}
                style={{ padding: "6px 12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "5px", fontSize: "12px", fontWeight: "600", cursor: "pointer", color: "#334155" }}
              >
                No, keep current revenue
              </button>
              <button
                type="button"
                onClick={revenuePrompt.onConfirmYes}
                disabled={saving}
                style={{ padding: "6px 14px", background: "#2563eb", border: "none", borderRadius: "5px", fontSize: "12px", fontWeight: "600", color: "#ffffff", cursor: "pointer" }}
              >
                Yes, increase revenue
              </button>
            </div>
          </div>
        )}

        {/* INVOICE DETAILS & LINE-BY-LINE BREAKDOWN VIEW */}
        {viewingDetails ? (
          <div>
            <InvoiceDetailsContent
              invoiceNo={displayDetailInvoiceNo}
              masterSheetId={invoicesClient?.masterSheetId || job?.masterSheetId}
              clientSheetId={invoicesClient?.clientSheetId || job?.clientSheetId}
              clientName={invoicesClient?.clientName || invoicesClient?.name || ""}
              fallbackSummary={{
                client: jobClient,
                jobName,
                amount: parseFloat(amount) || 0,
                sentDate,
                dueDate: slot?.dueDate || calculatePaymentDate(sentDate, daysToPay) || "",
                status,
                rechargedAmountGbp: parseFloat(ofWhichRechgd) || 0,
              }}
              isAdmin={isAdmin}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginTop: "18px" }}>
              <button
                type="button"
                onClick={() => setViewingDetails(false)}
                style={{ padding: "8px 16px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#334155" }}
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={close}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px", color: "#334155" }}
              >
                Close
              </button>
            </div>
          </div>
        ) : movingInvoice ? (
          <div>
            <div style={{ fontSize: "13px", color: "#475569", marginBottom: "12px" }}>
              Select a new destination job for invoice <strong>#{invoiceNo || slot.ref}</strong> (£{parseFloat(amount || 0).toFixed(2)}):
            </div>

            <div style={{ marginBottom: "12px" }}>
              <DeferredSearchInput
                type="text"
                placeholder="Search jobs by name, client, or code..."
                value={jobSearch}
                onChange={e => setJobSearch(e.target.value)}
                showClearButton
                style={{ ...inputStyle, padding: "8px 12px" }}
                autoFocus
              />
            </div>

            <div style={{ maxHeight: "260px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#f8fafc", marginBottom: "16px" }}>
              {loadingJobs ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                  <Spinner size={14} color="#2563eb" /> Loading available jobs...
                </div>
              ) : filteredTargetJobs.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                  No available jobs found.
                </div>
              ) : (
                filteredTargetJobs.map(j => {
                  const jKey = `${j.client}|||${j.jobName}`;
                  const rev = parseFloat(String(j.rows?.[0]?.revenue || "0").replace(/[£$€,\s]/g, "")) || 0;
                  const isMovingToThis = saving && selectedTargetJob && selectedTargetJob.jobName === j.jobName && selectedTargetJob.client === j.client;
                  return (
                    <div
                      key={jKey}
                      onClick={() => !saving && handleSelectTargetJob(j)}
                      style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid #e2e8f0",
                        cursor: saving ? "default" : "pointer",
                        backgroundColor: isMovingToThis ? "#eff6ff" : "#ffffff",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background-color 0.1s ease"
                      }}
                      onMouseEnter={e => { if (!saving) e.currentTarget.style.backgroundColor = "#eff6ff"; }}
                      onMouseLeave={e => { if (!saving) e.currentTarget.style.backgroundColor = "#ffffff"; }}
                    >
                      <div>
                        <div style={{ fontWeight: "600", fontSize: "13px", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                          {j.jobName}
                          {isMovingToThis && <span style={{ fontSize: "11px", color: "#2563eb", display: "inline-flex", alignItems: "center", gap: "4px" }}><Spinner size={11} color="#2563eb" /> Moving...</span>}
                        </div>
                        <div style={{ fontSize: "11px", color: "#64748b" }}>
                          {j.client}{j.projectCode ? ` · ${j.projectCode}` : ""}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "12px", fontWeight: "600", color: "#0f172a" }}>
                          {rev > 0 ? `£${rev.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                        </div>
                        <div style={{ fontSize: "10.5px", color: "#64748b" }}>Revenue</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setMovingInvoice(false)}
                disabled={saving}
                style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}
              >
                Back to edit
              </button>
            </div>
          </div>
        ) : (
          /* STANDARD EDIT FORM */
          <>
            {partPaidOverview && (
              <div
                style={{
                  fontSize: "12px",
                  color: partPaidOverview.isFullyPaid ? "#166534" : "#0369a1",
                  background: partPaidOverview.isFullyPaid ? "#f0fdf4" : "#f0f9ff",
                  border: `1px solid ${partPaidOverview.isFullyPaid ? "#bbf7d0" : "#bae6fd"}`,
                  borderRadius: "6px",
                  padding: "10px 12px",
                  marginBottom: "14px",
                  lineHeight: "1.4",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, color: partPaidOverview.isFullyPaid ? "#166534" : "#0369a1", display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>
                      {partPaidOverview.isFullyPaid
                        ? `Paid invoice #${slot?.ref || invoiceNo}`
                        : `Part-paid invoice #${slot?.ref || invoiceNo}`}
                    </span>
                    <span
                      style={{
                        fontSize: "10px",
                        background: partPaidOverview.isFullyPaid ? "#dcfce7" : "#e0f2fe",
                        color: partPaidOverview.isFullyPaid ? "#15803d" : "#0369a1",
                        padding: "1px 6px",
                        borderRadius: "10px",
                        fontWeight: 600
                      }}
                    >
                      {partPaidOverview.isFullyPaid
                        ? `Paid in full (${partPaidOverview.siblingSlots.length} payments)`
                        : `${partPaidOverview.percentPaid.toFixed(1)}% received`}
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, color: "#0f172a" }}>
                    Total: £{partPaidOverview.totalAmount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>

                {partPaidOverview.isFullyPaid ? (
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "6px 10px",
                      borderRadius: "4px",
                      border: "1px solid #dcfce7",
                      fontSize: "11px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px"
                    }}
                  >
                    <div style={{ color: "#166534", fontWeight: 600, marginBottom: "2px" }}>
                      Settled payment breakdown ({partPaidOverview.siblingSlots.length} tranches):
                    </div>
                    {partPaidOverview.siblingSlots.map((s, idx) => {
                      const amt = parseFloat(stripCurrency(s.amount)) || 0;
                      return (
                        <div key={idx} style={{ display: "flex", justifyContent: "space-between", color: "#334155" }}>
                          <span>
                            ✓ Payment {idx + 1}: <strong>£{amt.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                            {s.daysToPay && (
                              <span style={{ color: "#64748b" }}> · Paid in {s.daysToPay}d</span>
                            )}
                          </span>
                          <span style={{ fontSize: "10px", color: "#64748b" }}>
                            {isAdmin ? (s.slotNum ? `Slot ${s.slotNum}` : `Row ${s.rowNum}`) : (s.slotNum ? `Entry ${s.slotNum}` : "")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", background: "#ffffff", padding: "6px 10px", borderRadius: "4px", border: "1px solid #e0f2fe", fontSize: "11px" }}>
                    <div>
                      <span style={{ color: "#166534", fontWeight: 600 }}>✓ Received: </span>
                      <strong style={{ color: "#0f172a" }}>
                        £{partPaidOverview.receivedAmount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                      {partPaidOverview.receivedSlots[0]?.daysToPay && (
                        <span style={{ color: "#64748b" }}> ({partPaidOverview.receivedSlots[0].daysToPay}d to pay)</span>
                      )}
                    </div>
                    <div>
                      <span style={{ color: "#b45309", fontWeight: 600 }}>⏳ Balance: </span>
                      <strong style={{ color: "#0f172a" }}>
                        £{partPaidOverview.balanceAmount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </strong>
                      {partPaidOverview.isCurrentBalance ? (
                        <span style={{ color: "#0284c7", fontWeight: 600 }}>{isAdmin ? " (this slot)" : " (this entry)"}</span>
                      ) : (
                        <span style={{ color: "#64748b" }}>{isAdmin ? " (other slot)" : " (other entry)"}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
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
                <span>This is an automatic placeholder invoice, and the details are locked. To enable editing, click the &quot;Placeholder - auto&quot; button to convert it to a manual placeholder.</span>
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
                <span>This invoice is synced from accounting software. The invoice number, amount, and sent date are locked here to prevent sync conflicts{isPaid ? (isConfirmedTab ? ", and days to pay is locked because the invoice is paid (recharged expenses remain editable)." : ", and days to pay is locked because the invoice is paid.") : (isConfirmedTab ? ", while days to pay and recharged expenses remain editable." : ", but days to pay remains editable.")}</span>
              </div>
            )}
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                {isPlaceholder ? (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <label style={{ ...labelStyle, marginBottom: 0 }}>Invoice reference</label>
                      <PlaceholderPill
                        isAuto={isAuto}
                        onToggle={(targetAuto) => {
                          if (targetAuto) {
                            setInvoiceNo(generatePlaceholderInvoiceRef(sentDate));
                          } else {
                            setInvoiceNo(generateManualPlaceholderInvoiceRef(sentDate));
                          }
                        }}
                      />
                    </div>
                    {!isAuto ? (
                      <input
                        style={inputStyle}
                        value={invoiceNo}
                        onChange={e => setInvoiceNo(e.target.value)}
                        placeholder="e.g. INV-1001 (optional for manual placeholder)"
                      />
                    ) : (
                      <div style={{ fontSize: "12px", color: "#64748b", background: "#f8fafc", padding: "7px 10px", borderRadius: "5px", border: "1px solid #e2e8f0" }}>
                        Reference: <code style={{ color: "#7c3aed" }}>{invoiceNo || slot?.ref || "Automatic"}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>Invoice number</label>
                    <input
                      style={{
                        ...inputStyle,
                        ...(isLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                      }}
                      value={invoiceNo}
                      onChange={e => setInvoiceNo(e.target.value)}
                      disabled={isLocked}
                      title={isLocked ? "Synced from accounting software. To modify invoice number, amount, or sent date, update directly in your accounting software." : undefined}
                    />
                  </div>
                )}
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
                    title={isAutoLocked ? "Automatic placeholder. Convert to manual placeholder to edit." : (isPaid ? "Days to pay is determined once an invoice is marked as paid." : undefined)}
                  />
                  {calculatePaymentDate(sentDate, daysToPay) && (
                    <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                      Expected payment date: <strong style={{ color: "#0f172a", fontWeight: "600" }}>{calculatePaymentDate(sentDate, daysToPay)}</strong>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label style={labelStyle}>Sent date</label>
                <DateInput
                  style={{
                    ...inputStyle,
                    ...(isFieldLocked ? { background: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" } : {})
                  }}
                  value={sentDate}
                  onChange={e => setSentDate(e.target.value)}
                  disabled={isFieldLocked}
                  title={fieldLockTitle}
                />
              </div>
              <div>
                <label style={labelStyle}>Status</label>
                {isFieldLocked ? (
                  <div style={{
                    padding: "7px 10px",
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    color: "#334155",
                    display: "inline-block"
                  }} title={fieldLockTitle}>
                    {status || ""}
                  </div>
                ) : (
                  <select
                    style={inputStyle}
                    value={canonicalizeInvoiceStatus(status)}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value=""></option>
                    {INVOICE_STATUS_OPTIONS.map((st) => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                    {status && !INVOICE_STATUS_OPTIONS.includes(canonicalizeInvoiceStatus(status)) && (
                      <option value={status}>{status}</option>
                    )}
                  </select>
                )}
              </div>
            </div>

            {isConfirmedTab && (
              <div style={{ marginTop: "14px", padding: "12px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
                  <label style={{ ...labelStyle, marginBottom: 0, color: "#0f172a" }}>
                    Of which recharged (excl. VAT)
                  </label>
                  <span style={{ fontSize: "11px", color: "#64748b" }}>
                    Job recharged expenses: £{jobRecharged.toFixed(2)} · Other invoices: £{otherSlotsStats.otherNonAutoRechgd.toFixed(2)}
                  </span>
                </div>
                <input
                  type="number"
                  step="0.01"
                  value={ofWhichRechgd}
                  onChange={(e) => setOfWhichRechgd(e.target.value)}
                  disabled={saving}
                  placeholder="0.00"
                  style={inputStyle}
                />
                {(parseFloat(ofWhichRechgd) || 0) > 0 && (
                  <div style={{ marginTop: "10px" }}>
                    <InvoiceCostMonthControl
                      value={costMonth}
                      onChange={setCostMonth}
                      totalAmount={parseFloat(ofWhichRechgd) || 0}
                      invoiceSentDate={sentDate}
                      jobStartDate={job?.rows?.[0]?.startDate || ""}
                      disabled={saving}
                      compact={true}
                    />
                  </div>
                )}
              </div>
            )}

            {confirmingDelete ? (
              <div style={{ marginTop: "18px", padding: "14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
                <div style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a", marginBottom: "4px" }}>
                  Delete invoice from this job?
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px", lineHeight: "1.4" }}>
                  Would you prefer to move this invoice to another job or create a new job for it instead?
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={saving}
                    style={{ padding: "7px 12px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontSize: "12.5px", color: "#334155" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(false); setMovingInvoice(true); }}
                    disabled={saving}
                    style={{ padding: "7px 12px", background: "#ffffff", border: "1px solid #bfdbfe", borderRadius: "6px", cursor: "pointer", fontSize: "12.5px", color: "#1d4ed8", fontWeight: "500" }}
                  >
                    Move to a different job
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(false); setShowNewJobModal(true); }}
                    disabled={saving}
                    style={{ padding: "7px 12px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontSize: "12.5px", color: "#0f172a", fontWeight: "500" }}
                  >
                    Create new job
                  </button>
                  <button
                    type="button"
                    onClick={doDelete}
                    disabled={saving}
                    style={{ padding: "7px 12px", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "12.5px", color: "#b91c1c", fontWeight: "600", opacity: saving ? 0.7 : 1, display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    {saving ? <><Spinner size={12} color="#b91c1c" /> Deleting...</> : "Delete from job anyway"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={saving}
                    style={{ padding: "8px 14px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Delete invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => setMovingInvoice(true)}
                    disabled={saving}
                    style={{ padding: "8px 14px", background: "#ffffff", color: "#2563eb", border: "1px solid #bfdbfe", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}
                  >
                    Move to a different job
                  </button>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={close} disabled={saving}
                    style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
                  <button onClick={handleSaveClick} disabled={saving}
                    style={{ padding: "8px 22px", background: saving ? "#4caf50" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: saving ? "default" : "pointer", fontSize: "13px", fontWeight: "600", opacity: saving ? 0.8 : 1, display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    {saving ? <><Spinner size={12} color="#fff" /> Saving...</> : "Save changes"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showNewJobModal && (
        <InvoicesNewJobModal
          newJobData={{
            inv: {
              invoiceNo: slot.ref || invoiceNo,
              client: jobClient || invoicesClient?.clientName,
              job: jobName || "",
              amount: parseFloat(amount) || 0,
              sentDate: sentDate,
              daysToPay: daysToPay,
              status: status,
              dueDate: slot.dueDate || "",
            }
          }}
          invoicesClient={invoicesClient}
          onClose={() => setShowNewJobModal(false)}
          onMarkPullPending={onMarkPullPending}
          onSuccess={async () => {
            await doDelete();
            setShowNewJobModal(false);
          }}
        />
      )}
    </div>
  );
}