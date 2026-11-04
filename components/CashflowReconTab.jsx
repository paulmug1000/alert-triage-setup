import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";
import CashflowWorkbenchView from "./CashflowWorkbenchView";
import EditClientSelector from "./EditClientSelector";

const DARK_GREEN = "#14532d";
const RESOLVED_GREEN = "#d9ead3";

function parseAmount(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const str = String(val).trim();
  const isParen = /^\(.*\)$/.test(str);
  const clean = str.replace(/[£,\s()]/g, "");
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  return isParen ? -num : num;
}

function formatGBP(num) {
  if (num == null || isNaN(num)) return "£0.00";
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CashflowReconTab({
  allOutgoingsClients = [],
  eomMonthKey = "",
  automationCommanderSheetId = "",
  initialClient = "",
  onClearInitialClient,
  onTaskMarkedDone,
  eomAllTasks = [],
  eomStatusOverrides = [],
  styles = {},
  managedClient,
  onClearManagedClient
}) {
  const { user } = useAuth();
  const isAdmin = !user?.isReadOnly && !!(user?.isAdmin || user?.role === "Admin");

  const [selectedClient, setSelectedClient] = useState(initialClient || managedClient?.clientName || "");
  const [reconData, setReconData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // 3-Month Rolling Cashflow Modal State & Header Action Triggers
  const [isMatrixModalOpen, setIsMatrixModalOpen] = useState(false);
  const [workbenchActions, setWorkbenchActions] = useState(null);

  // Month navigation (allows shifting target month delta from default)
  const [monthDelta, setMonthDelta] = useState(0);

  // In-place editing state for adjustment cells
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Overwrite confirmation modal for "Use recon figures"
  const [overwriteModal, setOverwriteModal] = useState(null);
  const [applyingRecon, setApplyingRecon] = useState(false);
  const [applyingReconRow, setApplyingReconRow] = useState(null);
  const [resolvingCellKey, setResolvingCellKey] = useState(null);

  // Match Actuals state and modal
  const [matchingActuals, setMatchingActuals] = useState(false);
  const [showMatchConfirm, setShowMatchConfirm] = useState(false);

  // Track rows where recon has been applied during this session
  const [reconAppliedRows, setReconAppliedRows] = useState(new Set());

  // Live signed category actuals and unreconciled items pushed from CashflowWorkbenchView as bankTxns change
  const [liveSignedActuals, setLiveSignedActuals] = useState(null);
  const [liveUnreconItems, setLiveUnreconItems] = useState(null);

  // Edit adjustment modal note drafts
  const [editGeneralNote, setEditGeneralNote] = useState("");
  const [editPulseNote, setEditPulseNote] = useState("");

  // Future month offset modal
  const [offsetModal, setOffsetModal] = useState(null);
  const [savingOffset, setSavingOffset] = useState(false);

  // Note editor modal
  const [noteModal, setNoteModal] = useState(null);
  const [generalNoteDraft, setGeneralNoteDraft] = useState("");
  const [pulseNoteDraft, setPulseNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Status for Reconciled & ready for automated P&L updates
  const [updatingReconStatus, setUpdatingReconStatus] = useState(false);
  const [outgoingsSyncStatus, setOutgoingsSyncStatus] = useState(null);

  const handleToggleReconciledComplete = async () => {
    const tabName = reconData?.reconTabName || reconData?.tabName;
    if (!currentClientInfo?.reconSheetId || !tabName || updatingReconStatus) return;
    const nextVal = !reconData?.isReconciledComplete;
    setUpdatingReconStatus(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_recon_month_ready",
          reconSheetId: currentClientInfo.reconSheetId,
          tabName,
          isComplete: nextVal,
          clientName: selectedClient,
          clientSheetId: currentClientInfo?.clientSheetId,
          masterSheetId: currentClientInfo?.masterSheetId,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to update status");

      setReconData(prev => prev ? ({ ...prev, isReconciledComplete: nextVal }) : prev);
      setUpdatingReconStatus(false);

      // Show subtle inline progress beneath the checkbox while Outgoings actuals sync runs
      setOutgoingsSyncStatus({
        state: "syncing",
        text: nextVal
          ? "Pushing reconciled actuals to Outgoings…"
          : "Reverting month to forecast in Outgoings…"
      });

      try {
        const syncResp = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sync_client_expense_breakdown",
            clientName: selectedClient,
            clientSheetId: currentClientInfo?.clientSheetId,
            masterSheetId: currentClientInfo?.masterSheetId,
            automationCommanderSheetId
          })
        });
        const syncData = await syncResp.json();
        if (syncData?.success) {
          setOutgoingsSyncStatus({
            state: "done",
            text: nextVal
              ? "✓ Outgoings updated with actuals"
              : "✓ Outgoings reverted to forecast"
          });
          setTimeout(() => {
            setOutgoingsSyncStatus(prev => (prev?.state === "done" ? null : prev));
          }, 8000);
        } else {
          throw new Error(syncData?.error || "Sync returned an error");
        }
      } catch (syncErr) {
        console.warn("Failed to trigger P&L breakdown sync:", syncErr);
        setOutgoingsSyncStatus({
          state: "error",
          text: "Could not push actuals to Outgoings — please try toggling again"
        });
        setTimeout(() => {
          setOutgoingsSyncStatus(prev => (prev?.state === "error" ? null : prev));
        }, 8000);
      }
    } catch (err) {
      setError(`Failed to update reconciliation status: ${err.message}`);
      setTimeout(() => setError(""), 4000);
    } finally {
      setUpdatingReconStatus(false);
    }
  };

  // Auto-restore or sync client
  useEffect(() => {
    if (managedClient?.clientName && managedClient.clientName !== selectedClient) {
      setSelectedClient(managedClient.clientName);
    } else if (initialClient && initialClient !== selectedClient) {
      setSelectedClient(initialClient);
      if (onClearInitialClient) onClearInitialClient();
    }
  }, [initialClient, onClearInitialClient, managedClient, selectedClient]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient("");
      setReconData(null);
      if (onClearInitialClient) onClearInitialClient();
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_cashflow_recon_client");
      }
    }
  };

  const currentClientInfo = useMemo(() => {
    return (allOutgoingsClients || []).find(c => c.clientName === selectedClient) || null;
  }, [allOutgoingsClients, selectedClient]);

  // Compute effective eomMonthKey considering monthDelta
  const effectiveMonthKey = useMemo(() => {
    if (!eomMonthKey || !/^\d{4}-\d{2}$/.test(eomMonthKey)) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
    if (monthDelta === 0) return eomMonthKey;
    const [y, m] = eomMonthKey.split("-").map(Number);
    const shifted = new Date(y, m - 1 + monthDelta, 1);
    return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
  }, [eomMonthKey, monthDelta]);

  // Load Cashflow Recon Data
  const loadData = useCallback(async (clientNameToLoad, { silent = false } = {}) => {
    const targetName = clientNameToLoad || selectedClient;
    const clientObj = (allOutgoingsClients || []).find(c => c.clientName === targetName);
    if (!clientObj || !clientObj.clientSheetId) {
      setReconData(null);
      return;
    }

    if (silent) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
      setSuccessMsg("");
    }
    setError("");

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_cashflow_recon_data",
          clientSheetId: clientObj.clientSheetId,
          reconSheetUrl: clientObj.reconSheetUrl,
          reconSheetId: clientObj.reconSheetId,
          eomMonthKey: effectiveMonthKey,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load cashflow recon data");
      }
      setReconData(data);
    } catch (err) {
      console.error("Error loading cashflow recon data:", err);
      setError(err.message);
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [selectedClient, allOutgoingsClients, effectiveMonthKey, automationCommanderSheetId]);

  useEffect(() => {
    setLiveSignedActuals(null);
    if (selectedClient) {
      sessionStorage.setItem("pma_cashflow_recon_client", selectedClient);
      loadData(selectedClient);
    } else {
      setReconData(null);
    }
  }, [selectedClient, loadData]);

  // Effective recon actuals: prefer live calculated totals from workbench if available, else sheet actuals
  const effectiveReconActuals = useMemo(() => {
    return liveSignedActuals || reconData?.reconActuals || null;
  }, [liveSignedActuals, reconData?.reconActuals]);

  // Option A: Combined Transfers mode when KeyInfo!B10 is "Transfers" and client hasn't split transfers into separate Corp tax / VAT categories
  const isCombinedTransferMode = useMemo(() => {
    if (!reconData?.isTransfersMode) return false;
    if (!effectiveReconActuals) return true;
    const transferAmt = Math.abs(effectiveReconActuals.transfer || 0);
    const corpAmt = Math.abs(effectiveReconActuals.corpTax || 0);
    const vatAmt = Math.abs(effectiveReconActuals.vat || 0);
    if (transferAmt < 0.005 && (corpAmt >= 0.005 || vatAmt >= 0.005)) {
      return false;
    }
    return true;
  }, [reconData?.isTransfersMode, effectiveReconActuals]);

  const combinedTransferTxVal = useMemo(() => {
    if (!effectiveReconActuals) return null;
    return isCombinedTransferMode
      ? (effectiveReconActuals.transfer || 0)
      : (effectiveReconActuals.transfer || 0) + (effectiveReconActuals.corpTax || 0) + (effectiveReconActuals.vat || 0);
  }, [effectiveReconActuals, isCombinedTransferMode]);

  // Helper: retrieves transaction amount for a given category from effective recon actuals
  const getCategoryTxAmount = useCallback((itemType, rowLabel = "") => {
    if (!effectiveReconActuals) return null;
    const recon = effectiveReconActuals;
    if (itemType === "tax_transfer") return combinedTransferTxVal ?? 0;
    if (itemType === "confirmed_cash") return recon.revenue ?? 0;
    if (itemType === "salaries") return recon.salaries ?? 0;
    if (itemType === "dividends") return recon.dividends ?? 0;
    if (itemType === "contractors") return recon.contractors ?? 0;
    if (itemType === "direct_costs") return recon.directCosts ?? 0;
    if (itemType === "other_expenses") return recon.outgoings ?? 0;
    if (itemType === "corporation_tax") return recon.corpTax ?? 0;
    if (itemType === "vat") return recon.vat ?? 0;
    if (itemType === "non_operating_income") return recon.nonOperatingIncome ?? 0;
    if (itemType === "non_operating_expenses") return recon.nonOperatingExpenses ?? 0;
    if (itemType === "other_cash_movements") return recon.other ?? 0;

    // Fallback based on label text if mappedItemType was not set
    const l = (rowLabel || "").toLowerCase();
    if (l.includes("revenue") || l.includes("confirmed cash") || l.includes("incoming cash")) return recon.revenue ?? 0;
    if (l.includes("salar") || l.includes("payroll") || l.includes("paye") || l.includes("pension")) return recon.salaries ?? 0;
    if (l.includes("dividend")) return recon.dividends ?? 0;
    if (l.includes("contractor")) return recon.contractors ?? 0;
    if (l.includes("direct cost")) return recon.directCosts ?? 0;
    if (l.includes("other expense") || l.includes("outgoing") || l.includes("overhead")) return recon.outgoings ?? 0;
    if (l.includes("corp")) return recon.corpTax ?? 0;
    if (l.includes("vat")) return recon.vat ?? 0;
    if (l.includes("non-operating income")) return recon.nonOperatingIncome ?? 0;
    if (l.includes("non-operating expense")) return recon.nonOperatingExpenses ?? 0;
    if (l.includes("other cash movement")) return recon.other ?? 0;

    return null;
  }, [effectiveReconActuals, combinedTransferTxVal]);

  // Target and next month column info
  const targetCol = useMemo(() => {
    if (!reconData?.selectedCols) return null;
    return reconData.selectedCols.find(c => c.type === "target") || reconData.selectedCols[1] || null;
  }, [reconData]);

  const nextCol = useMemo(() => {
    if (!reconData?.selectedCols) return null;
    return reconData.selectedCols.find(c => c.type === "next") || reconData.selectedCols[2] || null;
  }, [reconData]);

  // Parse a raw cell note into internal general note + client-facing Pulse note
  const parseNoteParts = useCallback((rawNote) => {
    const raw = String(rawNote || "");
    const match = raw.match(/\[Note:\s*([^\]]+)\]/i);
    if (match) {
      return {
        generalNote: raw.replace(match[0], "").replace(/\n\s*\n/g, "\n").trim(),
        pulseNote: match[1].trim()
      };
    }
    return { generalNote: raw.trim(), pulseNote: "" };
  }, []);

  const formatCombinedNote = useCallback((generalText, pulseText) => {
    const g = String(generalText || "").trim();
    const p = String(pulseText || "").trim();
    if (g && p) return `${g}\n[Note: ${p}]`;
    if (p) return `[Note: ${p}]`;
    if (g) return g;
    return "";
  }, []);

  // Match unreconciled items belonging to a Cash row or adjustment row
  const getUnreconItemsForRow = useCallback((mappedItemType, rowLabel = "") => {
    const list = liveUnreconItems || reconData?.unreconciledItems || [];
    if (!list || list.length === 0) return [];
    const l = String(rowLabel || "").toLowerCase();

    return list.filter(u => {
      const cat = String(u.cashflowCategory || u.suggestedCategory || u.category || "").toLowerCase();
      const rawAmt = parseAmount(u.amount || u.inAmount || u.outAmount);
      const isOutflow = u.isNegative !== undefined ? Boolean(u.isNegative) : (parseAmount(u.outAmount) > 0 || rawAmt < 0);

      if (mappedItemType === "confirmed_cash" || l.includes("incoming cash") || l.includes("confirmed cash") || l.includes("revenue")) {
        return cat === "revenue" || (!isOutflow && (!cat || cat === "revenue"));
      }
      if (mappedItemType === "salaries" || l.includes("salar")) {
        return cat === "salaries" || cat === "paye" || cat === "pension";
      }
      if (mappedItemType === "dividends" || l.includes("dividend")) {
        return cat === "dividends";
      }
      if (mappedItemType === "contractors" || l.includes("contractor")) {
        return cat === "contractors";
      }
      if (mappedItemType === "direct_costs" || l.includes("direct cost")) {
        return cat === "direct costs";
      }
      if (mappedItemType === "other_expenses" || l.includes("other expense")) {
        return cat === "outgoings" || (isOutflow && (!cat || !["salaries", "paye", "pension", "dividends", "contractors", "direct costs", "vat", "corp tax", "transfer", "other"].includes(cat)));
      }
      if (mappedItemType === "corporation_tax" || l.includes("corporation tax")) {
        return cat === "corp tax";
      }
      if (mappedItemType === "vat" || mappedItemType === "tax_transfer" || l.includes("vat")) {
        return cat === "vat" || cat === "transfer";
      }
      if (mappedItemType === "other_cash_movements" || l.includes("other adjustment") || l.includes("other cash")) {
        return cat === "other";
      }
      return false;
    });
  }, [liveUnreconItems, reconData?.unreconciledItems]);

  // Generate context-aware suggested internal & client-facing Pulse notes
  const generateSuggestedNotesForRow = useCallback(({
    rowLabel = "",
    mappedItemType = "",
    targetMonthLabel = "",
    nextMonthLabel = "",
    targetAdjVal = 0,
    nextOffsetVal = null,
    isLinkedOffset = false
  }) => {
    const tMonth = targetMonthLabel || targetCol?.label || reconData?.targetMonthLabel || "this month";
    const nMonth = nextMonthLabel || nextCol?.label || "next month";
    const cleanTitle = String(rowLabel || "Cashflow")
      .replace(/^\s*↳\s*/i, "")
      .replace(/\b(adjustment|adjustments|outgoing|incoming)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "Cashflow";
    const cleanLower = mappedItemType === "tax_transfer"
      ? "tax transfers (Corporation tax & VAT)"
      : cleanTitle.toLowerCase();
    const isInflowCat = mappedItemType === "confirmed_cash" || mappedItemType === "non_operating_income" ||
      cleanLower.includes("incoming") || cleanLower.includes("confirmed cash") || cleanLower.includes("revenue");

    const unreconForCat = getUnreconItemsForRow(mappedItemType, rowLabel);
    let unreconSummary = "";
    if (unreconForCat.length > 0) {
      const sample = unreconForCat.slice(0, 2).map(u => {
        const p = String(u.payee || u.particulars || "item").trim();
        const a = Math.abs(parseAmount(u.amount || u.inAmount || u.outAmount));
        return `${p} ${formatGBP(a)}`;
      }).join(", ");
      unreconSummary = unreconForCat.length > 2
        ? `${sample} + ${unreconForCat.length - 2} more`
        : sample;
    }

    const absTarget = Math.abs(Number(targetAdjVal) || 0);
    const fmtTargetAbs = formatGBP(absTarget);
    const fmtTargetSigned = formatGBP(Number(targetAdjVal) || 0);

    // Case 1: Single-month adjustment (no Next Month offset)
    if (nextOffsetVal === null || nextOffsetVal === undefined) {
      if (unreconForCat.length > 0) {
        return {
          targetGeneral: `Reconciled ${cleanLower} to ${tMonth} bank actuals (${fmtTargetSigned} adjustment; includes unreconciled ${isInflowCat ? "receipt" : "payment"}: ${unreconSummary}).`,
          targetPulse: isInflowCat
            ? `Includes ${fmtTargetAbs} received in the bank in ${tMonth} awaiting invoice reconciliation.`
            : `Adjusted by ${fmtTargetSigned} to match actual ${cleanLower} paid in ${tMonth} (includes items awaiting reconciliation).`,
          nextGeneral: "",
          nextPulse: ""
        };
      }
      return {
        targetGeneral: `Reconciled ${cleanLower} to ${tMonth} bank transactions (${fmtTargetSigned} adjustment).`,
        targetPulse: `Adjusted by ${fmtTargetSigned} to align with actual ${cleanLower} bank transactions in ${tMonth}.`,
        nextGeneral: "",
        nextPulse: ""
      };
    }

    // Case 2: Two-month offset (Target Month + Next Month)
    const numNext = Number(nextOffsetVal) || 0;
    const absNext = Math.abs(numNext);
    const fmtNextAbs = formatGBP(absNext);
    const fmtNextSigned = formatGBP(numNext);

    // 2a. Unreconciled receipt / payment timing lag (e.g. Thrive £4,350 unreconciled payment)
    if (unreconForCat.length > 0 || (isLinkedOffset && isInflowCat)) {
      const detailText = unreconSummary ? ` (${unreconSummary})` : ` (${fmtTargetAbs})`;
      return {
        targetGeneral: `Includes unreconciled bank ${isInflowCat ? "receipt" : "payment"}${detailText} in ${tMonth} not yet matched in accounting software. Linked offset applied in ${nMonth}.`,
        targetPulse: isInflowCat
          ? `Includes ${fmtTargetAbs} received in the bank in ${tMonth} awaiting invoice reconciliation.`
          : `Includes ${fmtTargetAbs} paid in ${tMonth} awaiting bill reconciliation.`,
        nextGeneral: isLinkedOffset
          ? `Auto-reversing offset (${fmtNextSigned}) for ${tMonth} unreconciled ${cleanLower}${detailText} whose open invoice/bill pushed into ${nMonth}. Automatically clears once reconciled.`
          : `Offset (${fmtNextSigned}) for ${tMonth} unreconciled ${cleanLower}${detailText} carried into ${nMonth}.`,
        nextPulse: isInflowCat
          ? `Adjusted by ${fmtNextSigned} to reflect revenue already received in the bank in ${tMonth}.`
          : `Adjusted by ${fmtNextSigned} to reflect ${cleanLower} already paid in ${tMonth}.`
      };
    }

    // 2b. Partial or full cash deferral / early payment across months (e.g. Orinoco salary deferral)
    if (!isInflowCat && targetAdjVal > 0 && numNext < 0) {
      return {
        targetGeneral: `Reconciled ${cleanLower} to ${tMonth} bank actuals (${fmtTargetSigned} vs forecast). ${fmtNextAbs} deferred to ${nMonth}.`,
        targetPulse: `Adjusted to match actual ${cleanLower} paid in ${tMonth} (${fmtNextAbs} deferred to ${nMonth}).`,
        nextGeneral: `Carry-over ${cleanLower} outflow (${fmtNextSigned}) deferred from ${tMonth}.`,
        nextPulse: `Includes ${fmtNextAbs} of ${tMonth} ${cleanLower} deferred into ${nMonth}.`
      };
    }

    if (!isInflowCat && targetAdjVal < 0 && numNext > 0) {
      return {
        targetGeneral: `Reconciled ${cleanLower} to ${tMonth} bank actuals (${fmtTargetSigned} vs forecast). ${fmtNextAbs} offset in ${nMonth}.`,
        targetPulse: `Adjusted to match actual ${cleanLower} paid in ${tMonth} (includes ${fmtNextAbs} paid ahead of ${nMonth}).`,
        nextGeneral: `Offset (${fmtNextSigned}) for ${cleanLower} already paid in ${tMonth}.`,
        nextPulse: `Reduced by ${fmtNextAbs} for ${cleanLower} already paid in ${tMonth}.`
      };
    }

    return {
      targetGeneral: `Reconciled ${cleanLower} for ${tMonth} (${fmtTargetSigned} adjustment) with ${fmtNextSigned} offset in ${nMonth}.`,
      targetPulse: `Adjusted by ${fmtTargetSigned} to reflect ${tMonth} timing difference carried into ${nMonth}.`,
      nextGeneral: `${isLinkedOffset ? "Auto-reversing offset" : "Carry-over adjustment"} (${fmtNextSigned}) from ${tMonth} ${cleanLower}.`,
      nextPulse: `Adjusted by ${fmtNextSigned} to offset ${tMonth} ${cleanLower} timing difference.`
    };
  }, [targetCol, nextCol, reconData?.targetMonthLabel, getUnreconItemsForRow]);

  // Helper: check if recon figure is actively in use for a row
  const isReconUsedForRow = useCallback((row) => {
    if (!row.mappedItemType || !row.targetAdjustmentRow || !effectiveReconActuals || !reconData?.rows) return false;

    // Check destination adjustment cell formula in target month column
    const adjRowObj = reconData.rows.find(r => r.sheetRow === row.targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetCol?.colIdx);
    const raw = adjCell?.rawVal;
    if (typeof raw === "string" && (raw.startsWith("=") || /^['’]=/.test(raw))) {
      let reconVal = 0;
      if (row.mappedItemType === "confirmed_cash") reconVal = effectiveReconActuals.revenue;
      else if (row.mappedItemType === "salaries") reconVal = effectiveReconActuals.salaries;
      else if (row.mappedItemType === "dividends") reconVal = effectiveReconActuals.dividends;
      else if (row.mappedItemType === "contractors") reconVal = effectiveReconActuals.contractors;
      else if (row.mappedItemType === "direct_costs") reconVal = effectiveReconActuals.directCosts;
      else if (row.mappedItemType === "other_expenses") reconVal = effectiveReconActuals.outgoings;
      else if (row.mappedItemType === "corporation_tax") reconVal = effectiveReconActuals.corpTax;
      else if (row.mappedItemType === "vat") reconVal = effectiveReconActuals.vat;
      else if (row.mappedItemType === "non_operating_income") reconVal = effectiveReconActuals.nonOperatingIncome;
      else if (row.mappedItemType === "non_operating_expenses") reconVal = effectiveReconActuals.nonOperatingExpenses;
      else if (row.mappedItemType === "other_cash_movements") reconVal = effectiveReconActuals.other;

      const reconFixed = reconVal !== undefined && reconVal !== null ? Number(reconVal).toFixed(2) : "";
      if (reconFixed && (raw.includes(reconFixed) || raw.replace(/^['’]/, "").includes(reconFixed))) {
        return true;
      }
    }
    return false;
  }, [reconData, effectiveReconActuals, targetCol]);

  // Helper: check if combined transfer recon figure is actively in use on VAT adjustment row
  const isReconUsedForTransfer = useCallback((elem) => {
    const vatAdjRowNum = elem?.vatAdjRow?.sheetRow;
    if (!vatAdjRowNum || !reconData?.rows || combinedTransferTxVal === null) return false;

    const adjRowObj = reconData.rows.find(r => r.sheetRow === vatAdjRowNum);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetCol?.colIdx);
    const raw = adjCell?.rawVal;
    if (typeof raw === "string" && (raw.startsWith("=") || /^['’]=/.test(raw))) {
      const cleanRaw = raw.replace(/^['’]/, "").toUpperCase();
      const fixedStr = combinedTransferTxVal.toFixed(2);
      const intStr = String(Math.round(combinedTransferTxVal));
      if (cleanRaw.includes("SUM") && (cleanRaw.includes(fixedStr) || cleanRaw.includes(intStr))) {
        return true;
      }
    }
    return false;
  }, [reconData, combinedTransferTxVal, targetCol]);

  // Handle Mark Resolved Toggle
  const handleToggleResolved = async (cell) => {
    if (!reconData || !currentClientInfo || !cell) return;
    const cellKey = `${cell.sheetRow}_${cell.colIdx}`;
    if (resolvingCellKey === cellKey) return;
    const targetState = !cell.isResolved;
    setResolvingCellKey(cellKey);
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_cash_cell_resolved",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          sheetRow: cell.sheetRow,
          colIdx: cell.colIdx,
          resolved: targetState,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to update resolved status");

      // Update local state optimistically
      setReconData(prev => {
        if (!prev) return prev;
        const newRows = prev.rows.map(r => {
          if (r.sheetRow !== cell.sheetRow) return r;
          const newCells = r.cells.map(c => {
            if (c.colIdx !== cell.colIdx) return c;
            return {
              ...c,
              isResolved: targetState,
              bg: targetState ? RESOLVED_GREEN : null
            };
          });
          return { ...r, cells: newCells };
        });
        return { ...prev, rows: newRows };
      });
      setSuccessMsg(isAdmin ? (targetState ? `Cell ${cell.colLetter}${cell.sheetRow} marked resolved.` : `Cell ${cell.colLetter}${cell.sheetRow} un-marked.`) : (targetState ? "Item marked resolved." : "Item unmarked."));
    } catch (err) {
      console.error("Error toggling resolved:", err);
      setError(err.message);
    } finally {
      setResolvingCellKey(null);
    }
  };

  // Open Edit Cell Modal / Input
  const handleStartEdit = (row, cell) => {
    const colObj = (reconData?.selectedCols || []).find(c => c.colIdx === cell.colIdx || c.colLetter === cell.colLetter);
    const parentBaseRow = (reconData?.rows || []).find(r => r.targetAdjustmentRow === row.sheetRow);
    const mappedType = row.mappedItemType || parentBaseRow?.mappedItemType || "";
    const curNum = (cell?.numVal !== undefined && cell?.numVal !== null) ? cell.numVal : parseAmount(cell?.v);

    setEditingCell({
      sheetRow: row.sheetRow,
      colIdx: cell.colIdx,
      colLetter: cell.colLetter,
      colLabel: colObj?.label || reconData?.targetMonthLabel || "",
      label: row.label,
      mappedItemType: mappedType,
      currentValue: cell.v,
      rawValue: cell.rawVal ?? cell.v,
      currentNote: cell.note || ""
    });
    const rawStr = cell.rawVal !== null && cell.rawVal !== undefined ? String(cell.rawVal) : (cell.v || "");
    const cleanRaw = rawStr.replace(/^['’]=/, "=");
    if (!isAdmin && cleanRaw.startsWith("=")) {
      const displayNum = cell.v ? String(cell.v).replace(/[£,\s]/g, "") : "0";
      setEditValue(displayNum);
    } else {
      setEditValue(cleanRaw);
    }

    const existingParts = parseNoteParts(cell.note || "");
    if (existingParts.generalNote || existingParts.pulseNote) {
      setEditGeneralNote(existingParts.generalNote);
      setEditPulseNote(existingParts.pulseNote);
    } else if (Math.abs(curNum) >= 0.005) {
      const suggested = generateSuggestedNotesForRow({
        rowLabel: parentBaseRow?.label || row.label,
        mappedItemType: mappedType,
        targetMonthLabel: colObj?.label || reconData?.targetMonthLabel || "",
        targetAdjVal: curNum,
        nextOffsetVal: null
      });
      setEditGeneralNote(suggested.targetGeneral);
      setEditPulseNote(suggested.targetPulse);
    } else {
      setEditGeneralNote("");
      setEditPulseNote("");
    }
  };

  // Optimistically update adjustment cell(s) and summary rows in local state so the table updates in place without flashing
  const applyOptimisticCellUpdates = useCallback((adjustmentsList = [], colLetter, resolvedRowNums = []) => {
    setReconData(prev => {
      if (!prev || !prev.rows) return prev;
      const targetColObj = (prev.selectedCols || []).find(c => c.colLetter === colLetter) ||
        (prev.selectedCols || []).find(c => c.type === "target");
      if (!targetColObj) return prev;
      const colIdx = targetColObj.colIdx;

      const resolvedSet = new Set(resolvedRowNums);
      const adjMap = new Map();
      let totalDelta = 0;

      adjustmentsList.forEach(({ sheetRow, rawVal, note }) => {
        const adjRow = prev.rows.find(r => r.sheetRow === sheetRow);
        const adjCell = adjRow?.cells.find(c => c.colIdx === colIdx);
        const oldVal = (adjCell?.numVal !== undefined && adjCell?.numVal !== null) ? adjCell.numVal : parseAmount(adjCell?.v);
        let newNumVal = null;

        const str = rawVal !== null && rawVal !== undefined ? String(rawVal).trim() : "";
        const formulaMatch = str.match(/^=\s*(-?\d+(?:\.\d+)?)\s*-\s*([A-Z]+)(\d+)$/i);
        const sumFormulaMatch = str.match(/^=\s*(-?\d+(?:\.\d+)?)\s*-\s*SUM\(\s*([A-Z]+)(\d+)\s*:\s*([A-Z]+)(\d+)\s*\)$/i);
        const addFormulaMatch = str.match(/^=\s*(-?\d+(?:\.\d+)?)\s*-\s*\(\s*([A-Z]+)(\d+)\s*\+\s*([A-Z]+)(\d+)\s*\+\s*([A-Z]+)(\d+)\s*\)$/i);
        const negCellMatch = str.match(/^=\s*-\s*([A-Z]+)(\d+)$/i);
        if (formulaMatch) {
          const targetTotal = parseFloat(formulaMatch[1]);
          const refRowNum = parseInt(formulaMatch[3], 10);
          const refRow = prev.rows.find(r => r.sheetRow === refRowNum);
          const refCell = refRow?.cells.find(c => c.colIdx === colIdx);
          const refVal = (refCell?.numVal !== undefined && refCell?.numVal !== null) ? refCell.numVal : parseAmount(refCell?.v);
          newNumVal = targetTotal - refVal;
        } else if (sumFormulaMatch) {
          const targetTotal = parseFloat(sumFormulaMatch[1]);
          const startRow = parseInt(sumFormulaMatch[3], 10);
          const endRow = parseInt(sumFormulaMatch[5], 10);
          let sumRef = 0;
          prev.rows.forEach(r => {
            if (r.sheetRow >= startRow && r.sheetRow <= endRow) {
              const refCell = r.cells.find(c => c.colIdx === colIdx);
              const refVal = (refCell?.numVal !== undefined && refCell?.numVal !== null) ? refCell.numVal : parseAmount(refCell?.v);
              sumRef += refVal;
            }
          });
          newNumVal = targetTotal - sumRef;
        } else if (addFormulaMatch) {
          const targetTotal = parseFloat(addFormulaMatch[1]);
          const rNums = [parseInt(addFormulaMatch[3], 10), parseInt(addFormulaMatch[5], 10), parseInt(addFormulaMatch[7], 10)];
          let sumRef = 0;
          rNums.forEach(rn => {
            const refRow = prev.rows.find(r => r.sheetRow === rn);
            const refCell = refRow?.cells.find(c => c.colIdx === colIdx);
            const refVal = (refCell?.numVal !== undefined && refCell?.numVal !== null) ? refCell.numVal : parseAmount(refCell?.v);
            sumRef += refVal;
          });
          newNumVal = targetTotal - sumRef;
        } else if (negCellMatch) {
          const refColLetter = negCellMatch[1].toUpperCase();
          const refRowNum = parseInt(negCellMatch[2], 10);
          const refColObj = (prev.selectedCols || []).find(c => c.colLetter === refColLetter);
          const refRow = prev.rows.find(r => r.sheetRow === refRowNum);
          const refCell = refRow?.cells.find(c => c.colIdx === refColObj?.colIdx);
          const refVal = (refCell?.numVal !== undefined && refCell?.numVal !== null) ? refCell.numVal : parseAmount(refCell?.v);
          newNumVal = -refVal;
        } else if (str === "") {
          newNumVal = 0;
        } else if (!str.startsWith("=")) {
          newNumVal = parseAmount(str);
        }

        if (newNumVal !== null && !isNaN(newNumVal)) {
          const delta = newNumVal - oldVal;
          totalDelta += delta;
          adjMap.set(sheetRow, { rawVal: str, newNumVal, delta, note });
        } else {
          adjMap.set(sheetRow, { rawVal: str, newNumVal: null, delta: 0, note });
        }
      });

      const closingRowObj = prev.rows.find(row => (row.label || "").toLowerCase().trim() === "closing balance");
      const closingRowNum = closingRowObj?.sheetRow;

      const newRows = prev.rows.map(r => {
        const adjUpdate = adjMap.get(r.sheetRow);
        const isResolvedTarget = resolvedSet.has(r.sheetRow);
        const lowerLabel = (r.label || "").toLowerCase().trim();
        const isNetRow = lowerLabel.includes("net cash movement");
        const isClosingRow = lowerLabel === "closing balance";
        const isDiffRow = Boolean(r.isDifferenceRow);

        if (!adjUpdate && !isResolvedTarget && !(totalDelta !== 0 && (isNetRow || isClosingRow || isDiffRow))) {
          return r;
        }

        const newCells = r.cells.map(c => {
          if (c.colIdx !== colIdx) return c;
          const updated = { ...c };
          if (isResolvedTarget) {
            updated.isResolved = true;
            updated.bg = RESOLVED_GREEN;
          }
          if (adjUpdate) {
            updated.rawVal = adjUpdate.rawVal;
            if (adjUpdate.newNumVal !== null) {
              updated.numVal = adjUpdate.newNumVal;
              updated.v = formatGBP(adjUpdate.newNumVal);
            }
            if (adjUpdate.note !== undefined) {
              updated.note = adjUpdate.note;
            }
          } else if (totalDelta !== 0 && (isNetRow || isClosingRow)) {
            const curNum = (c.numVal !== undefined && c.numVal !== null) ? c.numVal : parseAmount(c.v);
            const nextNum = curNum + totalDelta;
            updated.numVal = nextNum;
            updated.v = formatGBP(nextNum);
          } else if (totalDelta !== 0 && isDiffRow && String(c.v || "").trim() !== "") {
            const curNum = (c.numVal !== undefined && c.numVal !== null) ? c.numVal : parseAmount(c.v);
            const rawUpper = String(c.rawVal || "").toUpperCase();
            const isSubtracted = closingRowNum && rawUpper.includes(`-${colLetter.toUpperCase()}${closingRowNum}`);
            const diffDelta = isSubtracted ? -totalDelta : totalDelta;
            const nextNum = curNum + diffDelta;
            updated.numVal = nextNum;
            updated.v = formatGBP(nextNum);
          }
          return updated;
        });

        return { ...r, cells: newCells };
      });

      return { ...prev, rows: newRows };
    });
  }, []);

  // Save Adjustment Edit (plus any note update entered in the Edit Adjustment modal)
  const handleSaveEdit = async () => {
    if (!editingCell || !currentClientInfo) return;
    setSavingEdit(true);
    setError("");
    try {
      const cleanVal = typeof editValue === "string" ? editValue.trim().replace(/^['’]=/, "=") : editValue;
      const targetEdit = { ...editingCell };
      const finalNote = formatCombinedNote(editGeneralNote, editPulseNote);
      const noteChanged = finalNote !== String(targetEdit.currentNote || "").trim();

      applyOptimisticCellUpdates(
        [{ sheetRow: targetEdit.sheetRow, rawVal: cleanVal, note: noteChanged ? finalNote : undefined }],
        targetEdit.colLetter
      );

      const requests = [
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_cash_adjustment",
            clientSheetId: currentClientInfo.clientSheetId,
            colLetter: targetEdit.colLetter,
            sheetRow: targetEdit.sheetRow,
            value: cleanVal,
            clientName: selectedClient,
            automationCommanderSheetId
          })
        }).then(r => r.json())
      ];

      if (noteChanged && reconData?.cashTabSheetId !== undefined && reconData?.cashTabSheetId !== null) {
        requests.push(
          fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update_cash_cell_note",
              clientSheetId: currentClientInfo.clientSheetId,
              cashTabSheetId: reconData.cashTabSheetId,
              sheetRow: targetEdit.sheetRow,
              colIdx: targetEdit.colIdx,
              note: finalNote,
              clientName: selectedClient,
              automationCommanderSheetId
            })
          }).then(r => r.json())
        );
      }

      const [res] = await Promise.all(requests);
      if (!res.success) throw new Error(res.error || "Failed to save adjustment");
      setEditingCell(null);
      setSuccessMsg(isAdmin ? `Adjustment saved to Cash!${targetEdit.colLetter}${targetEdit.sheetRow}` : "Adjustment saved.");
      // Silently reload table in background to recalculate all formula cells without unmounting
      await loadData(selectedClient, { silent: true });
    } catch (err) {
      console.error("Error saving adjustment:", err);
      setError(err.message);
      await loadData(selectedClient, { silent: true });
    } finally {
      setSavingEdit(false);
    }
  };

  // Use Recon Figures: Calculate formula and check for overwrite
  const handleUseReconFigures = (row, targetMonthCell) => {
    if (!effectiveReconActuals) {
      setError(reconData?.reconError ? `Cannot apply recon figures: ${reconData.reconError}` : "No recon actuals available for this month.");
      return;
    }

    const itemType = row.mappedItemType;
    const recon = effectiveReconActuals;
    const colLetter = targetMonthCell.colLetter;
    const cellRef = `${colLetter}${row.sheetRow}`;

    let reconVal = 0;
    let targetAdjustmentRow = row.targetAdjustmentRow;
    let formula = "";

    if (itemType === "confirmed_cash") {
      reconVal = recon.revenue || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 7; // Incoming cash adjustment row
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "salaries") {
      reconVal = recon.salaries || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 9; // Salaries adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "dividends") {
      reconVal = recon.dividends || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 11; // Dividends as salary adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "contractors") {
      reconVal = recon.contractors || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 13; // Contractors adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "direct_costs") {
      reconVal = recon.directCosts || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 15; // Direct costs adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "other_expenses") {
      reconVal = recon.outgoings || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 17; // Other expenses adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "corporation_tax") {
      reconVal = recon.corpTax || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 20; // Corporation tax adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "vat") {
      reconVal = recon.vat || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 22; // VAT adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "non_operating_income") {
      reconVal = recon.nonOperatingIncome || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 25; // Non-operating income adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "non_operating_expenses") {
      reconVal = recon.nonOperatingExpenses || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 27; // Non-operating expenses adjustment
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else if (itemType === "other_cash_movements") {
      reconVal = recon.other || 0;
      targetAdjustmentRow = row.targetAdjustmentRow || 30; // Other adjustments
      formula = `=${reconVal.toFixed(2)}-${cellRef}`;
    } else {
      return;
    }

    // Find destination adjustment row in table data
    const adjRowObj = reconData.rows.find(r => r.sheetRow === targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === targetMonthCell.colIdx);
    const currentVal = adjCell?.v ?? "";
    const rawVal = adjCell?.rawVal ?? "";
    const currentFormula = (typeof rawVal === "string" && (rawVal.startsWith("=") || /^['’]=/.test(rawVal))) ? rawVal.replace(/^['’]/, "") : "";

    // Check if cell has a non-zero value or formula
    const cleanStr = String(rawVal || currentVal).replace(/[£,\s]/g, "").trim();
    const num = parseFloat(cleanStr);
    const isNonZero = cleanStr !== "" && cleanStr !== "0" && cleanStr !== "0.00" && !isNaN(num) && num !== 0;

    if (isNonZero || currentFormula) {
      // Show warning modal
      setOverwriteModal({
        mappedItem: row.label,
        formula,
        targetRow: targetAdjustmentRow,
        colLetter,
        currentValue: currentVal,
        currentFormula,
        adjRowLabel: adjRowObj?.label || `Row ${targetAdjustmentRow}`
      });
    } else {
      // Overwrite safe: apply immediately
      executeApplyReconFormula(targetAdjustmentRow, colLetter, formula);
    }
  };

  // Option A: Combined Transfer Recon (reconciles combined Corp Tax + VAT against Transfer total via VAT adjustment row)
  const handleUseCombinedTransferRecon = (elem, targetColObj) => {
    if (!effectiveReconActuals || !elem?.corpBaseRow || !elem?.corpAdjRow || !elem?.vatBaseRow || !elem?.vatAdjRow) {
      setError("Cannot apply combined transfer recon: tax rows or actuals are missing.");
      return;
    }

    const col = targetColObj || targetCol;
    if (!col) return;
    const colLetter = col.colLetter;
    const reconVal = combinedTransferTxVal || 0;
    const targetAdjustmentRow = elem.vatAdjRow.sheetRow;

    const r1 = elem.corpBaseRow.sheetRow;
    const r2 = elem.corpAdjRow.sheetRow;
    const r3 = elem.vatBaseRow.sheetRow;
    const isContiguous = (r2 === r1 + 1) && (r3 === r2 + 1);
    const formula = isContiguous
      ? `=${reconVal.toFixed(2)}-SUM(${colLetter}${r1}:${colLetter}${r3})`
      : `=${reconVal.toFixed(2)}-(${colLetter}${r1}+${colLetter}${r2}+${colLetter}${r3})`;

    const adjRowObj = reconData.rows.find(r => r.sheetRow === targetAdjustmentRow);
    const adjCell = adjRowObj?.cells.find(c => c.colIdx === col.colIdx);
    const currentVal = adjCell?.v ?? "";
    const rawVal = adjCell?.rawVal ?? "";
    const currentFormula = (typeof rawVal === "string" && (rawVal.startsWith("=") || /^['’]=/.test(rawVal))) ? rawVal.replace(/^['’]/, "") : "";

    const cleanStr = String(rawVal || currentVal).replace(/[£,\s]/g, "").trim();
    const num = parseFloat(cleanStr);
    const isNonZero = cleanStr !== "" && cleanStr !== "0" && cleanStr !== "0.00" && !isNaN(num) && num !== 0;

    if (isNonZero || currentFormula) {
      setOverwriteModal({
        mappedItem: elem.title || "Tax transfers (Corporation tax & VAT)",
        formula,
        targetRow: targetAdjustmentRow,
        colLetter,
        currentValue: currentVal,
        currentFormula,
        adjRowLabel: adjRowObj?.label || `Row ${targetAdjustmentRow}`
      });
    } else {
      executeApplyReconFormula(targetAdjustmentRow, colLetter, formula);
    }
  };

  // Match Actuals: Applies recon figures and marks resolved across all mapped elements in target month
  const executeMatchAllActuals = async () => {
    if (!effectiveReconActuals || !targetCol || !currentClientInfo) {
      setError("Cannot match actuals: target month reconciliation actuals are not available.");
      return;
    }

    setMatchingActuals(true);
    setError("");
    setShowMatchConfirm(false);

    try {
      const recon = effectiveReconActuals;
      const colLetter = targetCol.colLetter;
      const adjustments = [];
      const resolvedRows = [];

      // Mapped items
      const mappedRows = (reconData.rows || []).filter(r => r.mappedItemType && !r.isAdjustmentRow);
      const corpBaseRow = mappedRows.find(r => r.mappedItemType === "corporation_tax");
      const vatBaseRow = mappedRows.find(r => r.mappedItemType === "vat");

      mappedRows.forEach(row => {
        const itemType = row.mappedItemType;
        if (isCombinedTransferMode && (itemType === "corporation_tax" || itemType === "vat")) {
          return; // Handled below as combined transfer
        }
        const cellRef = `${colLetter}${row.sheetRow}`;
        let reconVal = null;
        let targetRow = row.targetAdjustmentRow;

        if (itemType === "confirmed_cash") {
          reconVal = recon.revenue || 0;
        } else if (itemType === "salaries") {
          reconVal = recon.salaries || 0;
        } else if (itemType === "dividends") {
          reconVal = recon.dividends || 0;
        } else if (itemType === "contractors") {
          reconVal = recon.contractors || 0;
        } else if (itemType === "direct_costs") {
          reconVal = recon.directCosts || 0;
        } else if (itemType === "other_expenses") {
          reconVal = recon.outgoings || 0;
        } else if (itemType === "corporation_tax") {
          reconVal = recon.corpTax || 0;
        } else if (itemType === "vat") {
          reconVal = recon.vat || 0;
        } else if (itemType === "non_operating_income") {
          reconVal = recon.nonOperatingIncome || 0;
        } else if (itemType === "non_operating_expenses") {
          reconVal = recon.nonOperatingExpenses || 0;
        } else if (itemType === "other_cash_movements") {
          reconVal = recon.other || 0;
        }

        if (reconVal !== null && targetRow) {
          adjustments.push({
            sheetRow: targetRow,
            formula: `=${reconVal.toFixed(2)}-${cellRef}`
          });
          resolvedRows.push(row.sheetRow);
        }
      });

      if (isCombinedTransferMode && corpBaseRow && vatBaseRow && vatBaseRow.targetAdjustmentRow) {
        const r1 = corpBaseRow.sheetRow;
        const r2 = corpBaseRow.targetAdjustmentRow || (r1 + 1);
        const r3 = vatBaseRow.sheetRow;
        const isContiguous = (r2 === r1 + 1) && (r3 === r2 + 1);
        const transferVal = combinedTransferTxVal || 0;
        const transferFormula = isContiguous
          ? `=${transferVal.toFixed(2)}-SUM(${colLetter}${r1}:${colLetter}${r3})`
          : `=${transferVal.toFixed(2)}-(${colLetter}${r1}+${colLetter}${r2}+${colLetter}${r3})`;

        adjustments.push({
          sheetRow: vatBaseRow.targetAdjustmentRow,
          formula: transferFormula
        });
        resolvedRows.push(corpBaseRow.sheetRow, vatBaseRow.sheetRow);
      }

      applyOptimisticCellUpdates(
        adjustments.map(a => ({ sheetRow: a.sheetRow, rawVal: a.formula })),
        colLetter,
        resolvedRows
      );

      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_match_cashflow_actuals",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          colIdx: targetCol.colIdx,
          colLetter,
          adjustments,
          resolvedRows,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });

      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to match actuals");

      adjustments.forEach(a => setReconAppliedRows(prev => new Set([...prev, a.sheetRow])));
      setSuccessMsg(`Matched actuals applied and resolved for ${adjustments.length} cashflow items in ${reconData.targetMonthLabel || "target month"}.`);
      await loadData(selectedClient, { silent: true });
    } catch (err) {
      console.error("Error matching actuals:", err);
      setError(err.message);
      await loadData(selectedClient, { silent: true });
    } finally {
      setMatchingActuals(false);
    }
  };

  // Automatically keep any already-applied Recon formulas in Cashflow finalisation in sync when liveSignedActuals changes
  const prevLiveActualsRef = useRef(null);
  const autoReconSyncTimerRef = useRef(null);
  useEffect(() => {
    prevLiveActualsRef.current = null;
  }, [selectedClient, monthDelta]);

  useEffect(() => {
    if (!liveSignedActuals || !reconData?.rows || !targetCol || !currentClientInfo) return;
    const prevActuals = prevLiveActualsRef.current;
    prevLiveActualsRef.current = liveSignedActuals;
    if (!prevActuals) return; // Initial hydration only

    const colLetter = targetCol.colLetter;
    const colIdx = targetCol.colIdx;
    const mappedRows = (reconData.rows || []).filter(r => r.mappedItemType && !r.isAdjustmentRow);
    const corpBaseRow = mappedRows.find(r => r.mappedItemType === "corporation_tax");
    const vatBaseRow = mappedRows.find(r => r.mappedItemType === "vat");
    const updatesToApply = [];

    mappedRows.forEach(row => {
      const itemType = row.mappedItemType;
      if (isCombinedTransferMode && (itemType === "corporation_tax" || itemType === "vat")) return;
      const targetRow = row.targetAdjustmentRow;
      if (!targetRow) return;

      let reconVal = null;
      if (itemType === "confirmed_cash") reconVal = liveSignedActuals.revenue || 0;
      else if (itemType === "salaries") reconVal = liveSignedActuals.salaries || 0;
      else if (itemType === "dividends") reconVal = liveSignedActuals.dividends || 0;
      else if (itemType === "contractors") reconVal = liveSignedActuals.contractors || 0;
      else if (itemType === "direct_costs") reconVal = liveSignedActuals.directCosts || 0;
      else if (itemType === "other_expenses") reconVal = liveSignedActuals.outgoings || 0;
      else if (itemType === "corporation_tax") reconVal = liveSignedActuals.corpTax || 0;
      else if (itemType === "vat") reconVal = liveSignedActuals.vat || 0;
      else if (itemType === "non_operating_income") reconVal = liveSignedActuals.nonOperatingIncome || 0;
      else if (itemType === "non_operating_expenses") reconVal = liveSignedActuals.nonOperatingExpenses || 0;
      else if (itemType === "other_cash_movements") reconVal = liveSignedActuals.other || 0;
      if (reconVal === null) return;

      const adjRowObj = reconData.rows.find(r => r.sheetRow === targetRow);
      const adjCell = adjRowObj?.cells.find(c => c.colIdx === colIdx);
      const raw = typeof adjCell?.rawVal === "string" ? adjCell.rawVal.replace(/^['’]/, "").trim() : "";
      const cellRef = `${colLetter}${row.sheetRow}`;
      const reconRegex = new RegExp(`^=\\s*(-?\\d+(?:\\.\\d+)?)\\s*-\\s*${cellRef}$`, "i");
      const m = raw.match(reconRegex);
      if (m) {
        const existingTarget = parseFloat(m[1]);
        if (!isNaN(existingTarget) && Math.abs(existingTarget - reconVal) >= 0.005) {
          updatesToApply.push({
            sheetRow: targetRow,
            formula: `=${reconVal.toFixed(2)}-${cellRef}`
          });
        }
      }
    });

    if (isCombinedTransferMode && corpBaseRow && vatBaseRow && vatBaseRow.targetAdjustmentRow) {
      const targetRow = vatBaseRow.targetAdjustmentRow;
      const adjRowObj = reconData.rows.find(r => r.sheetRow === targetRow);
      const adjCell = adjRowObj?.cells.find(c => c.colIdx === colIdx);
      const raw = typeof adjCell?.rawVal === "string" ? adjCell.rawVal.replace(/^['’]/, "").trim() : "";
      if (/^=\s*(-?\d+(?:\.\d+)?)\s*-\s*(?:SUM\(|\()/i.test(raw)) {
        const m = raw.match(/^=\s*(-?\d+(?:\.\d+)?)/i);
        const existingTarget = m ? parseFloat(m[1]) : NaN;
        const transferVal = combinedTransferTxVal || 0;
        if (!isNaN(existingTarget) && Math.abs(existingTarget - transferVal) >= 0.005) {
          const r1 = corpBaseRow.sheetRow;
          const r2 = corpBaseRow.targetAdjustmentRow || (r1 + 1);
          const r3 = vatBaseRow.sheetRow;
          const isContiguous = (r2 === r1 + 1) && (r3 === r2 + 1);
          const transferFormula = isContiguous
            ? `=${transferVal.toFixed(2)}-SUM(${colLetter}${r1}:${colLetter}${r3})`
            : `=${transferVal.toFixed(2)}-(${colLetter}${r1}+${colLetter}${r2}+${colLetter}${r3})`;
          updatesToApply.push({
            sheetRow: targetRow,
            formula: transferFormula
          });
        }
      }
    }

    if (updatesToApply.length > 0) {
      applyOptimisticCellUpdates(
        updatesToApply.map(u => ({ sheetRow: u.sheetRow, rawVal: u.formula })),
        colLetter,
        []
      );
      if (autoReconSyncTimerRef.current) clearTimeout(autoReconSyncTimerRef.current);
      autoReconSyncTimerRef.current = setTimeout(async () => {
        try {
          await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "batch_match_cashflow_actuals",
              clientSheetId: currentClientInfo.clientSheetId,
              cashTabSheetId: reconData.cashTabSheetId,
              colIdx,
              colLetter,
              adjustments: updatesToApply,
              resolvedRows: [],
              clientName: selectedClient,
              automationCommanderSheetId
            })
          });
        } catch (err) {
          console.error("Failed to auto-sync updated recon formula:", err);
        }
      }, 800);
    }
  }, [liveSignedActuals, reconData?.rows, reconData?.cashTabSheetId, targetCol, currentClientInfo, isCombinedTransferMode, combinedTransferTxVal, applyOptimisticCellUpdates, selectedClient, automationCommanderSheetId]);

  const executeApplyReconFormula = async (targetRow, colLetter, formula) => {
    if (!currentClientInfo) return;
    setApplyingRecon(true);
    setApplyingReconRow(targetRow);
    setError("");
    try {
      const cleanFormula = typeof formula === "string" ? formula.trim().replace(/^['’]=/, "=") : formula;
      applyOptimisticCellUpdates([{ sheetRow: targetRow, rawVal: cleanFormula }], colLetter);
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_adjustment",
          clientSheetId: currentClientInfo.clientSheetId,
          colLetter,
          sheetRow: targetRow,
          value: cleanFormula,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to apply recon formula");
      setReconAppliedRows(prev => new Set([...prev, targetRow]));
      setOverwriteModal(null);
      setSuccessMsg(isAdmin ? `Applied formula ${cleanFormula} to Cash!${colLetter}${targetRow}` : "Reconciliation adjustment applied.");
      // Silently reload table in background so cell values sync without unmounting the table
      await loadData(selectedClient, { silent: true });
    } catch (err) {
      console.error("Error applying recon formula:", err);
      setError(err.message);
      await loadData(selectedClient, { silent: true });
    } finally {
      setApplyingRecon(false);
      setApplyingReconRow(null);
    }
  };

  // Cell Note Editor
  const handleOpenNote = (row, cell) => {
    const rawNote = cell.note || "";
    const parsed = parseNoteParts(rawNote);
    let generalDraft = parsed.generalNote;
    let pulseDraft = parsed.pulseNote;

    const colObj = (reconData?.selectedCols || []).find(c => c.colIdx === cell.colIdx || c.colLetter === cell.colLetter);
    const parentBaseRow = (reconData?.rows || []).find(r => r.targetAdjustmentRow === row.sheetRow);
    const mappedType = row.mappedItemType || parentBaseRow?.mappedItemType || "";
    const isAdj = Boolean(row.isAdjustmentRow || (row.label && row.label.toLowerCase().includes("adjustment")));
    const cellVal = (cell?.numVal !== undefined && cell?.numVal !== null) ? cell.numVal : parseAmount(cell?.v);

    if (!generalDraft && !pulseDraft && isAdj && Math.abs(cellVal) >= 0.005) {
      const suggested = generateSuggestedNotesForRow({
        rowLabel: parentBaseRow?.label || row.label,
        mappedItemType: mappedType,
        targetMonthLabel: colObj?.label || reconData?.targetMonthLabel || "",
        targetAdjVal: cellVal,
        nextOffsetVal: null
      });
      generalDraft = suggested.targetGeneral;
      pulseDraft = suggested.targetPulse;
    }

    setGeneralNoteDraft(generalDraft);
    setPulseNoteDraft(pulseDraft);
    setNoteModal({
      sheetRow: row.sheetRow,
      colIdx: cell.colIdx,
      colLetter: cell.colLetter,
      colLabel: colObj?.label || reconData?.targetMonthLabel || "",
      label: row.label,
      parentLabel: parentBaseRow?.label || row.label,
      mappedItemType: mappedType,
      cellVal,
      currentNote: rawNote,
      isAdjustmentRow: isAdj
    });
  };

  const handleSaveNote = async () => {
    if (!noteModal || !currentClientInfo || !reconData) return;
    setSavingNote(true);
    setError("");

    const finalNote = formatCombinedNote(generalNoteDraft, pulseNoteDraft);

    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cash_cell_note",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          sheetRow: noteModal.sheetRow,
          colIdx: noteModal.colIdx,
          note: finalNote,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to save note");

      // Update local state optimistically
      setReconData(prev => {
        if (!prev) return prev;
        const newRows = prev.rows.map(r => {
          if (r.sheetRow !== noteModal.sheetRow) return r;
          const newCells = r.cells.map(c => {
            if (c.colIdx !== noteModal.colIdx) return c;
            return { ...c, note: finalNote };
          });
          return { ...r, cells: newCells };
        });
        return { ...prev, rows: newRows };
      });

      setNoteModal(null);
      setSuccessMsg(isAdmin ? `Note updated on Cash!${noteModal.colLetter}${noteModal.sheetRow}` : "Note updated.");
    } catch (err) {
      console.error("Error saving note:", err);
      setError(err.message);
    } finally {
      setSavingNote(false);
    }
  };

  // Future Month Offset Modal (handles 100% auto-reversing timing offsets and partial/custom carry-overs)
  const handleOpenOffsetModal = useCallback(({
    baseRow,
    adjRow,
    title,
    mappedItemType,
    isCombinedTransfer = false,
    combinedElem = null
  }) => {
    if (!adjRow || !targetCol || !nextCol || !reconData) return;

    const targetColIndex = (reconData.selectedCols || []).findIndex(c => c.colIdx === targetCol.colIdx);
    const nextColIndex = (reconData.selectedCols || []).findIndex(c => c.colIdx === nextCol.colIdx);
    const tIdx = targetColIndex !== -1 ? targetColIndex : 1;
    const nIdx = nextColIndex !== -1 ? nextColIndex : 2;

    const targetBaseCell = baseRow?.cells?.[tIdx];
    const targetAdjCell = adjRow?.cells?.[tIdx];
    const nextAdjCell = adjRow?.cells?.[nIdx];

    let baseVal = (targetBaseCell?.numVal !== undefined && targetBaseCell?.numVal !== null)
      ? targetBaseCell.numVal
      : parseAmount(targetBaseCell?.v);
    const currentTargetAdjVal = (targetAdjCell?.numVal !== undefined && targetAdjCell?.numVal !== null)
      ? targetAdjCell.numVal
      : parseAmount(targetAdjCell?.v);
    const currentNextAdjVal = (nextAdjCell?.numVal !== undefined && nextAdjCell?.numVal !== null)
      ? nextAdjCell.numVal
      : parseAmount(nextAdjCell?.v);

    let txVal = getCategoryTxAmount(mappedItemType, title || baseRow?.label || adjRow?.label);
    let reconFormula = "";
    let reconAdjVal = currentTargetAdjVal;

    if (isCombinedTransfer && combinedElem?.corpBaseRow && combinedElem?.corpAdjRow && combinedElem?.vatBaseRow) {
      const cBase = combinedElem.corpBaseRow?.cells?.[tIdx];
      const cAdj = combinedElem.corpAdjRow?.cells?.[tIdx];
      const vBase = combinedElem.vatBaseRow?.cells?.[tIdx];
      const cBaseNum = (cBase?.numVal !== undefined && cBase?.numVal !== null) ? cBase.numVal : parseAmount(cBase?.v);
      const cAdjNum = (cAdj?.numVal !== undefined && cAdj?.numVal !== null) ? cAdj.numVal : parseAmount(cAdj?.v);
      const vBaseNum = (vBase?.numVal !== undefined && vBase?.numVal !== null) ? vBase.numVal : parseAmount(vBase?.v);
      baseVal = cBaseNum + cAdjNum + vBaseNum;
      txVal = combinedTransferTxVal ?? 0;
      reconAdjVal = txVal - baseVal;

      const r1 = combinedElem.corpBaseRow.sheetRow;
      const r2 = combinedElem.corpAdjRow.sheetRow;
      const r3 = combinedElem.vatBaseRow.sheetRow;
      const isContiguous = (r2 === r1 + 1) && (r3 === r2 + 1);
      reconFormula = isContiguous
        ? `=${txVal.toFixed(2)}-SUM(${targetCol.colLetter}${r1}:${targetCol.colLetter}${r3})`
        : `=${txVal.toFixed(2)}-(${targetCol.colLetter}${r1}+${targetCol.colLetter}${r2}+${targetCol.colLetter}${r3})`;
    } else if (baseRow && txVal !== null && txVal !== undefined) {
      reconAdjVal = txVal - baseVal;
      reconFormula = `=${txVal.toFixed(2)}-${targetCol.colLetter}${baseRow.sheetRow}`;
    }

    const isReconAlreadyUsed = isCombinedTransfer
      ? isReconUsedForTransfer(combinedElem)
      : (baseRow ? isReconUsedForRow(baseRow) : false);
    const hasUnreconciledVariance = txVal !== null && txVal !== undefined &&
      Math.abs((baseVal + currentTargetAdjVal) - txVal) >= 0.01;
    const applyTargetReconDefault = Boolean(!isReconAlreadyUsed && hasUnreconciledVariance && reconFormula);
    const effectiveTargetAdjVal = applyTargetReconDefault ? reconAdjVal : currentTargetAdjVal;

    // Detect if next month already has a linked formula or custom value
    const nextRawStr = typeof nextAdjCell?.rawVal === "string" ? nextAdjCell.rawVal.replace(/^['’]/, "").trim() : "";
    const linkedFormulaStr = `=-${targetCol.colLetter}${adjRow.sheetRow}`;
    const hasExistingNextOffset = Math.abs(currentNextAdjVal) >= 0.005 || nextRawStr.startsWith("=");
    const isExistingCustom = hasExistingNextOffset &&
      nextRawStr.toUpperCase() !== linkedFormulaStr.toUpperCase();

    const initialMode = isExistingCustom ? "custom" : "linked";
    const defaultCustomAmt = isExistingCustom
      ? currentNextAdjVal
      : Number((-effectiveTargetAdjVal).toFixed(2));
    const effectiveNextVal = initialMode === "linked"
      ? Number((-effectiveTargetAdjVal).toFixed(2))
      : defaultCustomAmt;

    const existingTargetNotes = parseNoteParts(targetAdjCell?.note || "");
    const existingNextNotes = parseNoteParts(nextAdjCell?.note || "");
    const suggested = generateSuggestedNotesForRow({
      rowLabel: title || baseRow?.label || adjRow?.label,
      mappedItemType,
      targetMonthLabel: targetCol.label,
      nextMonthLabel: nextCol.label,
      targetAdjVal: effectiveTargetAdjVal,
      nextOffsetVal: effectiveNextVal,
      isLinkedOffset: initialMode === "linked"
    });

    setOffsetModal({
      title: title || baseRow?.label || adjRow?.label,
      mappedItemType,
      baseSheetRow: baseRow?.sheetRow || null,
      adjSheetRow: adjRow.sheetRow,
      adjRowLabel: adjRow.label,
      baseVal,
      txVal,
      currentTargetAdjVal,
      reconAdjVal,
      reconFormula,
      isReconAlreadyUsed,
      hasUnreconciledVariance,
      applyTargetRecon: applyTargetReconDefault,
      hasExistingNextOffset,
      currentNextAdjVal,
      offsetMode: initialMode, // "linked" | "custom"
      customAmount: String(defaultCustomAmt),
      targetGeneralNote: existingTargetNotes.generalNote || suggested.targetGeneral,
      targetPulseNote: existingTargetNotes.pulseNote || suggested.targetPulse,
      nextGeneralNote: existingNextNotes.generalNote || suggested.nextGeneral,
      nextPulseNote: existingNextNotes.pulseNote || suggested.nextPulse
    });
  }, [targetCol, nextCol, reconData, getCategoryTxAmount, combinedTransferTxVal, isReconUsedForTransfer, isReconUsedForRow, parseNoteParts, generateSuggestedNotesForRow]);

  const handleRefreshOffsetSuggestedNotes = useCallback((modalState) => {
    const m = modalState || offsetModal;
    if (!m || !targetCol || !nextCol) return;
    const effectiveTargetAdj = m.applyTargetRecon ? m.reconAdjVal : m.currentTargetAdjVal;
    const effectiveNextVal = m.offsetMode === "linked"
      ? -effectiveTargetAdj
      : (parseFloat(String(m.customAmount || "0").replace(/[£,\s]/g, "")) || 0);
    const suggested = generateSuggestedNotesForRow({
      rowLabel: m.title,
      mappedItemType: m.mappedItemType,
      targetMonthLabel: targetCol.label,
      nextMonthLabel: nextCol.label,
      targetAdjVal: effectiveTargetAdj,
      nextOffsetVal: effectiveNextVal,
      isLinkedOffset: m.offsetMode === "linked"
    });
    setOffsetModal(prev => prev ? ({
      ...prev,
      targetGeneralNote: suggested.targetGeneral,
      targetPulseNote: suggested.targetPulse,
      nextGeneralNote: suggested.nextGeneral,
      nextPulseNote: suggested.nextPulse
    }) : prev);
  }, [offsetModal, targetCol, nextCol, generateSuggestedNotesForRow]);

  const handleSaveOffset = async (clearNextOnly = false) => {
    if (!offsetModal || !currentClientInfo || !reconData || !targetCol || !nextCol) return;
    setSavingOffset(true);
    setError("");

    try {
      const m = offsetModal;
      const linkedFormula = `=-${targetCol.colLetter}${m.adjSheetRow}`;
      let nextValueToWrite = "";
      if (!clearNextOnly) {
        if (m.offsetMode === "linked") {
          nextValueToWrite = linkedFormula;
        } else {
          const cleanCustom = String(m.customAmount || "0").replace(/[£,\s]/g, "").trim();
          nextValueToWrite = cleanCustom || "0";
        }
      }

      const targetValueToWrite = (!clearNextOnly && m.applyTargetRecon && m.reconFormula)
        ? m.reconFormula
        : undefined;

      const targetNoteCombined = clearNextOnly
        ? undefined
        : formatCombinedNote(m.targetGeneralNote, m.targetPulseNote);
      const nextNoteCombined = clearNextOnly
        ? ""
        : formatCombinedNote(m.nextGeneralNote, m.nextPulseNote);

      // Optimistically update target column (if applying target recon or note) and next column
      if (targetValueToWrite !== undefined) {
        applyOptimisticCellUpdates(
          [{ sheetRow: m.adjSheetRow, rawVal: targetValueToWrite, note: targetNoteCombined }],
          targetCol.colLetter
        );
      } else if (targetNoteCombined !== undefined) {
        setReconData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            rows: prev.rows.map(r => r.sheetRow !== m.adjSheetRow ? r : {
              ...r,
              cells: r.cells.map(c => c.colIdx !== targetCol.colIdx ? c : { ...c, note: targetNoteCombined })
            })
          };
        });
      }

      applyOptimisticCellUpdates(
        [{ sheetRow: m.adjSheetRow, rawVal: nextValueToWrite, note: nextNoteCombined }],
        nextCol.colLetter
      );

      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply_cash_future_offset",
          clientSheetId: currentClientInfo.clientSheetId,
          cashTabSheetId: reconData.cashTabSheetId,
          sheetRow: m.adjSheetRow,
          targetColLetter: targetCol.colLetter,
          targetColIdx: targetCol.colIdx,
          targetValue: targetValueToWrite,
          targetNote: targetNoteCombined,
          nextColLetter: nextCol.colLetter,
          nextColIdx: nextCol.colIdx,
          nextValue: nextValueToWrite,
          nextNote: nextNoteCombined,
          clientName: selectedClient,
          automationCommanderSheetId
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to save future month offset");

      if (targetValueToWrite !== undefined) {
        setReconAppliedRows(prev => new Set([...prev, m.adjSheetRow]));
      }
      setOffsetModal(null);
      setSuccessMsg(
        clearNextOnly
          ? `Cleared ${nextCol.label} offset for ${m.title}.`
          : `Saved ${nextCol.label} offset and notes for ${m.title}.`
      );
      await loadData(selectedClient, { silent: true });
    } catch (err) {
      console.error("Error saving future month offset:", err);
      setError(err.message);
      await loadData(selectedClient, { silent: true });
    } finally {
      setSavingOffset(false);
    }
  };

  // Find linked shared task if any
  const linkedTask = useMemo(() => {
    return (eomAllTasks || []).find(t =>
      t.clientName === selectedClient &&
      (t.linkedFunction === "cashflow_recon" ||
        (t.name && t.name.toLowerCase().includes("reconcile cashflow forecast against actual")))
    );
  }, [eomAllTasks, selectedClient]);

  // Check if linked task is already marked done
  const isLinkedTaskDone = useMemo(() => {
    if (!linkedTask) return false;
    return (eomStatusOverrides || []).find(s => s.clientName === selectedClient && s.taskId === linkedTask.taskId)?.status === "done";
  }, [eomStatusOverrides, selectedClient, linkedTask]);

  const handleShiftMonth = (delta) => {
    setReconData(null);
    setLoading(true);
    setMonthDelta(d => d + delta);
  };

  const handleResetMonth = () => {
    setReconData(null);
    setLoading(true);
    setMonthDelta(0);
  };

  // Grouped Elements for Cashflow finalisation (Cash table)
  const groupedElements = useMemo(() => {
    if (!reconData?.rows) return [];
    const rows = reconData.rows.filter(r => !r.isHeaderRow && !r.label.toLowerCase().includes("excluding pipeline"));

    const elements = [];
    const visitedRowNums = new Set();

    const corpBaseRow = rows.find(r => r.mappedItemType === "corporation_tax");
    const corpAdjRow = corpBaseRow?.targetAdjustmentRow ? rows.find(r => r.sheetRow === corpBaseRow.targetAdjustmentRow) : null;
    const vatBaseRow = rows.find(r => r.mappedItemType === "vat");
    const vatAdjRow = vatBaseRow?.targetAdjustmentRow ? rows.find(r => r.sheetRow === vatBaseRow.targetAdjustmentRow) : null;

    rows.forEach(row => {
      if (visitedRowNums.has(row.sheetRow)) return;

      const lower = row.label.toLowerCase().trim();
      if (!lower) return; // skip empty spacing rows

      // Option A: Combined Tax transfers bracketed card when client is in Transfers mode
      if (
        isCombinedTransferMode &&
        (row.mappedItemType === "corporation_tax" || row.mappedItemType === "vat") &&
        corpBaseRow && corpAdjRow && vatBaseRow && vatAdjRow
      ) {
        visitedRowNums.add(corpBaseRow.sheetRow);
        visitedRowNums.add(corpAdjRow.sheetRow);
        visitedRowNums.add(vatBaseRow.sheetRow);
        visitedRowNums.add(vatAdjRow.sheetRow);
        elements.push({
          id: `elem_tax_transfer_${corpBaseRow.sheetRow}`,
          type: "compound_transfer",
          title: "Tax transfers (Corporation tax & VAT)",
          corpTitle: corpBaseRow.label.replace(/\s*(outgoing|incoming)\s*/i, "").trim(),
          vatTitle: vatBaseRow.label.replace(/\s*(outgoing|incoming)\s*/i, "").trim(),
          corpBaseRow,
          corpAdjRow,
          vatBaseRow,
          vatAdjRow,
          mappedItemType: "tax_transfer"
        });
        return;
      }

      // Check if mapped base row with adjustment row
      if (row.mappedItemType && row.targetAdjustmentRow && row.targetAdjustmentRow !== row.sheetRow) {
        const adjRow = rows.find(r => r.sheetRow === row.targetAdjustmentRow);
        if (adjRow) {
          visitedRowNums.add(row.sheetRow);
          visitedRowNums.add(adjRow.sheetRow);
          elements.push({
            id: `elem_${row.sheetRow}`,
            type: "compound",
            title: row.label.replace(/\s*(outgoing|incoming)\s*/i, "").trim(),
            baseRow: row,
            adjRow: adjRow,
            mappedItemType: row.mappedItemType
          });
          return;
        }
      }

      // Check if adjustment row
      if (row.isAdjustmentRow) {
        visitedRowNums.add(row.sheetRow);
        elements.push({
          id: `elem_${row.sheetRow}`,
          type: "single",
          title: row.label,
          row: row,
          isAdjustment: true
        });
        return;
      }

      // Standalone row (Opening balance, Difference, Net cash movement, etc.)
      visitedRowNums.add(row.sheetRow);
      elements.push({
        id: `elem_${row.sheetRow}`,
        type: "single",
        title: row.label,
        row: row,
        mappedItemType: row.mappedItemType,
        isSummary: row.isDifferenceRow || lower.includes("closing") || lower.includes("net cash movement") || lower.includes("opening balance"),
        isDifference: row.isDifferenceRow
      });
    });

    return elements;
  }, [reconData, isCombinedTransferMode]);

  // Dynamic grid column coordinates for modern card view
  const { gridTemplateColumns, colPositions, totalColPosition, txColPosition, spacerBeforeTarget, spacerAfterTarget } = useMemo(() => {
    if (!reconData?.selectedCols || reconData.selectedCols.length === 0) {
      return {
        gridTemplateColumns: "175px 150px 16px 215px 120px 130px 16px 150px",
        colPositions: [2, 4, 8],
        totalColPosition: 5,
        txColPosition: 6,
        spacerBeforeTarget: 3,
        spacerAfterTarget: 7
      };
    }

    const parts = ["175px"];
    const positions = [];
    let currentGridCol = 2;
    let totalPos = null;
    let txPos = null;
    let spacerBefore = null;
    let spacerAfter = null;

    reconData.selectedCols.forEach((col, idx) => {
      if (col.type === "target") {
        if (idx > 0) {
          parts.push("16px"); // blank space between previous month and target month
          spacerBefore = currentGridCol;
          currentGridCol++;
        }
        positions.push(currentGridCol); // Target month column
        parts.push("215px"); // Target month column (~26% wider than original for button room)
        currentGridCol++;
        totalPos = currentGridCol;
        parts.push("120px"); // Total (Net)
        currentGridCol++;
        txPos = currentGridCol;
        parts.push("130px"); // Transaction amount
        currentGridCol++;
        if (idx < reconData.selectedCols.length - 1) {
          parts.push("16px"); // blank space between transaction amount and next month
          spacerAfter = currentGridCol;
          currentGridCol++;
        }
      } else {
        positions.push(currentGridCol);
        parts.push("150px"); // 150px provides ample room so note buttons never spill out
        currentGridCol++;
      }
    });

    return {
      gridTemplateColumns: parts.join(" "),
      colPositions: positions,
      totalColPosition: totalPos,
      txColPosition: txPos,
      spacerBeforeTarget: spacerBefore,
      spacerAfterTarget: spacerAfter
    };
  }, [reconData?.selectedCols]);

  // Reusable note trigger: amber 📝 if cell has note, subtle 💬 on hover if empty
  const renderNoteButton = (row, cell) => {
    if (!row || !cell) return null;
    const hasNote = !!cell.note;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleOpenNote(row, cell);
        }}
        title={hasNote ? `Note: ${cell.note}` : (isAdmin ? "Add cell note" : "Add note")}
        style={{
          background: hasNote ? "#fef3c7" : "transparent",
          border: hasNote ? "1px solid #fde68a" : "none",
          borderRadius: "4px",
          cursor: "pointer",
          padding: hasNote ? "1px 4px" : "1px 2px",
          fontSize: "11px",
          color: hasNote ? "#b45309" : "#cbd5e1",
          display: "inline-flex",
          alignItems: "center",
          gap: "2px",
          lineHeight: 1,
          flexShrink: 0,
          opacity: hasNote ? 1 : 0.4,
          transition: "color 0.15s, background 0.15s, opacity 0.15s"
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "1";
          if (!hasNote) e.currentTarget.style.color = "#d97706";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = hasNote ? "1" : "0.4";
          if (!hasNote) e.currentTarget.style.color = "#cbd5e1";
        }}
      >
        {hasNote ? "📝" : "💬"}
      </button>
    );
  };

  return (
    <div style={{ width: "100%", maxWidth: "100%" }}>
      {/* Top Header Card */}
      {/* Header card with title & client switcher */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
      }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {selectedClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
              <button
                type="button"
                onClick={handleBackToClients}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: "pointer",
                  padding: "6px 12px",
                  fontSize: "16px",
                  color: "#475569",
                  lineHeight: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f1f5f9";
                  e.currentTarget.style.borderColor = "#94a3b8";
                  e.currentTarget.style.color = "#0f172a";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#ffffff";
                  e.currentTarget.style.borderColor = "#cbd5e1";
                  e.currentTarget.style.color = "#475569";
                }}
                title="Back to client list"
              >
                ←
              </button>
            )}
            <div>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>Cashflow recon</span>
              </h1>
              {selectedClient ? (
                <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {selectedClient}
                </div>
              ) : (
                <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                  Select a client to reconcile cashflow
                </p>
              )}
            </div>
          </div>

          {selectedClient && (
            <button
              type="button"
              onClick={() => loadData(selectedClient, { silent: Boolean(reconData) })}
              disabled={loading || isRefreshing}
              title="Refresh cashflow and transaction data"
              style={{
                padding: "6px 12px",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                color: "#334155",
                fontSize: "12px",
                fontWeight: 600,
                cursor: (loading || isRefreshing) ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                transition: "all 0.15s ease",
                opacity: (loading || isRefreshing) ? 0.75 : 1
              }}
              onMouseEnter={(e) => {
                if (!loading && !isRefreshing) {
                  e.currentTarget.style.backgroundColor = "#f8fafc";
                  e.currentTarget.style.borderColor = "#94a3b8";
                  e.currentTarget.style.color = "#0f172a";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#cbd5e1";
                e.currentTarget.style.color = "#334155";
              }}
            >
              {(loading || isRefreshing) ? (
                <Spinner size={12} />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              )}
              <span>{(loading || isRefreshing) ? "Refreshing..." : "Refresh"}</span>
            </button>
          )}
        </div>

        {/* Selected Client Toolbar & Month Controls */}
        {selectedClient && (
          <div style={{
            marginTop: "14px",
            paddingTop: "14px",
            borderTop: "1px solid #f1f5f9",
            display: "flex",
            flexDirection: "column",
            gap: "12px"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              {/* Left: Month pill + Month arrows */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                {/* Target Month pill */}
                {reconData?.targetMonthLabel && (
                  <span style={{
                    fontSize: "15px",
                    fontWeight: "700",
                    background: "#f1f5f9",
                    color: "#1e293b",
                    border: "1px solid #e2e8f0",
                    padding: "4px 12px",
                    borderRadius: "8px"
                  }}>
                    {reconData.targetMonthLabel}
                  </span>
                )}

                {/* Month selector arrows (without Reset button) */}
                <div style={{ display: "flex", alignItems: "center", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "2px 4px", gap: "2px" }}>
                  <button
                    onClick={() => handleShiftMonth(-1)}
                    title="Previous month"
                    style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                  >
                    ◀
                  </button>
                  <button
                    onClick={() => handleShiftMonth(1)}
                    title="Next month"
                    style={{ padding: "4px 8px", background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "#475569" }}
                  >
                    ▶
                  </button>
                </div>
              </div>

              {/* Right: Reconciled & ready toggle, EoM task complete, Sheet links, and Action buttons underneath */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
                {/* Top row: Reconciled & ready + EoM complete + sheet links */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {reconData && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "3px" }}>
                      <label style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        cursor: updatingReconStatus ? "wait" : "pointer",
                        userSelect: "none",
                        padding: "5px 10px",
                        borderRadius: "6px",
                        background: reconData?.isReconciledComplete ? "#f0fdf4" : "#f8fafc",
                        border: `1px solid ${reconData?.isReconciledComplete ? "#86efac" : "#cbd5e1"}`
                      }}>
                        <input
                          type="checkbox"
                          checked={Boolean(reconData?.isReconciledComplete)}
                          disabled={updatingReconStatus}
                          onChange={handleToggleReconciledComplete}
                          style={{ width: "14px", height: "14px", cursor: "pointer", accentColor: "#15803d" }}
                        />
                        <span style={{
                          fontSize: "12px",
                          fontWeight: "600",
                          color: reconData?.isReconciledComplete ? "#15803d" : "#475569"
                        }}>
                          Reconciled & ready for automated P&L updates
                        </span>
                        {updatingReconStatus && <Spinner size={11} />}
                      </label>
                      {outgoingsSyncStatus && (
                        <div style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          paddingLeft: "4px",
                          fontSize: "11px",
                          fontWeight: "500",
                          color: outgoingsSyncStatus.state === "error"
                            ? "#dc2626"
                            : outgoingsSyncStatus.state === "done"
                              ? "#15803d"
                              : "#64748b"
                        }}>
                          {outgoingsSyncStatus.state === "syncing" && <Spinner size={10} />}
                          <span>{outgoingsSyncStatus.text}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {linkedTask && onTaskMarkedDone && (
                    <button
                      onClick={() => onTaskMarkedDone(selectedClient, linkedTask.taskId)}
                      style={{
                        padding: "6px 12px",
                        background: isLinkedTaskDone ? "#f0fdf4" : "#f1f5f9",
                        border: isLinkedTaskDone ? "1px solid #86efac" : "1px solid #cbd5e1",
                        color: isLinkedTaskDone ? "#166534" : "#475569",
                        borderRadius: "6px",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: "pointer"
                      }}
                    >
                      {isLinkedTaskDone ? "✓ EoM task marked complete" : "Mark EoM task complete"}
                    </button>
                  )}

                  {isAdmin && currentClientInfo?.clientSheetId && (
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.clientSheetId}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: "600", paddingTop: "5px" }}
                    >
                      Client sheet ↗
                    </a>
                  )}

                  {isAdmin && currentClientInfo?.reconSheetId && (
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${currentClientInfo.reconSheetId}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: "12px", color: "#0284c7", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: "600", paddingTop: "5px" }}
                    >
                      Recon sheet ↗
                    </a>
                  )}
                </div>

                {/* Sub-row directly underneath: Check for updated transactions + Restart month */}
                {workbenchActions && (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={workbenchActions.onUpdateBankTransactions}
                      disabled={workbenchActions.disabled}
                      title="Check accounting bank feeds for new, updated, or deleted transactions"
                      style={{
                        padding: "5px 10px",
                        background: "#f8fafc",
                        color: "#0369a1",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        fontSize: "11.5px",
                        fontWeight: "600",
                        cursor: workbenchActions.disabled ? "default" : "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        transition: "all 0.15s ease"
                      }}
                    >
                      {workbenchActions.updatingTxns ? <Spinner size={11} /> : null}
                      <span>Check for updated transactions</span>
                    </button>

                    <button
                      type="button"
                      onClick={workbenchActions.onRestartMonth}
                      disabled={workbenchActions.disabled}
                      title="Clear all transaction and unreconciled data and restart guided setup"
                      style={{
                        padding: "5px 10px",
                        background: "#f8fafc",
                        color: "#0369a1",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        fontSize: "11.5px",
                        fontWeight: "600",
                        cursor: workbenchActions.disabled ? "default" : "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        transition: "all 0.15s ease"
                      }}
                    >
                      Restart month
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Messages / Alerts */}
      {error && (
        <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", color: "#b91c1c", fontSize: "13px", marginBottom: "14px" }}>
          ⚠️ {error}
        </div>
      )}
      {successMsg && (
        <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", color: "#15803d", fontSize: "13px", marginBottom: "14px" }}>
          ✓ {successMsg}
        </div>
      )}

      {/* Main Content Area */}
      {!selectedClient ? (
        <EditClientSelector
          clients={allOutgoingsClients || []}
          onSelectClient={(c) => {
            const name = c.clientName || c.name || c;
            setSelectedClient(name);
          }}
          loading={loading}
          title="Select a client to reconcile cashflow:"
        />
      ) : (loading || !reconData) ? (
        <div style={{ textAlign: "center", padding: "80px 20px", background: "#ffffff", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
          <Spinner size={32} />
          <p style={{ fontSize: "14px", fontWeight: "600", color: "#1e293b", marginTop: "14px", marginBottom: "4px" }}>
            Loading cashflow recon data...
          </p>
          <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>
            Retrieving figures for the selected month.
          </p>
        </div>
      ) : (
        <>
          <CashflowWorkbenchView
            reconData={reconData}
            selectedClient={selectedClient}
            clientInfo={currentClientInfo}
            eomMonthKey={eomMonthKey}
            effectiveMonthKey={effectiveMonthKey}
            automationCommanderSheetId={automationCommanderSheetId}
            onRefresh={() => loadData(selectedClient, { silent: Boolean(reconData) })}
            onTabCreated={(tab) => {
              setReconData(prev => prev ? ({ ...prev, hasTargetTab: true, reconError: null }) : prev);
              loadData(selectedClient, { silent: Boolean(reconData) });
            }}
            isAdmin={isAdmin}
            groupedElements={groupedElements}
            targetCol={targetCol}
            nextCol={nextCol}
            isCombinedTransferMode={isCombinedTransferMode}
            combinedTransferTxVal={combinedTransferTxVal}
            getCategoryTxAmount={getCategoryTxAmount}
            isReconUsedForRow={isReconUsedForRow}
            isReconUsedForTransfer={isReconUsedForTransfer}
            onUseReconFigures={handleUseReconFigures}
            onUseCombinedTransferRecon={handleUseCombinedTransferRecon}
            onStartEdit={handleStartEdit}
            onToggleResolved={handleToggleResolved}
            onOpenNote={handleOpenNote}
            onOpenOffsetModal={handleOpenOffsetModal}
            onRequestMatchAll={() => setShowMatchConfirm(true)}
            onSwitchToMatrix={() => setIsMatrixModalOpen(true)}
            onRegisterActions={setWorkbenchActions}
            onLiveSignedActualsChange={setLiveSignedActuals}
            onLiveUnreconItemsChange={setLiveUnreconItems}
            applyingRecon={applyingRecon}
            applyingReconRow={applyingReconRow}
            resolvingCellKey={resolvingCellKey}
            matchingActuals={matchingActuals}
          />

          {/* 3-Month Rolling Cashflow Modal */}
          {isMatrixModalOpen && (
            <div
              onClick={() => setIsMatrixModalOpen(false)}
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(15, 23, 42, 0.55)",
                backdropFilter: "blur(2px)",
                zIndex: 950,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px"
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: "#ffffff",
                  borderRadius: "12px",
                  width: "96vw",
                  maxWidth: "1320px",
                  maxHeight: "92vh",
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                  border: "1px solid #cbd5e1",
                  overflow: "hidden"
                }}
              >
                {/* Modal Header */}
                <div style={{
                  padding: "14px 20px",
                  borderBottom: "1px solid #e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "#f8fafc"
                }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                      3-month rolling cashflow
                    </h3>
                    <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748b" }}>
                      {selectedClient} — {reconData?.targetMonthLabel || "Target month"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsMatrixModalOpen(false)}
                    title="Close 3-month view"
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "20px",
                      lineHeight: "1",
                      cursor: "pointer",
                      color: "#64748b",
                      padding: "4px 8px",
                      borderRadius: "6px"
                    }}
                  >
                    ✕
                  </button>
                </div>

                {/* Modal Body */}
                <div style={{
                  flex: 1,
                  overflowY: "auto",
                  overflowX: "auto",
                  padding: "20px"
                }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "fit-content", minWidth: "100%" }}>
                    {/* Cashflow Finalisation Toolbar: Match Actuals + Legend */}
                    <div style={{
                      padding: "10px 16px",
                      background: "#ffffff",
                      borderRadius: "10px",
                      border: "1px solid #cbd5e1",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "10px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                        <button
                          onClick={() => setShowMatchConfirm(true)}
                          disabled={matchingActuals || !reconData?.reconActuals}
                          title="Applies reconciliation figures to adjustments and marks all target month items resolved"
                          style={{
                            padding: "7px 16px",
                            background: "#15803d",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            fontSize: "12px",
                            fontWeight: "700",
                            cursor: matchingActuals || !reconData?.reconActuals ? "default" : "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.06)"
                          }}
                        >
                          {matchingActuals ? <Spinner size={12} /> : "⚡"} Match actuals
                        </button>
                        <span style={{ fontSize: "12px", color: "#64748b" }}>
                          Applies bank recon figures and resolves all target month cash items
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "11px", color: "#64748b", flexWrap: "wrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <span style={{ width: "10px", height: "10px", background: "#dcfce7", border: "1px solid #86efac", borderRadius: "2px", display: "inline-block" }}></span>
                          Matched transaction
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <span style={{ width: "10px", height: "10px", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: "2px", display: "inline-block" }}></span>
                          Variance
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <span style={{ width: "10px", height: "10px", background: RESOLVED_GREEN, border: "1px solid #86efac", borderRadius: "2px", display: "inline-block" }}></span>
                          Resolved actual
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <span style={{ width: "10px", height: "10px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "2px", display: "inline-block" }}></span>
                          Editable adjustment
                        </span>
                      </div>
                    </div>

                    {/* Overhauled Modern Cashflow Finalisation: Grouped Category Cards with Dedicated Total Column */}
                    <div style={{ width: "fit-content", maxWidth: "100%" }}>
                      <div style={{ overflowX: "auto", paddingBottom: "12px" }}>
                        <div style={{ minWidth: "972px", width: "fit-content" }}>
                          {/* 1. Header Bar: Segmented with clear blank space around Target Month */}
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: gridTemplateColumns,
                            alignItems: "stretch",
                            background: "transparent",
                            color: "#ffffff",
                            fontSize: "12px",
                            fontWeight: "700",
                            marginBottom: "10px"
                          }}>
                            <div style={{
                              padding: "10px 14px",
                              gridColumn: "1",
                              background: DARK_GREEN,
                              borderTopLeftRadius: "10px",
                              borderBottomLeftRadius: "10px",
                              display: "flex",
                              alignItems: "center"
                            }}>
                              Cash movement
                            </div>

                            {reconData.selectedCols.map((col, cIndex) => {
                              const isTarget = col.type === "target";
                              const gridCol = colPositions[cIndex];
                              const isPrev = cIndex === 0 || col.type === "prev";
                              const isLast = cIndex === reconData.selectedCols.length - 1;

                              return (
                                <React.Fragment key={col.colIdx}>
                                  <div
                                    style={{
                                      gridColumn: `${gridCol}`,
                                      padding: "10px 10px",
                                      textAlign: "right",
                                      background: isTarget ? "#15803d" : DARK_GREEN,
                                      borderTopLeftRadius: isTarget ? "10px" : (!isPrev && !isTarget ? "10px" : "0"),
                                      borderBottomLeftRadius: isTarget ? "10px" : (!isPrev && !isTarget ? "10px" : "0"),
                                      borderTopRightRadius: isPrev && !isTarget ? "10px" : (isLast ? "10px" : "0"),
                                      borderBottomRightRadius: isPrev && !isTarget ? "10px" : (isLast ? "10px" : "0"),
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "flex-end",
                                      gap: "6px"
                                    }}
                                  >
                                    <span>{col.label}</span>
                                    {isTarget && (
                                      <span style={{
                                        fontSize: "9px",
                                        padding: "1px 5px",
                                        background: "#ffffff",
                                        color: "#15803d",
                                        borderRadius: "4px",
                                        fontWeight: "800",
                                        textTransform: "uppercase"
                                      }}>
                                        Target
                                      </span>
                                    )}
                                  </div>

                                  {isTarget && (
                                    <>
                                      <div
                                        style={{
                                          gridColumn: `${totalColPosition}`,
                                          padding: "10px 10px",
                                          textAlign: "center",
                                          background: "#15803d",
                                          borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                                          fontWeight: "700",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center"
                                        }}
                                      >
                                        Pulse total
                                      </div>
                                      <div
                                        style={{
                                          gridColumn: `${txColPosition}`,
                                          padding: "10px 10px",
                                          textAlign: "center",
                                          background: "#15803d",
                                          borderLeft: "1px solid rgba(255, 255, 255, 0.2)",
                                          borderTopRightRadius: "10px",
                                          borderBottomRightRadius: "10px",
                                          fontWeight: "700",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center"
                                        }}
                                      >
                                        Transactions total
                                      </div>
                                    </>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </div>

                          {/* 2. Operational Movement Cards (with 8px gap between categories) */}
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {groupedElements.filter(e => !e.isSummary).map((elem) => {
                              if (elem.type === "compound_transfer") {
                                return (
                                  <div
                                    key={elem.id}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: gridTemplateColumns,
                                      gridTemplateRows: "auto auto auto auto",
                                      background: "#ffffff",
                                      border: "1px solid #bae6fd",
                                      borderLeft: "4px solid #0284c7",
                                      borderRadius: "10px",
                                      boxShadow: "0 1px 3px rgba(2, 132, 199, 0.08)",
                                      overflow: "hidden",
                                      transition: "box-shadow 0.15s, border-color 0.15s"
                                    }}
                                  >
                                    {/* Spacers before/after Target Month */}
                                    {spacerBeforeTarget && (
                                      <div
                                        style={{
                                          gridColumn: `${spacerBeforeTarget}`,
                                          gridRow: "1 / span 4",
                                          background: "#f8fafc",
                                          borderLeft: "1px solid #e2e8f0",
                                          borderRight: "1px solid #e2e8f0"
                                        }}
                                      />
                                    )}
                                    {spacerAfterTarget && (
                                      <div
                                        style={{
                                          gridColumn: `${spacerAfterTarget}`,
                                          gridRow: "1 / span 4",
                                          background: "#f8fafc",
                                          borderLeft: "1px solid #e2e8f0",
                                          borderRight: "1px solid #e2e8f0"
                                        }}
                                      />
                                    )}

                                    {/* Row 1 Title: Corporation tax */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "1",
                                        padding: "8px 14px",
                                        fontWeight: "700",
                                        fontSize: "13px",
                                        color: "#0f172a",
                                        borderBottom: "1px dashed #f1f5f9",
                                        display: "flex",
                                        flexDirection: "column",
                                        justifyContent: "center",
                                        gap: "2px"
                                      }}
                                    >
                                      <span>{elem.corpTitle || "Corporation tax"}</span>
                                      <span style={{
                                        fontSize: "9px",
                                        fontWeight: "700",
                                        color: "#0369a1",
                                        background: "#e0f2fe",
                                        padding: "1px 5px",
                                        borderRadius: "4px",
                                        width: "fit-content"
                                      }}>
                                        Transfers mode
                                      </span>
                                    </div>

                                    {/* Row 2 Title: Corp tax adjustment */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "2",
                                        padding: "6px 14px 7px 24px",
                                        color: "#64748b",
                                        fontStyle: "italic",
                                        fontSize: "11px",
                                        display: "flex",
                                        alignItems: "center",
                                        background: "#fafbfc",
                                        borderBottom: "1px solid #e2e8f0"
                                      }}
                                    >
                                      <span>↳ Adjustment</span>
                                    </div>

                                    {/* Row 3 Title: VAT */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "3",
                                        padding: "8px 14px",
                                        fontWeight: "700",
                                        fontSize: "13px",
                                        color: "#0f172a",
                                        borderBottom: "1px dashed #f1f5f9",
                                        display: "flex",
                                        alignItems: "center"
                                      }}
                                    >
                                      <span>{elem.vatTitle || "VAT"}</span>
                                    </div>

                                    {/* Row 4 Title: VAT adjustment */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "4",
                                        padding: "6px 14px 7px 24px",
                                        color: "#64748b",
                                        fontStyle: "italic",
                                        fontSize: "11px",
                                        display: "flex",
                                        alignItems: "center",
                                        background: "#fafbfc"
                                      }}
                                    >
                                      <span>↳ Adjustment</span>
                                    </div>

                                    {/* Month Columns across all 4 rows */}
                                    {reconData.selectedCols.map((col, cIndex) => {
                                      const isTargetCol = col.type === "target";
                                      const gridCol = colPositions[cIndex];
                                      const corpBaseCell = elem.corpBaseRow.cells[cIndex];
                                      const corpAdjCell = elem.corpAdjRow?.cells[cIndex];
                                      const vatBaseCell = elem.vatBaseRow.cells[cIndex];
                                      const vatAdjCell = elem.vatAdjRow?.cells[cIndex];

                                      const corpBaseVal = (corpBaseCell?.numVal !== undefined && corpBaseCell?.numVal !== null) ? corpBaseCell.numVal : parseAmount(corpBaseCell?.v);
                                      const corpAdjVal = (corpAdjCell?.numVal !== undefined && corpAdjCell?.numVal !== null) ? corpAdjCell.numVal : parseAmount(corpAdjCell?.v);
                                      const vatBaseVal = (vatBaseCell?.numVal !== undefined && vatBaseCell?.numVal !== null) ? vatBaseCell.numVal : parseAmount(vatBaseCell?.v);
                                      const vatAdjVal = (vatAdjCell?.numVal !== undefined && vatAdjCell?.numVal !== null) ? vatAdjCell.numVal : parseAmount(vatAdjCell?.v);

                                      const corpTotal = corpBaseVal + corpAdjVal;
                                      const vatTotal = vatBaseVal + vatAdjVal;
                                      const combinedTotalVal = corpTotal + vatTotal;
                                      const combinedTotalFmt = formatGBP(combinedTotalVal);

                                      const corpBg = corpBaseCell?.isResolved ? RESOLVED_GREEN : (isTargetCol ? "#f8fafc" : "#ffffff");
                                      const vatBg = vatBaseCell?.isResolved ? RESOLVED_GREEN : (isTargetCol ? "#f8fafc" : "#ffffff");

                                      return (
                                        <React.Fragment key={col.colIdx}>
                                          {/* Row 1: Corp tax base */}
                                          <div
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              gridRow: "1",
                                              padding: "8px 10px",
                                              background: corpBg,
                                              borderBottom: "1px dashed #f1f5f9",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: isTargetCol ? "space-between" : "flex-end",
                                              gap: "6px"
                                            }}
                                          >
                                            {isTargetCol ? (
                                              <>
                                                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                  {renderNoteButton(elem.corpBaseRow, corpBaseCell)}
                                                  <button
                                                    onClick={() => handleToggleResolved(corpBaseCell)}
                                                    disabled={resolvingCellKey === `${corpBaseCell?.sheetRow}_${corpBaseCell?.colIdx}`}
                                                    title={corpBaseCell?.isResolved ? "Un-mark resolved" : "Mark resolved"}
                                                    style={{
                                                      padding: "2px 7px",
                                                      borderRadius: "4px",
                                                      border: corpBaseCell?.isResolved ? "1px solid #86efac" : "1px solid #cbd5e1",
                                                      background: corpBaseCell?.isResolved ? "#dcfce7" : "#ffffff",
                                                      color: corpBaseCell?.isResolved ? "#166534" : "#475569",
                                                      fontSize: "9px",
                                                      fontWeight: "700",
                                                      textTransform: "uppercase",
                                                      cursor: resolvingCellKey === `${corpBaseCell?.sheetRow}_${corpBaseCell?.colIdx}` ? "wait" : "pointer",
                                                      flexShrink: 0,
                                                      display: "inline-flex",
                                                      alignItems: "center",
                                                      gap: "4px"
                                                    }}
                                                  >
                                                    {resolvingCellKey === `${corpBaseCell?.sheetRow}_${corpBaseCell?.colIdx}` ? <Spinner size={9} /> : null}
                                                    {corpBaseCell?.isResolved ? "Resolved" : "Resolve"}
                                                  </button>
                                                </div>
                                                <span style={{ display: "inline-block", minWidth: "80px", textAlign: "right", padding: "3px 8px", fontWeight: "700", fontVariantNumeric: "tabular-nums", color: "#0f172a", fontSize: "12px", whiteSpace: "nowrap" }}>
                                                  {corpBaseCell?.v || "£0.00"}
                                                </span>
                                              </>
                                            ) : (
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.corpBaseRow, corpBaseCell)}
                                                <span style={{ display: "inline-block", minWidth: "80px", textAlign: "right", padding: "3px 8px", fontVariantNumeric: "tabular-nums", color: "#334155", fontSize: "12px", whiteSpace: "nowrap" }}>
                                                  {corpBaseCell?.v || "£0.00"}
                                                </span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Row 2: Corp tax adjustment */}
                                          <div
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              gridRow: "2",
                                              padding: "5px 10px 6px",
                                              background: isTargetCol ? "#f8fafc" : "#fafbfc",
                                              borderBottom: "1px solid #e2e8f0",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: isTargetCol ? "space-between" : "flex-end",
                                              gap: "6px"
                                            }}
                                          >
                                            {isTargetCol ? (
                                              <>
                                                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                  {renderNoteButton(elem.corpAdjRow, corpAdjCell)}
                                                </div>
                                                <span
                                                  onClick={() => handleStartEdit(elem.corpAdjRow, corpAdjCell)}
                                                  title="Click to edit corporation tax adjustment"
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    background: "#ffffff",
                                                    border: "1px solid #cbd5e1",
                                                    borderRadius: "4px",
                                                    cursor: "pointer",
                                                    fontVariantNumeric: "tabular-nums",
                                                    fontSize: "11px",
                                                    color: "#334155",
                                                    fontWeight: "600",
                                                    boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                                    whiteSpace: "nowrap",
                                                    boxSizing: "border-box"
                                                  }}
                                                >
                                                  {corpAdjCell?.v || "£0.00"}
                                                </span>
                                              </>
                                            ) : (
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.corpAdjRow, corpAdjCell)}
                                                <span
                                                  onClick={() => handleStartEdit(elem.corpAdjRow, corpAdjCell)}
                                                  title="Click to edit adjustment"
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    background: "#ffffff",
                                                    border: "1px solid #cbd5e1",
                                                    borderRadius: "4px",
                                                    cursor: "pointer",
                                                    fontVariantNumeric: "tabular-nums",
                                                    fontSize: "11px",
                                                    color: "#334155",
                                                    fontWeight: "600",
                                                    whiteSpace: "nowrap",
                                                    boxSizing: "border-box"
                                                  }}
                                                >
                                                  {corpAdjCell?.v || "£0.00"}
                                                </span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Row 3: VAT base */}
                                          <div
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              gridRow: "3",
                                              padding: "8px 10px",
                                              background: vatBg,
                                              borderBottom: "1px dashed #f1f5f9",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: isTargetCol ? "space-between" : "flex-end",
                                              gap: "6px"
                                            }}
                                          >
                                            {isTargetCol ? (
                                              <>
                                                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                  {renderNoteButton(elem.vatBaseRow, vatBaseCell)}
                                                  <button
                                                    onClick={() => handleToggleResolved(vatBaseCell)}
                                                    disabled={resolvingCellKey === `${vatBaseCell?.sheetRow}_${vatBaseCell?.colIdx}`}
                                                    title={vatBaseCell?.isResolved ? "Un-mark resolved" : "Mark resolved"}
                                                    style={{
                                                      padding: "2px 7px",
                                                      borderRadius: "4px",
                                                      border: vatBaseCell?.isResolved ? "1px solid #86efac" : "1px solid #cbd5e1",
                                                      background: vatBaseCell?.isResolved ? "#dcfce7" : "#ffffff",
                                                      color: vatBaseCell?.isResolved ? "#166534" : "#475569",
                                                      fontSize: "9px",
                                                      fontWeight: "700",
                                                      textTransform: "uppercase",
                                                      cursor: resolvingCellKey === `${vatBaseCell?.sheetRow}_${vatBaseCell?.colIdx}` ? "wait" : "pointer",
                                                      flexShrink: 0,
                                                      display: "inline-flex",
                                                      alignItems: "center",
                                                      gap: "4px"
                                                    }}
                                                  >
                                                    {resolvingCellKey === `${vatBaseCell?.sheetRow}_${vatBaseCell?.colIdx}` ? <Spinner size={9} /> : null}
                                                    {vatBaseCell?.isResolved ? "Resolved" : "Resolve"}
                                                  </button>
                                                </div>
                                                <span style={{ display: "inline-block", minWidth: "80px", textAlign: "right", padding: "3px 8px", fontWeight: "700", fontVariantNumeric: "tabular-nums", color: "#0f172a", fontSize: "12px", whiteSpace: "nowrap" }}>
                                                  {vatBaseCell?.v || "£0.00"}
                                                </span>
                                              </>
                                            ) : (
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.vatBaseRow, vatBaseCell)}
                                                <span style={{ display: "inline-block", minWidth: "80px", textAlign: "right", padding: "3px 8px", fontVariantNumeric: "tabular-nums", color: "#334155", fontSize: "12px", whiteSpace: "nowrap" }}>
                                                  {vatBaseCell?.v || "£0.00"}
                                                </span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Row 4: VAT adjustment (with Combined Transfer Recon button) */}
                                          <div
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              gridRow: "4",
                                              padding: "5px 10px 6px",
                                              background: isTargetCol ? "#f8fafc" : "#fafbfc",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: isTargetCol ? "space-between" : "flex-end",
                                              gap: "6px"
                                            }}
                                          >
                                            {isTargetCol ? (
                                              <>
                                                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                  {renderNoteButton(elem.vatAdjRow, vatAdjCell)}
                                                  {(() => {
                                                    const isReconUsed = isReconUsedForTransfer(elem);
                                                    const isThisRowApplying = applyingRecon && applyingReconRow === elem.vatAdjRow?.sheetRow;
                                                    return (
                                                      <button
                                                        onClick={() => handleUseCombinedTransferRecon(elem, col)}
                                                        disabled={applyingRecon}
                                                        title={isReconUsed ? "Combined transfer recon actual is currently applied" : "Reconcile combined Corporation tax + VAT against Transfer total"}
                                                        style={{
                                                          padding: "2px 7px",
                                                          borderRadius: "4px",
                                                          border: isReconUsed ? "1px solid #86efac" : "1px solid #bfdbfe",
                                                          background: isReconUsed ? "#dcfce7" : "#eff6ff",
                                                          color: isReconUsed ? "#166534" : "#1d4ed8",
                                                          fontSize: "9px",
                                                          fontWeight: "700",
                                                          textTransform: "uppercase",
                                                          cursor: applyingRecon ? "default" : "pointer",
                                                          opacity: isThisRowApplying ? 0.7 : 1,
                                                          flexShrink: 0,
                                                          display: "inline-flex",
                                                          alignItems: "center",
                                                          gap: "4px"
                                                        }}
                                                      >
                                                        {isThisRowApplying ? <Spinner size={9} /> : null}
                                                        Recon
                                                      </button>
                                                    );
                                                  })()}
                                                  {nextCol && (
                                                    <button
                                                      type="button"
                                                      onClick={() => handleOpenOffsetModal({
                                                        baseRow: elem.vatBaseRow,
                                                        adjRow: elem.vatAdjRow,
                                                        title: "Tax transfers (Corporation tax & VAT)",
                                                        mappedItemType: "tax_transfer",
                                                        isCombinedTransfer: true,
                                                        combinedElem: elem
                                                      })}
                                                      title={`Offset combined tax transfers in ${nextCol.label}`}
                                                      style={{
                                                        padding: "2px 6px",
                                                        borderRadius: "4px",
                                                        border: "1px solid #cbd5e1",
                                                        background: "#ffffff",
                                                        color: "#475569",
                                                        fontSize: "9px",
                                                        fontWeight: "700",
                                                        cursor: "pointer"
                                                      }}
                                                    >
                                                      ⇄ {(nextCol.label || "Next").split(" ")[0]}
                                                    </button>
                                                  )}
                                                </div>
                                                <span
                                                  onClick={() => handleStartEdit(elem.vatAdjRow, vatAdjCell)}
                                                  title="Click to edit VAT / transfer adjustment"
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    background: "#ffffff",
                                                    border: "1px solid #cbd5e1",
                                                    borderRadius: "4px",
                                                    cursor: "pointer",
                                                    fontVariantNumeric: "tabular-nums",
                                                    fontSize: "11px",
                                                    color: "#334155",
                                                    fontWeight: "600",
                                                    boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                                    whiteSpace: "nowrap",
                                                    boxSizing: "border-box"
                                                  }}
                                                >
                                                  {vatAdjCell?.v || "£0.00"}
                                                </span>
                                              </>
                                            ) : (
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.vatAdjRow, vatAdjCell)}
                                                <span
                                                  onClick={() => handleStartEdit(elem.vatAdjRow, vatAdjCell)}
                                                  title="Click to edit adjustment"
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    background: "#ffffff",
                                                    border: "1px solid #cbd5e1",
                                                    borderRadius: "4px",
                                                    cursor: "pointer",
                                                    fontVariantNumeric: "tabular-nums",
                                                    fontSize: "11px",
                                                    color: "#334155",
                                                    fontWeight: "600",
                                                    whiteSpace: "nowrap",
                                                    boxSizing: "border-box"
                                                  }}
                                                >
                                                  {vatAdjCell?.v || "£0.00"}
                                                </span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Spanning Pulse Total Column (All 4 rows) */}
                                          {isTargetCol && (
                                            <div
                                              style={{
                                                gridColumn: `${totalColPosition}`,
                                                gridRow: "1 / span 4",
                                                padding: "8px 10px",
                                                background: "#f0f9ff",
                                                borderLeft: "1px solid #bae6fd",
                                                borderRight: "1px solid #bae6fd",
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                gap: "3px"
                                              }}
                                            >
                                              <span style={{ fontSize: "10px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
                                                Corp: {formatGBP(corpTotal)}
                                              </span>
                                              <span style={{ fontSize: "10px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
                                                VAT: {formatGBP(vatTotal)}
                                              </span>
                                              <div style={{ width: "80%", height: "1px", background: "#bae6fd", margin: "2px 0" }} />
                                              <span
                                                style={{
                                                  fontSize: "12px",
                                                  fontWeight: "700",
                                                  fontVariantNumeric: "tabular-nums",
                                                  color: "#0f172a"
                                                }}
                                                title={`Combined Corporation tax (${formatGBP(corpTotal)}) + VAT (${formatGBP(vatTotal)}) = ${combinedTotalFmt}`}
                                              >
                                                {combinedTotalFmt}
                                              </span>
                                            </div>
                                          )}

                                          {/* Spanning Transactions Total (Transfer) Column (All 4 rows) */}
                                          {isTargetCol && (() => {
                                            const txVal = combinedTransferTxVal;
                                            const isAvailable = txVal !== null && txVal !== undefined;
                                            const isMatch = isAvailable && (
                                              Math.abs(combinedTotalVal - txVal) < 0.05 ||
                                              (Math.sign(combinedTotalVal) !== Math.sign(txVal) && Math.abs(Math.abs(combinedTotalVal) - Math.abs(txVal)) < 0.05)
                                            );
                                            return (
                                              <div
                                                style={{
                                                  gridColumn: `${txColPosition}`,
                                                  gridRow: "1 / span 4",
                                                  padding: "8px 10px",
                                                  background: "#f0f9ff",
                                                  borderRight: "1px solid #bae6fd",
                                                  display: "flex",
                                                  flexDirection: "column",
                                                  alignItems: "center",
                                                  justifyContent: "center",
                                                  gap: "4px"
                                                }}
                                              >
                                                <span style={{ fontSize: "9px", fontWeight: "700", color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                                  Transfer
                                                </span>
                                                {isAvailable ? (
                                                  <span
                                                    style={{
                                                      padding: "4px 10px",
                                                      borderRadius: "14px",
                                                      fontSize: "11px",
                                                      fontWeight: "700",
                                                      fontVariantNumeric: "tabular-nums",
                                                      background: isMatch ? "#dcfce7" : "#fee2e2",
                                                      color: isMatch ? "#166534" : "#991b1b",
                                                      border: isMatch ? "1px solid #86efac" : "1px solid #fca5a5",
                                                      display: "inline-block",
                                                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                                    }}
                                                    title={isMatch
                                                      ? `Matches combined Corp tax + VAT total: ${formatGBP(txVal)}`
                                                      : `Mismatch: Transfer amount ${formatGBP(txVal)} vs Combined total ${combinedTotalFmt} (Diff: ${formatGBP(txVal - combinedTotalVal)})`
                                                    }
                                                  >
                                                    {formatGBP(txVal)}
                                                  </span>
                                                ) : (
                                                  <span style={{ color: "#94a3b8", fontSize: "12px" }}>—</span>
                                                )}
                                              </div>
                                            );
                                          })()}
                                        </React.Fragment>
                                      );
                                    })}
                                  </div>
                                );
                              }

                              if (elem.type === "compound") {
                                return (
                                  <div
                                    key={elem.id}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: gridTemplateColumns,
                                      gridTemplateRows: "auto auto",
                                      background: "#ffffff",
                                      border: "1px solid #e2e8f0",
                                      borderRadius: "10px",
                                      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                                      overflow: "hidden",
                                      transition: "box-shadow 0.15s, border-color 0.15s"
                                    }}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.borderColor = "#cbd5e1";
                                      e.currentTarget.style.boxShadow = "0 3px 6px -1px rgba(15, 23, 42, 0.07)";
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.borderColor = "#e2e8f0";
                                      e.currentTarget.style.boxShadow = "0 1px 2px rgba(15, 23, 42, 0.04)";
                                    }}
                                  >
                                    {/* Row 1: Forecast Category Title */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "1",
                                        padding: "8px 14px",
                                        fontWeight: "700",
                                        fontSize: "13px",
                                        color: "#0f172a",
                                        borderBottom: "1px dashed #f1f5f9",
                                        display: "flex",
                                        alignItems: "center"
                                      }}
                                    >
                                      <span>{elem.title}</span>
                                    </div>

                                    {/* Spacers before/after Target Month */}
                                    {spacerBeforeTarget && (
                                      <div
                                        style={{
                                          gridColumn: `${spacerBeforeTarget}`,
                                          gridRow: "1 / span 2",
                                          background: "#f8fafc",
                                          borderLeft: "1px solid #e2e8f0",
                                          borderRight: "1px solid #e2e8f0"
                                        }}
                                      />
                                    )}
                                    {spacerAfterTarget && (
                                      <div
                                        style={{
                                          gridColumn: `${spacerAfterTarget}`,
                                          gridRow: "1 / span 2",
                                          background: "#f8fafc",
                                          borderLeft: "1px solid #e2e8f0",
                                          borderRight: "1px solid #e2e8f0"
                                        }}
                                      />
                                    )}

                                    {/* Row 1: Forecast Month Columns */}
                                    {reconData.selectedCols.map((col, cIndex) => {
                                      const isTargetCol = col.type === "target";
                                      const gridCol = colPositions[cIndex];
                                      const baseCell = elem.baseRow.cells[cIndex];
                                      const adjCell = elem.adjRow?.cells[cIndex];
                                      const baseVal = (baseCell?.numVal !== undefined && baseCell?.numVal !== null) ? baseCell.numVal : parseAmount(baseCell?.v);
                                      const adjVal = (adjCell?.numVal !== undefined && adjCell?.numVal !== null) ? adjCell.numVal : parseAmount(adjCell?.v);
                                      const totalVal = baseVal + adjVal;
                                      const totalFmt = formatGBP(totalVal);
                                      let cellBg = baseCell?.isResolved ? RESOLVED_GREEN : (isTargetCol ? "#f8fafc" : "#ffffff");

                                      return (
                                        <React.Fragment key={col.colIdx}>
                                          <div
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              gridRow: "1",
                                              padding: "8px 10px",
                                              background: cellBg,
                                              borderBottom: "1px dashed #f1f5f9",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: isTargetCol ? "space-between" : "flex-end",
                                              gap: "6px"
                                            }}
                                          >
                                            {isTargetCol ? (
                                              <>
                                                <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                  {renderNoteButton(elem.baseRow, baseCell)}
                                                  <button
                                                    onClick={() => handleToggleResolved(baseCell)}
                                                    disabled={resolvingCellKey === `${baseCell?.sheetRow}_${baseCell?.colIdx}`}
                                                    title={baseCell?.isResolved ? "Un-mark resolved" : "Mark resolved"}
                                                    style={{
                                                      padding: "2px 7px",
                                                      borderRadius: "4px",
                                                      border: baseCell?.isResolved ? "1px solid #86efac" : "1px solid #cbd5e1",
                                                      background: baseCell?.isResolved ? "#dcfce7" : "#ffffff",
                                                      color: baseCell?.isResolved ? "#166534" : "#475569",
                                                      fontSize: "9px",
                                                      fontWeight: "700",
                                                      textTransform: "uppercase",
                                                      cursor: resolvingCellKey === `${baseCell?.sheetRow}_${baseCell?.colIdx}` ? "wait" : "pointer",
                                                      flexShrink: 0,
                                                      display: "inline-flex",
                                                      alignItems: "center",
                                                      gap: "4px"
                                                    }}
                                                  >
                                                    {resolvingCellKey === `${baseCell?.sheetRow}_${baseCell?.colIdx}` ? <Spinner size={9} /> : null}
                                                    {baseCell?.isResolved ? "Resolved" : "Resolve"}
                                                  </button>
                                                </div>
                                                <span
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    border: "1px solid transparent",
                                                    boxSizing: "border-box",
                                                    fontWeight: "700",
                                                    fontVariantNumeric: "tabular-nums",
                                                    color: "#0f172a",
                                                    fontSize: "12px",
                                                    whiteSpace: "nowrap"
                                                  }}
                                                >
                                                  {baseCell?.v || "£0.00"}
                                                </span>
                                              </>
                                            ) : (
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.baseRow, baseCell)}
                                                <span
                                                  style={{
                                                    display: "inline-block",
                                                    minWidth: "80px",
                                                    textAlign: "right",
                                                    padding: "3px 8px",
                                                    border: "1px solid transparent",
                                                    boxSizing: "border-box",
                                                    fontVariantNumeric: "tabular-nums",
                                                    color: "#334155",
                                                    fontSize: "12px",
                                                    whiteSpace: "nowrap"
                                                  }}
                                                >
                                                  {baseCell?.v || "£0.00"}
                                                </span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Spanning Net Total Column (Unshaded) */}
                                          {isTargetCol && (
                                            <div
                                              style={{
                                                gridColumn: `${totalColPosition}`,
                                                gridRow: "1 / span 2",
                                                padding: "6px 10px",
                                                background: "#f8fafc",
                                                borderLeft: "1px solid #e2e8f0",
                                                borderRight: "1px solid #e2e8f0",
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center"
                                              }}
                                            >
                                              <span
                                                style={{
                                                  fontSize: "12px",
                                                  fontWeight: "700",
                                                  fontVariantNumeric: "tabular-nums",
                                                  color: "#0f172a",
                                                  display: "inline-block"
                                                }}
                                                title={`Forecast: ${baseCell?.v || "£0.00"} + Adjustment: ${adjCell?.v || "£0.00"} = Net: ${totalFmt}`}
                                              >
                                                {totalFmt}
                                              </span>
                                            </div>
                                          )}

                                          {/* Spanning Transaction Amount Column */}
                                          {isTargetCol && (() => {
                                            const txVal = getCategoryTxAmount(elem.mappedItemType, elem.title);
                                            const isAvailable = txVal !== null && txVal !== undefined;
                                            const isMatch = isAvailable && (
                                              Math.abs(totalVal - txVal) < 0.05 ||
                                              (Math.sign(totalVal) !== Math.sign(txVal) && Math.abs(Math.abs(totalVal) - Math.abs(txVal)) < 0.05)
                                            );
                                            return (
                                              <div
                                                style={{
                                                  gridColumn: `${txColPosition}`,
                                                  gridRow: "1 / span 2",
                                                  padding: "6px 10px",
                                                  background: "#f8fafc",
                                                  borderRight: "1px solid #e2e8f0",
                                                  display: "flex",
                                                  alignItems: "center",
                                                  justifyContent: "center"
                                                }}
                                              >
                                                {isAvailable ? (
                                                  <span
                                                    style={{
                                                      padding: "4px 10px",
                                                      borderRadius: "14px",
                                                      fontSize: "11px",
                                                      fontWeight: "700",
                                                      fontVariantNumeric: "tabular-nums",
                                                      background: isMatch ? "#dcfce7" : "#fee2e2",
                                                      color: isMatch ? "#166534" : "#991b1b",
                                                      border: isMatch ? "1px solid #86efac" : "1px solid #fca5a5",
                                                      display: "inline-block",
                                                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                                                    }}
                                                    title={isMatch
                                                      ? `Matches Total (Net): ${formatGBP(txVal)}`
                                                      : `Mismatch: Transaction amount ${formatGBP(txVal)} vs Total (Net) ${formatGBP(totalVal)} (Diff: ${formatGBP(txVal - totalVal)})`
                                                    }
                                                  >
                                                    {formatGBP(txVal)}
                                                  </span>
                                                ) : (
                                                  <span style={{ color: "#94a3b8", fontSize: "12px" }}>—</span>
                                                )}
                                              </div>
                                            );
                                          })()}
                                        </React.Fragment>
                                      );
                                    })}

                                    {/* Row 2: Adjustment Label */}
                                    <div
                                      style={{
                                        gridColumn: "1",
                                        gridRow: "2",
                                        padding: "6px 14px 7px 24px",
                                        color: "#64748b",
                                        fontStyle: "italic",
                                        fontSize: "11px",
                                        display: "flex",
                                        alignItems: "center",
                                        background: "#fafbfc"
                                      }}
                                    >
                                      <span>↳ Adjustment</span>
                                    </div>

                                    {/* Row 2: Adjustment Month Columns */}
                                    {reconData.selectedCols.map((col, cIndex) => {
                                      const isTargetCol = col.type === "target";
                                      const gridCol = colPositions[cIndex];
                                      const adjCell = elem.adjRow?.cells[cIndex];

                                      return (
                                        <div
                                          key={`adj_${col.colIdx}`}
                                          style={{
                                            gridColumn: `${gridCol}`,
                                            gridRow: "2",
                                            padding: "5px 10px 6px",
                                            background: isTargetCol ? "#f8fafc" : "#fafbfc",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: isTargetCol ? "space-between" : "flex-end",
                                            gap: "6px"
                                          }}
                                        >
                                          {isTargetCol ? (
                                            <>
                                              <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                                                {renderNoteButton(elem.adjRow, adjCell)}
                                                {(() => {
                                                  const isReconUsed = isReconUsedForRow(elem.baseRow);
                                                  const isThisRowApplying = applyingRecon && (applyingReconRow === elem.adjRow?.sheetRow || applyingReconRow === elem.baseRow?.targetAdjustmentRow);
                                                  return (
                                                    <button
                                                      onClick={() => handleUseReconFigures(elem.baseRow, elem.baseRow.cells[cIndex])}
                                                      disabled={applyingRecon}
                                                      title={isReconUsed ? "Recon actual figure is currently applied" : `Apply recon actual for ${elem.title}`}
                                                      style={{
                                                        padding: "2px 7px",
                                                        borderRadius: "4px",
                                                        border: isReconUsed ? "1px solid #86efac" : "1px solid #bfdbfe",
                                                        background: isReconUsed ? "#dcfce7" : "#eff6ff",
                                                        color: isReconUsed ? "#166534" : "#1d4ed8",
                                                        fontSize: "9px",
                                                        fontWeight: "700",
                                                        textTransform: "uppercase",
                                                        cursor: applyingRecon ? "default" : "pointer",
                                                        opacity: isThisRowApplying ? 0.7 : 1,
                                                        flexShrink: 0,
                                                        display: "inline-flex",
                                                        alignItems: "center",
                                                        gap: "4px"
                                                      }}
                                                    >
                                                      {isThisRowApplying ? <Spinner size={9} /> : null}
                                                      Recon
                                                    </button>
                                                  );
                                                })()}
                                                {nextCol && (
                                                  <button
                                                    type="button"
                                                    onClick={() => handleOpenOffsetModal({
                                                      baseRow: elem.baseRow,
                                                      adjRow: elem.adjRow,
                                                      title: elem.title,
                                                      mappedItemType: elem.mappedItemType
                                                    })}
                                                    title={`Offset in ${nextCol.label}`}
                                                    style={{
                                                      padding: "2px 6px",
                                                      borderRadius: "4px",
                                                      border: "1px solid #cbd5e1",
                                                      background: "#ffffff",
                                                      color: "#475569",
                                                      fontSize: "9px",
                                                      fontWeight: "700",
                                                      cursor: "pointer"
                                                    }}
                                                  >
                                                    ⇄ {(nextCol.label || "Next").split(" ")[0]}
                                                  </button>
                                                )}
                                              </div>

                                              {/* Thin Grey Input Box for Adjustment */}
                                              <span
                                                onClick={() => handleStartEdit(elem.adjRow, adjCell)}
                                                title="Click to edit adjustment"
                                                style={{
                                                  display: "inline-block",
                                                  minWidth: "80px",
                                                  textAlign: "right",
                                                  padding: "3px 8px",
                                                  background: "#ffffff",
                                                  border: "1px solid #cbd5e1",
                                                  borderRadius: "4px",
                                                  cursor: "pointer",
                                                  fontVariantNumeric: "tabular-nums",
                                                  fontSize: "11px",
                                                  color: "#334155",
                                                  fontWeight: "600",
                                                  boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                                                  whiteSpace: "nowrap",
                                                  boxSizing: "border-box"
                                                }}
                                              >
                                                {adjCell?.v || "£0.00"}
                                              </span>
                                            </>
                                          ) : (
                                            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                                              {renderNoteButton(elem.adjRow, adjCell)}
                                              <span
                                                onClick={() => handleStartEdit(elem.adjRow, adjCell)}
                                                title="Click to edit adjustment"
                                                style={{
                                                  display: "inline-block",
                                                  minWidth: "80px",
                                                  textAlign: "right",
                                                  padding: "3px 8px",
                                                  background: "#ffffff",
                                                  border: "1px solid #cbd5e1",
                                                  borderRadius: "4px",
                                                  cursor: "pointer",
                                                  fontVariantNumeric: "tabular-nums",
                                                  fontSize: "11px",
                                                  color: "#334155",
                                                  fontWeight: "600",
                                                  whiteSpace: "nowrap",
                                                  boxSizing: "border-box"
                                                }}
                                              >
                                                {adjCell?.v || "£0.00"}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              }

                              // Single operational card
                              const row = elem.row;
                              return (
                                <div
                                  key={elem.id}
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: gridTemplateColumns,
                                    alignItems: "center",
                                    background: "#ffffff",
                                    border: "1px solid #e2e8f0",
                                    borderRadius: "10px",
                                    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
                                    overflow: "hidden"
                                  }}
                                >
                                  {/* Spacers before/after Target Month */}
                                  {spacerBeforeTarget && (
                                    <div
                                      style={{
                                        gridColumn: `${spacerBeforeTarget}`,
                                        background: "#f8fafc",
                                        borderLeft: "1px solid #e2e8f0",
                                        borderRight: "1px solid #e2e8f0",
                                        alignSelf: "stretch"
                                      }}
                                    />
                                  )}
                                  {spacerAfterTarget && (
                                    <div
                                      style={{
                                        gridColumn: `${spacerAfterTarget}`,
                                        background: "#f8fafc",
                                        borderLeft: "1px solid #e2e8f0",
                                        borderRight: "1px solid #e2e8f0",
                                        alignSelf: "stretch"
                                      }}
                                    />
                                  )}
                                  <div style={{ gridColumn: "1", padding: "8px 14px", fontWeight: "600", fontSize: "12px", color: "#1e293b" }}>
                                    {elem.title}
                                  </div>
                                  {row.cells.map((cell, cIndex) => {
                                    const isTargetCol = reconData.selectedCols[cIndex]?.type === "target";
                                    const gridCol = colPositions[cIndex];
                                    if (isTargetCol) {
                                      return (
                                        <div
                                          key={cell.colIdx}
                                          style={{
                                            gridColumn: `${gridCol} / ${gridCol + 3}`,
                                            padding: "8px 10px",
                                            textAlign: "right",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "flex-end",
                                            gap: "6px"
                                          }}
                                        >
                                          {renderNoteButton(row, cell)}
                                          <span
                                            style={{
                                              display: "inline-block",
                                              minWidth: "80px",
                                              textAlign: "right",
                                              padding: "3px 8px",
                                              border: "1px solid transparent",
                                              boxSizing: "border-box",
                                              fontVariantNumeric: "tabular-nums",
                                              fontSize: "12px",
                                              color: "#334155",
                                              whiteSpace: "nowrap"
                                            }}
                                          >
                                            {cell.v || ""}
                                          </span>
                                        </div>
                                      );
                                    }
                                    return (
                                      <div
                                        key={cell.colIdx}
                                        style={{
                                          gridColumn: `${gridCol}`,
                                          padding: "8px 10px",
                                          textAlign: "right",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "flex-end",
                                          gap: "6px"
                                        }}
                                      >
                                        {renderNoteButton(row, cell)}
                                        <span
                                          style={{
                                            display: "inline-block",
                                            minWidth: "80px",
                                            textAlign: "right",
                                            padding: "3px 8px",
                                            border: "1px solid transparent",
                                            boxSizing: "border-box",
                                            fontVariantNumeric: "tabular-nums",
                                            fontSize: "12px",
                                            color: "#334155",
                                            whiteSpace: "nowrap"
                                          }}
                                        >
                                          {cell.v || ""}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </div>

                          {/* 3. Section Separator for Reconciliation & Cash Balance */}
                          {groupedElements.some(e => e.isSummary) && (
                            <>
                              <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "12px",
                                marginTop: "16px",
                                marginBottom: "10px",
                                padding: "0 4px"
                              }}>
                                <div style={{ height: "1px", flex: 1, background: "#e2e8f0" }} />
                                <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                  Reconciliation & Cash Balance
                                </span>
                                <div style={{ height: "1px", flex: 1, background: "#e2e8f0" }} />
                              </div>

                              {/* 4. Summary & Balance Cards */}
                              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                {groupedElements.filter(e => e.isSummary).map((elem) => {
                                  const row = elem.row;
                                  const isDiff = elem.isDifference;
                                  const isClosing = elem.title.toLowerCase().includes("closing balance");
                                  const isOpening = elem.title.toLowerCase().includes("opening balance");
                                  const isNet = elem.title.toLowerCase().includes("net cash movement");

                                  let cardBg = "#ffffff";
                                  let cardBorder = "1px solid #e2e8f0";
                                  const targetCell = row.cells.find((_, cIdx) => reconData.selectedCols[cIdx]?.type === "target");
                                  const valNum = parseAmount(targetCell?.v);

                                  if (isDiff) {
                                    if (valNum === 0) {
                                      cardBg = "#f0fdf4";
                                      cardBorder = "1px solid #86efac";
                                    } else {
                                      cardBg = "#fef2f2";
                                      cardBorder = "1px solid #fca5a5";
                                    }
                                  } else if (isClosing) {
                                    cardBg = "#eff6ff";
                                    cardBorder = "1px solid #93c5fd";
                                  } else if (isNet) {
                                    cardBg = "#f8fafc";
                                    cardBorder = "1px solid #cbd5e1";
                                  } else if (isOpening) {
                                    cardBg = "#fafbfc";
                                    cardBorder = "1px solid #e2e8f0";
                                  }

                                  return (
                                    <div
                                      key={elem.id}
                                      style={{
                                        display: "grid",
                                        gridTemplateColumns: gridTemplateColumns,
                                        alignItems: "center",
                                        background: cardBg,
                                        border: cardBorder,
                                        borderRadius: "10px",
                                        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.03)",
                                        overflow: "hidden"
                                      }}
                                    >
                                      {/* Spacers before/after Target Month */}
                                      {spacerBeforeTarget && (
                                        <div
                                          style={{
                                            gridColumn: `${spacerBeforeTarget}`,
                                            background: "#f8fafc",
                                            borderLeft: "1px solid #e2e8f0",
                                            borderRight: "1px solid #e2e8f0",
                                            alignSelf: "stretch"
                                          }}
                                        />
                                      )}
                                      {spacerAfterTarget && (
                                        <div
                                          style={{
                                            gridColumn: `${spacerAfterTarget}`,
                                            background: "#f8fafc",
                                            borderLeft: "1px solid #e2e8f0",
                                            borderRight: "1px solid #e2e8f0",
                                            alignSelf: "stretch"
                                          }}
                                        />
                                      )}
                                      {/* Title */}
                                      <div
                                        style={{
                                          gridColumn: "1",
                                          padding: "9px 14px",
                                          fontWeight: elem.isSummary ? "700" : "500",
                                          fontSize: "12px",
                                          color: isDiff ? (valNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b"),
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px"
                                        }}
                                      >
                                        <span>{elem.title}</span>
                                        {isDiff && valNum === 0 && (
                                          <span style={{
                                            fontSize: "9px",
                                            padding: "1px 6px",
                                            background: "#dcfce7",
                                            color: "#166534",
                                            borderRadius: "4px",
                                            fontWeight: "800",
                                            textTransform: "uppercase"
                                          }}>
                                            In Balance ✓
                                          </span>
                                        )}
                                      </div>

                                      {/* Month Columns */}
                                      {row.cells.map((cell, cIndex) => {
                                        const isTargetCol = reconData.selectedCols[cIndex]?.type === "target";
                                        const gridCol = colPositions[cIndex];
                                        const cellValNum = parseAmount(cell.v);

                                        if (isTargetCol) {
                                          return (
                                            <div
                                              key={cell.colIdx}
                                              style={{
                                                gridColumn: `${gridCol} / ${gridCol + 3}`,
                                                padding: "9px 10px",
                                                textAlign: "right",
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "flex-end",
                                                gap: "8px",
                                                fontWeight: elem.isSummary ? "700" : "500",
                                                fontSize: "12px",
                                                color: isDiff ? (cellValNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b")
                                              }}
                                            >
                                              {renderNoteButton(row, cell)}
                                              <span
                                                style={{
                                                  display: "inline-block",
                                                  minWidth: "80px",
                                                  textAlign: "right",
                                                  padding: "3px 8px",
                                                  border: "1px solid transparent",
                                                  boxSizing: "border-box",
                                                  fontVariantNumeric: "tabular-nums",
                                                  whiteSpace: "nowrap"
                                                }}
                                              >
                                                {isDiff && cellValNum === 0 ? "✓ £0.00" : (cell.v || "")}
                                              </span>
                                            </div>
                                          );
                                        }

                                        return (
                                          <div
                                            key={cell.colIdx}
                                            style={{
                                              gridColumn: `${gridCol}`,
                                              padding: "9px 10px",
                                              textAlign: "right",
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: "flex-end",
                                              gap: "6px",
                                              fontWeight: elem.isSummary ? "700" : "500",
                                              fontSize: "12px",
                                              color: isDiff ? (cellValNum === 0 ? "#166534" : "#991b1b") : (isClosing || isNet ? "#1e40af" : "#1e293b")
                                            }}
                                          >
                                            {renderNoteButton(row, cell)}
                                            <span
                                              style={{
                                                display: "inline-block",
                                                minWidth: "80px",
                                                textAlign: "right",
                                                padding: "3px 8px",
                                                border: "1px solid transparent",
                                                boxSizing: "border-box",
                                                fontVariantNumeric: "tabular-nums",
                                                whiteSpace: "nowrap"
                                              }}
                                            >
                                              {isDiff && cellValNum === 0 ? "✓ £0.00" : (cell.v || "")}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit Adjustment Modal */}
      {editingCell && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "460px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
          }}>
            <h4 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
              Edit adjustment: {editingCell.label}
            </h4>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              {isAdmin && <>Cell: <strong>Cash!{editingCell.colLetter}{editingCell.sheetRow}</strong> • </>}Current: {editingCell.currentValue || "0"}
            </p>

            <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "6px" }}>
              {isAdmin ? "New value or formula (e.g. 500, -250, or =26850-C6)" : "New adjustment value (e.g. 500 or -250)"}
            </label>
            <input
              type="text"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              placeholder={isAdmin ? "Enter number or formula..." : "Enter adjustment amount..."}
              autoFocus
              onKeyDown={e => {
                if (e.key === "Enter") handleSaveEdit();
                if (e.key === "Escape") setEditingCell(null);
              }}
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "14px",
                boxSizing: "border-box",
                marginBottom: "14px"
              }}
            />

            <div style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "12px",
              marginBottom: "16px"
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <span style={{ fontSize: "11.5px", fontWeight: "700", color: "#334155" }}>
                  Adjustment notes (optional)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const parsedVal = parseFloat(String(editValue || "0").replace(/[£,\s]/g, "")) || parseAmount(editingCell.currentValue);
                    const suggested = generateSuggestedNotesForRow({
                      rowLabel: editingCell.label,
                      mappedItemType: editingCell.mappedItemType,
                      targetMonthLabel: editingCell.colLabel,
                      targetAdjVal: parsedVal,
                      nextOffsetVal: null
                    });
                    setEditGeneralNote(suggested.targetGeneral);
                    setEditPulseNote(suggested.targetPulse);
                  }}
                  style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#0284c7",
                    fontSize: "10.5px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  ↻ Suggest notes
                </button>
              </div>

              <div style={{ marginBottom: "10px" }}>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#334155", marginBottom: "3px" }}>
                  Internal note <span style={{ fontWeight: "400", color: "#64748b" }}>(not shown to client in Pulse)</span>
                </label>
                <textarea
                  value={editGeneralNote}
                  onChange={e => setEditGeneralNote(e.target.value)}
                  placeholder="Internal note for managers..."
                  rows={2}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "12px",
                    boxSizing: "border-box",
                    fontFamily: "inherit"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#0047AB", marginBottom: "3px" }}>
                  Client-facing Pulse note <span style={{ fontWeight: "400", color: "#64748b" }}>(shown in Pulse breakdowns)</span>
                </label>
                <textarea
                  value={editPulseNote}
                  onChange={e => setEditPulseNote(e.target.value)}
                  placeholder="Client-facing explanation for this adjustment..."
                  rows={2}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    border: "1px solid #93c5fd",
                    borderRadius: "6px",
                    fontSize: "12px",
                    boxSizing: "border-box",
                    fontFamily: "inherit",
                    background: "#f0f7ff"
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setEditingCell(null)}
                disabled={savingEdit}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={savingEdit}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#0284c7",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: savingEdit ? "default" : "pointer",
                  opacity: savingEdit ? 0.7 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {savingEdit ? <><Spinner size={12} color="#fff" /> Saving...</> : "Save adjustment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overwrite Confirmation Modal for Recon Formula */}
      {overwriteModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "480px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <h4 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#991b1b" }}>
                Confirm overwrite of existing adjustment
              </h4>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#334155", lineHeight: "1.4" }}>
              The target adjustment {isAdmin ? <>cell <strong>Cash!{overwriteModal.colLetter}{overwriteModal.targetRow}</strong> ({overwriteModal.adjRowLabel})</> : <>line <strong>{overwriteModal.adjRowLabel}</strong></>} currently contains a pre-existing value:
            </p>

            {isAdmin && overwriteModal.currentFormula ? (
              <div style={{ padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", marginBottom: "14px" }}>
                <div style={{ fontSize: "12px", color: "#7f1d1d", marginBottom: "4px" }}>
                  Current formula: <code style={{ background: "#ffffff", padding: "2px 6px", borderRadius: "4px", border: "1px solid #fca5a5", fontSize: "12px", fontWeight: "700", color: "#991b1b" }}>{overwriteModal.currentFormula}</code>
                </div>
                <div style={{ fontSize: "12px", color: "#7f1d1d" }}>
                  Evaluates to: <strong>{overwriteModal.currentValue || "£0.00"}</strong>
                </div>
              </div>
            ) : (
              <div style={{ padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", fontSize: "13px", color: "#991b1b", fontWeight: "600", marginBottom: "14px" }}>
                Current value: {overwriteModal.currentValue || "£0.00"}
              </div>
            )}

            {isAdmin && (
              <p style={{ margin: "0 0 14px", fontSize: "13px", color: "#334155" }}>
                Applying this recon figure will overwrite it with formula:
                <br />
                <code style={{ display: "block", marginTop: "4px", padding: "6px 8px", background: "#f1f5f9", borderRadius: "4px", fontSize: "13px", color: "#0f172a" }}>
                  {overwriteModal.formula}
                </code>
              </p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setOverwriteModal(null)}
                disabled={applyingRecon}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => executeApplyReconFormula(overwriteModal.targetRow, overwriteModal.colLetter, overwriteModal.formula)}
                disabled={applyingRecon}
                style={{
                  padding: "7px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: applyingRecon ? "default" : "pointer",
                  opacity: applyingRecon ? 0.7 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {applyingRecon ? <><Spinner size={12} color="#fff" /> Applying...</> : (isAdmin ? "Overwrite & apply formula" : "Overwrite & apply")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Match Actuals Confirmation Modal */}
      {showMatchConfirm && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "24px",
            width: "100%",
            maxWidth: "500px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15)"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <span style={{ fontSize: "24px" }}>⚡</span>
              <h4 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                Match all actuals for {reconData?.targetMonthLabel || "target month"}
              </h4>
            </div>

            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
              This action will automatically apply the {isAdmin ? "reconciliation actual formulas" : "reconciliation actuals"} to all adjustment rows and mark all cashflow lines as <strong>resolved</strong> for <strong>{reconData?.targetMonthLabel || "target month"}</strong>{isAdmin ? ` (${targetCol?.colLetter})` : ""}:
            </p>

            <div style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "16px",
              fontSize: "12px",
              color: "#334155"
            }}>
              <ul style={{ margin: 0, paddingLeft: "18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" }}>
                <li>Confirmed cash incoming (to Incoming cash adj)</li>
                <li>Salaries outgoing</li>
                <li>Dividends as salary</li>
                <li>Contractors</li>
                <li>Direct costs</li>
                <li>Other expenses</li>
                {isCombinedTransferMode ? (
                  <li style={{ gridColumn: "1 / span 2", fontWeight: "600", color: "#0369a1" }}>
                    Tax transfers (Corporation tax & VAT combined via Transfer total)
                  </li>
                ) : (
                  <>
                    <li>Corporation tax</li>
                    <li>VAT</li>
                  </>
                )}
                <li>Non-operating income</li>
                <li>Non-operating expenses</li>
                <li>Other cash movements</li>
              </ul>
            </div>

            <p style={{ margin: "0 0 18px", fontSize: "12px", color: "#64748b", fontStyle: "italic" }}>
              {isAdmin
                ? "Any pre-existing adjustment formulas or manual overrides for this month will be updated with the calculated variance formulas."
                : "Any pre-existing adjustments or manual overrides for this month will be updated with the reconciled figures."}
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setShowMatchConfirm(false)}
                disabled={matchingActuals}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeMatchAllActuals}
                disabled={matchingActuals}
                style={{
                  padding: "7px 18px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#15803d",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: matchingActuals ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {matchingActuals ? <Spinner size={14} /> : "⚡"}
                {matchingActuals ? "Applying actuals..." : "Match all actuals"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Note Edit Modal */}
      {noteModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px 24px",
            width: "100%",
            maxWidth: "460px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)"
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
              <h4 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                {isAdmin ? "Edit cell note" : "Edit note"}: {noteModal.label}
              </h4>
              <button
                type="button"
                onClick={() => {
                  const suggested = generateSuggestedNotesForRow({
                    rowLabel: noteModal.parentLabel || noteModal.label,
                    mappedItemType: noteModal.mappedItemType,
                    targetMonthLabel: noteModal.colLabel,
                    targetAdjVal: noteModal.cellVal || 0,
                    nextOffsetVal: null
                  });
                  setGeneralNoteDraft(suggested.targetGeneral);
                  setPulseNoteDraft(suggested.targetPulse);
                }}
                style={{
                  padding: "3px 9px",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  color: "#0284c7",
                  fontSize: "11px",
                  fontWeight: "600",
                  cursor: "pointer",
                  whiteSpace: "nowrap"
                }}
              >
                ↻ Suggest notes
              </button>
            </div>
            {isAdmin && (
              <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
                Cell: <strong>Cash!{noteModal.colLetter}{noteModal.sheetRow}</strong>
              </p>
            )}

            <div style={{ marginBottom: "14px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                Internal note <span style={{ fontWeight: "400", color: "#64748b", fontSize: "11px" }}>(internal only, not shown in Pulse)</span>
              </label>
              <textarea
                value={generalNoteDraft}
                onChange={e => setGeneralNoteDraft(e.target.value)}
                placeholder="Enter internal notes, audit memos, or reconciliation comments..."
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  boxSizing: "border-box",
                  fontFamily: "inherit"
                }}
              />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#0047AB", marginBottom: "4px" }}>
                Client-facing Pulse note <span style={{ fontWeight: "400", color: "#64748b", fontSize: "11px" }}>(shown in Pulse breakdowns)</span>
              </label>
              <textarea
                value={pulseNoteDraft}
                onChange={e => setPulseNoteDraft(e.target.value)}
                placeholder="e.g. Partial payment of invoice 1045 made in September, remainder to be paid in October"
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #93c5fd",
                  borderRadius: "6px",
                  fontSize: "13px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  background: "#f0f7ff"
                }}
              />
              <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#64748b" }}>
                {isAdmin
                  ? <>Saved with <code>[Note: ...]</code> wrapper for display in Pulse popovers and monthly breakdown pages.</>
                  : "Displayed to the client in Pulse cashflow popovers and monthly breakdown pages."}
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setNoteModal(null)}
                disabled={savingNote}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveNote}
                disabled={savingNote}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#0284c7",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: savingNote ? "default" : "pointer",
                  opacity: savingNote ? 0.7 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {savingNote ? <><Spinner size={12} color="#fff" /> Saving...</> : "Save note"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Offset in Next Month Modal */}
      {offsetModal && targetCol && nextCol && (() => {
        const effectiveTargetAdj = offsetModal.applyTargetRecon ? offsetModal.reconAdjVal : offsetModal.currentTargetAdjVal;
        const linkedOffsetVal = -effectiveTargetAdj;
        const customOffsetVal = parseFloat(String(offsetModal.customAmount || "0").replace(/[£,\s]/g, "")) || 0;
        const activeNextOffsetVal = offsetModal.offsetMode === "linked" ? linkedOffsetVal : customOffsetVal;
        const nextShortLabel = (nextCol.label || "next month").split(" ")[0];

        return (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1005,
            padding: "16px"
          }}>
            <div style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "20px 24px",
              width: "100%",
              maxWidth: "580px",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15)"
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px", marginBottom: "10px" }}>
                <div>
                  <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                    Offset in {nextCol.label}: {offsetModal.title}
                  </h4>
                  <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                    Carry over or reverse {targetCol.label} timing variances in {nextCol.label} with client-facing and internal notes.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOffsetModal(null)}
                  disabled={savingOffset}
                  style={{
                    background: "transparent",
                    border: "none",
                    fontSize: "16px",
                    color: "#64748b",
                    cursor: "pointer",
                    padding: "2px 6px"
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Target Month Summary Box */}
              <div style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "10px 12px",
                marginBottom: "12px",
                fontSize: "12px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                  <div>
                    <span style={{ color: "#64748b" }}>{targetCol.label} forecast: </span>
                    <strong style={{ color: "#0f172a" }}>{formatGBP(offsetModal.baseVal)}</strong>
                    {offsetModal.txVal !== null && offsetModal.txVal !== undefined && (
                      <>
                        <span style={{ color: "#94a3b8", margin: "0 6px" }}>•</span>
                        <span style={{ color: "#64748b" }}>Transactions total: </span>
                        <strong style={{ color: "#0f172a" }}>{formatGBP(offsetModal.txVal)}</strong>
                      </>
                    )}
                  </div>
                  <div>
                    <span style={{ color: "#64748b" }}>{targetCol.label} adjustment: </span>
                    <strong style={{ color: "#0284c7" }}>{formatGBP(effectiveTargetAdj)}</strong>
                  </div>
                </div>

                {!offsetModal.isReconAlreadyUsed && offsetModal.hasUnreconciledVariance && offsetModal.reconFormula && (
                  <label style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "7px",
                    marginTop: "8px",
                    paddingTop: "8px",
                    borderTop: "1px dashed #cbd5e1",
                    cursor: "pointer",
                    fontSize: "12px",
                    color: "#1e293b",
                    fontWeight: "600"
                  }}>
                    <input
                      type="checkbox"
                      checked={Boolean(offsetModal.applyTargetRecon)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const nextTargetAdj = checked ? offsetModal.reconAdjVal : offsetModal.currentTargetAdjVal;
                        const nextDefaultCustom = Number((-nextTargetAdj).toFixed(2));
                        const nextState = {
                          ...offsetModal,
                          applyTargetRecon: checked,
                          customAmount: offsetModal.offsetMode === "linked" ? String(nextDefaultCustom) : offsetModal.customAmount
                        };
                        setOffsetModal(nextState);
                        handleRefreshOffsetSuggestedNotes(nextState);
                      }}
                    />
                    <span>
                      Also apply {targetCol.label} reconciliation adjustment ({formatGBP(offsetModal.reconAdjVal)})
                    </span>
                  </label>
                )}
              </div>

              {/* Next Month Offset Mode Selector */}
              <div style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  {nextCol.label} offset method
                </label>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {/* Option 1: Linked 100% Auto-Reversing Offset */}
                  <label
                    onClick={() => {
                      const nextState = { ...offsetModal, offsetMode: "linked" };
                      setOffsetModal(nextState);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "9px",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: offsetModal.offsetMode === "linked" ? "1.5px solid #4f46e5" : "1px solid #cbd5e1",
                      background: offsetModal.offsetMode === "linked" ? "#eef2ff" : "#ffffff",
                      cursor: "pointer"
                    }}
                  >
                    <input
                      type="radio"
                      name="offsetMode"
                      checked={offsetModal.offsetMode === "linked"}
                      onChange={() => {
                        const nextState = { ...offsetModal, offsetMode: "linked" };
                        setOffsetModal(nextState);
                      }}
                      style={{ marginTop: "3px" }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12.5px", fontWeight: "700", color: "#1e293b" }}>
                          Full linked offset (auto-reversing)
                        </span>
                        <span style={{ fontSize: "12.5px", fontWeight: "700", color: "#4338ca" }}>
                          {formatGBP(linkedOffsetVal)}
                        </span>
                      </div>
                      <p style={{ margin: "3px 0 0", fontSize: "11.5px", color: "#475569", lineHeight: "1.4" }}>
                        Automatically reverses the {targetCol.label} adjustment in {nextCol.label}. If {targetCol.label} changes or an unreconciled payment is later matched in Xero/QuickBooks, {nextCol.label} automatically updates.
                        {isAdmin && (
                          <span style={{ marginLeft: "6px", padding: "1px 5px", background: "#e0e7ff", color: "#3730a3", borderRadius: "4px", fontFamily: "monospace", fontSize: "10.5px", fontWeight: "700" }}>
                            =-{targetCol.colLetter}{offsetModal.adjSheetRow}
                          </span>
                        )}
                      </p>
                    </div>
                  </label>

                  {/* Option 2: Partial / Custom Carry-Over Amount */}
                  <div
                    onClick={() => {
                      if (offsetModal.offsetMode !== "custom") {
                        setOffsetModal(prev => prev ? ({ ...prev, offsetMode: "custom" }) : prev);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "9px",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: offsetModal.offsetMode === "custom" ? "1.5px solid #4f46e5" : "1px solid #cbd5e1",
                      background: offsetModal.offsetMode === "custom" ? "#eef2ff" : "#ffffff",
                      cursor: "pointer"
                    }}
                  >
                    <input
                      type="radio"
                      name="offsetMode"
                      checked={offsetModal.offsetMode === "custom"}
                      onChange={() => setOffsetModal(prev => prev ? ({ ...prev, offsetMode: "custom" }) : prev)}
                      style={{ marginTop: "3px" }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12.5px", fontWeight: "700", color: "#1e293b" }}>
                          Partial or custom carry-over amount
                        </span>
                        <span style={{ fontSize: "12.5px", fontWeight: "700", color: "#4338ca" }}>
                          {formatGBP(customOffsetVal)}
                        </span>
                      </div>
                      <p style={{ margin: "3px 0 8px", fontSize: "11.5px", color: "#475569", lineHeight: "1.4" }}>
                        Specify the exact amount deferred into {nextCol.label} (e.g. partial salary, contractor, or cost deferral).
                      </p>

                      {offsetModal.offsetMode === "custom" && (
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }} onClick={e => e.stopPropagation()}>
                          <input
                            type="text"
                            value={offsetModal.customAmount}
                            onChange={e => setOffsetModal(prev => prev ? ({ ...prev, customAmount: e.target.value }) : prev)}
                            placeholder="e.g. -4000"
                            style={{
                              width: "140px",
                              padding: "6px 10px",
                              border: "1px solid #94a3b8",
                              borderRadius: "6px",
                              fontSize: "13px",
                              fontWeight: "600",
                              background: "#ffffff"
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setOffsetModal(prev => prev ? ({ ...prev, customAmount: String(Number(linkedOffsetVal.toFixed(2))) }) : prev)}
                            style={{
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid #cbd5e1",
                              background: "#ffffff",
                              color: "#334155",
                              fontSize: "11px",
                              fontWeight: "600",
                              cursor: "pointer"
                            }}
                          >
                            100% ({formatGBP(linkedOffsetVal)})
                          </button>
                          <button
                            type="button"
                            onClick={() => setOffsetModal(prev => prev ? ({ ...prev, customAmount: String(Number((linkedOffsetVal * 0.5).toFixed(2))) }) : prev)}
                            style={{
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid #cbd5e1",
                              background: "#ffffff",
                              color: "#334155",
                              fontSize: "11px",
                              fontWeight: "600",
                              cursor: "pointer"
                            }}
                          >
                            50% ({formatGBP(linkedOffsetVal * 0.5)})
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Suggested Notes for Both Months */}
              <div style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "12px",
                marginBottom: "16px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <span style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a" }}>
                    Suggested notes for {targetCol.label} and {nextCol.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRefreshOffsetSuggestedNotes()}
                    style={{
                      padding: "3px 9px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#0284c7",
                      fontSize: "11px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    ↻ Refresh suggested notes
                  </button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {/* Target Month Notes */}
                  <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "9px" }}>
                    <div style={{ fontSize: "11.5px", fontWeight: "700", color: "#15803d", marginBottom: "6px" }}>
                      {targetCol.label} ({formatGBP(effectiveTargetAdj)})
                    </div>
                    <label style={{ display: "block", fontSize: "10.5px", fontWeight: "700", color: "#475569", marginBottom: "2px" }}>
                      Internal note
                    </label>
                    <textarea
                      value={offsetModal.targetGeneralNote}
                      onChange={e => setOffsetModal(prev => prev ? ({ ...prev, targetGeneralNote: e.target.value }) : prev)}
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "5px 7px",
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        fontSize: "11.5px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        marginBottom: "6px"
                      }}
                    />
                    <label style={{ display: "block", fontSize: "10.5px", fontWeight: "700", color: "#0047AB", marginBottom: "2px" }}>
                      Client-facing Pulse note
                    </label>
                    <textarea
                      value={offsetModal.targetPulseNote}
                      onChange={e => setOffsetModal(prev => prev ? ({ ...prev, targetPulseNote: e.target.value }) : prev)}
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "5px 7px",
                        border: "1px solid #93c5fd",
                        borderRadius: "4px",
                        fontSize: "11.5px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        background: "#f0f7ff"
                      }}
                    />
                  </div>

                  {/* Next Month Notes */}
                  <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "9px" }}>
                    <div style={{ fontSize: "11.5px", fontWeight: "700", color: "#4338ca", marginBottom: "6px" }}>
                      {nextCol.label} ({formatGBP(activeNextOffsetVal)})
                    </div>
                    <label style={{ display: "block", fontSize: "10.5px", fontWeight: "700", color: "#475569", marginBottom: "2px" }}>
                      Internal note
                    </label>
                    <textarea
                      value={offsetModal.nextGeneralNote}
                      onChange={e => setOffsetModal(prev => prev ? ({ ...prev, nextGeneralNote: e.target.value }) : prev)}
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "5px 7px",
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        fontSize: "11.5px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        marginBottom: "6px"
                      }}
                    />
                    <label style={{ display: "block", fontSize: "10.5px", fontWeight: "700", color: "#0047AB", marginBottom: "2px" }}>
                      Client-facing Pulse note
                    </label>
                    <textarea
                      value={offsetModal.nextPulseNote}
                      onChange={e => setOffsetModal(prev => prev ? ({ ...prev, nextPulseNote: e.target.value }) : prev)}
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "5px 7px",
                        border: "1px solid #93c5fd",
                        borderRadius: "4px",
                        fontSize: "11.5px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        background: "#f0f7ff"
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div>
                  {offsetModal.hasExistingNextOffset && (
                    <button
                      type="button"
                      onClick={() => handleSaveOffset(true)}
                      disabled={savingOffset}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid #fecaca",
                        background: "#fef2f2",
                        color: "#b91c1c",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: savingOffset ? "default" : "pointer"
                      }}
                    >
                      Clear {nextShortLabel} offset
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setOffsetModal(null)}
                    disabled={savingOffset}
                    style={{
                      padding: "6px 14px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#475569",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveOffset(false)}
                    disabled={savingOffset}
                    style={{
                      padding: "6px 18px",
                      borderRadius: "6px",
                      border: "none",
                      background: "#4f46e5",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: savingOffset ? "default" : "pointer",
                      opacity: savingOffset ? 0.7 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px"
                    }}
                  >
                    {savingOffset ? <><Spinner size={12} color="#fff" /> Saving...</> : `Apply ${nextShortLabel} offset & notes`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
