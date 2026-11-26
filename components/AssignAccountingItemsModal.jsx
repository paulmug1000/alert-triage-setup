import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import InvoiceDetailsModal from "./InvoiceDetailsModal";
import { getStatusPill, sanitizeSpreadsheetTerms } from "../utils/helpers";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const parseMoney = (val) => {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const n = parseFloat(String(val ?? "").replace(/[£$€,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const fmtMoney = (val, symbol = "£") => {
  const num = Number(val) || 0;
  const absStr = Math.abs(num).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-${symbol}${absStr}` : `${symbol}${absStr}`;
};

const formatMonthTag = (monthKey) => {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return "";
  const [y, m] = monthKey.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${y}` : monthKey;
};

const itemMatchesSearch = (item, qLower) => {
  if (!qLower) return true;
  const hay = [
    item.invoiceNo,
    item.appId,
    item.client,
    item.job,
    item.reference,
    item.description,
    item.displayDescription,
    item.contactName,
    item.accountName,
    item.status,
    item.sentDate,
    item.date,
    item.amount != null ? String(item.amount) : "",
    item.assignedJob?.client,
    item.assignedJob?.jobName,
    item.assignedJob?.projectCode,
    item.assignedContractor?.name,
    item.assignedContractor?.monthLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(qLower);
};

export default function AssignAccountingItemsModal({
  isOpen,
  onClose,
  itemType = "invoice",
  surface = "portal", // "portal" | "pma"
  clientName = "",
  clientSheetId = "",
  masterSheetId = "",
  targetJob = null,
  currencySymbol = "£",
  prefetchedCatalog = null,
  onCatalogUpdated,
  onCompleted,
  isAdmin = false,
}) {
  const isInvoice = itemType === "invoice";
  const [activeTab, setActiveTab] = useState("unassigned"); // "unassigned" | "reassign"
  const [lookbackMonths, setLookbackMonths] = useState(3);
  const [searchQuery, setSearchQuery] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Live background sync state: "idle" | "checking" | "pulling" | "uptodate" | "synced" | "error"
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncToolName, setSyncToolName] = useState("");
  const [syncErrorMsg, setSyncErrorMsg] = useState("");

  // Pending selections in Unassigned tab
  const [pendingAssignKeys, setPendingAssignKeys] = useState(() => new Set());
  const [pendingUnassignKeys, setPendingUnassignKeys] = useState(() => new Set());

  // Reassign inline confirmation state
  const [confirmMoveKey, setConfirmMoveKey] = useState(null);
  const [increaseBudgetOnMove, setIncreaseBudgetOnMove] = useState(true);
  const [movingKey, setMovingKey] = useState(null);

  // Batch save + overrun prompt state
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [overrunPrompt, setOverrunPrompt] = useState(null);
  const [viewingInvoiceDetails, setViewingInvoiceDetails] = useState(null);

  const openInvoiceDetails = useCallback(
    (item) => {
      if (!item?.invoiceNo) return;
      setViewingInvoiceDetails({
        invoiceNo: item.invoiceNo,
        clientSheetId,
        masterSheetId,
        clientName,
        surface,
        initialLineItems: Array.isArray(item.lineItems) ? item.lineItems : [],
        fallbackSummary: {
          client: item.client || item.contactName || "",
          jobName: item.job || item.assignedJob?.jobName || targetJob?.jobName || "",
          amount: item.amountOnJob ?? item.amount,
          sentDate: item.sentDate || item.date || "",
          dueDate: item.dueDate || "",
          status: item.status || "",
          currencyCode: item.currency || "GBP",
          rechargedAmountGbp: item.detectedRechargedAmount || 0,
        },
      });
    },
    [clientSheetId, masterSheetId, clientName, surface, targetJob?.jobName]
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const targetJobPayload = useMemo(() => {
    if (!targetJob) return null;
    return {
      client: targetJob.client || "",
      jobName: targetJob.jobName || "",
      projectCode: targetJob.projectCode || "",
      ...(targetJob.jobUuid ? { jobUuid: targetJob.jobUuid } : {}),
      isRetainer: Boolean(targetJob.isRetainer),
      startDate: targetJob.startDate || "",
      endDate: targetJob.endDate || "",
      rowNum: targetJob.rowNum || targetJob.rowNumber || undefined,
    };
  }, [targetJob]);

  const callCatalogEndpoint = useCallback(
    async (action, extra = {}) => {
      if (surface === "portal") {
        const res = await fetch("/api/portal/accounting-catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            clientSheetId,
            clientName,
            itemType,
            ...extra,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to load accounting data.");
        }
        return data;
      }

      const triageAction =
        action === "refresh" ? "refresh_accounting_catalog" : "get_accounting_catalog";
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: triageAction,
          clientSheetId,
          masterSheetId,
          clientName,
          itemType,
          ...extra,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load accounting data.");
      }
      return data;
    },
    [surface, clientSheetId, masterSheetId, clientName, itemType]
  );

  const callMutationEndpoint = useCallback(
    async (action, extra = {}) => {
      if (surface === "portal") {
        const res = await fetch("/api/portal/assign-job-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            clientSheetId,
            clientName,
            itemType,
            targetJob: targetJobPayload,
            ...extra,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to update job.");
        }
        return data;
      }

      const triageAction = action === "move" ? "move_job_item" : "batch_assign_job_items";
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: triageAction,
          clientSheetId,
          masterSheetId,
          clientName,
          itemType,
          targetJob: targetJobPayload,
          ...extra,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to update job.");
      }
      return data;
    },
    [surface, clientSheetId, masterSheetId, clientName, itemType, targetJobPayload]
  );

  const mergeCatalogPreservingSelections = useCallback(
    (nextCatalog) => {
      setCatalog(nextCatalog);
      if (nextCatalog?.accountingTool && nextCatalog.accountingTool !== "None") {
        setSyncToolName(nextCatalog.accountingTool);
      }
      if (typeof onCatalogUpdated === "function") {
        onCatalogUpdated(itemType, nextCatalog);
      }
      const validUnassigned = new Set((nextCatalog?.unassigned || []).map((i) => i.key));
      const validCurrent = new Set((nextCatalog?.assignedToCurrentJob || []).map((i) => i.key));
      setPendingAssignKeys((prev) => {
        const next = new Set();
        prev.forEach((k) => {
          if (validUnassigned.has(k)) next.add(k);
        });
        return next;
      });
      setPendingUnassignKeys((prev) => {
        const next = new Set();
        prev.forEach((k) => {
          if (validCurrent.has(k)) next.add(k);
        });
        return next;
      });
    },
    [itemType, onCatalogUpdated]
  );

  const fetchCatalog = useCallback(
    async (months, { showSpinner = true } = {}) => {
      if (!clientSheetId || !targetJobPayload) return null;
      if (showSpinner) setLoading(true);
      setLoadError("");
      try {
        const data = await callCatalogEndpoint("get", {
          lookbackMonths: months,
          targetJob: targetJobPayload,
        });
        if (!mountedRef.current) return null;
        mergeCatalogPreservingSelections(data);
        return data;
      } catch (err) {
        if (!mountedRef.current) return null;
        const msg = err?.message || "Failed to load items.";
        setLoadError(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
        return null;
      } finally {
        if (mountedRef.current && showSpinner) setLoading(false);
      }
    },
    [clientSheetId, targetJobPayload, callCatalogEndpoint, mergeCatalogPreservingSelections, isAdmin]
  );

  const runBackgroundSync = useCallback(
    async (months, force = false) => {
      if (!clientSheetId || !targetJobPayload) return;
      setSyncStatus(force ? "pulling" : "checking");
      setSyncErrorMsg("");
      try {
        const res = await callCatalogEndpoint("refresh", { force });
        if (!mountedRef.current) return;
        if (res.tool) setSyncToolName(res.tool);
        if (res.refreshed) {
          setSyncStatus("synced");
          await fetchCatalog(months, { showSpinner: false });
        } else if (res.upToDate) {
          setSyncStatus("uptodate");
        } else if (res.inProgress) {
          setSyncStatus("pulling");
        } else {
          setSyncStatus("idle");
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setSyncStatus("error");
        const msg = err?.message || "Could not check accounting feed.";
        setSyncErrorMsg(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
      }
    },
    [clientSheetId, targetJobPayload, callCatalogEndpoint, fetchCatalog, isAdmin]
  );

  // Reset modal state on open
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab("unassigned");
    setLookbackMonths(3);
    setSearchQuery("");
    setPendingAssignKeys(new Set());
    setPendingUnassignKeys(new Set());
    setConfirmMoveKey(null);
    setMovingKey(null);
    setSaving(false);
    setActionError("");
    setLoadError("");
    setOverrunPrompt(null);
    setSyncStatus("idle");
    setSyncErrorMsg("");

    const canUsePrefetched =
      prefetchedCatalog &&
      prefetchedCatalog.itemType === itemType &&
      Number(prefetchedCatalog.lookbackMonths || 3) === 3;

    if (canUsePrefetched) {
      mergeCatalogPreservingSelections(prefetchedCatalog);
      setLoading(false);
      // Silently refresh catalog & run delta check
      fetchCatalog(3, { showSpinner: false });
      runBackgroundSync(3, false);
    } else {
      setCatalog(null);
      fetchCatalog(3, { showSpinner: true }).then(() => {
        if (mountedRef.current) runBackgroundSync(3, false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, itemType]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !saving && !movingKey) {
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, saving, movingKey, onClose]);

  const handleLookbackChange = (months) => {
    setLookbackMonths(months);
    fetchCatalog(months, { showSpinner: true });
  };

  const toggleAssignKey = (key) => {
    setActionError("");
    setOverrunPrompt(null);
    setPendingAssignKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleUnassignKey = (key) => {
    setActionError("");
    setOverrunPrompt(null);
    setPendingUnassignKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const qLower = searchQuery.trim().toLowerCase();

  const filteredCurrentItems = useMemo(() => {
    const list = catalog?.assignedToCurrentJob || [];
    if (!qLower) return list;
    return list.filter((it) => itemMatchesSearch(it, qLower));
  }, [catalog, qLower]);

  const filteredUnassignedItems = useMemo(() => {
    const list = catalog?.unassigned || [];
    if (!qLower) return list;
    return list.filter((it) => itemMatchesSearch(it, qLower));
  }, [catalog, qLower]);

  const filteredReassignItems = useMemo(() => {
    const list = catalog?.assignedToOtherJobs || [];
    if (!qLower) return list;
    return list.filter((it) => itemMatchesSearch(it, qLower));
  }, [catalog, qLower]);

  const pendingStats = useMemo(() => {
    const unassignedByKey = new Map((catalog?.unassigned || []).map((i) => [i.key, i]));
    const currentByKey = new Map((catalog?.assignedToCurrentJob || []).map((i) => [i.key, i]));

    let assignSum = 0;
    const assignItems = [];
    pendingAssignKeys.forEach((k) => {
      const item = unassignedByKey.get(k);
      if (item) {
        assignSum += parseMoney(item.amount);
        assignItems.push({
          key: item.key,
          monthKey: item.monthKey || "",
        });
      }
    });

    let unassignSum = 0;
    const unassignKeys = [];
    pendingUnassignKeys.forEach((k) => {
      const item = currentByKey.get(k);
      if (item) {
        unassignSum += parseMoney(item.amountOnJob ?? item.amount);
        unassignKeys.push(item.key);
      }
    });

    return {
      assignItems,
      unassignKeys,
      assignCount: assignItems.length,
      unassignCount: unassignKeys.length,
      assignSum: round2(assignSum),
      unassignSum: round2(unassignSum),
      netDelta: round2(assignSum - unassignSum),
    };
  }, [catalog, pendingAssignKeys, pendingUnassignKeys]);

  // Compute current job totals for overrun prompt checks
  const jobBudgets = useMemo(() => {
    const rev = parseMoney(targetJob?.revenue);
    const rech = parseMoney(targetJob?.rechargedExpenses);
    const billable = round2(rev + rech);
    const dcBudget = round2(parseMoney(targetJob?.directCosts));
    const currentRealFromCatalog = round2(
      (catalog?.assignedToCurrentJob || []).reduce(
        (s, it) => s + parseMoney(it.amountOnJob ?? it.amount),
        0
      )
    );
    const baseRealInv =
      targetJob?.currentRealInvoiced !== undefined
        ? round2(parseMoney(targetJob.currentRealInvoiced))
        : currentRealFromCatalog;
    const baseRealDc =
      targetJob?.currentRealDirectCosts !== undefined
        ? round2(parseMoney(targetJob.currentRealDirectCosts))
        : currentRealFromCatalog;
    return {
      billable,
      dcBudget,
      baseRealInv,
      baseRealDc,
      isRetainer: Boolean(targetJob?.isRetainer),
      isJobCosting: Boolean(targetJob?.isJobCosting),
    };
  }, [targetJob, catalog]);

  const executeBatchSave = async ({ increaseBudget = false, projectedTotal = undefined } = {}) => {
    setSaving(true);
    setActionError("");
    setOverrunPrompt(null);
    try {
      const payload = {
        assignItems: pendingStats.assignItems,
        unassignKeys: pendingStats.unassignKeys,
        ...(isInvoice && increaseBudget && projectedTotal !== undefined
          ? { updateJobRevenue: true, newJobRevenue: projectedTotal }
          : {}),
        ...(!isInvoice && increaseBudget && projectedTotal !== undefined && !jobBudgets.isJobCosting
          ? { updateJobBudget: true, newJobBudget: projectedTotal }
          : {}),
      };
      const res = await callMutationEndpoint("batch_assign", payload);
      if (!mountedRef.current) return;
      onCompleted?.(res);
      onClose?.();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || "Failed to save changes.";
      setActionError(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleDoneClick = () => {
    if (saving || movingKey) return;
    if (pendingStats.assignCount === 0 && pendingStats.unassignCount === 0) {
      onClose?.();
      return;
    }

    if (isInvoice && !jobBudgets.isRetainer && jobBudgets.billable > 0) {
      const projected = round2(jobBudgets.baseRealInv + pendingStats.netDelta);
      if (pendingStats.assignCount > 0 && projected > jobBudgets.billable + 0.01) {
        setOverrunPrompt({
          kind: "revenue",
          projectedTotal: projected,
          currentTotal: jobBudgets.billable,
        });
        return;
      }
    }

    if (!isInvoice && !jobBudgets.isJobCosting && jobBudgets.dcBudget > 0) {
      const projected = round2(jobBudgets.baseRealDc + pendingStats.netDelta);
      if (pendingStats.assignCount > 0 && projected > jobBudgets.dcBudget + 0.01) {
        setOverrunPrompt({
          kind: "directCosts",
          projectedTotal: projected,
          currentTotal: jobBudgets.dcBudget,
        });
        return;
      }
    }

    executeBatchSave({ increaseBudget: false });
  };

  const handleOpenMoveConfirm = (item) => {
    setActionError("");
    const amt = parseMoney(item.amount);
    const currentBase = isInvoice ? jobBudgets.baseRealInv : jobBudgets.baseRealDc;
    const currentLimit = isInvoice ? jobBudgets.billable : jobBudgets.dcBudget;
    const willExceed =
      (isInvoice ? !jobBudgets.isRetainer : !jobBudgets.isJobCosting) &&
      currentLimit > 0 &&
      round2(currentBase + amt) > currentLimit + 0.01;
    setIncreaseBudgetOnMove(willExceed);
    setConfirmMoveKey(item.key);
  };

  const handleConfirmMove = async (item) => {
    setMovingKey(item.key);
    setActionError("");
    try {
      const amt = parseMoney(item.amount);
      const currentBase = isInvoice ? jobBudgets.baseRealInv : jobBudgets.baseRealDc;
      const currentLimit = isInvoice ? jobBudgets.billable : jobBudgets.dcBudget;
      const projected = round2(currentBase + amt);
      const shouldIncrease =
        increaseBudgetOnMove &&
        (isInvoice ? !jobBudgets.isRetainer : !jobBudgets.isJobCosting) &&
        currentLimit > 0 &&
        projected > currentLimit + 0.01;

      const res = await callMutationEndpoint("move", {
        itemKey: isInvoice ? item.invoiceNo : item.appId,
        sourceType: item.sourceType || "auto",
        ...(isInvoice && shouldIncrease
          ? { updateJobRevenue: true, newJobRevenue: projected }
          : {}),
        ...(!isInvoice && shouldIncrease
          ? { updateJobBudget: true, newJobBudget: projected }
          : {}),
      });
      if (!mountedRef.current) return;
      setConfirmMoveKey(null);
      onCompleted?.(res);
      await fetchCatalog(lookbackMonths, { showSpinner: false });
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || "Failed to move item.";
      setActionError(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
    } finally {
      if (mountedRef.current) setMovingKey(null);
    }
  };

  if (!isOpen) return null;

  const toolLabel = syncToolName && syncToolName !== "None" ? syncToolName : "accounting";
  const totalChanges = pendingStats.assignCount + pendingStats.unassignCount;

  const renderSyncPill = () => {
    let text = "";
    let bg = "#f1f5f9";
    let color = "#475569";
    let border = "#e2e8f0";
    let spinning = false;

    if (syncStatus === "checking") {
      text = `Checking ${toolLabel}...`;
      bg = "#eff6ff";
      color = "#1d4ed8";
      border = "#bfdbfe";
      spinning = true;
    } else if (syncStatus === "pulling") {
      text = `Syncing latest from ${toolLabel}...`;
      bg = "#eff6ff";
      color = "#1d4ed8";
      border = "#bfdbfe";
      spinning = true;
    } else if (syncStatus === "synced") {
      text = `Synced with ${toolLabel}`;
      bg = "#dcfce7";
      color = "#166534";
      border = "#bbf7d0";
    } else if (syncStatus === "uptodate") {
      text = `Up to date with ${toolLabel}`;
      bg = "#f0fdf4";
      color = "#15803d";
      border = "#bbf7d0";
    } else if (syncStatus === "error") {
      text = syncErrorMsg || "Sync check unavailable";
      bg = "#fff7ed";
      color = "#9a3412";
      border = "#fed7aa";
    }

    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        {text && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11px",
              fontWeight: 600,
              padding: "3px 9px",
              borderRadius: "999px",
              background: bg,
              color,
              border: `1px solid ${border}`,
              whiteSpace: "nowrap",
            }}
          >
            {spinning && <Spinner size={11} color={color} style={{ marginRight: 0 }} />}
            {syncStatus === "uptodate" || syncStatus === "synced" ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : null}
            <span>{text}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => runBackgroundSync(lookbackMonths, true)}
          disabled={syncStatus === "checking" || syncStatus === "pulling" || saving || Boolean(movingKey)}
          title={`Refresh from ${toolLabel}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "4px 8px",
            borderRadius: "6px",
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: "#334155",
            fontSize: "11px",
            fontWeight: 600,
            cursor: syncStatus === "checking" || syncStatus === "pulling" ? "wait" : "pointer",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          <span>Refresh</span>
        </button>
      </div>
    );
  };

  const renderItemBadgeRow = (item) => {
    const pillStyle = getStatusPill(item.status);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        {isInvoice ? (
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#0047AB" }}>
            #{item.invoiceNo}
          </span>
        ) : (
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
            {item.displayDescription || item.description || item.contactName || "Direct cost"}
          </span>
        )}

        {item.status && (
          <span
            style={{
              fontSize: "10.5px",
              fontWeight: 600,
              padding: "1px 7px",
              borderRadius: "999px",
              ...pillStyle,
            }}
          >
            {item.status}
          </span>
        )}

        {isInvoice && item.invoiceNo && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openInvoiceDetails(item);
            }}
            style={{
              padding: "2px 7px",
              borderRadius: "5px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#475569",
              fontSize: "10.5px",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            View details
          </button>
        )}

        {!isInvoice && item.expenseCategoryType && (
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              padding: "1px 6px",
              borderRadius: "4px",
              background: item.expenseCategoryType === "passthrough" ? "#f0f9ff" : "#f5f3ff",
              color: item.expenseCategoryType === "passthrough" ? "#0369a1" : "#6d28d9",
              border: `1px solid ${item.expenseCategoryType === "passthrough" ? "#bae6fd" : "#ddd6fe"}`,
            }}
          >
            {item.expenseCategoryType === "passthrough" ? "Pass-through" : "Contractor"}
          </span>
        )}

        {item.isLikelyMatch && (
          <span
            style={{
              fontSize: "10px",
              fontWeight: 700,
              padding: "1px 7px",
              borderRadius: "999px",
              background: "#ecfdf5",
              color: "#047857",
              border: "1px solid #a7f3d0",
            }}
          >
            Likely match
          </span>
        )}

        {isInvoice && (Number(item.detectedRechargedAmount) || 0) > 0 && (
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              padding: "1px 6px",
              borderRadius: "4px",
              background: "#f0f9ff",
              color: "#0369a1",
              border: "1px solid #bae6fd",
            }}
          >
            Incl. {fmtMoney(item.detectedRechargedAmount, currencySymbol)} recharged
          </span>
        )}

        {!isInvoice && (Number(item.vatAmount) || 0) > 0.005 && (
          <span style={{ fontSize: "10px", color: "#64748b", background: "#f1f5f9", padding: "1px 5px", borderRadius: "4px" }}>
            VAT: Yes
          </span>
        )}
      </div>
    );
  };

  const renderItemSubtitle = (item) => {
    if (isInvoice) {
      const parts = [
        item.client || "Unknown client",
        item.job ? item.job : null,
        item.sentDate ? `Sent: ${item.sentDate}` : null,
      ].filter(Boolean);
      return parts.join(" · ");
    }
    const parts = [
      item.contactName && !String(item.displayDescription || "").toLowerCase().includes(item.contactName.toLowerCase())
        ? item.contactName
        : null,
      item.reference ? `Ref: ${item.reference}` : null,
      item.accountName || null,
      item.date ? `Date: ${item.date}` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        zIndex: 10050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving && !movingKey) onClose?.();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(95vw, 760px)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.28)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
              {isInvoice ? "Assign invoice" : "Assign direct cost"}
            </h3>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
              Job: <strong style={{ color: "#334155" }}>{targetJob?.client ? `${targetJob.client} – ` : ""}{targetJob?.jobName || "Current job"}</strong>
              {targetJob?.projectCode ? ` · ${targetJob.projectCode}` : ""}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {renderSyncPill()}
            <button
              type="button"
              onClick={() => !saving && !movingKey && onClose?.()}
              disabled={saving || Boolean(movingKey)}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                fontSize: "22px",
                lineHeight: 1,
                color: "#94a3b8",
                cursor: saving || movingKey ? "not-allowed" : "pointer",
                padding: "2px 4px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Tabs, lookback & search */}
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid #f1f5f9",
            background: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* Tabs */}
            <div
              role="tablist"
              style={{
                display: "inline-flex",
                background: "#e2e8f0",
                padding: "3px",
                borderRadius: "8px",
                gap: "2px",
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "unassigned"}
                onClick={() => {
                  setActiveTab("unassigned");
                  setConfirmMoveKey(null);
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: activeTab === "unassigned" ? "#ffffff" : "transparent",
                  color: activeTab === "unassigned" ? "#0f172a" : "#475569",
                  fontWeight: 600,
                  fontSize: "12px",
                  cursor: "pointer",
                  boxShadow: activeTab === "unassigned" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                Unassigned ({catalog?.unassigned?.length ?? 0})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "reassign"}
                onClick={() => setActiveTab("reassign")}
                style={{
                  padding: "5px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: activeTab === "reassign" ? "#ffffff" : "transparent",
                  color: activeTab === "reassign" ? "#0f172a" : "#475569",
                  fontWeight: 600,
                  fontSize: "12px",
                  cursor: "pointer",
                  boxShadow: activeTab === "reassign" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                }}
              >
                {isInvoice ? "Reassign invoices" : "Reassign direct costs"} ({catalog?.assignedToOtherJobs?.length ?? 0})
              </button>
            </div>

            {/* Lookback window */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Lookback:</span>
              <div style={{ display: "inline-flex", background: "#e2e8f0", padding: "2px", borderRadius: "6px", gap: "2px" }}>
                {[3, 6, 12].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleLookbackChange(m)}
                    disabled={loading}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      border: "none",
                      background: lookbackMonths === m ? "#ffffff" : "transparent",
                      color: lookbackMonths === m ? "#1d4ed8" : "#475569",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DeferredSearchInput
            type="text"
            placeholder={
              isInvoice
                ? "Search by client, invoice number, job reference, or amount..."
                : "Search by supplier, description, reference, contractor, or amount..."
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            showClearButton
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "7px",
              border: "1px solid #cbd5e1",
              fontSize: "13px",
              background: "#ffffff",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Error banner */}
        {(loadError || actionError) && (
          <div
            style={{
              margin: "12px 20px 0",
              padding: "10px 12px",
              borderRadius: "7px",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              fontSize: "12.5px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span>{actionError || loadError}</span>
            <button
              type="button"
              onClick={() => {
                setActionError("");
                setLoadError("");
              }}
              style={{ background: "none", border: "none", color: "#991b1b", cursor: "pointer", fontWeight: 700 }}
            >
              ×
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {loading && !catalog ? (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
              <Spinner size={18} color="#2563eb" /> Loading {isInvoice ? "invoices" : "direct costs"}...
            </div>
          ) : activeTab === "unassigned" ? (
            <>
              {/* Already assigned on current job (can unassign) */}
              {filteredCurrentItems.length > 0 && (
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    background: "#f8fafc",
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    Currently assigned to this job ({filteredCurrentItems.length})
                  </div>
                  {filteredCurrentItems.map((item) => {
                    const markedUnassign = pendingUnassignKeys.has(item.key);
                    return (
                      <div
                        key={`cur_${item.key}`}
                        style={{
                          background: markedUnassign ? "#fef2f2" : "#ffffff",
                          border: `1px solid ${markedUnassign ? "#fecaca" : "#e2e8f0"}`,
                          borderRadius: "7px",
                          padding: "8px 10px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "12px",
                          opacity: markedUnassign ? 0.85 : 1,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ textDecoration: markedUnassign ? "line-through" : "none" }}>
                            {renderItemBadgeRow(item)}
                          </div>
                          <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                            {renderItemSubtitle(item)}
                            {item.trancheCount > 1 ? ` · ${item.trancheCount} part-paid entries` : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                          <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", textDecoration: markedUnassign ? "line-through" : "none" }}>
                            {fmtMoney(item.amountOnJob ?? item.amount, currencySymbol)}
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleUnassignKey(item.key)}
                            disabled={saving}
                            style={{
                              padding: "5px 10px",
                              borderRadius: "6px",
                              border: markedUnassign ? "1px solid #cbd5e1" : "1px solid #fecaca",
                              background: markedUnassign ? "#ffffff" : "#fff5f5",
                              color: markedUnassign ? "#334155" : "#dc2626",
                              fontSize: "11.5px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            {markedUnassign ? "Undo" : "Unassign"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Unassigned items */}
              {filteredUnassignedItems.length === 0 ? (
                <div
                  style={{
                    padding: "36px 16px",
                    textAlign: "center",
                    background: "#f8fafc",
                    border: "1px dashed #cbd5e1",
                    borderRadius: "8px",
                    color: "#64748b",
                    fontSize: "13px",
                  }}
                >
                  {qLower
                    ? `No unassigned ${isInvoice ? "invoices" : "direct costs"} match "${searchQuery}".`
                    : `No unassigned ${isInvoice ? "invoices" : "direct costs"} found in the last ${lookbackMonths} months.`}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {filteredUnassignedItems.map((item) => {
                    const isSelected = pendingAssignKeys.has(item.key);
                    const targetMonthLabel =
                      isInvoice && targetJob?.isRetainer ? formatMonthTag(item.monthKey) : "";
                    return (
                      <div
                        key={`un_${item.key}`}
                        style={{
                          background: isSelected ? "#f0fdf4" : "#ffffff",
                          border: `1.5px solid ${isSelected ? "#86efac" : "#e2e8f0"}`,
                          borderRadius: "8px",
                          padding: "10px 12px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "12px",
                          transition: "all 0.12s ease",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          {renderItemBadgeRow(item)}
                          <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                            {renderItemSubtitle(item)}
                          </div>
                          {isSelected && targetMonthLabel && (
                            <div style={{ fontSize: "10.5px", color: "#15803d", fontWeight: 600, marginTop: "3px" }}>
                              Target retainer month: {targetMonthLabel}
                            </div>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                              {fmtMoney(item.amount, currencySymbol)}
                            </div>
                            <div style={{ fontSize: "10px", color: "#64748b" }}>excl. VAT</div>
                          </div>

                          <button
                            type="button"
                            onClick={() => toggleAssignKey(item.key)}
                            disabled={saving}
                            style={{
                              padding: "6px 12px",
                              borderRadius: "6px",
                              border: isSelected ? "1px solid #16a34a" : "1px solid #cbd5e1",
                              background: isSelected ? "#16a34a" : "#ffffff",
                              color: isSelected ? "#ffffff" : "#0f172a",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              minWidth: "104px",
                              justifyContent: "center",
                            }}
                          >
                            {isSelected ? (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Unassign</span>
                              </>
                            ) : (
                              <span>Assign to job</span>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            /* Reassign tab */
            <>
              {filteredReassignItems.length === 0 ? (
                <div
                  style={{
                    padding: "36px 16px",
                    textAlign: "center",
                    background: "#f8fafc",
                    border: "1px dashed #cbd5e1",
                    borderRadius: "8px",
                    color: "#64748b",
                    fontSize: "13px",
                  }}
                >
                  {qLower
                    ? `No assigned ${isInvoice ? "invoices" : "direct costs"} match "${searchQuery}".`
                    : `No ${isInvoice ? "invoices assigned to other jobs" : "direct costs assigned to other jobs or contractors"} found in the last ${lookbackMonths} months.`}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {filteredReassignItems.map((item) => {
                    const isConfirming = confirmMoveKey === item.key;
                    const isMovingThis = movingKey === item.key;
                    const sourceDesc =
                      item.sourceType === "outgoings"
                        ? `Contractors · ${item.assignedContractor?.name || "Contractor"}${item.assignedContractor?.monthLabel ? ` (${item.assignedContractor.monthLabel})` : ""}`
                        : `${item.assignedJob?.client ? `${item.assignedJob.client} – ` : ""}${item.assignedJob?.jobName || "Other job"}`;

                    const amt = parseMoney(item.amount);
                    const currentBase = isInvoice ? jobBudgets.baseRealInv : jobBudgets.baseRealDc;
                    const currentLimit = isInvoice ? jobBudgets.billable : jobBudgets.dcBudget;
                    const projectedOnMove = round2(currentBase + amt);
                    const moveOverruns =
                      (isInvoice ? !jobBudgets.isRetainer : !jobBudgets.isJobCosting) &&
                      currentLimit > 0 &&
                      projectedOnMove > currentLimit + 0.01;

                    return (
                      <div
                        key={`rea_${item.key}`}
                        style={{
                          background: isConfirming ? "#fffbeb" : "#ffffff",
                          border: `1px solid ${isConfirming ? "#fcd34d" : "#e2e8f0"}`,
                          borderRadius: "8px",
                          padding: "10px 12px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "10px",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {renderItemBadgeRow(item)}
                            <div style={{ fontSize: "11.5px", color: "#64748b", marginTop: "3px" }}>
                              {renderItemSubtitle(item)}
                            </div>
                            <div style={{ fontSize: "11px", color: "#0369a1", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                              <span>{item.sourceType === "outgoings" ? "Currently in:" : "Currently on:"} {sourceDesc}</span>
                              {item.trancheCount > 1 && (
                                <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px", background: "#e0f2fe", color: "#0369a1" }}>
                                  {item.trancheCount} entries (moves together)
                                </span>
                              )}
                            </div>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                                {fmtMoney(item.amount, currencySymbol)}
                              </div>
                              <div style={{ fontSize: "10px", color: "#64748b" }}>excl. VAT</div>
                            </div>

                            {!isConfirming && (
                              <button
                                type="button"
                                onClick={() => handleOpenMoveConfirm(item)}
                                disabled={Boolean(movingKey) || saving}
                                style={{
                                  padding: "6px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #cbd5e1",
                                  background: "#ffffff",
                                  color: "#1e293b",
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  cursor: movingKey || saving ? "not-allowed" : "pointer",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {isInvoice ? "Move invoice to this job" : "Move direct cost to this job"}
                              </button>
                            )}
                          </div>
                        </div>

                        {isConfirming && (
                          <div
                            style={{
                              borderTop: "1px solid #fde68a",
                              paddingTop: "10px",
                              display: "flex",
                              flexDirection: "column",
                              gap: "8px",
                            }}
                          >
                            <div style={{ fontSize: "12.5px", color: "#78350f", lineHeight: 1.45 }}>
                              Move {isInvoice ? `invoice #${item.invoiceNo}` : `"${item.displayDescription || item.description}"`} ({fmtMoney(item.amount, currencySymbol)}) from <strong>{sourceDesc}</strong> to <strong>{targetJob?.jobName}</strong>?
                            </div>
                            {moveOverruns && (
                              <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "#1e293b", cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={increaseBudgetOnMove}
                                  onChange={(e) => setIncreaseBudgetOnMove(e.target.checked)}
                                  disabled={isMovingThis}
                                />
                                <span>
                                  Also increase {isInvoice ? "job revenue" : "job direct costs"} from {fmtMoney(currentLimit, currencySymbol)} to {fmtMoney(projectedOnMove, currencySymbol)} to match
                                </span>
                              </label>
                            )}
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                              <button
                                type="button"
                                onClick={() => setConfirmMoveKey(null)}
                                disabled={isMovingThis}
                                style={{
                                  padding: "5px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #cbd5e1",
                                  background: "#ffffff",
                                  color: "#475569",
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleConfirmMove(item)}
                                disabled={isMovingThis}
                                style={{
                                  padding: "5px 14px",
                                  borderRadius: "6px",
                                  border: "none",
                                  background: "#d97706",
                                  color: "#ffffff",
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  cursor: isMovingThis ? "wait" : "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "6px",
                                }}
                              >
                                {isMovingThis && <Spinner size={12} color="#ffffff" style={{ marginRight: 0 }} />}
                                <span>{isMovingThis ? "Moving..." : "Confirm move"}</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Revenue / Budget Overrun Confirmation Banner */}
        {overrunPrompt && (
          <div
            style={{
              padding: "12px 20px",
              background: "#eff6ff",
              borderTop: "1px solid #bfdbfe",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#1e40af" }}>
              {overrunPrompt.kind === "revenue"
                ? "Increase job revenue to match?"
                : "Increase job direct costs budget to match?"}
            </div>
            <div style={{ fontSize: "12px", color: "#334155", lineHeight: 1.45 }}>
              {overrunPrompt.kind === "revenue" ? (
                <>
                  These changes bring total invoiced on this job to{" "}
                  <strong>{fmtMoney(overrunPrompt.projectedTotal, currencySymbol)}</strong>, which exceeds the current job revenue of{" "}
                  <strong>{fmtMoney(overrunPrompt.currentTotal, currencySymbol)}</strong>.
                </>
              ) : (
                <>
                  These changes bring total direct costs on this job to{" "}
                  <strong>{fmtMoney(overrunPrompt.projectedTotal, currencySymbol)}</strong>, which exceeds the current direct costs budget of{" "}
                  <strong>{fmtMoney(overrunPrompt.currentTotal, currencySymbol)}</strong>.
                </>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setOverrunPrompt(null)}
                disabled={saving}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => executeBatchSave({ increaseBudget: false })}
                disabled={saving}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  color: "#1e293b",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Keep current ({fmtMoney(overrunPrompt.currentTotal, currencySymbol)})
              </button>
              <button
                type="button"
                onClick={() =>
                  executeBatchSave({
                    increaseBudget: true,
                    projectedTotal: overrunPrompt.projectedTotal,
                  })
                }
                disabled={saving}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                Increase to {fmtMoney(overrunPrompt.projectedTotal, currencySymbol)}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: "12px", color: "#475569" }}>
            {totalChanges === 0 ? (
              <span>No pending changes</span>
            ) : (
              <span>
                {pendingStats.assignCount > 0 ? `${pendingStats.assignCount} to assign` : ""}
                {pendingStats.assignCount > 0 && pendingStats.unassignCount > 0 ? ", " : ""}
                {pendingStats.unassignCount > 0 ? `${pendingStats.unassignCount} to unassign` : ""}
                {" · "}
                <strong style={{ color: "#0f172a" }}>
                  {pendingStats.netDelta >= 0 ? "+" : ""}
                  {fmtMoney(pendingStats.netDelta, currencySymbol)}
                </strong>
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              onClick={() => !saving && !movingKey && onClose?.()}
              disabled={saving || Boolean(movingKey)}
              style={{
                padding: "7px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                fontSize: "13px",
                fontWeight: 600,
                cursor: saving || movingKey ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDoneClick}
              disabled={saving || Boolean(movingKey)}
              style={{
                padding: "7px 18px",
                borderRadius: "6px",
                border: "none",
                background: "#2563eb",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: 600,
                cursor: saving || movingKey ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                opacity: saving ? 0.8 : 1,
              }}
            >
              {saving && <Spinner size={13} color="#ffffff" style={{ marginRight: 0 }} />}
              <span>{saving ? "Saving..." : "Done"}</span>
            </button>
          </div>
        </div>
      </div>

      {viewingInvoiceDetails && (
        <InvoiceDetailsModal
          isOpen={Boolean(viewingInvoiceDetails)}
          target={viewingInvoiceDetails}
          surface={surface}
          isAdmin={isAdmin}
          onClose={() => setViewingInvoiceDetails(null)}
        />
      )}
    </div>
  );
}
