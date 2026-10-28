import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaOutgoingsTableSkeleton, PmaInvoicesTableSkeleton } from "./Skeleton";
import OutgoingsEditModal from "./OutgoingsEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import OutgoingsEstimateModal from "./OutgoingsEstimateModal";
import OutgoingsNewVendorModal from "./OutgoingsNewVendorModal";
import JobDetailModal from "./JobDetailModal";
import CellNoteIndicator from "./CellNoteIndicator";
import EditClientSelector from "./EditClientSelector";
import PlaceholderChoiceModal from "./PlaceholderChoiceModal";
import PlaceholderPill, { isAutoPlaceholder } from "./PlaceholderPill";
import { getJobExpenseItems } from "./JobsView";
import { useOutgoings } from "../hooks/useOutgoings";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";
import { useAuth } from "../hooks/useAuth";
import { isPlaceholderExpense, groupSlotItemsForDisplay, getRetainerRowMonthLabel, getRetainerDurationMonths } from "../utils/helpers";

const formatCurrency = (val) => {
  const s = String(val || "").trim();
  if (!s) return "";
  const hasSymbol = /^[£$€]/.test(s);
  const symbol = hasSymbol ? s.charAt(0) : "£";
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return symbol + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const getStatusPill = (status) => {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid") return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  if (s === "draft") return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
  if (s === "sent" || s === "received") return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  if (s.includes("part-paid") || s.includes("part paid") || s.includes("partpaid")) {
    return { backgroundColor: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
};

const rowHasExpense = (r) => r.expenseSlots && r.expenseSlots.some(s => {
  const hasDesc = !!(s.description && String(s.description).trim() !== "");
  const hasAmt = !!(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
  const hasTx = !!(s.transactionId && String(s.transactionId).trim() !== "");
  return hasDesc || hasAmt || hasTx;
});

function parseVendorAndDescription(exp) {
  let rawVendor = String(exp?.contactName || "").trim();
  let rawDesc = String(exp?.description || "").trim();
  const rawAccount = String(exp?.accountName || "").trim();

  // Pattern: "Vendor Name (Item Description)" or "Vendor Name [Item Description]"
  const bracketRegex = /^([^(]+?)\s*[\(\[]([^)\]]+)[\)\]]$/;

  let vendor = "";
  let description = "";

  if (rawVendor) {
    const vMatch = rawVendor.match(bracketRegex);
    if (vMatch) {
      vendor = vMatch[1].trim();
      description = vMatch[2].trim();
    } else {
      vendor = rawVendor;
    }
  }

  if (rawDesc) {
    const dMatch = rawDesc.match(bracketRegex);
    if (dMatch) {
      if (!vendor) vendor = dMatch[1].trim();
      if (!description || description === rawDesc) description = dMatch[2].trim();
    } else if (!description) {
      if (!vendor || rawDesc.toLowerCase() !== vendor.toLowerCase()) {
        description = rawDesc;
      }
    }
  }

  if (!vendor) {
    vendor = rawDesc || rawAccount || "Expense";
    if (vendor === description) description = "";
  }

  if (description && vendor && description.toLowerCase() === vendor.toLowerCase()) {
    description = "";
  }

  return { vendor, description };
}

export default function OutgoingsView({
  allOutgoingsClients,
  styles,
  isAdmin: propIsAdmin = false,
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient
}) {
  const auth = useAuth();
  const isAdmin = propIsAdmin || (!auth.user?.isReadOnly && !!(auth.user?.isAdmin || auth.user?.role === "Admin"));

  const {
    automationCommanderSheetId, assignedAppIds, assignedByClient,
    setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, addAssignedAppId
  } = useAppGlobals();
  const { clientsWithFlags, setClientsWithFlags } = useTriage();
  const {
    outgoingsData, setOutgoingsData,
    outgoingsLoading, setOutgoingsLoading,
    outgoingsClient, setOutgoingsClient,
    outgoingsMonthOffset, setOutgoingsMonthOffset,
    outgoingsEditCell, setOutgoingsEditCell,
    directCostsEditSlot, setDirectCostsEditSlot,
    outgoingsInbox, setOutgoingsInbox,
    outgoingsPlacing, setOutgoingsPlacing, outgoingsPlacingRef,
    outgoingsEstimate, setOutgoingsEstimate,
    outgoingsNewVendor, setOutgoingsNewVendor,
    vendorsSubTab, setVendorsSubTab,
    directCostsJobs, setDirectCostsJobs,
    directCostsLoading, setDirectCostsLoading,
    directCostsShowAll, setDirectCostsShowAll,
    directCostsSavingCell, setDirectCostsSavingCell,
    loadOutgoings, loadDirectCostsJobs
  } = useOutgoings(assignedAppIds, assignedByClient, setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, automationCommanderSheetId, managedClient || initialClient);

  const prevInitialClientRef = React.useRef(null);
  const prevManagedClientRef = React.useRef(null);
  // Auto-select managedClient when in manage mode, or initialClient when passed, or clear when cancelled
  useEffect(() => {
    if (managedClient) {
      const currentName = managedClient.clientName?.toLowerCase();
      const hasFullClient = Boolean(outgoingsClient?.clientSheetId);
      const clientWithSheet = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName && c.clientSheetId) || (managedClient.clientSheetId ? managedClient : null);
      if (prevManagedClientRef.current !== currentName || (!hasFullClient && clientWithSheet)) {
        prevManagedClientRef.current = currentName;
        const clientObj = clientWithSheet || (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === currentName) || managedClient;
        if (clientObj?.clientSheetId) {
          loadOutgoings(clientObj);
        }
      }
    } else if (initialClient && (initialClient !== prevInitialClientRef.current || (!outgoingsClient?.clientSheetId && initialClient.clientSheetId))) {
      prevInitialClientRef.current = initialClient;
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === initialClient.clientName?.toLowerCase()) || initialClient;
      if (clientObj?.clientSheetId) {
        loadOutgoings(clientObj);
      }
    } else if (prevManagedClientRef.current && !managedClient) {
      prevManagedClientRef.current = null;
      setOutgoingsData(null);
      setOutgoingsClient(null);
      setOutgoingsInbox([]);
      if (typeof clearInboxSelection === "function") clearInboxSelection();
    }
  }, [managedClient, initialClient, allOutgoingsClients, outgoingsClient?.clientSheetId]);

  const effectiveClientObj = outgoingsClient || (managedClient?.clientName ? (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === managedClient.clientName.toLowerCase()) || managedClient : null) || initialClient;
  const effectiveSheetId = outgoingsClient?.clientSheetId || managedClient?.clientSheetId || (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === (outgoingsClient?.clientName || managedClient?.clientName)?.toLowerCase())?.clientSheetId;
  const effectiveClientName = outgoingsClient?.clientName || managedClient?.clientName || "";

  const [viewMode, setViewMode] = useState("modern");
  const [expandedRetainerKeys, setExpandedRetainerKeys] = useState(() => new Set());
  const toggleRetainerExpand = (key) => {
    setExpandedRetainerKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const [clearedClients, setClearedClients] = useState(new Set());
  const [selectedInboxAppIds, setSelectedInboxAppIds] = useState(new Set());
  const [outgoingsReplacePrompt, setOutgoingsReplacePrompt] = useState(null); // { exp, contractor, colLetter, realBlocks, manualTotal, blocksToKeep }
  const [contractorSearch, setContractorSearch] = useState("");
  const [directCostsJobSearch, setDirectCostsJobSearch] = useState("");
  const [selectedJobForDetail, setSelectedJobForDetail] = useState(null);
  const [placeholderChoicePrompt, setPlaceholderChoicePrompt] = useState(null);

  const filteredContractors = React.useMemo(() => {
    const list = outgoingsData?.contractors || [];
    if (!contractorSearch.trim()) return list;
    const q = contractorSearch.toLowerCase().trim();
    return list.filter(c => (c.name || "").toLowerCase().includes(q));
  }, [outgoingsData?.contractors, contractorSearch]);

  const filteredDirectCostsJobs = React.useMemo(() => {
    const list = directCostsJobs || [];
    if (!directCostsJobSearch.trim()) return list;
    const q = directCostsJobSearch.toLowerCase().trim();
    return list.filter(j =>
      (j.client || "").toLowerCase().includes(q) ||
      (j.jobName || "").toLowerCase().includes(q) ||
      (j.projectCode || "").toLowerCase().includes(q)
    );
  }, [directCostsJobs, directCostsJobSearch]);

  const markClientCleared = useCallback((clientName) => {
    if (!clientName) return;
    setClearedClients(prev => new Set([...prev, clientName]));
    setClientsWithFlags?.(prev => prev.map(f => {
      if (f.clientName !== clientName) return f;
      return {
        ...f,
        flags: { ...f.flags, expenseDashboardDiscr: false, dirCompMismatch: false },
        alertCounts: { ...f.alertCounts, expenseDashboardDiscr: 0, dirCompMismatch: 0 }
      };
    }));
  }, [setClientsWithFlags]);

  const decrementClientExpenseCount = useCallback((clientName, count = 1) => {
    if (!clientName || count <= 0) return;
    setClientsWithFlags?.(prev => prev.map(f => {
      if (f.clientName !== clientName) return f;
      const currentCount = f.alertCounts?.expenseDashboardDiscr || 0;
      const newCount = Math.max(0, currentCount - count);
      return {
        ...f,
        flags: { ...f.flags, ...(newCount === 0 ? { expenseDashboardDiscr: false } : {}) },
        alertCounts: { ...f.alertCounts, expenseDashboardDiscr: newCount }
      };
    }));
  }, [setClientsWithFlags]);

  useEffect(() => {
    if (outgoingsClient && !outgoingsLoading && outgoingsInbox.length === 0) {
      markClientCleared(outgoingsClient.clientName);
    }
  }, [outgoingsInbox.length, outgoingsClient, outgoingsLoading, markClientCleared]);

  useEffect(() => {
    if (vendorsSubTab === "directCosts" && outgoingsClient?.clientSheetId && !directCostsJobs && !directCostsLoading) {
      loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
    }
  }, [vendorsSubTab, outgoingsClient?.clientSheetId, directCostsJobs, directCostsLoading, directCostsShowAll, loadDirectCostsJobs]);

  const toggleInboxSelection = (exp) => {
    setSelectedInboxAppIds(prev => {
      const next = new Set(prev);
      if (next.has(exp.appId)) next.delete(exp.appId);
      else next.add(exp.appId);
      setOutgoingsPlacing(next.size > 0 ? exp : null);
      return next;
    });
  };

  const selectAllInbox = () => {
    const allIds = new Set(outgoingsInbox.map(e => e.appId));
    setSelectedInboxAppIds(allIds);
    if (outgoingsInbox.length > 0) setOutgoingsPlacing(outgoingsInbox[0]);
  };

  const clearInboxSelection = () => {
    setSelectedInboxAppIds(new Set());
    setOutgoingsPlacing(null);
  };

  const executeExpensePlacement = async (job, toPlace, rowNum, slotNum, createNewRow = false, cellSavingKey = null) => {
    if (!toPlace || toPlace.length === 0) return;
    const savingKey = cellSavingKey || (createNewRow ? `newrow-${job.client}|||${job.jobName}` : `${rowNum}-${slotNum}`);
    setDirectCostsSavingCell(savingKey);

    const placedIds = new Set(toPlace.map(e => e.appId));
    toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
    decrementClientExpenseCount(outgoingsClient?.clientName, toPlace.length);
    setOutgoingsInbox(prev => {
      const remaining = prev.filter(e => !placedIds.has(e.appId));
      if (remaining.length === 0 && outgoingsClient) {
        markClientCleared(outgoingsClient.clientName);
      }
      return remaining;
    });
    clearInboxSelection();
    setOutgoingsPlacing(null);
    outgoingsPlacingRef.current = null;

    const jobLastRow = job.rows[job.rows.length - 1]?.rowNum;

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign_expense_to_job",
          clientSheetId: outgoingsClient?.clientSheetId,
          clientName: outgoingsClient?.clientName || outgoingsClient?.name || "",
          masterSheetId: outgoingsClient?.masterSheetId || "",
          createNewRow: !!createNewRow,
          rowNum: !createNewRow ? rowNum : undefined,
          slotNum: !createNewRow ? slotNum : undefined,
          jobLastRow: createNewRow ? jobLastRow : undefined,
          expenses: toPlace,
          jobClient: job.client,
          jobName: job.jobName,
          jobRows: job.rows,
        }),
      });
      const data = await res.json();
      if (outgoingsClient?.masterSheetId) {
        outgoingsPullPendingRef.current = { clientSheetId: outgoingsClient.clientSheetId, masterSheetId: outgoingsClient.masterSheetId };
      }
      if (data.newRowsCreated) {
        await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
      } else if (data.placed && Array.isArray(data.placed)) {
        setDirectCostsJobs(prev => prev && prev.map(j => {
          if (j.client !== job.client || j.jobName !== job.jobName) return j;
          return {
            ...j,
            rows: j.rows.map(r => {
              const placedForThisRow = data.placed.filter(p => p.rowNum === r.rowNum);
              if (placedForThisRow.length === 0) return r;
              return {
                ...r,
                expenseSlots: r.expenseSlots.map(sl => {
                  const match = placedForThisRow.find(p => p.slotNum === sl.slotNum);
                  if (!match) return sl;
                  return {
                    ...sl,
                    description: match.description,
                    amount: match.amount,
                    vat: match.vat,
                    date: match.date,
                    status: match.status,
                    transactionId: match.transactionId
                  };
                })
              };
            })
          };
        }));
      } else {
        await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
      }
    } catch (e) {
      console.error("assign_expense_to_job error:", e);
    } finally {
      setDirectCostsSavingCell(null);
    }
  };

  const proceedWithAutoExpensePlacement = (job, toPlace, targetRowNum = null) => {
    const targetRows = targetRowNum
      ? (job.rows || []).filter(r => r.rowNum === targetRowNum)
      : (job.rows || []);

    // 1. Look for auto-placeholder slot
    for (const r of targetRows) {
      for (const s of (r.expenseSlots || [])) {
        const hasDesc = !!(s.description && String(s.description).trim() !== "");
        const isPlhdr = isPlaceholderExpense(s) || String(s.description || "").toUpperCase().startsWith("PLACE");
        if (hasDesc && isPlhdr && isAutoPlaceholder(s.description)) {
          executeExpensePlacement(job, toPlace, r.rowNum, s.slotNum, false, `${r.rowNum}-${s.slotNum}`);
          return;
        }
      }
    }

    // 2. Look for empty slot
    for (const r of targetRows) {
      for (const s of (r.expenseSlots || [])) {
        const hasDesc = !!(s.description && String(s.description).trim() !== "");
        const hasAmt = !!(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        if (!hasDesc && !hasAmt) {
          executeExpensePlacement(job, toPlace, r.rowNum, s.slotNum, false, `${r.rowNum}-${s.slotNum}`);
          return;
        }
      }
    }

    // 3. If no auto-placeholders and no empty slots:
    const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
    if (!isRetainer) {
      executeExpensePlacement(job, toPlace, null, null, true);
      return;
    } else {
      alert("All direct cost slots for this retainer month are already occupied by actual expenses.");
    }
  };

  const handleInitiateExpensePlacement = (job, targetRowNum = null, explicitExpenses = null) => {
    const toPlace = explicitExpenses
      ? (Array.isArray(explicitExpenses) ? explicitExpenses : [explicitExpenses])
      : (selectedInboxAppIds.size > 0
        ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
        : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []));

    if (toPlace.length === 0) return;

    const targetRows = targetRowNum
      ? (job.rows || []).filter(r => r.rowNum === targetRowNum)
      : (job.rows || []);

    // Check for manual placeholders
    const manualPlaceholders = [];
    for (const r of targetRows) {
      for (const s of (r.expenseSlots || [])) {
        const hasDesc = !!(s.description && String(s.description).trim() !== "");
        const hasAmt = !!(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const isPlhdr = isPlaceholderExpense(s) || String(s.description || "").toUpperCase().startsWith("MANUAL") || (!hasDesc && hasAmt);
        if ((hasDesc || hasAmt) && isPlhdr && !isAutoPlaceholder(s.description)) {
          manualPlaceholders.push({ ...s, rowNum: r.rowNum, slotNum: s.slotNum });
        }
      }
    }

    if (manualPlaceholders.length > 0) {
      setPlaceholderChoicePrompt({
        job,
        itemToPlace: toPlace[0],
        allExpensesToPlace: toPlace,
        targetRowNum,
        manualPlaceholders,
      });
      return;
    }

    proceedWithAutoExpensePlacement(job, toPlace, targetRowNum);
  };

  const updateCell = async (contractor, colLetter, newBlocks, newTopNote) => {
    const existingTopNote = contractor.cells[colLetter]?.topNote || "";
    const topNoteToSave = newTopNote !== undefined ? newTopNote : existingTopNote;
    setOutgoingsData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        contractors: prev.contractors.map(c =>
          c.sheetRow === contractor.sheetRow
            ? { ...c, cells: { ...c.cells, [colLetter]: { ...c.cells[colLetter], blocks: newBlocks, topNote: topNoteToSave } } }
            : c
        ),
      };
    });
    try {
      await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId: outgoingsClient?.clientSheetId,
          clientName: outgoingsClient?.clientName || outgoingsClient?.name || "",
          contractorName: contractor?.name || "",
          masterSheetId: outgoingsClient?.masterSheetId || "",
          sheetRow: contractor.sheetRow,
          colLetter,
          blocks: newBlocks,
          topNote: topNoteToSave,
        }),
      });
      if (outgoingsClient?.masterSheetId) {
        outgoingsPullPendingRef.current = { clientSheetId: outgoingsClient.clientSheetId, masterSheetId: outgoingsClient.masterSheetId };
      }
    } catch (e) { console.error("updateCell error:", e); }
  };

  const STATUS_COLOURS = {
    "Paid": { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
    "Received": { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
    "Draft": { bg: "#fff8e1", border: "#ffc107", text: "#e65100" },
    "": { bg: "#f5f5f5", border: "#bdbdbd", text: "#616161" },
  };
  const getStatusColour = (s) => STATUS_COLOURS[s] || STATUS_COLOURS[""];

  const OUTGOINGS_WINDOW = 7;
  const visibleMonths = outgoingsData
    ? outgoingsData.months.slice(outgoingsMonthOffset, outgoingsMonthOffset + OUTGOINGS_WINDOW)
    : [];

  const fmtMonthLabel = (labelOrIso) => {
    if (!labelOrIso) return "";
    const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, 1);
      return d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    }
    return String(labelOrIso).slice(0, 7);
  };

  const isCurrentMonth = (labelOrIso) => {
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isoMatch = String(labelOrIso).match(/^(\d{4})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}` === cur;
    return false;
  };

  const allClients = allOutgoingsClients.length > 0
    ? allOutgoingsClients
    : [...(clientsWithFlags || [])].sort((a, b) => a.clientName.localeCompare(b.clientName));
  const noClient = !outgoingsClient && !managedClient && !initialClient;

  return (
    <>
      {outgoingsEditCell && (
        <OutgoingsEditModal
          editCellData={outgoingsEditCell}
          outgoingsData={outgoingsData}
          updateCell={updateCell}
          onReturnToInbox={(exp) => {
            setOutgoingsInbox(prev => {
              if (prev.some(e => e.appId === exp.appId)) return prev;
              return [...prev, exp];
            });
          }}
          onClose={() => setOutgoingsEditCell(null)}
        />
      )}
      {placeholderChoicePrompt && (
        <PlaceholderChoiceModal
          isOpen={!!placeholderChoicePrompt}
          type="expense"
          job={placeholderChoicePrompt.job}
          itemToPlace={placeholderChoicePrompt.itemToPlace}
          manualPlaceholders={placeholderChoicePrompt.manualPlaceholders}
          onReplaceManual={(p) => {
            const { job, allExpensesToPlace } = placeholderChoicePrompt;
            setPlaceholderChoicePrompt(null);
            executeExpensePlacement(job, allExpensesToPlace, p.rowNum, p.slotNum, false, `${p.rowNum}-${p.slotNum}`);
          }}
          onUseAuto={() => {
            const { job, allExpensesToPlace, targetRowNum } = placeholderChoicePrompt;
            setPlaceholderChoicePrompt(null);
            proceedWithAutoExpensePlacement(job, allExpensesToPlace, targetRowNum);
          }}
          onClose={() => setPlaceholderChoicePrompt(null)}
        />
      )}
      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={outgoingsClient}
          isAdmin={isAdmin}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onUpdateJobs={(rNum, sNum, newData, resData) => {
            setDirectCostsJobs(prev => prev && prev.map(j => {
              const hasRow = j.rows?.some(r => r.rowNum === rNum);
              let updatedJob = j;
              if (hasRow && resData?.placeholderAdjustment) {
                const { rowNum: pRow, slotNum: pSlot, newAmount: pAmt } = resData.placeholderAdjustment;
                updatedJob = {
                  ...updatedJob,
                  rows: updatedJob.rows.map(r => {
                    if (r.rowNum === pRow) {
                      return {
                        ...r,
                        expenseSlots: (r.expenseSlots || []).map(sl =>
                          sl.slotNum === pSlot ? { ...sl, amount: pAmt > 0 ? String(pAmt) : "" } : sl
                        )
                      };
                    }
                    return r;
                  })
                };
              }
              return {
                ...updatedJob,
                rows: updatedJob.rows.map(r => r.rowNum !== rNum ? r : {
                  ...r,
                  expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== sNum ? sl : { ...sl, ...newData })
                }),
              };
            }));
          }}
        />
      )}
      {selectedJobForDetail && (
        <JobDetailModal
          isOpen={!!selectedJobForDetail}
          target={selectedJobForDetail}
          isAdmin={isAdmin}
          onClose={() => setSelectedJobForDetail(null)}
          onMarkPullPending={(masterId) => (outgoingsPullPendingRef.current = masterId)}
        />
      )}
      {outgoingsEstimate && (
        <OutgoingsEstimateModal
          estimateData={outgoingsEstimate}
          outgoingsData={outgoingsData}
          updateCell={updateCell}
          onClose={() => setOutgoingsEstimate(null)}
        />
      )}
      {outgoingsNewVendor && (
        <OutgoingsNewVendorModal
          newVendorData={outgoingsNewVendor}
          outgoingsClient={outgoingsClient}
          onClose={() => setOutgoingsNewVendor(null)}
          onCreated={async () => {
            const clientToReload = outgoingsClient;
            await loadOutgoings(clientToReload);
          }}
        />
      )}
      {outgoingsReplacePrompt && (() => {
        const { expenses, exp, contractor, colLetter, allBlocks, realBlocks, totalManual, blocksWithoutManual, placeholderBlocks } = outgoingsReplacePrompt;
        const expenseList = expenses || (exp ? [exp] : []);
        const currentAllBlocks = allBlocks || realBlocks || [];
        const currentPlaceholderBlocks = placeholderBlocks || currentAllBlocks.filter(b => b.appId && isPlaceholderExpense(b.appId));
        const currentBlocksWithoutManual = blocksWithoutManual || currentAllBlocks.filter(b => !b.appId || !isPlaceholderExpense(b.appId));
        const totalExpenseAmount = expenseList.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        const canUseUp = totalExpenseAmount <= totalManual + 0.001;

        const doPlace = async (keepManual) => {
          setOutgoingsReplacePrompt(null);
          const base = keepManual ? currentAllBlocks : currentBlocksWithoutManual;
          const newBlocks = expenseList.map(item => {
            const { vendor, description } = parseVendorAndDescription(item);
            const descToStore = description ? `${vendor} - ${description}` : (vendor || item.accountName || "");
            return {
              appId: item.appId,
              amount: item.amount,
              status: item.status || "",
              recDate: item.date || "",
              payDate: item.datePaid || "",
              description: descToStore || item.description || item.contactName || item.accountName || ""
            };
          });
          await updateCell(contractor, colLetter, [...base, ...newBlocks]);
          const placedIds = new Set(expenseList.map(e => e.appId));
          setOutgoingsInbox(prev => {
            const remaining = prev.filter(e => !placedIds.has(e.appId));
            if (remaining.length === 0 && outgoingsClient) {
              markClientCleared(outgoingsClient.clientName);
            }
            return remaining;
          });
          expenseList.forEach(item => {
            addAssignedAppId(item.appId, outgoingsClient?.clientName);
          });
          decrementClientExpenseCount(outgoingsClient?.clientName, expenseList.length);
          clearInboxSelection();
        };

        const doUseUp = async () => {
          setOutgoingsReplacePrompt(null);
          let remaining = totalExpenseAmount;
          const reducedPlaceholderBlocks = [];
          for (const pb of currentPlaceholderBlocks) {
            const pbAmount = parseFloat(pb.amount) || 0;
            const used = Math.min(remaining, pbAmount);
            const newAmount = pbAmount - used;
            remaining -= used;
            if (newAmount > 0.004) {
              reducedPlaceholderBlocks.push({ ...pb, amount: newAmount });
            }
          }
          const newBlocks = expenseList.map(item => {
            const { vendor, description } = parseVendorAndDescription(item);
            const descToStore = description ? `${vendor} - ${description}` : (vendor || item.accountName || "");
            return {
              appId: item.appId,
              amount: item.amount,
              status: item.status || "",
              recDate: item.date || "",
              payDate: item.datePaid || "",
              description: descToStore || item.description || item.contactName || item.accountName || ""
            };
          });
          await updateCell(contractor, colLetter, [...currentBlocksWithoutManual, ...reducedPlaceholderBlocks, ...newBlocks]);
          const placedIds = new Set(expenseList.map(e => e.appId));
          setOutgoingsInbox(prev => {
            const remaining = prev.filter(e => !placedIds.has(e.appId));
            if (remaining.length === 0 && outgoingsClient) {
              markClientCleared(outgoingsClient.clientName);
            }
            return remaining;
          });
          expenseList.forEach(item => {
            addAssignedAppId(item.appId, outgoingsClient?.clientName);
          });
          decrementClientExpenseCount(outgoingsClient?.clientName, expenseList.length);
          clearInboxSelection();
        };

        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: "700" }}>Placeholder / Unrecon gap exists</h3>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#555" }}>
                This month already contains a placeholder / gap of <strong>£{totalManual.toFixed(2)}</strong>.<br />
                You are placing <strong>{expenseList.length}</strong> expense{expenseList.length > 1 ? "s" : ""} totaling <strong>£{totalExpenseAmount.toFixed(2)}</strong>.<br /><br />
                Would you like to replace it, keep both, or use up part of the estimate?
              </p>
              <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={() => setOutgoingsReplacePrompt(null)}
                  style={{ padding: "8px 16px", background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                  Cancel
                </button>
                <button onClick={() => doPlace(true)}
                  style={{ padding: "8px 18px", background: "#f0f9ff", border: "1px solid #93c5fd", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#1d4ed8" }}>
                  Add alongside
                </button>
                {canUseUp && (
                  <button onClick={doUseUp}
                    style={{ padding: "8px 18px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600", color: "#166534" }}>
                    Use up
                  </button>
                )}
                <button onClick={() => doPlace(false)}
                  style={{ padding: "8px 18px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                  Replace
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {(selectedInboxAppIds.size > 0 || outgoingsPlacing) && (() => {
        const selectedList = selectedInboxAppIds.size > 0
          ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
          : (outgoingsPlacing ? [outgoingsPlacing] : []);
        const totalAmt = selectedList.reduce((s, e) => s + (e.amount || 0), 0);
        return (
          <div style={{ background: "#1a56db", color: "#fff", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "13px", borderRadius: "8px", margin: "0 20px 16px", boxShadow: "0 4px 14px rgba(26,86,219,0.25)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontWeight: "700", background: "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: "10px" }}>
                {selectedList.length} {selectedList.length === 1 ? "expense" : "expenses"} selected
              </span>
              <span>Total: <strong>£{totalAmt.toLocaleString("en-GB", { minimumFractionDigits: 2 })}</strong></span>
              <span style={{ opacity: 0.9 }}>
                {vendorsSubTab === "contractors"
                  ? "· Click a contractor month to allocate all selected items"
                  : "· Click an expense entry to allocate each item sequentially"}
              </span>
            </div>
            <button onClick={clearInboxSelection}
              style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "4px", padding: "5px 14px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
              Cancel
            </button>
          </div>
        );
      })()}

      <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
            marginBottom: "20px",
            background: "#ffffff",
            padding: "16px 20px",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {outgoingsClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (managedClient && onClearManagedClient) {
                    onClearManagedClient();
                  } else {
                    setOutgoingsData(null);
                    setOutgoingsClient(null);
                    setOutgoingsInbox([]);
                    clearInboxSelection();
                    onSelectClient?.(null);
                  }
                }}
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
                <span>Contractors</span>
              </h1>
              {outgoingsClient && (
                <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                  {outgoingsClient.clientName}
                </div>
              )}
            </div>
          </div>

          {outgoingsClient && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {isAdmin && vendorsSubTab === "directCosts" && (
                <button
                  type="button"
                  onClick={() => setViewMode(prev => prev === "modern" ? "legacy" : "modern")}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: viewMode === "legacy" ? "#0f172a" : "#ffffff",
                    color: viewMode === "legacy" ? "#ffffff" : "#334155",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                  title={viewMode === "modern" ? "Switch to traditional spreadsheet view" : "Switch to improved modern view"}
                >
                  <span>{viewMode === "modern" ? "📋 Legacy view" : "✨ Modern view"}</span>
                </button>
              )}
              {isAdmin && outgoingsClient.clientSheetId && (
                <button
                  className="triage-btn"
                  onClick={() => {
                    window.open(`https://docs.google.com/spreadsheets/d/${outgoingsClient.clientSheetId}/edit`, "_blank");
                  }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}
                >
                  📊 Open sheets
                </button>
              )}
            </div>
          )}
        </div>

        {noClient && (
          <EditClientSelector
            clients={allClients}
            onSelectClient={(c) => {
              onSelectClient?.(c);
              loadOutgoings(c);
            }}
            loading={outgoingsLoading}
            title="Select a client to view contractor expenses:"
            renderExtra={(c) => {
              if (clearedClients.has(c.clientName)) return null;
              const f = clientsWithFlags?.find(item => item.clientName === c.clientName);
              if (!f) return null;
              const hasFlag = !!(f.flags?.expenseDashboardDiscr || f.flags?.dirCompMismatch);
              if (!hasFlag) return null;
              const assignedSet = assignedByClient[c.clientName] || new Set();
              const expenseIds = f.activeExpenseIds || [];
              const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
              const rawCount = (f.alertCounts?.expenseDashboardDiscr || 0) + (f.alertCounts?.dirCompMismatch || 0);
              const remainingCount = Math.max(0, (rawCount > 0 ? rawCount : 1) - validAssignedExp);
              if (remainingCount <= 0) return null;
              return (
                <span style={{ fontSize: "11px", background: "#f97316", color: "#fff", borderRadius: "10px", padding: "1px 7px", fontWeight: "600" }}>
                  {remainingCount} to assign
                </span>
              );
            }}
          />
        )}

        {!noClient && (
          <div style={{ background: "#fff", border: `1px solid ${outgoingsInbox.length > 0 ? "#ffc107" : "#e0e0e0"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: outgoingsInbox.length > 0 ? "10px" : "0" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: outgoingsInbox.length > 0 ? "#e65100" : "#888" }}>
                {outgoingsInbox.length > 0
                  ? `Unmatched expenses (${outgoingsInbox.length}) - select one or more items to place`
                  : "No unmatched expenses - inbox is clear ✓"}
              </div>
              {outgoingsInbox.length > 0 && (
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button onClick={selectAllInbox}
                    style={{ fontSize: "11px", padding: "4px 10px", background: "#f0f4ff", border: "1px solid #bfdbfe", borderRadius: "5px", cursor: "pointer", color: "#1d4ed8", fontWeight: "600" }}>
                    Select all ({outgoingsInbox.length})
                  </button>
                  {selectedInboxAppIds.size > 0 && (
                    <button onClick={clearInboxSelection}
                      style={{ fontSize: "11px", padding: "4px 10px", background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "5px", cursor: "pointer", color: "#64748b" }}>
                      Clear selection
                    </button>
                  )}
                </div>
              )}
            </div>
            {outgoingsInbox.length > 0 && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {outgoingsInbox.map((exp, i) => {
                    const isSelected = selectedInboxAppIds.has(exp.appId);
                    const { vendor, description } = parseVendorAndDescription(exp);
                    return (
                      <div key={exp.appId || i} style={{ display: "flex", flexDirection: "column", gap: "3px", alignItems: "flex-start" }}>
                        <div
                          onClick={() => toggleInboxSelection(exp)}
                          style={{
                            background: isSelected ? "#eff6ff" : "#fff",
                            border: `2px solid ${isSelected ? "#1a56db" : "#ffc107"}`,
                            borderRadius: "7px", padding: "7px 10px", fontSize: "11px",
                            cursor: "pointer", textAlign: "left", color: "#1e293b",
                            transition: "background 0.1s, border-color 0.1s",
                            display: "flex", flexDirection: "column", gap: "3px",
                            userSelect: "none", width: "195px", boxSizing: "border-box"
                          }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "4px" }}>
                            <div style={{ fontWeight: "700", fontSize: "12px", color: isSelected ? "#1a56db" : "#111827", lineHeight: "1.2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={vendor}>
                              {vendor}
                            </div>
                            <input type="checkbox" checked={isSelected} readOnly
                              style={{ cursor: "pointer", accentColor: "#1a56db", margin: 0, width: "14px", height: "14px", flexShrink: 0 }} />
                          </div>

                          {/* Item description tag if available and distinct */}
                          {description && (
                            <div style={{ fontSize: "10.5px", color: "#334155", background: isSelected ? "#dbeafe" : "#fef3c7", padding: "2px 5px", borderRadius: "3px", lineHeight: "1.25", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={description}>
                              {description}
                            </div>
                          )}

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1px", fontSize: "10.5px", color: "#4b5563" }}>
                            <span style={{ fontWeight: "700", color: "#111827", fontSize: "11.5px" }}>
                              £{(exp.amount || 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                            </span>
                            <span>{exp.date}</span>
                          </div>

                          {exp.reference && (
                            <div style={{ fontSize: "9.5px", color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              Ref: {exp.reference}
                            </div>
                          )}

                          <div style={{ fontSize: "9.5px", color: isSelected ? "#1a56db" : "#9ca3af", fontWeight: isSelected ? "700" : "400" }}>
                            {isSelected ? "✓ Selected to place" : "Click to select"}
                          </div>
                        </div>
                        {vendorsSubTab === "contractors" && (
                          <button onClick={e => { e.stopPropagation(); setOutgoingsNewVendor({ exp }); }}
                            title="Create new vendor for this expense"
                            style={{ fontSize: "9.5px", padding: "1px 6px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "3px", cursor: "pointer", color: "#555", whiteSpace: "nowrap" }}>
                            + New vendor
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {!noClient && (outgoingsLoading || !outgoingsData) && (
          <PmaOutgoingsTableSkeleton />
        )}

        {!noClient && !outgoingsLoading && outgoingsData && (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e0e0e0" }}>
              <a
                href={`/pma?nav=outgoings&subtab=contractors${outgoingsClient?.clientName ? `&client=${encodeURIComponent(outgoingsClient.clientName)}` : ""}`}
                onClick={(e) => {
                  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                    e.preventDefault();
                    setVendorsSubTab("contractors");
                  }
                }}
                style={{
                  padding: "8px 16px", background: "none", border: "none",
                  borderBottom: vendorsSubTab === "contractors" ? "2px solid #0066cc" : "2px solid transparent",
                  color: vendorsSubTab === "contractors" ? "#0066cc" : "#666",
                  fontWeight: vendorsSubTab === "contractors" ? "700" : "500", fontSize: "14px", cursor: "pointer",
                  textDecoration: "none", display: "inline-block", boxSizing: "border-box"
                }}>
                By month
              </a>
              <a
                href={`/pma?nav=outgoings&subtab=directCosts${outgoingsClient?.clientName ? `&client=${encodeURIComponent(outgoingsClient.clientName)}` : ""}`}
                onClick={(e) => {
                  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                    e.preventDefault();
                    setVendorsSubTab("directCosts");
                    if (!directCostsJobs && outgoingsClient) loadDirectCostsJobs(outgoingsClient, false);
                  }
                }}
                style={{
                  padding: "8px 16px", background: "none", border: "none",
                  borderBottom: vendorsSubTab === "directCosts" ? "2px solid #0066cc" : "2px solid transparent",
                  color: vendorsSubTab === "directCosts" ? "#0066cc" : "#666",
                  fontWeight: vendorsSubTab === "directCosts" ? "700" : "500", fontSize: "14px", cursor: "pointer",
                  textDecoration: "none", display: "inline-block", boxSizing: "border-box"
                }}>
                By job
              </a>
            </div>
          </>
        )}

        {!noClient && outgoingsData && vendorsSubTab === "contractors" && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", flex: 1, minWidth: "260px" }}>
                <div style={{ position: "relative", width: "100%", maxWidth: "340px" }}>
                  <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: "14px", pointerEvents: "none" }}>🔍</span>
                  <input
                    type="text"
                    placeholder="Search vendors..."
                    value={contractorSearch}
                    onChange={e => setContractorSearch(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "7px 10px 7px 32px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      outline: "none",
                      boxSizing: "border-box",
                      backgroundColor: "#ffffff",
                    }}
                  />
                  {contractorSearch && (
                    <button
                      type="button"
                      onClick={() => setContractorSearch("")}
                      style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "14px" }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setOutgoingsNewVendor({})}
                  style={{
                    padding: "7px 14px",
                    background: "#0066cc",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                >
                  <span style={{ fontSize: "14px", lineHeight: "1" }}>+</span> Add new vendor
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button onClick={() => setOutgoingsMonthOffset(Math.max(0, outgoingsMonthOffset - 1))}
                  disabled={outgoingsMonthOffset === 0}
                  style={{ padding: "5px 12px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: outgoingsMonthOffset === 0 ? "default" : "pointer", opacity: outgoingsMonthOffset === 0 ? 0.4 : 1 }}>◀</button>
                <span style={{ fontSize: "13px", color: "#555", minWidth: "140px", textAlign: "center" }}>
                  {fmtMonthLabel(visibleMonths[0]?.isoMonth || visibleMonths[0]?.label)} – {fmtMonthLabel(visibleMonths[visibleMonths.length - 1]?.isoMonth || visibleMonths[visibleMonths.length - 1]?.label)}
                </span>
                <button onClick={() => setOutgoingsMonthOffset(Math.min((outgoingsData.months.length - OUTGOINGS_WINDOW), outgoingsMonthOffset + 1))}
                  disabled={outgoingsMonthOffset >= outgoingsData.months.length - OUTGOINGS_WINDOW}
                  style={{ padding: "5px 12px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: "pointer" }}>▶</button>
                <button onClick={async () => { setOutgoingsLoading(true); await loadOutgoings(outgoingsClient); setOutgoingsLoading(false); }}
                  disabled={outgoingsLoading}
                  style={{ padding: "5px 14px", background: outgoingsLoading ? "#e0e0e0" : "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: outgoingsLoading ? "default" : "pointer", fontSize: "12px" }}>
                  {outgoingsLoading ? "Loading..." : "↻ Refresh"}
                </button>
              </div>
            </div>

            <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed", minWidth: `${190 + OUTGOINGS_WINDOW * 160}px` }}>
                <colgroup>
                  <col style={{ width: "190px" }} />
                  {visibleMonths.map(m => <col key={m.colLetter} style={{ width: "160px" }} />)}
                </colgroup>
                <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                  <tr>
                    <th style={{ padding: "9px 12px", background: "#f5f6fa", borderBottom: "2px solid #ddd", borderRight: "1px solid #e0e0e0", fontSize: "12px", fontWeight: "700", textAlign: "left", position: "sticky", left: 0, zIndex: 11 }}>Contractor</th>
                    {visibleMonths.map(m => {
                      const isCurr = isCurrentMonth(m.isoMonth || m.label);
                      return (
                        <th key={m.colLetter} style={{ padding: "9px 10px", background: isCurr ? "#e8f0fe" : "#f5f6fa", borderBottom: "2px solid #ddd", borderRight: "1px solid #e0e0e0", fontSize: "12px", fontWeight: "700", textAlign: "center", color: isCurr ? "#1a56db" : "#444" }}>
                          {fmtMonthLabel(m.isoMonth || m.label)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredContractors.length === 0 ? (
                    <tr>
                      <td colSpan={visibleMonths.length + 1} style={{ padding: "32px", textAlign: "center", color: "#64748b" }}>
                        <div style={{ marginBottom: "10px" }}>No matching vendors found.</div>
                        <button
                          type="button"
                          onClick={() => setOutgoingsNewVendor({})}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 14px",
                            background: "#f0f4ff",
                            border: "1px solid #c5cff0",
                            borderRadius: "6px",
                            color: "#1a56db",
                            fontSize: "12px",
                            fontWeight: "600",
                            cursor: "pointer"
                          }}
                        >
                          <span style={{ fontSize: "14px", lineHeight: "1" }}>+</span> Add new vendor
                        </button>
                      </td>
                    </tr>
                  ) : filteredContractors.map((contractor, rowIdx) => (
                    <tr key={contractor.sheetRow} style={{ background: rowIdx % 2 === 0 ? "#fff" : "#fafbfd" }}>
                      <td style={{ padding: "8px 12px", borderBottom: "1px solid #eee", borderRight: "1px solid #e0e0e0", fontSize: "12px", background: rowIdx % 2 === 0 ? "#fff" : "#fafbfd", position: "sticky", left: 0, zIndex: 1, verticalAlign: "top" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                          <div>
                            <div style={{ fontWeight: "600", color: "#222" }}>{contractor.name}</div>
                            <div style={{ fontSize: "10px", color: "#aaa", marginTop: "1px" }}>VAT:{contractor.vatFlag} · Inv:{contractor.invTiming} · Pay:{contractor.payTiming}</div>
                          </div>
                          <button
                            onClick={() => {
                              const curM = visibleMonths.find(m => isCurrentMonth(m.label)) || visibleMonths[3] || visibleMonths[0];
                              if (curM) setOutgoingsEstimate({ contractor, colLetter: curM.colLetter, monthLabel: curM.label });
                            }}
                            title="Add estimate"
                            style={{ background: "none", border: "1px solid #ddd", borderRadius: "4px", cursor: "pointer", color: "#888", fontSize: "16px", padding: "0 5px", lineHeight: "18px", flexShrink: 0, marginLeft: "4px" }}>+</button>
                        </div>
                      </td>
                      {visibleMonths.map(m => {
                        const cell = contractor.cells[m.colLetter] || { blocks: [] };
                        const realBlocks = (cell.blocks || []).filter(b => !b.appId.startsWith("UNRECON-GAP"));
                        const total = realBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                        const isEmpty = realBlocks.length === 0;
                        const isTarget = selectedInboxAppIds.size > 0 || !!outgoingsPlacing;
                        const isCurr = isCurrentMonth(m.isoMonth || m.label);

                        const handleCellClick = async () => {
                          const toPlace = selectedInboxAppIds.size > 0
                            ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                            : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);

                          if (toPlace.length > 0) {
                            const contrWords = contractor.name.toLowerCase().replace(/[()]/g, " ").split(/\s+/).filter(w => w.length > 3);
                            const anyMismatch = toPlace.some(exp => {
                              const expDesc = ((exp.contactName || "") + " " + (exp.description || "") + " " + (exp.accountName || "")).toLowerCase();
                              return !contrWords.some(w => expDesc.includes(w));
                            });
                            if (anyMismatch) {
                              const ok = window.confirm(
                                `Vendor mismatch?\n\nContractor: "${contractor.name}"\nPlacing ${toPlace.length} expense${toPlace.length > 1 ? "s" : ""}.\n\nPlace anyway?`
                              );
                              if (!ok) return;
                            }
                            const allBlocks = cell.blocks || [];
                            const placeholderBlocks = allBlocks.filter(b => b.appId && isPlaceholderExpense(b.appId));
                            if (placeholderBlocks.length > 0) {
                              const totalManual = placeholderBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                              setOutgoingsReplacePrompt({
                                expenses: toPlace,
                                contractor,
                                colLetter: m.colLetter,
                                allBlocks,
                                totalManual,
                                blocksWithoutManual: allBlocks.filter(b => !b.appId || !isPlaceholderExpense(b.appId)),
                                placeholderBlocks,
                              });
                              return;
                            }
                            const newBlocks = toPlace.map(item => {
                              const { vendor, description } = parseVendorAndDescription(item);
                              const descToStore = description ? `${vendor} - ${description}` : (vendor || item.accountName || "");
                              return {
                                appId: item.appId,
                                amount: item.amount,
                                status: item.status || "",
                                recDate: item.date || "",
                                payDate: item.datePaid || "",
                                description: descToStore || item.description || item.contactName || item.accountName || ""
                              };
                            });
                            await updateCell(contractor, m.colLetter, [...realBlocks, ...newBlocks]);

                            const placedIds = new Set(toPlace.map(e => e.appId));
                            setOutgoingsInbox(prev => {
                              const remaining = prev.filter(e => !placedIds.has(e.appId));
                              if (remaining.length === 0 && outgoingsClient) {
                                markClientCleared(outgoingsClient.clientName);
                              }
                              return remaining;
                            });
                            toPlace.forEach(exp => {
                              addAssignedAppId(exp.appId, outgoingsClient?.clientName);
                            });
                            decrementClientExpenseCount(outgoingsClient?.clientName, toPlace.length);
                            clearInboxSelection();
                          } else {
                            setOutgoingsEditCell({ contractor, colLetter: m.colLetter, monthLabel: m.label, topNote: cell.topNote || "" });
                          }
                        };

                        return (
                          <td key={m.colLetter} onClick={handleCellClick}
                            style={{
                              padding: "6px 8px", borderBottom: "1px solid #eee", borderRight: "1px solid #e0e0e0", verticalAlign: "top", cursor: "pointer", minHeight: "52px", position: "relative",
                              background: isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8",
                              outline: isTarget ? "2px dashed #1a56db" : "none", outlineOffset: "-2px"
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = "#f0f4ff"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8"; }}>
                            <CellNoteIndicator note={cell.topNote} />
                            {!isEmpty ? (
                              <>
                                <div style={{ fontWeight: "700", fontSize: "12px", color: "#1a56db", marginBottom: "3px" }}>
                                  £{total.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                                </div>
                                {realBlocks.map((b, bi) => {
                                  const sc = getStatusColour(b.status);
                                  return (
                                    <div key={bi}
                                      style={{ fontSize: "10px", background: sc.bg, border: `1px solid ${sc.border}`, borderRadius: "3px", padding: "2px 5px", marginBottom: "2px", color: sc.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      £{parseFloat(b.amount).toLocaleString("en-GB", { minimumFractionDigits: 0 })}{b.status ? ` · ${b.status}` : ""}{
                                        !isPlaceholderExpense(b.appId) &&
                                          (outgoingsData?.months || []).some(mo =>
                                            mo.colLetter !== m.colLetter &&
                                            (contractor.cells[mo.colLetter]?.blocks || []).some(ob => ob.appId === b.appId)
                                          ) ? " (split)" : ""
                                      }
                                    </div>
                                  );
                                })}
                              </>
                            ) : (
                              <div style={{ color: isTarget ? "#1a56db" : "#d0d0d0", fontSize: "18px", textAlign: "center", paddingTop: "4px" }}>{isTarget ? "+" : "+"}</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {filteredContractors.length > 0 && (
                    <tr style={{ background: "#ffffff" }}>
                      <td style={{
                        padding: "10px 12px",
                        borderTop: "1px solid #e0e0e0",
                        borderRight: "1px solid #e0e0e0",
                        background: "#ffffff",
                        position: "sticky",
                        left: 0,
                        zIndex: 2,
                      }}>
                        <button
                          type="button"
                          onClick={() => setOutgoingsNewVendor({})}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 12px",
                            background: "#f0f4ff",
                            border: "1px solid #c5cff0",
                            borderRadius: "6px",
                            color: "#1a56db",
                            fontSize: "12px",
                            fontWeight: "600",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = "#e1ecff"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "#f0f4ff"; }}
                        >
                          <span style={{ fontSize: "14px", lineHeight: "1" }}>+</span> Add new vendor
                        </button>
                      </td>
                      {visibleMonths.map(m => (
                        <td key={m.colLetter} style={{ borderTop: "1px solid #e0e0e0", borderRight: "1px solid #e0e0e0", background: "#ffffff" }} />
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!noClient && outgoingsData && vendorsSubTab === "directCosts" && (
          <>
            {directCostsLoading && (
              <PmaInvoicesTableSkeleton />
            )}
            {!directCostsLoading && directCostsJobs && (
              <>
                {/* Description Banner & Toggle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "10px",
                    padding: "10px 16px",
                    background: directCostsShowAll ? "#f8fafc" : "#eff6ff",
                    border: `1px solid ${directCostsShowAll ? "#e2e8f0" : "#bfdbfe"}`,
                    borderRadius: "8px",
                    marginBottom: "14px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: directCostsShowAll ? "#334155" : "#1e40af" }}>
                    <span style={{ fontSize: "15px" }}>ℹ️</span>
                    <span>
                      {directCostsShowAll ? (
                        <>Showing <strong>all confirmed jobs</strong> ({directCostsJobs.length} jobs). Jobs with zero direct costs are visible.</>
                      ) : (
                        <>By default showing jobs with <strong>direct costs</strong> started within the last 6 months ({directCostsJobs.length} jobs). Jobs with no direct costs are hidden.</>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !directCostsShowAll;
                      setDirectCostsShowAll(next);
                      loadDirectCostsJobs(outgoingsClient, next);
                    }}
                    disabled={directCostsLoading}
                    style={{
                      padding: "5px 12px",
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: "600",
                      color: "#1e293b",
                      cursor: "pointer",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                      transition: "all 0.15s ease"
                    }}
                  >
                    {directCostsShowAll ? "Show only jobs with direct costs" : "Show all jobs"}
                  </button>
                </div>

                {/* Search Bar for Direct Costs Jobs */}
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ position: "relative", maxWidth: "340px" }}>
                    <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: "14px", pointerEvents: "none" }}>🔍</span>
                    <input
                      type="text"
                      placeholder="Search jobs..."
                      value={directCostsJobSearch}
                      onChange={e => setDirectCostsJobSearch(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 10px 7px 32px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "13px",
                        outline: "none",
                        boxSizing: "border-box",
                        backgroundColor: "#ffffff",
                      }}
                    />
                    {directCostsJobSearch && (
                      <button
                        type="button"
                        onClick={() => setDirectCostsJobSearch("")}
                        style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "14px" }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* ========================================================================= */}
                {/* MODERN VIEW                                                               */}
                {/* ========================================================================= */}
                {viewMode === "modern" && (
                  <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1200px" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em" }}>

                          <th style={{ padding: "10px 12px", width: "160px", textAlign: "left" }}>Client</th>
                          <th style={{ padding: "10px 12px", width: "200px", textAlign: "left" }}>Job name</th>
                          <th style={{ padding: "10px 10px", width: "80px", textAlign: "left" }}>Code</th>
                          <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Type</th>
                          <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Budget</th>
                          <th style={{ padding: "10px 10px", width: "100px", textAlign: "left" }}>Revenue</th>
                          <th style={{ padding: "10px 10px", width: "150px", textAlign: "left" }}>Dates</th>
                          <th style={{ padding: "10px 10px", minWidth: "340px", textAlign: "left" }}>Direct costs</th>
                          <th style={{ padding: "10px 8px", width: "160px", textAlign: "center" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDirectCostsJobs.length === 0 ? (
                          <tr>
                            <td colSpan={9} style={{ padding: "36px", textAlign: "center", color: "#64748b" }}>
                              No matching jobs found.
                            </td>
                          </tr>
                        ) : (
                          filteredDirectCostsJobs.map((job) => {
                            const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
                            const isPlacing = selectedInboxAppIds.size > 0 || !!outgoingsPlacing;
                            const jr = job.rows[0] || {};

                            const jobTotalExpenses = job.rows.reduce((sum, r) => sum + r.expenseSlots.reduce((s, slot) => {
                              const isReal = (slot.transactionId || slot.description) && !isPlaceholderExpense(slot.transactionId, slot.description, slot.status);
                              return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,s]/g, "")) || 0) : 0);
                            }, 0), 0);
                            const jobBudget = parseFloat(String(job.rows[0]?.directCosts || "").replace(/[£$€,s]/g, "")) || 0;
                            const unreceived = jobBudget - jobTotalExpenses;

                            return (
                              <tr
                                key={jr.rowNum || job.jobName}
                                onClick={() => {
                                  if (isPlacing) {
                                    handleInitiateExpensePlacement(job, null);
                                  }
                                }}
                                style={{
                                  borderBottom: "1px solid #e2e8f0",
                                  backgroundColor: "#ffffff",
                                  cursor: isPlacing ? "pointer" : "default",
                                  transition: "background-color 0.1s ease"
                                }}
                                onMouseEnter={(e) => {
                                  if (isPlacing) {
                                    e.currentTarget.style.backgroundColor = "#eff6ff";
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (isPlacing) {
                                    e.currentTarget.style.backgroundColor = "#ffffff";
                                  }
                                }}
                                title={isPlacing ? `Click to place direct cost against ${job.jobName}` : undefined}
                              >
                                {/* Client */}
                                <td style={{ padding: "8px 12px", verticalAlign: "top", fontWeight: "600", color: "#0f172a" }}>
                                  {jr.client}
                                </td>

                                {/* Job Name */}
                                <td style={{ padding: "8px 12px", verticalAlign: "top" }}>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                                    <div style={{ fontWeight: "600", color: "#1e293b" }}>{jr.jobName}</div>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rawCode = job.projectCode || jr.projectCode || "";
                                        const cleanCode = (rawCode === "-" || rawCode.toLowerCase() === "n/a" || rawCode.toLowerCase() === "none") ? "" : rawCode;
                                        setSelectedJobForDetail({
                                          client: job.client,
                                          endClientName: job.client,
                                          jobName: job.jobName,
                                          projectCode: cleanCode,
                                          rowNum: jr.rowNum,
                                          tabName: "Confirmed",
                                          clientSheetId: effectiveSheetId,
                                          clientName: effectiveClientName,
                                          crmTool: effectiveClientObj?.crmTool,
                                          crmDrives: effectiveClientObj?.crmDrives
                                        });
                                      }}
                                      style={{
                                        background: "#ffffff",
                                        border: "1px solid #cbd5e1",
                                        borderRadius: "4px",
                                        padding: "2px 7px",
                                        fontSize: "11px",
                                        color: "#475569",
                                        cursor: "pointer",
                                        fontWeight: "600",
                                        whiteSpace: "nowrap"
                                      }}
                                      title="Edit job details"
                                    >
                                      Edit job
                                    </button>
                                  </div>
                                </td>

                                {/* Project Code */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#64748b", fontSize: "11px" }}>
                                  {jr.projectCode || "-"}
                                </td>

                                {/* Type */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                  {isRetainer ? (
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "2px 8px",
                                        borderRadius: "12px",
                                        background: "#f0fdf4",
                                        color: "#166534",
                                        border: "1px solid #bbf7d0",
                                        fontSize: "11px",
                                        fontWeight: "600"
                                      }}
                                    >
                                      Retainer ({getRetainerDurationMonths(job)}m)
                                    </span>
                                  ) : (
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "2px 8px",
                                        borderRadius: "12px",
                                        background: "#eff6ff",
                                        color: "#1d4ed8",
                                        border: "1px solid #bfdbfe",
                                        fontSize: "11px",
                                        fontWeight: "600"
                                      }}
                                    >
                                      Project
                                    </span>
                                  )}
                                </td>

                                {/* Budget */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                  <div>
                                    <div style={{ fontWeight: "600", color: "#0f172a" }}>{formatCurrency(jobBudget)}</div>
                                    {unreceived > 0 && (
                                      <div style={{ display: "inline-block", marginTop: "3px", padding: "1px 6px", borderRadius: "4px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", fontSize: "10px", fontWeight: "600" }}>
                                        £{unreceived.toLocaleString("en-GB", { minimumFractionDigits: 2 })} left
                                      </div>
                                    )}
                                  </div>
                                </td>

                                {/* Revenue */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#475569" }}>
                                  {formatCurrency(jr.revenue) || jr.revenue || "-"}
                                </td>

                                {/* Dates */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: "11px", color: "#475569", whiteSpace: "nowrap" }}>
                                  <div>{jr.startDate || "-"}</div>
                                  <div style={{ color: "#94a3b8" }}>{jr.endDate ? `to ${jr.endDate}` : ""}</div>
                                </td>

                                {/* Direct Costs */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                  {(() => {
                                    const rawJobExpenses = getJobExpenseItems(job, false);
                                    const displayExpenseItems = groupSlotItemsForDisplay(rawJobExpenses, "expense");

                                    if (displayExpenseItems.length === 0) {
                                      return (
                                        <span style={{ color: "#94a3b8", fontSize: "11px", fontStyle: "italic" }}>
                                          No direct costs found.
                                        </span>
                                      );
                                    }

                                    return (
                                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px", width: "100%" }}>
                                        {displayExpenseItems.map((expItem, itemIdx) => {
                                          const isPlhdr = isPlaceholderExpense(expItem) ||
                                            String(expItem.description || "").toUpperCase().startsWith("PLACE") ||
                                            String(expItem.description || "").toUpperCase().startsWith("MANUAL") ||
                                            (!expItem.description && !!expItem.amount);
                                          const cellSavingKey = `${expItem.rowNum}-${expItem.slotNum}`;
                                          const isSaving = directCostsSavingCell === cellSavingKey;

                                          return (
                                            <div
                                              key={itemIdx}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (isSaving) return;
                                                setDirectCostsEditSlot({
                                                  rowNum: expItem.rowNum,
                                                  slotNum: expItem.slotNum,
                                                  slot: expItem,
                                                  jobClient: job.client,
                                                  jobName: job.jobName,
                                                  job,
                                                });
                                              }}
                                              style={{
                                                padding: "6px 8px",
                                                borderRadius: "6px",
                                                border: isPlhdr ? "1px dashed #c084fc" : "1px solid #e2e8f0",
                                                background: isPlhdr ? "#faf5ff" : "#ffffff",
                                                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                                                cursor: isSaving ? "default" : "pointer",
                                                width: "100%",
                                                boxSizing: "border-box",
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: "3px",
                                                transition: "border-color 0.15s ease",
                                              }}
                                              onMouseEnter={(e) => { if (!isSaving) e.currentTarget.style.borderColor = isPlhdr ? "#9333ea" : "#94a3b8"; }}
                                              onMouseLeave={(e) => { if (!isSaving) e.currentTarget.style.borderColor = isPlhdr ? "#c084fc" : "#e2e8f0"; }}
                                              title="Click to edit direct cost details"
                                            >
                                              {isSaving ? (
                                                <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "#64748b", fontSize: "10px" }}>
                                                  <Spinner size={10} color="#2563eb" /> Saving...
                                                </div>
                                              ) : (
                                                <>
                                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "4px" }}>
                                                    <span
                                                      title={expItem.description || "Placeholder"}
                                                      style={{
                                                        fontWeight: "700",
                                                        fontSize: "11px",
                                                        color: isPlhdr ? "#9333ea" : "#0f172a",
                                                        overflow: "hidden",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                      }}
                                                    >
                                                      {isPlhdr
                                                        ? (isAutoPlaceholder(expItem.description) ? "Placeholder (A)" : "Placeholder (M)")
                                                        : (expItem.description || (expItem.transactionId ? `#${expItem.transactionId}` : "Expense"))}
                                                    </span>
                                                    <span style={{ fontWeight: "700", fontSize: "11px", color: "#0f172a", flexShrink: 0 }}>
                                                      {formatCurrency(expItem.amount)}
                                                    </span>
                                                  </div>
                                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "4px", fontSize: "10px", color: "#64748b" }}>
                                                    <span>{expItem.date || "-"}</span>
                                                    {expItem.status && (
                                                      <span style={{ ...getStatusPill(expItem.status), padding: "1px 5px", borderRadius: "3px", fontSize: "9px", fontWeight: "600" }}>
                                                        {expItem.status}
                                                      </span>
                                                    )}
                                                  </div>
                                                  {expItem.isGroupedTranche && (
                                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "2px" }}>
                                                      <span style={{ background: "#dcfce7", color: "#166534", padding: "1px 4px", borderRadius: "3px", fontSize: "9px", fontWeight: "600" }}>
                                                        Rec: {formatCurrency(expItem.receivedAmount)}
                                                      </span>
                                                      <span style={{ background: "#fef3c7", color: "#92400e", padding: "1px 4px", borderRadius: "3px", fontSize: "9px", fontWeight: "600" }}>
                                                        Bal: {formatCurrency(expItem.balanceAmount)}
                                                      </span>
                                                    </div>
                                                  )}
                                                </>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                </td>

                                {/* Actions */}
                                <td style={{ padding: "8px 10px", verticalAlign: "top", textAlign: "center" }}>
                                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "stretch", width: "100%", maxWidth: "160px", margin: "0 auto" }}>
                                    {(selectedInboxAppIds.size > 0 || outgoingsPlacing) && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleInitiateExpensePlacement(job, null);
                                        }}
                                        style={{
                                          padding: "5px 10px",
                                          borderRadius: "6px",
                                          border: "1px solid #2563eb",
                                          background: "#2563eb",
                                          color: "#ffffff",
                                          fontSize: "11px",
                                          fontWeight: "600",
                                          cursor: "pointer",
                                          whiteSpace: "nowrap",
                                          boxShadow: "0 1px 2px rgba(37,99,235,0.2)",
                                          transition: "background 0.15s ease",
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = "#1d4ed8"; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = "#2563eb"; }}
                                      >
                                        + Place expense
                                      </button>
                                    )}

                                    {!(selectedInboxAppIds.size > 0 || outgoingsPlacing) && outgoingsInbox && outgoingsInbox.length > 0 && (
                                      <select
                                        onChange={(e) => {
                                          const selectedAppId = e.target.value;
                                          if (!selectedAppId) return;
                                          const chosenExp = outgoingsInbox.find((i) => i.appId === selectedAppId);
                                          if (chosenExp) {
                                            handleInitiateExpensePlacement(job, null, chosenExp);
                                          }
                                          e.target.value = "";
                                        }}
                                        defaultValue=""
                                        style={{
                                          padding: "4px 6px",
                                          borderRadius: "5px",
                                          border: "1px solid #cbd5e1",
                                          background: "#ffffff",
                                          color: "#475569",
                                          fontSize: "11px",
                                          cursor: "pointer",
                                          width: "100%",
                                          textOverflow: "ellipsis",
                                        }}
                                      >
                                        <option value="" disabled>Select expense to place...</option>
                                        {outgoingsInbox.map((exp) => (
                                          <option key={exp.appId} value={exp.appId}>
                                            {exp.description} - {exp.vendor} ({formatCurrency(exp.amount)})
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ========================================================================= */}
                {/* LEGACY VIEW (for Admins)                                                  */}
                {/* ========================================================================= */}
                {viewMode === "legacy" && (
                  <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1140px", tableLayout: "fixed" }}>
                      <colgroup>
                        <col style={{ width: "50px" }} />
                        <col style={{ width: "130px" }} />
                        <col style={{ width: "160px" }} />
                        <col style={{ width: "80px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "70px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "90px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "150px" }} />
                        <col style={{ width: "40px" }} />
                      </colgroup>
                      <thead>
                        <tr style={{ background: "#f5f6fa" }}>
                          {["Row", "Client", "Job name", "Code", "Revenue", "Direct costs", "Type", "Start", "End",
                            "ExpSlot1", "ExpSlot2", "ExpSlot3", ""].map(h => (
                              <th key={h} style={{ padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {directCostsJobs.flatMap((job, jobIdx) => {
                          const jobHasEmptySlot = job.rows.some(jr => jr.expenseSlots.some(s => !s.description && !s.amount));
                          const jobLastRow = job.rows[job.rows.length - 1].rowNum;

                          const jobTotalExpenses = job.rows.reduce((sum, r) => sum + r.expenseSlots.reduce((s, slot) => {
                            const isReal = slot.transactionId && !isPlaceholderExpense(slot.transactionId);
                            return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) || 0) : 0);
                          }, 0), 0);
                          const jobBudget = parseFloat(String(job.rows[0].directCosts).replace(/[£$€,\s]/g, "")) || 0;
                          const unreceived = jobBudget - jobTotalExpenses;

                          return job.rows.map((jr, rIdx) => {
                            const isLastRowOfJob = rIdx === job.rows.length - 1;
                            return (
                              <tr key={jr.rowNum} style={{ background: jobIdx % 2 === 0 ? "#fff" : "#f1f5f9" }}>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", color: "#888" }}>{jr.rowNum}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.client : ""}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {rIdx === 0 ? (
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                                      <span>{jr.jobName}</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const rawCode = job.projectCode || jr.projectCode || "";
                                          const cleanCode = (rawCode === "-" || rawCode.toLowerCase() === "n/a" || rawCode.toLowerCase() === "none") ? "" : rawCode;
                                          setSelectedJobForDetail({
                                            client: job.client,
                                            endClientName: job.client,
                                            jobName: job.jobName,
                                            projectCode: cleanCode,
                                            rowNum: jr.rowNum,
                                            tabName: "Confirmed",
                                            clientSheetId: effectiveSheetId,
                                            clientName: effectiveClientName,
                                            crmTool: effectiveClientObj?.crmTool,
                                            crmDrives: effectiveClientObj?.crmDrives
                                          });
                                        }}
                                        style={{
                                          background: "#ffffff",
                                          border: "1px solid #cbd5e1",
                                          borderRadius: "4px",
                                          padding: "2px 6px",
                                          fontSize: "10.5px",
                                          color: "#475569",
                                          cursor: "pointer",
                                          fontWeight: "600",
                                          whiteSpace: "nowrap"
                                        }}
                                        title="Edit job details"
                                      >
                                        Edit job
                                      </button>
                                    </div>
                                  ) : ""}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.projectCode : ""}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.revenue : ""}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                                  {rIdx === 0 ? (
                                    <>
                                      <div>{jr.directCosts}</div>
                                      {unreceived > 0 && <div style={{ fontSize: "11px", color: "#ef4444", marginTop: "4px" }}>£{unreceived.toLocaleString("en-GB", { minimumFractionDigits: 2 })} rem.</div>}
                                    </>
                                  ) : ""}
                                </td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee" }}>{jr.projectRetainer}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.startDate}</td>
                                <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{jr.endDate}</td>
                                {jr.expenseSlots.map(s => {
                                  const isManualEntry = isPlaceholderExpense(s.transactionId);
                                  const isGenuinelyBlank = !s.description && !s.amount;
                                  const isEmpty = isGenuinelyBlank || isManualEntry;
                                  const isPlacing = selectedInboxAppIds.size > 0 || !!outgoingsPlacing;
                                  const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                                  const isSaving = directCostsSavingCell === cellSavingKey;
                                  return (
                                    <td key={s.slotNum}
                                      onClick={async () => {
                                        if (isSaving) return;
                                        const toPlace = selectedInboxAppIds.size > 0
                                          ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                                          : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);

                                        if (toPlace.length > 0 && isEmpty) {
                                          setDirectCostsSavingCell(cellSavingKey);
                                          const placedIds = new Set(toPlace.map(e => e.appId));
                                          toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
                                          decrementClientExpenseCount(outgoingsClient?.clientName, toPlace.length);
                                          setOutgoingsInbox(prev => {
                                            const remaining = prev.filter(e => !placedIds.has(e.appId));
                                            if (remaining.length === 0 && outgoingsClient) {
                                              markClientCleared(outgoingsClient.clientName);
                                            }
                                            return remaining;
                                          });
                                          clearInboxSelection();

                                          try {
                                            const res = await fetch("/api/triage", {
                                              method: "POST", headers: { "Content-Type": "application/json" },
                                              body: JSON.stringify({
                                                action: "assign_expense_to_job",
                                                clientSheetId: outgoingsClient?.clientSheetId,
                                                clientName: outgoingsClient?.clientName || outgoingsClient?.name || "",
                                                masterSheetId: outgoingsClient?.masterSheetId || "",
                                                rowNum: jr.rowNum, slotNum: s.slotNum,
                                                expenses: toPlace,
                                                jobClient: job.client,
                                                jobName: job.jobName,
                                                jobLastRow,
                                                jobRows: job.rows
                                              }),
                                            });
                                            const data = await res.json();
                                            if (outgoingsClient?.masterSheetId) {
                                              outgoingsPullPendingRef.current = { clientSheetId: outgoingsClient.clientSheetId, masterSheetId: outgoingsClient.masterSheetId };
                                            }
                                            if (data.newRowsCreated) {
                                              await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
                                            } else if (data.placed && Array.isArray(data.placed)) {
                                              setDirectCostsJobs(prev => prev && prev.map(j => {
                                                if (j.client !== job.client || j.jobName !== job.jobName) return j;
                                                return {
                                                  ...j,
                                                  rows: j.rows.map(r => {
                                                    const placedForThisRow = data.placed.filter(p => p.rowNum === r.rowNum);
                                                    if (placedForThisRow.length === 0) return r;
                                                    return {
                                                      ...r,
                                                      expenseSlots: r.expenseSlots.map(sl => {
                                                        const match = placedForThisRow.find(p => p.slotNum === sl.slotNum);
                                                        if (!match) return sl;
                                                        return {
                                                          ...sl,
                                                          description: match.description,
                                                          amount: match.amount,
                                                          vat: match.vat,
                                                          date: match.date,
                                                          status: match.status,
                                                          transactionId: match.transactionId
                                                        };
                                                      })
                                                    };
                                                  })
                                                };
                                              }));
                                            } else {
                                              await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
                                            }
                                          } catch (e) { console.error("assign_expense_to_job error:", e); }
                                          finally { setDirectCostsSavingCell(null); }
                                        } else if (toPlace.length === 0 && !isGenuinelyBlank) {
                                          setDirectCostsEditSlot({
                                            rowNum: jr.rowNum,
                                            slotNum: s.slotNum,
                                            slot: s,
                                            jobName: job.jobName,
                                            jobClient: job.client
                                          });
                                        }
                                      }}
                                      style={{
                                        padding: "7px 10px", borderBottom: "1px solid #eee",
                                        cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                        background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                        border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none"
                                      }}>
                                      {isSaving ? (
                                        <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#666" }}>
                                          <Spinner size={12} color="#1a56db" /> Saving...
                                        </div>
                                      ) : isGenuinelyBlank ? (
                                        isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>-</span>
                                      ) : (
                                        <div>
                                          <div title={s.description} style={{ fontWeight: "600", color: isManualEntry ? "#9333ea" : "inherit", wordBreak: "break-word" }}>
                                            {isManualEntry && "(placeholder) "}{s.description}
                                          </div>
                                          <div style={{ color: "#888" }}>{/^[£$€]/.test(String(s.amount)) ? s.amount : `£${s.amount}`} · {s.date}{s.status ? ` · ${s.status}` : ""}</div>
                                          {isManualEntry && isPlacing && (
                                            <div style={{ color: "#1a56db", fontWeight: "700", marginTop: "2px" }}>Click to overwrite</div>
                                          )}
                                          {!isPlacing && (
                                            <div style={{ color: "#1a56db", fontSize: "10px", marginTop: "2px" }}>Click to edit</div>
                                          )}
                                        </div>
                                      )}
                                    </td>
                                  );
                                })}
                                <td style={{ padding: "0", borderBottom: "1px solid #eee", textAlign: "center" }}>
                                  {directCostsSavingCell === `newrow-${job.client}|||${job.jobName}` ? (
                                    <div style={{ height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                      <Spinner size={12} color="#1a56db" />
                                    </div>
                                  ) : isLastRowOfJob && !jobHasEmptySlot && (selectedInboxAppIds.size > 0 || !!outgoingsPlacing) && (
                                    <div
                                      title="Add more space for this job"
                                      onClick={async () => {
                                        const toPlace = selectedInboxAppIds.size > 0
                                          ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                                          : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);
                                        if (toPlace.length === 0) return;
                                        const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                        setDirectCostsSavingCell(savingKey);
                                        const placedIds = new Set(toPlace.map(e => e.appId));
                                        toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
                                        decrementClientExpenseCount(outgoingsClient?.clientName, toPlace.length);
                                        setOutgoingsInbox(prev => {
                                          const remaining = prev.filter(e => !placedIds.has(e.appId));
                                          if (remaining.length === 0 && outgoingsClient) {
                                            markClientCleared(outgoingsClient.clientName);
                                          }
                                          return remaining;
                                        });
                                        clearInboxSelection();
                                        try {
                                          await fetch("/api/triage", {
                                            method: "POST", headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({
                                              action: "assign_expense_to_job",
                                              clientSheetId: outgoingsClient?.clientSheetId,
                                              clientName: outgoingsClient?.clientName || outgoingsClient?.name || "",
                                              masterSheetId: outgoingsClient?.masterSheetId || "",
                                              createNewRow: true,
                                              jobLastRow, jobClient: job.client, jobName: job.jobName,
                                              expenses: toPlace,
                                              jobRows: job.rows
                                            }),
                                          });
                                          if (outgoingsClient?.masterSheetId) {
                                            outgoingsPullPendingRef.current = { clientSheetId: outgoingsClient.clientSheetId, masterSheetId: outgoingsClient.masterSheetId };
                                          }
                                          await loadDirectCostsJobs(outgoingsClient, directCostsShowAll);
                                        } catch (e) { console.error("assign_expense_to_job (new row) error:", e); }
                                        finally { setDirectCostsSavingCell(null); }
                                      }}
                                      style={{
                                        cursor: "pointer", background: "#e8f0fe", border: "1.5px solid #1a56db",
                                        height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center",
                                        color: "#1a56db", fontWeight: "700", fontSize: "16px"
                                      }}>
                                      +
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          });
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}