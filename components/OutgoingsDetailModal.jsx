import React, { useState, useEffect, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { formatCurrency, JobDateInput, toSheetDateFormat } from "./JobsView";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { stripRowInfo, isPlaceholderExpense, parseSheetDate } from "../utils/helpers";

export default function OutgoingsDetailModal({
  isOpen,
  target,
  onClose,
  onDeleted,
  isAdmin = false
}) {
  const { allClientsMap } = useAppGlobals();
  const [description, setDescription] = useState("");
  const [amountVal, setAmountVal] = useState("");
  const [recDateVal, setRecDateVal] = useState("");
  const [payDateVal, setPayDateVal] = useState("");
  const [appIdVal, setAppIdVal] = useState("UNRECON-GAP");
  const [resolvedColLetter, setResolvedColLetter] = useState("");
  const [resolvedSheetRow, setResolvedSheetRow] = useState(null);
  const [existingBlocks, setExistingBlocks] = useState([]);
  const [loadingCellData, setLoadingCellData] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletedSuccess, setDeletedSuccess] = useState(false);
  const [userEdited, setUserEdited] = useState(false);
  const userEditedRef = useRef(false);

  const resolvedClientInfo = useMemo(() => {
    let client = (target?.client && typeof target.client === "object") ? { ...target.client } : {};
    let clientSheetId =
      target?.clientSheetId ||
      client?.clientSheetId ||
      client?.sheetId ||
      client?.client_sheet_id ||
      null;

    const candidateNames = [
      target?.clientName,
      client?.clientName,
      client?.name
    ].filter(Boolean);

    if (!clientSheetId && allClientsMap && Object.keys(allClientsMap).length > 0) {
      for (const name of candidateNames) {
        const trimmed = String(name).trim();
        if (allClientsMap[trimmed]) {
          const matched = allClientsMap[trimmed];
          clientSheetId = matched.clientSheetId || matched.sheetId || null;
          client = { ...(matched || {}), ...(client || {}), clientSheetId, clientName: trimmed };
          break;
        }
        const lower = trimmed.toLowerCase();
        const foundKey = Object.keys(allClientsMap).find((k) => k.toLowerCase() === lower);
        if (foundKey && allClientsMap[foundKey]) {
          const matched = allClientsMap[foundKey];
          clientSheetId = matched.clientSheetId || matched.sheetId || null;
          client = { ...(matched || {}), ...(client || {}), clientSheetId, clientName: foundKey };
          break;
        }
      }
    } else if (clientSheetId) {
      client.clientSheetId = clientSheetId;
      if (!client.clientName && target?.clientName) {
        client.clientName = target.clientName;
      }
      if (!client.masterSheetId && target?.clientName && allClientsMap?.[target.clientName]) {
        client.masterSheetId = allClientsMap[target.clientName].masterSheetId;
      }
    }

    return { client, clientSheetId };
  }, [target, allClientsMap]);

  useEffect(() => {
    if (!isOpen || !target) {
      setDescription("");
      setAmountVal("");
      setRecDateVal("");
      setPayDateVal("");
      setAppIdVal("UNRECON-GAP");
      setResolvedColLetter("");
      setResolvedSheetRow(null);
      setExistingBlocks([]);
      setLoadingCellData(false);
      setSavedSuccess(false);
      setConfirmingDelete(false);
      setDeleting(false);
      setDeletedSuccess(false);
      setUserEdited(false);
      userEditedRef.current = false;
      return;
    }

    const initDesc = target.description || target.contractor || "";
    const rawAmt = target.amount ? String(target.amount).replace(/^[£$€]\s*/, "").trim() : "";
    const initRec = target.recDate || "";
    const initPay = target.payDate || "";
    const initAppId = target.appId || "UNRECON-GAP";

    setDescription(initDesc);
    setAmountVal(rawAmt);
    setRecDateVal(initRec);
    setPayDateVal(initPay);
    setAppIdVal(initAppId);
    setSavedSuccess(false);
    setConfirmingDelete(false);
    setDeleting(false);
    setDeletedSuccess(false);
    setUserEdited(false);
    userEditedRef.current = false;

    // Initial column & row determination
    let col = "";
    let row = target.rowNum ? parseInt(target.rowNum, 10) : null;
    if (target.cellCoord) {
      const match = String(target.cellCoord).match(/^([A-Za-z]+)(\d+)$/);
      if (match) {
        col = match[1].toUpperCase();
        row = parseInt(match[2], 10);
      }
    }
    setResolvedColLetter(col);
    setResolvedSheetRow(row);
  }, [isOpen, target]);

  // Hydrate cell information (column letter, existing note blocks, dates) from Outgoings sheet
  useEffect(() => {
    if (!isOpen || !target || !resolvedClientInfo.clientSheetId) return;

    let cancelled = false;

    const computeDefaultDatesForMonth = (monthObjOrStr, invTimingStr = "Curr", payTimingStr = "Curr") => {
      const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      let baseDate = null;
      if (monthObjOrStr && typeof monthObjOrStr === "object" && monthObjOrStr.isoMonth) {
        baseDate = parseSheetDate(`${monthObjOrStr.isoMonth}-01`);
      }
      if (!baseDate && monthObjOrStr) {
        const rawStr = typeof monthObjOrStr === "object" ? (monthObjOrStr.label || "") : String(monthObjOrStr);
        baseDate = parseSheetDate(rawStr.replace(/sept/i, "Sep"));
      }
      if (!baseDate) return { rec: "", pay: "" };

      const yr = baseDate.getFullYear();
      const mIdx = baseDate.getMonth();
      const today = new Date();
      const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

      const recDate = new Date(yr, mIdx, 1);
      if (String(invTimingStr || "Curr").trim().toLowerCase().includes("next")) {
        recDate.setMonth(recDate.getMonth() + 1);
      }
      recDate.setDate(5);
      if (recDate < currentMonthStart) {
        recDate.setFullYear(today.getFullYear(), today.getMonth(), 5);
      }

      const payDate = new Date(yr, mIdx, 1);
      if (String(payTimingStr || "Curr").trim().toLowerCase().includes("next")) {
        payDate.setMonth(payDate.getMonth() + 1);
      }
      payDate.setDate(28);
      if (payDate < currentMonthStart) {
        const targetPayMonth = today.getDate() > 20 ? today.getMonth() + 1 : today.getMonth();
        payDate.setFullYear(today.getFullYear(), targetPayMonth, 28);
      }

      const fmt = (d) => `${d.getDate()}-${mNames[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
      return { rec: fmt(recDate), pay: fmt(payDate) };
    };

    const hydrateFromSheet = async () => {
      setLoadingCellData(true);
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_outgoings",
            clientSheetId: resolvedClientInfo.clientSheetId,
            bypassCache: true
          })
        });
        const data = await res.json();
        if (cancelled || !data.success) return;

        const months = data.months || [];
        const allRows = [...(data.contractors || []), ...(data.extraOutgoingsRows || [])];

        // 1. Resolve column letter from cellCoord or month
        let col = "";
        let initialRow = target.rowNum ? parseInt(target.rowNum, 10) : null;
        if (target.cellCoord) {
          const match = String(target.cellCoord).match(/^([A-Za-z]+)(\d+)$/);
          if (match) {
            col = match[1].toUpperCase();
            initialRow = parseInt(match[2], 10);
          }
        }

        let matchedMonth = null;
        if (col) {
          matchedMonth = months.find(m => m.colLetter === col) || null;
        }
        if (!col && target.month && months.length > 0) {
          const parsedTargetDate = parseSheetDate(String(target.month).replace(/sept/i, "Sep"));
          const targetIsoMonth = parsedTargetDate
            ? `${parsedTargetDate.getFullYear()}-${String(parsedTargetDate.getMonth() + 1).padStart(2, "0")}`
            : "";
          const cleanTargetMonth = String(target.month).replace(/sept/gi, "sep").replace(/[-_,\s]/g, "").toLowerCase();
          matchedMonth = months.find(m => {
            if (targetIsoMonth && m.isoMonth === targetIsoMonth) return true;
            const cleanLabel = String(m.label || "").replace(/sept/gi, "sep").replace(/[-_,\s]/g, "").toLowerCase();
            const cleanIso = String(m.isoMonth || "").replace(/[-_,\s]/g, "").toLowerCase();
            return cleanLabel === cleanTargetMonth || cleanIso === cleanTargetMonth ||
              cleanLabel.includes(cleanTargetMonth) || cleanTargetMonth.includes(cleanLabel);
          });
          if (matchedMonth) {
            col = matchedMonth.colLetter;
            setResolvedColLetter(col);
          }
        }

        // 2. Resolve contractor / outgoings row
        const targetContractor = String(target.contractor || "").trim().toLowerCase();

        let matchedContractor = null;
        if (initialRow) {
          matchedContractor = allRows.find(c => c.sheetRow === initialRow);
        }
        if (!matchedContractor && targetContractor) {
          matchedContractor = allRows.find(c => {
            const cName = String(c.name || "").trim().toLowerCase();
            return cName === targetContractor;
          }) || allRows.find(c => {
            const cName = String(c.name || "").trim().toLowerCase();
            return cName.includes(targetContractor) || targetContractor.includes(cName);
          });
        }

        const targetAppId = target.appId;
        const targetAmountNum = parseFloat(String(target.amount || "").replace(/[£$€,\s]/g, ""));

        if (matchedContractor) {
          setResolvedSheetRow(matchedContractor.sheetRow);

          // If col was not resolved yet, search cells in matchedContractor for a matching block
          if (!col && matchedContractor.cells) {
            for (const [cLetter, cInfo] of Object.entries(matchedContractor.cells)) {
              const cBlocks = cInfo?.blocks || [];
              if (cBlocks.length === 0) continue;
              const hasMatch = cBlocks.some(b => {
                if (targetAppId && targetAppId !== "UNRECON-GAP" && b.appId === targetAppId) return true;
                if (!isNaN(targetAmountNum) && targetAmountNum > 0 && Math.abs((parseFloat(b.amount) || 0) - targetAmountNum) < 0.05) return true;
                return false;
              });
              if (hasMatch) {
                col = cLetter;
                matchedMonth = months.find(m => m.colLetter === col) || null;
                setResolvedColLetter(col);
                break;
              }
            }
          }

          // 3. Inspect cell in contractor row
          const estDefaults = computeDefaultDatesForMonth(
            matchedMonth || target.month,
            matchedContractor.invTiming || "Curr",
            matchedContractor.payTiming || "Curr"
          );

          if (col && matchedContractor.cells && matchedContractor.cells[col]) {
            const cellInfo = matchedContractor.cells[col];
            const blocks = cellInfo.blocks || [];
            setExistingBlocks(blocks);

            // Find matching block
            let matchedBlock = null;
            if (targetAppId && targetAppId !== "UNRECON-GAP") {
              matchedBlock = blocks.find(b => b.appId === targetAppId);
            }
            if (!matchedBlock && !isNaN(targetAmountNum) && targetAmountNum > 0) {
              matchedBlock = blocks.find(b => Math.abs((parseFloat(b.amount) || 0) - targetAmountNum) < 0.05);
            }
            if (!matchedBlock && blocks.length > 0) {
              matchedBlock = blocks[0];
            }

            if (matchedBlock) {
              if (matchedBlock.appId) setAppIdVal(matchedBlock.appId);
              if (!userEditedRef.current) {
                if (matchedBlock.description) setDescription(matchedBlock.description);
                if (matchedBlock.amount) {
                  setAmountVal(String(matchedBlock.amount));
                }
                const resolvedRec = matchedBlock.recDate || target.recDate || estDefaults.rec;
                const resolvedPay = matchedBlock.payDate || target.payDate || estDefaults.pay;
                if (resolvedRec) setRecDateVal(resolvedRec);
                if (resolvedPay) setPayDateVal(resolvedPay);
              }
            } else if (!userEditedRef.current) {
              if (cellInfo.value) {
                const parsedVal = parseFloat(String(cellInfo.value).replace(/[£$€,\s]/g, ""));
                if (!isNaN(parsedVal) && parsedVal > 0) setAmountVal(String(parsedVal));
              }
              const resolvedRec = target.recDate || estDefaults.rec;
              const resolvedPay = target.payDate || estDefaults.pay;
              if (resolvedRec) setRecDateVal(resolvedRec);
              if (resolvedPay) setPayDateVal(resolvedPay);
            }
          } else if (!userEditedRef.current) {
            const resolvedRec = target.recDate || estDefaults.rec;
            const resolvedPay = target.payDate || estDefaults.pay;
            if (resolvedRec) setRecDateVal(resolvedRec);
            if (resolvedPay) setPayDateVal(resolvedPay);
          }
        } else if (!userEditedRef.current) {
          const estDefaults = computeDefaultDatesForMonth(matchedMonth || target.month, "Curr", "Curr");
          if (!target.recDate && estDefaults.rec) setRecDateVal(estDefaults.rec);
          if (!target.payDate && estDefaults.pay) setPayDateVal(estDefaults.pay);
        }
      } catch (err) {
        console.error("Failed to hydrate outgoings cell data:", err);
      } finally {
        if (!cancelled) setLoadingCellData(false);
      }
    };

    hydrateFromSheet();

    return () => {
      cancelled = true;
    };
  }, [isOpen, target, resolvedClientInfo.clientSheetId]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !target) return null;

  const colLetter = resolvedColLetter;
  const sheetRow = resolvedSheetRow || (target.rowNum ? parseInt(target.rowNum, 10) : null);
  const cellCoordDisplay = colLetter && sheetRow ? `Cell ${colLetter}${sheetRow}` : (target.cellCoord || (sheetRow ? `Row ${sheetRow}` : ""));

  const canSave = Boolean(resolvedClientInfo.clientSheetId && colLetter && sheetRow);

  const handleSaveOutgoings = async () => {
    if (!canSave) return;
    setSaving(true);
    setSavedSuccess(false);

    try {
      const parsedAmount = parseFloat(String(amountVal).replace(/[£$€,\s]/g, "")) || 0;
      const formattedRec = recDateVal ? toSheetDateFormat(recDateVal) : "";
      const formattedPay = payDateVal ? toSheetDateFormat(payDateVal) : "";

      let blocks;
      if (existingBlocks && existingBlocks.length > 0) {
        const curAppId = appIdVal || target.appId;
        let matchIdx = existingBlocks.findIndex(b => curAppId && curAppId !== "UNRECON-GAP" && b.appId === curAppId);
        if (matchIdx < 0 && parsedAmount > 0) {
          matchIdx = existingBlocks.findIndex(b => Math.abs((parseFloat(b.amount) || 0) - parsedAmount) < 0.05);
        }
        const idxToUpdate = matchIdx >= 0 ? matchIdx : 0;
        blocks = existingBlocks.map((b, i) => {
          if (i === idxToUpdate) {
            return {
              ...b,
              appId: b.appId || curAppId || "UNRECON-GAP",
              amount: parsedAmount,
              description: description.trim() || target.contractor || "Expense",
              recDate: formattedRec,
              payDate: formattedPay,
              status: b.status || "pending"
            };
          }
          return b;
        });
      } else {
        blocks = [
          {
            appId: appIdVal || target.appId || "UNRECON-GAP",
            amount: parsedAmount,
            description: description.trim() || target.contractor || "Expense",
            recDate: formattedRec,
            payDate: formattedPay,
            status: "pending"
          }
        ];
      }

      const newCellTotal = blocks
        .filter(b => !String(b.appId || "").startsWith("UNRECON-GAP"))
        .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId: resolvedClientInfo.clientSheetId,
          clientName: resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName || "",
          contractorName: target.contractor || description,
          masterSheetId: resolvedClientInfo.client?.masterSheetId || target.client?.masterSheetId || "",
          cellRef: `${colLetter}${sheetRow}`,
          colLetter,
          sheetRow,
          cellTotal: newCellTotal,
          blocks
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update outgoings entry");

      setExistingBlocks(blocks);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3500);
    } catch (err) {
      alert("Error saving outgoings entry: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOutgoings = async () => {
    if (!canSave) return;
    setDeleting(true);
    setSavedSuccess(false);

    try {
      const parsedAmount = parseFloat(String(amountVal).replace(/[£$€,\s]/g, "")) || 0;
      let updatedBlocks = [];
      if (existingBlocks && existingBlocks.length > 0) {
        const curAppId = appIdVal || target.appId;
        let matchIdx = existingBlocks.findIndex(b => curAppId && curAppId !== "UNRECON-GAP" && b.appId === curAppId);
        if (matchIdx < 0 && parsedAmount > 0) {
          matchIdx = existingBlocks.findIndex(b => Math.abs((parseFloat(b.amount) || 0) - parsedAmount) < 0.05);
        }
        if (matchIdx < 0) matchIdx = 0;
        updatedBlocks = existingBlocks.filter((_, i) => i !== matchIdx);
      }

      const newCellTotal = updatedBlocks
        .filter(b => !String(b.appId || "").startsWith("UNRECON-GAP"))
        .reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_outgoing_note",
          clientSheetId: resolvedClientInfo.clientSheetId,
          clientName: resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName || "",
          contractorName: target.contractor || description,
          masterSheetId: resolvedClientInfo.client?.masterSheetId || target.client?.masterSheetId || "",
          cellRef: `${colLetter}${sheetRow}`,
          colLetter,
          sheetRow,
          cellTotal: newCellTotal,
          blocks: updatedBlocks,
          ...(updatedBlocks.length === 0 ? { topNote: "" } : {})
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to delete outgoings entry");

      setExistingBlocks(updatedBlocks);
      setConfirmingDelete(false);
      setDeletedSuccess(true);
      onDeleted?.(target);
      setTimeout(() => {
        onClose();
      }, 600);
    } catch (err) {
      alert("Error deleting outgoings entry: " + err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.65)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "min(94vw, 680px)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
          overflow: "hidden"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #e2e8f0",
            background: "#ffffff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "10px",
                  fontSize: "11px",
                  fontWeight: "700",
                  background: "#fef3c7",
                  color: "#92400e",
                  border: "1px solid #fde68a"
                }}
              >
                {isAdmin ? "Outgoings contractor" : "Contractor"}
              </span>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                {target.contractor || "Contractor / Overhead Expense"}
              </h2>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>
                {isAdmin ? (
                  <>
                    Outgoings tab{target.month ? ` · ${target.month}` : ""}{cellCoordDisplay ? ` · ${cellCoordDisplay}` : ""}
                    {resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName ? ` (${resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName})` : ""}
                  </>
                ) : (
                  <>
                    {target.month || "Expense"}
                    {resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName ? ` (${resolvedClientInfo.client?.clientName || target.client?.clientName || target.clientName})` : ""}
                  </>
                )}
              </span>
              {loadingCellData && (
                <span style={{ color: "#0284c7", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <Spinner size={10} color="#0284c7" /> {isAdmin ? "Loading cell details…" : "Loading expense details…"}
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: "#f1f5f9",
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              padding: "6px 14px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#475569",
              cursor: "pointer"
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Overdue / Alert notice */}
          {target.weeksAgo && (
            <div
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: "8px",
                padding: "12px 14px",
                display: "flex",
                alignItems: "flex-start",
                gap: "10px"
              }}
            >
              <span style={{ fontSize: "18px" }}>⚠️</span>
              <div style={{ fontSize: "13px", color: "#92400e", lineHeight: "1.4" }}>
                <strong>Stale UNRECON-GAP expense overdue</strong>
                <div>
                  This gap expense has received date <strong>{target.recDate || "overdue"}</strong> ({target.weeksAgo} weeks ago — more than 6 weeks overdue without reconciliation).
                </div>
              </div>
            </div>
          )}

          {target.changes && target.changes.length > 0 && (
            <div
              style={{
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: "8px",
                padding: "12px 14px"
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: "700", color: "#0369a1", marginBottom: "6px" }}>
                Date changes
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {target.changes.map((ch, idx) => (
                  <span
                    key={idx}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: "600",
                      background: "#ffffff",
                      color: "#0369a1",
                      border: "1px solid #bae6fd"
                    }}
                  >
                    {ch.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Details Overview Card */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "16px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.04em", color: "#64748b", marginBottom: "12px" }}>
              Expense details
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Contractor / description
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setUserEdited(true);
                    userEditedRef.current = true;
                  }}
                  style={{
                    width: "100%", padding: "6px 8px", borderRadius: "5px",
                    border: "1px solid #cbd5e1", fontSize: "13px", fontWeight: "500",
                    outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Amount
                </label>
                <input
                  type="text"
                  value={amountVal}
                  onChange={(e) => {
                    setAmountVal(e.target.value);
                    setUserEdited(true);
                    userEditedRef.current = true;
                  }}
                  placeholder="0.00"
                  style={{
                    width: "100%", padding: "6px 8px", borderRadius: "5px",
                    border: "1px solid #cbd5e1", fontSize: "13px", fontWeight: "600",
                    outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Received date
                </label>
                <JobDateInput
                  value={recDateVal}
                  onChange={(val) => {
                    setRecDateVal(val);
                    setUserEdited(true);
                    userEditedRef.current = true;
                  }}
                  defaultBorder="1px solid #cbd5e1"
                  defaultBg="#ffffff"
                  style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                  Pay date
                </label>
                <JobDateInput
                  value={payDateVal}
                  onChange={(val) => {
                    setPayDateVal(val);
                    setUserEdited(true);
                    userEditedRef.current = true;
                  }}
                  defaultBorder="1px solid #cbd5e1"
                  defaultBg="#ffffff"
                  style={{ width: "100%", padding: "6px 8px", boxSizing: "border-box" }}
                />
              </div>
            </div>

            {(appIdVal || target.appId) && (
              <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid #f1f5f9", fontSize: "11px", color: "#64748b" }}>
                <strong>App ID:</strong>{" "}
                <span style={{ fontFamily: isPlaceholderExpense(appIdVal || target.appId) ? "inherit" : "monospace", color: isPlaceholderExpense(appIdVal || target.appId) ? "#6b21a8" : "#334155", fontWeight: isPlaceholderExpense(appIdVal || target.appId) ? 600 : "normal" }}>
                  {isPlaceholderExpense(appIdVal || target.appId) ? "Placeholder - auto" : (appIdVal || target.appId)}
                </span>
              </div>
            )}

            {target.rawText && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#64748b" }}>
                <strong>Alert log entry:</strong>{" "}
                {(() => {
                  const cleaned = String(target.rawText).replace(/\s*[-–]\s*$/, "").trim();
                  return isAdmin ? cleaned : stripRowInfo(cleaned);
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px"
          }}
        >
          <div>
            {deletedSuccess ? (
              <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: "700" }}>
                ✓ Expense deleted
              </span>
            ) : savedSuccess ? (
              <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: "700" }}>
                {isAdmin ? "✓ Outgoings cell updated successfully" : "✓ Expense updated successfully"}
              </span>
            ) : (
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                {canSave
                  ? (isAdmin ? "Edit fields above and click Save to update Outgoings sheet" : "Edit fields above and click Save to update expense")
                  : "Viewing expense record"}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            {isAdmin && resolvedClientInfo.clientSheetId && (
              <button
                type="button"
                onClick={() => {
                  window.open(`https://docs.google.com/spreadsheets/d/${resolvedClientInfo.clientSheetId}/edit`, "_blank");
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #93c5fd",
                  background: "#ffffff",
                  color: "#1d4ed8",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Open Outgoings sheet
              </button>
            )}

            {canSave && (
              confirmingDelete ? (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={handleDeleteOutgoings}
                    disabled={deleting || saving}
                    style={{
                      padding: "6px 14px",
                      borderRadius: "6px",
                      border: "none",
                      background: "#dc2626",
                      color: "#ffffff",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: deleting ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px"
                    }}
                  >
                    {deleting ? <><Spinner size={12} color="#ffffff" /> Deleting...</> : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#475569",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving || deleting}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "6px",
                    border: "1px solid #fecaca",
                    background: "#fef2f2",
                    color: "#dc2626",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  Delete expense
                </button>
              )
            )}

            {canSave && (
              <button
                type="button"
                onClick={handleSaveOutgoings}
                disabled={saving || deleting}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: saving ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                {saving ? <><Spinner size={12} color="#ffffff" /> Saving...</> : "Save expense"}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#334155",
                fontSize: "12px",
                fontWeight: "600",
                cursor: "pointer"
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
