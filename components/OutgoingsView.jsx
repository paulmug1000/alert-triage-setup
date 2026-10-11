import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import OutgoingsEditModal from "./OutgoingsEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import OutgoingsEstimateModal from "./OutgoingsEstimateModal";
import OutgoingsNewVendorModal from "./OutgoingsNewVendorModal";
import { useOutgoings } from "../hooks/useOutgoings";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";
import { useAuth } from "../hooks/useAuth";
import { isPlaceholderExpense } from "../utils/helpers";

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
  onClearManagedClient
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
  } = useOutgoings(assignedAppIds, assignedByClient, setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, automationCommanderSheetId);

  // Auto-select managedClient when in manage mode, or clear when manage mode cancelled
  useEffect(() => {
    if (managedClient) {
      const clientObj = (allOutgoingsClients || []).find(c => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()) || managedClient;
      loadOutgoings(clientObj);
    } else {
      setOutgoingsData(null);
      setOutgoingsClient(null);
      setOutgoingsInbox([]);
      if (typeof clearInboxSelection === "function") clearInboxSelection();
    }
  }, [managedClient, allOutgoingsClients]);

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

  useEffect(() => {
    if (outgoingsClient && !outgoingsLoading && outgoingsInbox.length === 0) {
      markClientCleared(outgoingsClient.clientName);
    }
  }, [outgoingsInbox.length, outgoingsClient, outgoingsLoading, markClientCleared]);

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

  const updateCell = async (contractor, colLetter, newBlocks) => {
    setOutgoingsData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        contractors: prev.contractors.map(c =>
          c.sheetRow === contractor.sheetRow
            ? { ...c, cells: { ...c.cells, [colLetter]: { ...c.cells[colLetter], blocks: newBlocks } } }
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
        }),
      });
      if (outgoingsClient?.masterSheetId) {
        outgoingsPullPendingRef.current = { clientSheetId: outgoingsClient.clientSheetId, masterSheetId: outgoingsClient.masterSheetId };
      }
    } catch(e) { console.error("updateCell error:", e); }
  };

  const STATUS_COLOURS = {
    "Paid":     { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
    "Received": { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
    "Draft":    { bg: "#fff8e1", border: "#ffc107", text: "#e65100" },
    "":         { bg: "#f5f5f5", border: "#bdbdbd", text: "#616161" },
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
  const noClient = !outgoingsClient || !outgoingsData;

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
      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={outgoingsClient}
          isAdmin={isAdmin}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => outgoingsPullPendingRef.current = masterId}
          onUpdateJobs={(rNum, sNum, newData) => {
            setDirectCostsJobs(prev => prev && prev.map(j => ({
              ...j,
              rows: j.rows.map(r => r.rowNum !== rNum ? r : {
                ...r,
                expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== sNum ? sl : { ...sl, ...newData })
              }),
            })));
          }}
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
          clearInboxSelection();
        };

        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 480px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: "700" }}>Placeholder / Unrecon gap exists</h3>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#555" }}>
                This cell already contains a placeholder / gap of <strong>£{totalManual.toFixed(2)}</strong>.<br/>
                You are placing <strong>{expenseList.length}</strong> expense{expenseList.length > 1 ? "s" : ""} totaling <strong>£{totalExpenseAmount.toFixed(2)}</strong>.<br/><br/>
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
                  ? "· Click a contractor cell to place all selected items into that single slot"
                  : "· Click an expense slot to place each item sequentially starting from that slot"}
              </span>
            </div>
            <button onClick={clearInboxSelection}
              style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "4px", padding: "5px 14px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
              Cancel
            </button>
          </div>
        );
      })()}

      <div style={{ padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          {outgoingsClient && (
            <button onClick={() => {
              if (managedClient && onClearManagedClient) {
                onClearManagedClient();
              } else {
                setOutgoingsData(null);
                setOutgoingsClient(null);
                setOutgoingsInbox([]);
                clearInboxSelection();
              }
            }}
              style={{ background: "none", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", padding: "4px 10px", fontSize: "16px", color: "#555", lineHeight: 1 }}
              title="Back to client list">&#8592;</button>
          )}
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
            {outgoingsClient ? outgoingsClient.clientName : "Contractors"}
          </h2>
          {isAdmin && outgoingsClient && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
              {vendorsSubTab === "directCosts" && (
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
                  <span>{viewMode === "modern" ? "📋 Legacy View" : "✨ Modern View"}</span>
                </button>
              )}
              <button className="triage-btn"
                onClick={() => {
                  if (outgoingsClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${outgoingsClient.clientSheetId}/edit`, "_blank");
                }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
                📊 Open Sheets
              </button>
            </div>
          )}
        </div>

        {noClient && (
          <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e0e0e0", padding: "24px" }}>
            {outgoingsLoading ? (
              <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading...</div>
            ) : (
              <>
                <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#666" }}>Select a client to assign vendor expenses:</p>
                {(() => {
                  const getClientRemainingCount = (c) => {
                    if (clearedClients.has(c.clientName)) return 0;
                    const f = clientsWithFlags?.find(item => item.clientName === c.clientName);
                    if (!f) return 0;
                    const hasFlag = !!(f.flags?.expenseDashboardDiscr || f.flags?.dirCompMismatch);
                    if (!hasFlag) return 0;
                    const assignedSet = assignedByClient[c.clientName] || new Set();
                    const expenseIds = f.activeExpenseIds || [];
                    const validAssignedExp = expenseIds.filter(id => assignedSet.has(id) || assignedAppIds.has(id)).length;
                    const rawCount = (f.alertCounts?.expenseDashboardDiscr || 0) + (f.alertCounts?.dirCompMismatch || 0);
                    return Math.max(0, (rawCount > 0 ? rawCount : 1) - validAssignedExp);
                  };

                  const clientsWithInbox = allClients.filter(c => getClientRemainingCount(c) > 0);
                  const clientsNoInbox = allClients.filter(c => !clientsWithInbox.includes(c));
                  const renderClientBtn = (c) => {
                    const remainingCount = getClientRemainingCount(c);
                    return (
                      <button key={c.clientName} className="triage-btn" onClick={() => loadOutgoings(c)}
                        style={{
                          ...styles.buttonSecondary,
                          textAlign: "left",
                          padding: "12px 16px",
                          fontSize: "14px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          ...(remainingCount > 0 ? {
                            background: "#fff7ed",
                            borderColor: "#fed7aa"
                          } : {})
                        }}>
                        <span>{c.clientName}</span>
                        {remainingCount > 0 && (
                          <span style={{ fontSize: "11px", background: "#f97316", color: "#fff", borderRadius: "10px", padding: "1px 7px", fontWeight: "600" }}>
                            {remainingCount} to assign
                          </span>
                        )}
                      </button>
                    );
                  };
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {clientsWithInbox.length > 0 && clientsNoInbox.length > 0 && (
                        <div style={{ fontSize: "11px", fontWeight: "700", color: "#f97316", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>Expenses to assign</div>
                      )}
                      {clientsWithInbox.map(renderClientBtn)}
                      {clientsNoInbox.length > 0 && clientsWithInbox.length > 0 && (
                        <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 2px" }}>No expenses to assign</div>
                      )}
                      {clientsNoInbox.map(renderClientBtn)}
                      {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet - go to Home and refresh first.</p>}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
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
                          title="Create new vendor row for this expense"
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

        {!noClient && outgoingsData && (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "14px", borderBottom: "1px solid #e0e0e0" }}>
              <button onClick={() => setVendorsSubTab("contractors")}
                style={{ padding: "8px 16px", background: "none", border: "none",
                  borderBottom: vendorsSubTab === "contractors" ? "2px solid #0066cc" : "2px solid transparent",
                  color: vendorsSubTab === "contractors" ? "#0066cc" : "#666",
                  fontWeight: vendorsSubTab === "contractors" ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                By month
              </button>
              <button onClick={() => {
                  setVendorsSubTab("directCosts");
                  if (!directCostsJobs) loadDirectCostsJobs(outgoingsClient, false);
                }}
                style={{ padding: "8px 16px", background: "none", border: "none",
                  borderBottom: vendorsSubTab === "directCosts" ? "2px solid #0066cc" : "2px solid transparent",
                  color: vendorsSubTab === "directCosts" ? "#0066cc" : "#666",
                  fontWeight: vendorsSubTab === "directCosts" ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                By job
              </button>
            </div>
          </>
        )}

        {!noClient && outgoingsData && vendorsSubTab === "contractors" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
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
                style={{ marginLeft: "auto", padding: "5px 14px", background: outgoingsLoading ? "#e0e0e0" : "#f0f0f0", border: "1px solid #ccc", borderRadius: "5px", cursor: outgoingsLoading ? "default" : "pointer", fontSize: "12px" }}>
                {outgoingsLoading ? "Loading..." : "↻ Refresh"}
              </button>
            </div>

            <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
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
                  {outgoingsData.contractors.map((contractor, rowIdx) => (
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
                            clearInboxSelection();
                          } else {
                            setOutgoingsEditCell({ contractor, colLetter: m.colLetter, monthLabel: m.label });
                          }
                        };

                        return (
                          <td key={m.colLetter} onClick={handleCellClick}
                            style={{ padding: "6px 8px", borderBottom: "1px solid #eee", borderRight: "1px solid #e0e0e0", verticalAlign: "top", cursor: "pointer", minHeight: "52px",
                              background: isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8",
                              outline: isTarget ? "2px dashed #1a56db" : "none", outlineOffset: "-2px" }}
                            onMouseEnter={e => { e.currentTarget.style.background = "#f0f4ff"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isTarget ? "#f0f4ff" : isCurr && !isEmpty ? "#f0f8f0" : isEmpty ? "transparent" : "#f8fff8"; }}>
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
                </tbody>
              </table>
            </div>
          </>
        )}

        {!noClient && outgoingsData && vendorsSubTab === "directCosts" && (
          <>
            {directCostsLoading && (
              <div style={{ textAlign: "center", color: "#999", padding: "24px" }}>Loading jobs...</div>
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

                {/* ========================================================================= */}
                {/* MODERN VIEW                                                               */}
                {/* ========================================================================= */}
                {viewMode === "modern" && (
                  <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px", minWidth: "1200px" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                          <th style={{ padding: "10px 10px", width: "36px", textAlign: "center" }}></th>
                          <th style={{ padding: "10px 12px", width: "160px", textAlign: "left" }}>Client</th>
                          <th style={{ padding: "10px 12px", width: "200px", textAlign: "left" }}>Job Name</th>
                          <th style={{ padding: "10px 10px", width: "80px", textAlign: "left" }}>Code</th>
                          <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Type</th>
                          <th style={{ padding: "10px 10px", width: "110px", textAlign: "left" }}>Direct Costs</th>
                          <th style={{ padding: "10px 10px", width: "100px", textAlign: "left" }}>Revenue</th>
                          <th style={{ padding: "10px 10px", width: "150px", textAlign: "left" }}>Dates</th>
                          <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 1</th>
                          <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 2</th>
                          <th style={{ padding: "10px 10px", width: "170px", textAlign: "left" }}>Slot 3</th>
                          <th style={{ padding: "10px 8px", width: "40px", textAlign: "center" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {directCostsJobs.length === 0 ? (
                          <tr>
                            <td colSpan={12} style={{ padding: "36px", textAlign: "center", color: "#64748b" }}>
                              No matching jobs found.
                            </td>
                          </tr>
                        ) : (
                          directCostsJobs.map((job) => {
                            const jobKey = `${job.client}|||${job.jobName}`;
                            const isRetainer = String(job.rows?.[0]?.projectRetainer || "").toLowerCase().includes("retainer");
                            const hasMultipleRows = job.rows && job.rows.length > 1;
                            const isRetainerExpanded = expandedRetainerKeys.has(jobKey);
                            const isPlacing = selectedInboxAppIds.size > 0 || !!outgoingsPlacing;

                            let visibleRows;
                            if (isRetainer) {
                              visibleRows = (isRetainer && !isRetainerExpanded) ? [job.rows[0]] : job.rows;
                            } else {
                              // Project job: only show multiple rows if expenses go over multiple rows
                              const lastRowWithExpenseIdx = job.rows.reduce((maxIdx, r, idx) => rowHasExpense(r) ? idx : maxIdx, 0);
                              let neededIdx = lastRowWithExpenseIdx;
                              if (isPlacing) {
                                const firstRowWithSpaceIdx = job.rows.findIndex(r => r.expenseSlots.some(s => !s.description && !s.amount));
                                if (firstRowWithSpaceIdx > neededIdx) {
                                  neededIdx = firstRowWithSpaceIdx;
                                }
                              }
                              visibleRows = job.rows.slice(0, neededIdx + 1);
                            }

                            const jobTotalExpenses = job.rows.reduce((sum, r) => sum + r.expenseSlots.reduce((s, slot) => {
                              const isReal = (slot.transactionId || slot.description) && !isPlaceholderExpense(slot.transactionId, slot.description, slot.status);
                              return s + (isReal ? (parseFloat(String(slot.amount).replace(/[£$€,\s]/g, "")) || 0) : 0);
                            }, 0), 0);
                            const jobBudget = parseFloat(String(job.rows[0]?.directCosts || "").replace(/[£$€,\s]/g, "")) || 0;
                            const unreceived = jobBudget - jobTotalExpenses;
                            const jobHasEmptySlot = visibleRows.some(jr => jr.expenseSlots.some(s => !s.description && !s.amount));
                            const jobLastRow = job.rows[job.rows.length - 1]?.rowNum;

                            return visibleRows.map((jr, rIdx) => {
                              const isLastRowOfJob = rIdx === visibleRows.length - 1;
                              const isChildRow = rIdx > 0;

                              return (
                                <tr
                                  key={jr.rowNum}
                                  style={{
                                    borderBottom: isLastRowOfJob ? "1px solid #e2e8f0" : "1px solid #f1f5f9",
                                    backgroundColor: isChildRow ? "#f8fafc" : "#ffffff",
                                    transition: "background-color 0.1s ease"
                                  }}
                                >
                                  {/* Expand/Collapse Chevron (for Retainers) */}
                                  <td style={{ padding: "8px 6px", textAlign: "center", verticalAlign: "top" }}>
                                    {rIdx === 0 && isRetainer && hasMultipleRows && (
                                      <button
                                        type="button"
                                        onClick={() => toggleRetainerExpand(jobKey)}
                                        style={{
                                          background: "none",
                                          border: "none",
                                          color: "#64748b",
                                          cursor: "pointer",
                                          padding: "2px 4px",
                                          fontSize: "11px",
                                          lineHeight: 1
                                        }}
                                        title={isRetainerExpanded ? "Collapse retainer months" : `Expand all ${job.rows.length} retainer months`}
                                      >
                                        {isRetainerExpanded ? "▼" : "▶"}
                                      </button>
                                    )}
                                  </td>

                                  {/* Client */}
                                  <td style={{ padding: "8px 12px", verticalAlign: "top", fontWeight: "600", color: "#0f172a" }}>
                                    {rIdx === 0 ? jr.client : ""}
                                  </td>

                                  {/* Job Name */}
                                  <td style={{ padding: "8px 12px", verticalAlign: "top" }}>
                                    {rIdx === 0 ? (
                                      <div style={{ fontWeight: "600", color: "#1e293b" }}>{jr.jobName}</div>
                                    ) : (
                                      <div style={{ fontSize: "11px", color: "#64748b", paddingLeft: "8px" }}>
                                        {isRetainer ? `↳ Month ${rIdx + 1}` : (isAdmin ? `↳ Row ${rIdx + 1}` : `↳ Part ${rIdx + 1}`)}
                                      </div>
                                    )}
                                  </td>

                                  {/* Project Code */}
                                  <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#64748b", fontSize: "11px" }}>
                                    {rIdx === 0 ? (jr.projectCode || "-") : ""}
                                  </td>

                                  {/* Type */}
                                  <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                    {rIdx === 0 ? (
                                      isRetainer ? (
                                        <button
                                          type="button"
                                          onClick={() => hasMultipleRows && toggleRetainerExpand(jobKey)}
                                          style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            gap: "4px",
                                            padding: "2px 8px",
                                            borderRadius: "12px",
                                            background: "#f0fdf4",
                                            color: "#166534",
                                            border: "1px solid #bbf7d0",
                                            fontSize: "11px",
                                            fontWeight: "600",
                                            cursor: hasMultipleRows ? "pointer" : "default"
                                          }}
                                          title={hasMultipleRows ? (isRetainerExpanded ? "Collapse" : "Expand all months") : undefined}
                                        >
                                          <span>Retainer</span>
                                          {hasMultipleRows && (
                                            <span style={{ fontSize: "10px", color: "#15803d" }}>
                                              {isRetainerExpanded ? "▲" : `(${job.rows.length}m)`}
                                            </span>
                                          )}
                                        </button>
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
                                      )
                                    ) : (
                                      <span style={{ fontSize: "10px", color: "#94a3b8" }}>
                                        {isRetainer ? `mo. ${rIdx + 1}` : (isAdmin ? `row ${rIdx + 1}` : `part ${rIdx + 1}`)}
                                      </span>
                                    )}
                                  </td>

                                  {/* Direct Costs */}
                                  <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                                    {rIdx === 0 ? (
                                      <div>
                                        <div style={{ fontWeight: "600", color: "#0f172a" }}>{formatCurrency(jr.directCosts) || jr.directCosts}</div>
                                        {unreceived > 0 && (
                                          <div style={{ display: "inline-block", marginTop: "3px", padding: "1px 6px", borderRadius: "4px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", fontSize: "10px", fontWeight: "600" }}>
                                            £{unreceived.toLocaleString("en-GB", { minimumFractionDigits: 2 })} left
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div style={{ color: "#94a3b8", fontSize: "11px" }}>-</div>
                                    )}
                                  </td>

                                  {/* Revenue */}
                                  <td style={{ padding: "8px 10px", verticalAlign: "top", color: "#475569" }}>
                                    {rIdx === 0 ? (formatCurrency(jr.revenue) || jr.revenue || "-") : ""}
                                  </td>

                                  {/* Dates */}
                                  <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: "11px", color: "#475569", whiteSpace: "nowrap" }}>
                                    <div>{jr.startDate || "-"}</div>
                                    <div style={{ color: "#94a3b8" }}>{jr.endDate ? `to ${jr.endDate}` : ""}</div>
                                  </td>

                                  {/* Expense Slots 1, 2, 3 */}
                                  {jr.expenseSlots.map((s) => {
                                    const txUpper = String(s.transactionId || "").trim().toUpperCase();
                                    const descUpper = String(s.description || "").trim().toUpperCase();
                                    const statusUpper = String(s.status || "").trim().toUpperCase();
                                    const isPlaceholder = isPlaceholderExpense(s.transactionId, s.description, s.status) ||
                                      txUpper.startsWith("PLACE") ||
                                      descUpper.startsWith("PLACE") ||
                                      txUpper.includes("PLACEHOLDER") ||
                                      descUpper.includes("PLACEHOLDER") ||
                                      statusUpper.includes("PLACEHOLDER") ||
                                      txUpper.startsWith("MANUAL") ||
                                      descUpper.startsWith("MANUAL") ||
                                      (!s.description && !!s.amount);
                                    const isGenuinelyBlank = !s.description && !s.amount;
                                    const isEmpty = isGenuinelyBlank || isPlaceholder;
                                    const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                                    const isSaving = directCostsSavingCell === cellSavingKey;

                                    return (
                                      <td
                                        key={s.slotNum}
                                        onClick={async () => {
                                          if (isSaving) return;
                                          const toPlace = selectedInboxAppIds.size > 0
                                            ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                                            : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);

                                          if (toPlace.length > 0 && isEmpty) {
                                            setDirectCostsSavingCell(cellSavingKey);
                                            const placedIds = new Set(toPlace.map(e => e.appId));
                                            toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
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
                                            } catch(e) { console.error("assign_expense_to_job error:", e); }
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
                                          padding: "6px 8px",
                                          verticalAlign: "top",
                                          cursor: isSaving ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default"
                                        }}
                                      >
                                        <div
                                          style={{
                                            borderRadius: "6px",
                                            padding: "6px 8px",
                                            minHeight: "44px",
                                            display: "flex",
                                            flexDirection: "column",
                                            justifyContent: "center",
                                            transition: "all 0.15s ease",
                                            background: isSaving
                                              ? "#f8fafc"
                                              : (isPlacing && isEmpty)
                                              ? "#eff6ff"
                                              : isGenuinelyBlank
                                              ? "transparent"
                                              : "#ffffff",
                                            border: (isPlacing && isEmpty && !isSaving)
                                              ? "1.5px dashed #2563eb"
                                              : isGenuinelyBlank
                                              ? "1px dashed #e2e8f0"
                                              : "1px solid #e2e8f0",
                                            boxShadow: (!isGenuinelyBlank && !isSaving) ? "0 1px 2px rgba(0,0,0,0.03)" : "none"
                                          }}
                                        >
                                          {isSaving ? (
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#64748b", fontSize: "11px" }}>
                                              <Spinner size={12} color="#2563eb" /> Saving...
                                            </div>
                                          ) : isGenuinelyBlank ? (
                                            isPlacing ? (
                                              <div style={{ color: "#1d4ed8", fontWeight: "700", textAlign: "center", fontSize: "11px" }}>
                                                + Place expense
                                              </div>
                                            ) : (
                                              <div style={{ color: "#cbd5e1", textAlign: "center", fontSize: "12px" }}>—</div>
                                            )
                                          ) : (
                                            <div>
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "4px" }}>
                                                <span
                                                  title={!isAdmin && isPlaceholder ? "Placeholder" : (s.description || "")}
                                                  style={{
                                                    fontWeight: "700",
                                                    fontSize: "12px",
                                                    color: isPlaceholder ? "#9333ea" : "#0f172a",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                    maxWidth: "105px"
                                                  }}
                                                >
                                                  {isPlaceholder
                                                    ? (isAdmin ? `⚠️ ${s.description || "Placeholder"}` : "⚠️ Placeholder")
                                                    : (s.description || "-")}
                                                </span>
                                                <span style={{ fontWeight: "600", fontSize: "11px", color: "#0f172a" }}>
                                                  {formatCurrency(s.amount) || `£${s.amount}`}
                                                </span>
                                              </div>
                                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "4px", gap: "4px" }}>
                                                <span style={{ color: "#64748b", fontSize: "10px" }}>{s.date || "-"}</span>
                                                {s.status && (
                                                  <span style={{ ...getStatusPill(s.status), padding: "1px 5px", borderRadius: "4px", fontSize: "9px", fontWeight: "600" }}>
                                                    {s.status}
                                                  </span>
                                                )}
                                              </div>
                                              {isPlaceholder && isPlacing && (
                                                <div style={{ color: "#2563eb", fontWeight: "700", fontSize: "10px", marginTop: "3px" }}>
                                                  Click to overwrite
                                                </div>
                                              )}
                                              {!isPlacing && (
                                                <div style={{ color: "#2563eb", fontSize: "10px", marginTop: "2px" }}>
                                                  Edit
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </td>
                                    );
                                  })}

                                  {/* Add Row Action Column */}
                                  <td style={{ padding: "6px 4px", verticalAlign: "middle", textAlign: "center" }}>
                                    {directCostsSavingCell === `newrow-${job.client}|||${job.jobName}` ? (
                                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                        <Spinner size={12} color="#2563eb" />
                                      </div>
                                    ) : isLastRowOfJob && !jobHasEmptySlot && isPlacing ? (
                                      <button
                                        type="button"
                                        title={isAdmin ? "No spare expense slot - click to add a new row for this job" : "No spare expense slot - click to add more space for this job"}
                                        onClick={async () => {
                                          const toPlace = selectedInboxAppIds.size > 0
                                            ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                                            : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);
                                          if (toPlace.length === 0) return;
                                          const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                          setDirectCostsSavingCell(savingKey);
                                          const placedIds = new Set(toPlace.map(e => e.appId));
                                          toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
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
                                          } catch(e) { console.error("assign_expense_to_job (new row) error:", e); }
                                          finally { setDirectCostsSavingCell(null); }
                                        }}
                                        style={{
                                          cursor: "pointer",
                                          background: "#eff6ff",
                                          border: "1.5px solid #2563eb",
                                          borderRadius: "6px",
                                          width: "28px",
                                          height: "28px",
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          color: "#1d4ed8",
                                          fontWeight: "700",
                                          fontSize: "16px"
                                        }}
                                      >
                                        +
                                      </button>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            });
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
                          {["Row","Client","Job name","Code","Revenue","Direct costs","Type","Start","End",
                            "ExpSlot1","ExpSlot2","ExpSlot3",""].map(h => (
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
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.jobName : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.projectCode : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>{rIdx === 0 ? jr.revenue : ""}</td>
                            <td style={{ padding: "7px 10px", borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                              {rIdx === 0 ? (
                                <>
                                  <div>{jr.directCosts}</div>
                                  {unreceived > 0 && <div style={{ fontSize: "11px", color: "#ef4444", marginTop: "4px" }}>£{unreceived.toLocaleString("en-GB", {minimumFractionDigits: 2})} rem.</div>}
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
                                      } catch(e) { console.error("assign_expense_to_job error:", e); }
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
                                  style={{ padding: "7px 10px", borderBottom: "1px solid #eee",
                                    cursor: (isSaving) ? "default" : (isPlacing && isEmpty) ? "pointer" : (!isPlacing && !isGenuinelyBlank) ? "pointer" : "default",
                                    background: isSaving ? "#f5f5f5" : (isPlacing && isEmpty) ? "#e8f0fe" : "transparent",
                                    border: (isPlacing && isEmpty && !isSaving) ? "1.5px solid #1a56db" : "none" }}>
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
                                  title="No spare expense slot - click to add a new row for this job"
                                  onClick={async () => {
                                    const toPlace = selectedInboxAppIds.size > 0
                                      ? outgoingsInbox.filter(e => selectedInboxAppIds.has(e.appId))
                                      : (outgoingsPlacingRef.current ? [outgoingsPlacingRef.current] : []);
                                    if (toPlace.length === 0) return;
                                    const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                    setDirectCostsSavingCell(savingKey);
                                    const placedIds = new Set(toPlace.map(e => e.appId));
                                    toPlace.forEach(exp => addAssignedAppId(exp.appId, outgoingsClient?.clientName));
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
                                    } catch(e) { console.error("assign_expense_to_job (new row) error:", e); }
                                    finally { setDirectCostsSavingCell(null); }
                                  }}
                                  style={{ cursor: "pointer", background: "#e8f0fe", border: "1.5px solid #1a56db",
                                    height: "100%", minHeight: "36px", display: "flex", alignItems: "center", justifyContent: "center",
                                    color: "#1a56db", fontWeight: "700", fontSize: "16px" }}>
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