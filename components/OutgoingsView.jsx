import React, { useState } from "react";
import Spinner from "./Spinner";
import OutgoingsEditModal from "./OutgoingsEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import OutgoingsEstimateModal from "./OutgoingsEstimateModal";
import OutgoingsNewVendorModal from "./OutgoingsNewVendorModal";
import { useOutgoings } from "../hooks/useOutgoings";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";

export default function OutgoingsView({
  allOutgoingsClients,
  styles
}) {
  const {
    automationCommanderSheetId, assignedAppIds, assignedByClient,
    setAssignedByClient, setAssignedAppIds, outgoingsPullPendingRef, addAssignedAppId
  } = useAppGlobals();
  const { clientsWithFlags } = useTriage();
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

  const [outgoingsReplacePrompt, setOutgoingsReplacePrompt] = useState(null); // { exp, contractor, colLetter, realBlocks, manualTotal, blocksToKeep }

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
          masterSheetId: outgoingsClient?.masterSheetId || "",
          sheetRow: contractor.sheetRow,
          colLetter,
          blocks: newBlocks,
        }),
      });
      if (outgoingsClient?.masterSheetId) {
        outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
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
        const { exp, contractor, colLetter, realBlocks, totalManual, blocksWithoutManual } = outgoingsReplacePrompt;
        const expenseAmount = parseFloat(exp.amount) || 0;
        const canUseUp = expenseAmount <= totalManual + 0.001;
        const doPlace = async (keepManual) => {
          setOutgoingsReplacePrompt(null);
          const base = keepManual ? realBlocks : blocksWithoutManual;
          const newBlock = { appId: exp.appId, amount: exp.amount, status: exp.status || "", recDate: exp.date || "", payDate: exp.datePaid || "", description: exp.description || exp.accountName || "" };
          await updateCell(contractor, colLetter, [...base, newBlock]);
          setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
          addAssignedAppId(exp.appId, outgoingsClient?.clientName);
          setOutgoingsPlacing(null);
        };
        const doUseUp = async () => {
          setOutgoingsReplacePrompt(null);
          const manualBlocksList = realBlocks.filter(b => b.appId && (b.appId.startsWith("MANUAL-ENTRY") || b.appId.startsWith("MANUAL-GAP")));
          const exactIdx = manualBlocksList.findIndex(mb => Math.abs((parseFloat(mb.amount) || 0) - expenseAmount) < 0.01);
          let reducedManualBlocks;
          if (exactIdx !== -1) {
            reducedManualBlocks = manualBlocksList.filter((_, i) => i !== exactIdx);
          } else {
            let remaining = expenseAmount;
            reducedManualBlocks = [];
            for (const mb of manualBlocksList) {
              const mbAmount = parseFloat(mb.amount) || 0;
              const used = Math.min(remaining, mbAmount);
              const newAmount = mbAmount - used;
              remaining -= used;
              if (newAmount > 0.004) reducedManualBlocks.push({ ...mb, amount: newAmount });
            }
          }
          const newBlock = { appId: exp.appId, amount: exp.amount, status: exp.status || "", recDate: exp.date || "", payDate: exp.datePaid || "", description: exp.description || exp.accountName || "" };
          await updateCell(contractor, colLetter, [...blocksWithoutManual, ...reducedManualBlocks, newBlock]);
          setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
          addAssignedAppId(exp.appId, outgoingsClient?.clientName);
          setOutgoingsPlacing(null);
        };
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "min(92vw, 460px)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
              <h3 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: "700" }}>Manual entry exists</h3>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#555" }}>
                This cell already contains a manual entry of <strong>£{totalManual.toFixed(2)}</strong>.<br/>
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

      {outgoingsPlacing && (
        <div style={{ background: "#1a56db", color: "#fff", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
          <span>Placing: <strong>{outgoingsPlacing.description || outgoingsPlacing.accountName}</strong> — £{(outgoingsPlacing.amount || 0).toLocaleString()} · Click a contractor cell to place it</span>
          <button onClick={() => setOutgoingsPlacing(null)}
            style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: "4px", padding: "4px 12px", cursor: "pointer", fontSize: "12px" }}>Cancel</button>
        </div>
      )}

      <div style={{ padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          {outgoingsClient && (
            <button onClick={() => { setOutgoingsData(null); setOutgoingsClient(null); setOutgoingsInbox([]); setOutgoingsPlacing(null); }}
              style={{ background: "none", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", padding: "4px 10px", fontSize: "16px", color: "#555", lineHeight: 1 }}
              title="Back to client list">&#8592;</button>
          )}
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: "700" }}>
            {outgoingsClient ? outgoingsClient.clientName : "Vendors"}
          </h2>
          {outgoingsClient && (
            <button className="triage-btn"
              onClick={() => {
                if (outgoingsClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${outgoingsClient.clientSheetId}/edit`, "_blank");
              }}
              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd", marginLeft: "auto" }}>
              📊 Open Sheets
            </button>
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
                  const clientsWithInbox = allClients.filter(c =>
                    clientsWithFlags?.some(f => f.clientName === c.clientName &&
                      (f.flags?.expenseDashboardDiscr || f.flags?.dirCompMismatch))
                  );
                  const clientsNoInbox = allClients.filter(c => !clientsWithInbox.includes(c));
                  const renderClientBtn = (c) => (
                    <button key={c.clientName} onClick={() => loadOutgoings(c)}
                      style={{ padding: "10px 16px", background: c.inboxCount > 0 ? "#fff7ed" : "#f8f9ff",
                        border: `1px solid ${c.inboxCount > 0 ? "#fed7aa" : "#dde"}`,
                        borderRadius: "8px", cursor: "pointer", textAlign: "left", fontSize: "14px", fontWeight: "500",
                        display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>{c.clientName}</span>
                      {c.inboxCount > 0 && <span style={{ fontSize: "11px", background: "#f97316", color: "#fff", borderRadius: "10px", padding: "1px 7px" }}>{c.inboxCount} to assign</span>}
                    </button>
                  );
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
                      {allClients.length === 0 && <p style={{ color: "#999", fontSize: "13px" }}>No clients loaded yet — go to Home and refresh first.</p>}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {!noClient && (
          <div style={{ background: "#fff", border: `1px solid ${outgoingsInbox.length > 0 ? "#ffc107" : "#e0e0e0"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: "700", color: outgoingsInbox.length > 0 ? "#e65100" : "#888", marginBottom: outgoingsInbox.length > 0 ? "6px" : "0" }}>
              {outgoingsInbox.length > 0
                ? `Unmatched expenses (${outgoingsInbox.length}) — click to select, then click a cell to place`
                : "No unmatched expenses — inbox is clear ✓"}
            </div>
            {outgoingsInbox.length > 0 && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {outgoingsInbox.map((exp, i) => {
                    const isPlacing = outgoingsPlacing?.appId === exp.appId;
                    return (
                      <div key={i} style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
                      <div
                        onClick={() => {
                          setOutgoingsPlacing(outgoingsPlacingRef.current?.appId === exp.appId ? null : exp);
                        }}
                        style={{ background: isPlacing ? "#1a56db" : "#fff8e1", border: `1.5px solid ${isPlacing ? "#1a56db" : "#ffc107"}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px", cursor: "pointer", textAlign: "left", color: isPlacing ? "#fff" : "#333", transition: "background 0.1s, border-color 0.1s", display: "flex", flexDirection: "column", gap: "2px", userSelect: "none" }}>
                        <div style={{ fontWeight: "700" }}>{exp.description || exp.accountName}</div>
                        <div style={{ opacity: 0.8 }}>£{(exp.amount || 0).toLocaleString("en-GB", { minimumFractionDigits: 2 })} · {exp.date}</div>
                        <div style={{ fontSize: "10px", opacity: 0.7 }}>{isPlacing ? "Click a cell below to place" : "Click to select"}</div>
                      </div>
                      {vendorsSubTab === "contractors" && (
                        <button onClick={e => { e.stopPropagation(); setOutgoingsNewVendor({ exp }); }}
                          title="Create new vendor row for this expense"
                          style={{ fontSize: "10px", padding: "2px 8px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", color: "#555", whiteSpace: "nowrap" }}>
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
                Contractors
              </button>
              <button onClick={() => {
                  setVendorsSubTab("directCosts");
                  if (!directCostsJobs) loadDirectCostsJobs(outgoingsClient, false);
                }}
                style={{ padding: "8px 16px", background: "none", border: "none",
                  borderBottom: vendorsSubTab === "directCosts" ? "2px solid #0066cc" : "2px solid transparent",
                  color: vendorsSubTab === "directCosts" ? "#0066cc" : "#666",
                  fontWeight: vendorsSubTab === "directCosts" ? "700" : "500", fontSize: "14px", cursor: "pointer" }}>
                Direct costs
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
                        const isTarget = !!outgoingsPlacing;
                        const isCurr = isCurrentMonth(m.isoMonth || m.label);

                        const handleCellClick = async () => {
                          if (outgoingsPlacingRef.current) {
                            const exp = outgoingsPlacingRef.current;
                            const expDesc = (exp.description || exp.accountName || "").toLowerCase();
                            const contrWords = contractor.name.toLowerCase().replace(/[()]/g, " ").split(/\s+/).filter(w => w.length > 3);
                            const nameMatch = contrWords.some(w => expDesc.includes(w));
                            if (!nameMatch) {
                              const ok = window.confirm("Vendor mismatch?\n\nExpense: \"" + (exp.description || exp.accountName) + "\"\nContractor: \"" + contractor.name + "\"\n\nPlace anyway?");
                              if (!ok) return;
                            }
                            const manualBlocks = realBlocks.filter(b => b.appId && (b.appId.startsWith("MANUAL-ENTRY") || b.appId.startsWith("MANUAL-GAP")));
                            if (manualBlocks.length > 0) {
                              const totalManual = manualBlocks.reduce((s, b) => s + (parseFloat(b.amount) || 0), 0);
                              setOutgoingsReplacePrompt({
                                exp, contractor, colLetter: m.colLetter, realBlocks, totalManual,
                                blocksWithoutManual: realBlocks.filter(b => !b.appId || !(b.appId.startsWith("MANUAL-ENTRY") || b.appId.startsWith("MANUAL-GAP"))),
                              });
                              return;
                            }
                            const newBlock = { appId: exp.appId, amount: exp.amount, status: exp.status || "", recDate: exp.date || "", payDate: exp.datePaid || "", description: exp.description || exp.accountName || "" };
                            await updateCell(contractor, m.colLetter, [...realBlocks, newBlock]);
                            setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                            addAssignedAppId(exp.appId, outgoingsClient?.clientName);
                            setOutgoingsPlacing(null);
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
                                        !b.appId.startsWith("MANUAL-ENTRY") && !b.appId.startsWith("UNRECON-GAP") &&
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
                          const isReal = slot.transactionId && !String(slot.transactionId).toUpperCase().includes("MANUAL-ENTRY") && !String(slot.transactionId).toUpperCase().includes("UNRECON-GAP");
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
                            const isManualEntry = String(s.transactionId || "").toUpperCase().includes("MANUAL-ENTRY");
                            const isGenuinelyBlank = !s.description && !s.amount;
                            const isEmpty = isGenuinelyBlank || isManualEntry;
                            const isPlacing = !!outgoingsPlacing;
                            const cellSavingKey = `${jr.rowNum}-${s.slotNum}`;
                            const isSaving = directCostsSavingCell === cellSavingKey;
                            return (
                              <td key={s.slotNum}
                                onClick={async () => {
                                  if (isSaving) return;
                                  if (isPlacing && isEmpty) {
                                    const exp = outgoingsPlacingRef.current;
                                    if (!exp) return;
                                    setOutgoingsPlacing(null);
                                    setDirectCostsSavingCell(cellSavingKey);
                                    addAssignedAppId(exp.appId, outgoingsClient?.clientName);
                                    setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                                    try {
                                      await fetch("/api/triage", {
                                        method: "POST", headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          action: "assign_expense_to_job",
                                          clientSheetId: outgoingsClient?.clientSheetId,
                                          masterSheetId: outgoingsClient?.masterSheetId || "",
                                          rowNum: jr.rowNum, slotNum: s.slotNum, expense: exp,
                                        }),
                                      });
                                      if (outgoingsClient?.masterSheetId) {
                                        outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
                                      }
                                      setDirectCostsJobs(prev => prev && prev.map(j => ({
                                        ...j,
                                        rows: j.rows.map(r => r.rowNum !== jr.rowNum ? r : {
                                          ...r,
                                          expenseSlots: r.expenseSlots.map(sl => sl.slotNum !== s.slotNum ? sl : {
                                            ...sl,
                                            description: exp.description || exp.accountName || "",
                                            amount: exp.amount || 0,
                                            date: exp.date || "",
                                            status: exp.status || "",
                                            transactionId: exp.appId || "",
                                          }),
                                        }),
                                      })));
                                    } catch(e) { console.error("assign_expense_to_job error:", e); }
                                    finally { setDirectCostsSavingCell(null); }
                                  } else if (!isPlacing && !isGenuinelyBlank) {
                                    setDirectCostsEditSlot({ rowNum: jr.rowNum, slotNum: s.slotNum, slot: s });
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
                                  isPlacing ? <span style={{ color: "#1a56db", fontWeight: "700" }}>Click to place</span> : <span style={{ color: "#ccc" }}>—</span>
                                ) : (
                                  <div>
                                    <div style={{ fontWeight: "600", color: isManualEntry ? "#9333ea" : "inherit" }}>
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
                            ) : isLastRowOfJob && !jobHasEmptySlot && !!outgoingsPlacing && (
                              <div
                                title="No spare expense slot — click to add a new row for this job"
                                onClick={async () => {
                                  const exp = outgoingsPlacingRef.current;
                                  if (!exp) return;
                                  setOutgoingsPlacing(null);
                                  const savingKey = `newrow-${job.client}|||${job.jobName}`;
                                  setDirectCostsSavingCell(savingKey);
                                  addAssignedAppId(exp.appId, outgoingsClient?.clientName);
                                  setOutgoingsInbox(prev => prev.filter(e => e.appId !== exp.appId));
                                  try {
                                    await fetch("/api/triage", {
                                      method: "POST", headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({
                                        action: "assign_expense_to_job",
                                        clientSheetId: outgoingsClient?.clientSheetId,
                                        masterSheetId: outgoingsClient?.masterSheetId || "",
                                        createNewRow: true,
                                        jobLastRow, jobClient: job.client, jobName: job.jobName,
                                        expense: exp,
                                      }),
                                    });
                                    if (outgoingsClient?.masterSheetId) {
                                      outgoingsPullPendingRef.current = outgoingsClient.masterSheetId;
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
                {!directCostsShowAll && (
                  <div style={{ textAlign: "center", marginTop: "14px" }}>
                    <button onClick={() => { setDirectCostsShowAll(true); loadDirectCostsJobs(outgoingsClient, true); }}
                      style={{ padding: "8px 20px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                      Show all jobs
                    </button>
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