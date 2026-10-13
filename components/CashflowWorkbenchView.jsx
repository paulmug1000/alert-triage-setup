import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import Spinner from "./Spinner";

export const VALID_RECON_CATEGORIES = [
  "Revenue",
  "Outgoings",
  "Contractors",
  "Direct costs",
  "Dividends",
  "Salaries",
  "PAYE",
  "Pension",
  "Transfer",
  "Corp tax",
  "VAT",
  "Other"
];

const CATEGORY_COLORS = {
  Revenue: { bg: "#dcfce7", color: "#166534", border: "#86efac" },
  Contractors: { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
  "Direct costs": { bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
  Salaries: { bg: "#f3e8ff", color: "#6b21a8", border: "#d8b4fe" },
  PAYE: { bg: "#ede9fe", color: "#5b21b6", border: "#c4b5fd" },
  Pension: { bg: "#e0e7ff", color: "#3730a3", border: "#a5b4fc" },
  Dividends: { bg: "#fae8ff", color: "#86198f", border: "#f0abfc" },
  Outgoings: { bg: "#f1f5f9", color: "#334155", border: "#cbd5e1" },
  Transfer: { bg: "#e2e8f0", color: "#475569", border: "#94a3b8" },
  "Corp tax": { bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  VAT: { bg: "#ffedd5", color: "#9a3412", border: "#fdba74" },
};

export function formatGBP(val) {
  if (val == null || val === "" || isNaN(Number(val))) return "£0.00";
  const num = Number(val);
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatAmountGBP(val, isNegative = false) {
  if (val == null || val === "") return "";
  const s = String(val).trim();
  const clean = s.replace(/[£,\s]/g, "");
  const num = parseFloat(clean);
  if (isNaN(num)) return s;
  const isNeg = num < 0 || isNegative || s.startsWith("-") || s.includes("-");
  const abs = Math.abs(num).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return isNeg ? `-£${abs}` : `£${abs}`;
}

/**
 * Pairs bank transactions with Pulse items based on spreadsheet row cross-references
 * or heuristic amount matches, separating cleanly into matched pairs and unmatched lists.
 */
export function buildAlignedComparison(bankItems = [], pulseItems = []) {
  const isErr = (val) => {
    if (val == null) return false;
    const s = String(val).trim();
    return s.startsWith("#") || s === "—";
  };

  // Filter out any invalid / formula error items
  const cleanBank = (bankItems || []).filter(b => {
    if (!b) return false;
    return !isErr(b.date) && !isErr(b.payee) && !isErr(b.inAmt) && !isErr(b.outAmt) && !isErr(b.amount);
  });

  const cleanPulse = (pulseItems || []).filter(p => {
    if (!p) return false;
    return !isErr(p.client) && !isErr(p.amount) && !isErr(p.job);
  });

  const matchedPairs = [];
  const usedBankIndices = new Set();
  const usedPulseIndices = new Set();

  const extractRowNumber = (val) => {
    if (!val || isErr(val)) return null;
    const m = String(val).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  // 1. Match by explicit row number reference (from Google Sheet formulas)
  cleanBank.forEach((b, bIdx) => {
    const targetPulseRow = extractRowNumber(b.matched);
    if (targetPulseRow != null) {
      const pIdx = cleanPulse.findIndex((p, idx) => !usedPulseIndices.has(idx) && p.rowNum === targetPulseRow);
      if (pIdx !== -1) {
        matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx] });
        usedBankIndices.add(bIdx);
        usedPulseIndices.add(pIdx);
      }
    }
  });

  // 2. Pulse items referencing bank rows
  cleanPulse.forEach((p, pIdx) => {
    if (usedPulseIndices.has(pIdx)) return;
    const targetBankRow = extractRowNumber(p.matchedRow || (p.matched !== "Matched" && p.matched !== "No Match" ? p.matched : null));
    if (targetBankRow != null) {
      const bIdx = cleanBank.findIndex((b, idx) => !usedBankIndices.has(idx) && b.rowNum === targetBankRow);
      if (bIdx !== -1) {
        matchedPairs.push({ bank: cleanBank[bIdx], pulse: p });
        usedBankIndices.add(bIdx);
        usedPulseIndices.add(pIdx);
      }
    }
  });

  // 3. Fallback heuristic match for items where amounts align exactly
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseFloat(String(b.inAmt || b.outAmt || b.amount || "0").replace(/[£,\s]/g, "")) || 0;
    if (bAmt <= 0) return;
    const pIdx = cleanPulse.findIndex((p, idx) => {
      if (usedPulseIndices.has(idx)) return false;
      const pAmt = parseFloat(String(p.amount || "0").replace(/[£,\s]/g, "")) || 0;
      if (pAmt <= 0) return false;
      return Math.abs(bAmt - pAmt) < 0.01;
    });
    if (pIdx !== -1 && (b.matched === "Matched" || cleanPulse[pIdx].matched === "Matched" || b.matched !== "No Match")) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx] });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(pIdx);
    }
  });

  const unmatchedBank = cleanBank.filter((_, idx) => !usedBankIndices.has(idx));
  const unmatchedPulse = cleanPulse.filter((_, idx) => !usedPulseIndices.has(idx));

  return { matchedPairs, unmatchedBank, unmatchedPulse };
}

/**
 * Renders a side-by-side comparison for Revenue, Contractors, or Direct costs.
 * Matches are aligned horizontally on the exact same row, with unmatched items
 * organized cleanly underneath on their respective sides.
 */
function AlignedBreakdownView({
  type = "revenue",
  bankItems = [],
  pulseItems = [],
  title = "Revenue matching",
  subtitle = "Bank deposits tagged as revenue vs paid invoices from Pulse Monthly! tab:"
}) {
  const comparison = useMemo(() => {
    return buildAlignedComparison(bankItems, pulseItems);
  }, [bankItems, pulseItems]);

  const { matchedPairs, unmatchedBank, unmatchedPulse } = comparison;

  const isCredit = type === "revenue";
  const bankTheme = isCredit
    ? { title: "Bank deposits (revenue)", bg: "#f0fdf4", border: "#bbf7d0", text: "#166534" }
    : {
      title: `Bank debits (${type === "contractors" ? "contractors" : "direct costs"})`,
      bg: type === "contractors" ? "#fff7ed" : "#fefce8",
      border: type === "contractors" ? "#fed7aa" : "#fef08a",
      text: type === "contractors" ? "#c2410c" : "#a16207"
    };

  const pulseTheme = {
    title:
      type === "revenue"
        ? "Pulse invoices paid in month"
        : type === "contractors"
          ? "Pulse contractors paid"
          : "Pulse direct costs in month",
    bg: "#eff6ff",
    border: "#bfdbfe",
    text: "#1e40af"
  };

  const getBankAmt = (b) => (isCredit ? b.inAmt || b.amount || 0 : b.outAmt || b.amount || 0);
  const getPulseDesc = (p) => {
    if (type === "contractors") return `${p.client || "Client"} — ${p.description || p.job || "Contractor payment"}`;
    return `${p.client || "Client"} — ${p.job || "Job"}`;
  };

  return (
    <div>
      <div
        style={{
          marginBottom: "12px",
          fontSize: "12px",
          color: "#475569",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px"
        }}
      >
        <span>
          <strong>{title}:</strong> {subtitle}
        </span>
        <div style={{ display: "flex", gap: "8px", fontSize: "11px" }}>
          <span style={{ padding: "2px 8px", background: "#dcfce7", color: "#166534", borderRadius: "10px", fontWeight: "600" }}>
            ✓ {matchedPairs.length} matched
          </span>
          {(unmatchedBank.length > 0 || unmatchedPulse.length > 0) && (
            <span style={{ padding: "2px 8px", background: "#fee2e2", color: "#991b1b", borderRadius: "10px", fontWeight: "600" }}>
              ⚠️ {unmatchedBank.length + unmatchedPulse.length} unmatched ({unmatchedBank.length} bank, {unmatchedPulse.length} Pulse)
            </span>
          )}
        </div>
      </div>

      {/* Column Headers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "8px" }}>
        <div style={{ fontWeight: "700", fontSize: "12px", color: bankTheme.text, padding: "5px 10px", background: bankTheme.bg, borderRadius: "6px", border: `1px solid ${bankTheme.border}` }}>
          {bankTheme.title} ({bankItems.length})
        </div>
        <div style={{ fontWeight: "700", fontSize: "12px", color: pulseTheme.text, padding: "5px 10px", background: pulseTheme.bg, borderRadius: "6px", border: `1px solid ${pulseTheme.border}` }}>
          {pulseTheme.title} ({pulseItems.length})
        </div>
      </div>

      {/* SECTION 1: Matched Pairs (Aligned Vertically Side-by-Side) */}
      {matchedPairs.length > 0 && (
        <div style={{ marginBottom: "18px" }}>
          <div
            style={{
              fontSize: "11px",
              fontWeight: "700",
              color: "#166534",
              letterSpacing: "0.3px",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            <span>✓ Matched pairs ({matchedPairs.length})</span>
            <div style={{ flex: 1, height: "1px", background: "#bbf7d0" }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {matchedPairs.map((pair, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", alignItems: "stretch" }}>
                {/* Left: Bank Item */}
                <div
                  style={{
                    padding: "8px 10px",
                    background: bankTheme.bg,
                    border: `1px solid ${bankTheme.border}`,
                    borderRadius: "6px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ fontWeight: "600", fontSize: "12px", color: "#1e293b", wordBreak: "break-word" }}>
                      {pair.bank.particulars || pair.bank.payee || "Deposit"}
                    </span>
                    <span style={{ fontWeight: "700", fontSize: "12px", color: bankTheme.text, whiteSpace: "nowrap" }}>
                      £{getBankAmt(pair.bank)}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
                    <span>{pair.bank.date || "No date"} • {pair.bank.ref || "No ref"}</span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        padding: "2px 6px",
                        background: "#dcfce7",
                        color: "#166534",
                        borderRadius: "4px",
                        fontSize: "10px",
                        fontWeight: "700",
                        border: "1px solid #86efac"
                      }}
                    >
                      ✓ Matched
                    </span>
                  </div>
                </div>

                {/* Right: Pulse Item */}
                <div
                  style={{
                    padding: "8px 10px",
                    background: pulseTheme.bg,
                    border: `1px solid ${pulseTheme.border}`,
                    borderRadius: "6px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <span style={{ fontWeight: "600", fontSize: "12px", color: "#1e293b", wordBreak: "break-word" }}>
                      {getPulseDesc(pair.pulse)}
                    </span>
                    <span style={{ fontWeight: "700", fontSize: "12px", color: pulseTheme.text, whiteSpace: "nowrap" }}>
                      £{pair.pulse.amount}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
                    <span>{pair.pulse.ref || "Invoice"} • {pair.pulse.status || "Paid"}</span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        padding: "2px 6px",
                        background: "#dcfce7",
                        color: "#166534",
                        borderRadius: "4px",
                        fontSize: "10px",
                        fontWeight: "700",
                        border: "1px solid #86efac"
                      }}
                    >
                      ✓ Matched
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 2: Unmatched Items (Organized side-by-side below matched pairs) */}
      {unmatchedBank.length > 0 || unmatchedPulse.length > 0 ? (
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: "700",
              color: "#b91c1c",
              textTransform: "uppercase",
              letterSpacing: "0.3px",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            <span>⚠️ Unmatched items (pending resolution)</span>
            <div style={{ flex: 1, height: "1px", background: "#fecaca" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", alignItems: "flex-start" }}>
            {/* Unmatched Bank Items */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b" }}>
                Unmatched bank ({unmatchedBank.length})
              </div>
              {unmatchedBank.length === 0 ? (
                <div style={{ padding: "12px", background: "#f8fafc", borderRadius: "6px", border: "1px dashed #cbd5e1", fontSize: "11px", color: "#94a3b8", textAlign: "center" }}>
                  ✓ All bank items matched
                </div>
              ) : (
                unmatchedBank.map((b, i) => (
                  <div key={i} style={{ padding: "8px 10px", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span style={{ fontWeight: "600", fontSize: "12px", color: "#1e293b" }}>
                        {b.particulars || b.payee || "Deposit"}
                      </span>
                      <span style={{ fontWeight: "700", fontSize: "12px", color: "#e11d48" }}>
                        £{getBankAmt(b)}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
                      <span>{b.date || "No date"} • {b.ref || "No ref"}</span>
                      <span style={{ padding: "2px 6px", background: "#fee2e2", color: "#991b1b", borderRadius: "4px", fontSize: "10px", fontWeight: "700", border: "1px solid #fca5a5" }}>
                        Unmatched
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Unmatched Pulse Items */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b" }}>
                Unmatched Pulse ({unmatchedPulse.length})
              </div>
              {unmatchedPulse.length === 0 ? (
                <div style={{ padding: "12px", background: "#f8fafc", borderRadius: "6px", border: "1px dashed #cbd5e1", fontSize: "11px", color: "#94a3b8", textAlign: "center" }}>
                  ✓ All pulse items matched
                </div>
              ) : (
                unmatchedPulse.map((p, i) => (
                  <div key={i} style={{ padding: "8px 10px", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span style={{ fontWeight: "600", fontSize: "12px", color: "#1e293b" }}>
                        {getPulseDesc(p)}
                      </span>
                      <span style={{ fontWeight: "700", fontSize: "12px", color: "#e11d48" }}>
                        £{p.amount}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
                      <span>{p.ref || "Invoice"} • {p.status || "Pending"}</span>
                      <span style={{ padding: "2px 6px", background: "#fee2e2", color: "#991b1b", borderRadius: "4px", fontSize: "10px", fontWeight: "700", border: "1px solid #fca5a5" }}>
                        Unmatched
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : matchedPairs.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#94a3b8", fontSize: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1" }}>
          No comparison items found for this category.
        </div>
      ) : null}
    </div>
  );
}

export default function CashflowWorkbenchView({
  reconData,
  selectedClient,
  clientInfo,
  eomMonthKey,
  effectiveMonthKey,
  automationCommanderSheetId,
  onRefresh,
  onTabCreated,
  isAdmin = false
}) {
  const [bankTxns, setBankTxns] = useState([]);
  const [unreconItems, setUnreconItems] = useState([]);
  const [filterCategory, setFilterCategory] = useState("ALL");
  const [filterAccount, setFilterAccount] = useState("ALL");
  const [groupByAccount, setGroupByAccount] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeRightTab, setActiveRightTab] = useState("variance");
  const [selectedUploadAccount, setSelectedUploadAccount] = useState("");

  // Ingestion & Sync states
  const [fetchingApi, setFetchingApi] = useState(false);
  const [apiMsg, setApiMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [autoSaveStatus, setAutoSaveStatus] = useState("saved"); // "saved" | "saving" | "error"
  const autoSaveTimerRef = useRef(null);

  const [creatingTab, setCreatingTab] = useState(false);
  const [tabError, setTabError] = useState("");
  const [localHasTargetTab, setLocalHasTargetTab] = useState(null);
  const [customModal, setCustomModal] = useState(null); // { title: string, message: string, type: 'success' | 'error' | 'info' }

  // Paste / Upload Modal states
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [uploadMode, setUploadMode] = useState("file"); // "file" | "paste"
  const [pasteRawText, setPasteRawText] = useState("");
  const [pasteParsing, setPasteParsing] = useState(false);
  const [parsedPreview, setParsedPreview] = useState(null);
  const [parsedItems, setParsedItems] = useState([]);
  const [showSkippedAccordion, setShowSkippedAccordion] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Sync state with incoming reconData
  useEffect(() => {
    if (reconData?.bankTransactions) {
      setBankTxns(reconData.bankTransactions.map((tx, idx) => ({
        ...tx,
        id: tx.id || (tx.rowNum ? `row_${tx.rowNum}` : `bt_${idx}_${Date.now()}`),
        category: tx.category || tx.suggestedCategory || (parseFloat(tx.inAmount) > 0 ? "Revenue" : "Outgoings"),
        suggestedCategory: tx.suggestedCategory || tx.category || (parseFloat(tx.inAmount) > 0 ? "Revenue" : "Outgoings")
      })));
    }
    if (reconData?.unreconciledItems) {
      setUnreconItems(reconData.unreconciledItems);
    }
    if (reconData?.hasTargetTab !== undefined) {
      setLocalHasTargetTab(Boolean(reconData.hasTargetTab));
    }
  }, [reconData]);

  // Tab check
  const hasTargetTab = localHasTargetTab !== null ? localHasTargetTab : Boolean(reconData?.hasTargetTab);
  const tabName = reconData?.reconTabName || "";

  // Background Auto-Save to Recon Sheet
  const triggerAutoSync = useCallback(async (txnsToSave, unreconToSave) => {
    if (!clientInfo?.reconSheetId || !tabName) return;
    setAutoSaveStatus("saving");
    try {
      // 1. Sync bank transactions
      const txResp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_recon_bank_transactions",
          reconSheetId: clientInfo.reconSheetId,
          tabName,
          transactions: txnsToSave,
          clientName: selectedClient
        })
      });
      const txData = await txResp.json();
      if (!txData.success) throw new Error(txData.error || "Failed to auto-sync transactions");

      // 2. Sync unreconciled items if present
      if (unreconToSave && unreconToSave.length > 0) {
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sync_recon_unreconciled_items",
            reconSheetId: clientInfo.reconSheetId,
            tabName,
            unreconciledItems: unreconToSave,
            clientName: selectedClient
          })
        });
      }
      setAutoSaveStatus("saved");
    } catch (err) {
      console.warn("Background auto-sync error:", err);
      setAutoSaveStatus("error");
    }
  }, [clientInfo, tabName, selectedClient]);

  const triggerDebouncedAutoSync = useCallback((txnsToSave, unreconToSave) => {
    setAutoSaveStatus("saving");
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      triggerAutoSync(txnsToSave, unreconToSave);
    }, 1200);
  }, [triggerAutoSync]);

  // Live Category Totals calculated from bankTxns in memory
  const liveCategoryTotals = useMemo(() => {
    const totals = {
      Revenue: 0,
      Contractors: 0,
      "Direct costs": 0,
      Salaries: 0,
      PAYE: 0,
      Pension: 0,
      Dividends: 0,
      Outgoings: 0,
      Transfer: 0,
      "Corp tax": 0,
      VAT: 0,
      Other: 0
    };

    (bankTxns || []).forEach(tx => {
      const cat = tx.category || tx.suggestedCategory || "Other";
      const inVal = parseFloat(tx.inAmount || tx.inAmt || 0) || 0;
      const outVal = parseFloat(tx.outAmount || tx.outAmt || 0) || 0;
      if (cat === "Revenue") {
        totals.Revenue += inVal;
      } else {
        totals[cat] = (totals[cat] || 0) + outVal;
      }
    });

    return totals;
  }, [bankTxns]);

  // Matches a cashflow comparison label to liveCategoryTotals
  const getLiveBankActual = useCallback((c) => {
    if (!c?.label) return null;
    const l = c.label.toLowerCase().trim();

    // 1. Direct match on standard categories (matching U3:X16)
    const exact = VALID_RECON_CATEGORIES.find(k => k.toLowerCase() === l);
    if (exact) {
      return liveCategoryTotals[exact] ?? 0;
    }

    // 2. Summary/total rows
    if (l.includes("total outgoing") || l.includes("total cost") || l.includes("total expense") || l.includes("total payment")) {
      let sum = 0;
      Object.keys(liveCategoryTotals).forEach(k => {
        if (k !== "Revenue") sum += (liveCategoryTotals[k] || 0);
      });
      return sum;
    }
    if (l.includes("net cash") || l.includes("net movement") || l.includes("net cashflow")) {
      let outSum = 0;
      Object.keys(liveCategoryTotals).forEach(k => {
        if (k !== "Revenue") outSum += (liveCategoryTotals[k] || 0);
      });
      return (liveCategoryTotals.Revenue || 0) - outSum;
    }
    if (l.includes("total revenue") || l.includes("total income") || l.includes("total receipts")) {
      return liveCategoryTotals.Revenue || 0;
    }

    let catKey = null;
    if (l.includes("revenue") || l.includes("income") || l.includes("sales")) catKey = "Revenue";
    else if (l.includes("contractor")) catKey = "Contractors";
    else if (l.includes("direct cost")) catKey = "Direct costs";
    else if (l.includes("salar") || l.includes("wages") || l.includes("payroll")) catKey = "Salaries";
    else if (l.includes("outgoing") || l.includes("other exp") || l.includes("overheads")) catKey = "Outgoings";
    else if (l.includes("vat")) catKey = "VAT";
    else if (l.includes("corp")) catKey = "Corp tax";
    else if (l.includes("dividend")) catKey = "Dividends";
    else if (l.includes("paye")) catKey = "PAYE";
    else if (l.includes("pension")) catKey = "Pension";
    else if (l.includes("transfer")) catKey = "Transfer";

    if (!catKey) return null;
    return liveCategoryTotals[catKey] ?? 0;
  }, [liveCategoryTotals]);

  // Live items for Revenue, Contractors, Direct costs derived directly from bankTxns in memory
  const liveRevenueBankItems = useMemo(() => {
    if (!bankTxns || bankTxns.length === 0) {
      return (reconData?.revenueBreakdown?.bankItems || []).filter(b => !String(b.date || "").startsWith("#") && !String(b.payee || "").startsWith("#"));
    }
    return bankTxns
      .filter(t => {
        const cat = t.category || t.suggestedCategory;
        const inAmt = parseFloat(t.inAmount || t.inAmt || 0) || 0;
        return cat === "Revenue" || (inAmt > 0 && !cat);
      })
      .map(t => ({
        id: t.id,
        rowNum: t.rowNum,
        date: t.date,
        payee: t.payee,
        particulars: t.particulars,
        ref: t.reference,
        outAmt: "",
        inAmt: t.inAmount || t.inAmt || t.amount || "",
        matched: t.matched || ""
      }));
  }, [bankTxns, reconData]);

  const liveContractorsBankItems = useMemo(() => {
    if (!bankTxns || bankTxns.length === 0) {
      return (reconData?.contractorsBreakdown?.bankItems || []).filter(b => !String(b.date || "").startsWith("#") && !String(b.payee || "").startsWith("#"));
    }
    return bankTxns
      .filter(t => (t.category || t.suggestedCategory) === "Contractors")
      .map(t => ({
        id: t.id,
        rowNum: t.rowNum,
        date: t.date,
        payee: t.payee,
        particulars: t.particulars,
        ref: t.reference,
        outAmt: t.outAmount || t.outAmt || t.amount || "",
        inAmt: "",
        matched: t.matched || ""
      }));
  }, [bankTxns, reconData]);

  const liveDirectCostsBankItems = useMemo(() => {
    if (!bankTxns || bankTxns.length === 0) {
      return (reconData?.directCostsBreakdown?.bankItems || []).filter(b => !String(b.date || "").startsWith("#") && !String(b.payee || "").startsWith("#"));
    }
    return bankTxns
      .filter(t => (t.category || t.suggestedCategory) === "Direct costs")
      .map(t => ({
        id: t.id,
        rowNum: t.rowNum,
        date: t.date,
        payee: t.payee,
        particulars: t.particulars,
        ref: t.reference,
        outAmt: t.outAmount || t.outAmt || t.amount || "",
        inAmt: "",
        matched: t.matched || ""
      }));
  }, [bankTxns, reconData]);

  const sanitizedPulseInvoices = useMemo(() => {
    return (reconData?.revenueBreakdown?.pulseInvoices || []).filter(p => !String(p.client || "").startsWith("#") && !String(p.amount || "").startsWith("#"));
  }, [reconData]);

  const sanitizedPulseContractors = useMemo(() => {
    return (reconData?.contractorsBreakdown?.pulseContractors || []).filter(p => !String(p.client || "").startsWith("#") && !String(p.amount || "").startsWith("#"));
  }, [reconData]);

  const sanitizedPulseDirectCosts = useMemo(() => {
    return (reconData?.directCostsBreakdown?.pulseDirectCosts || []).filter(p => !String(p.client || "").startsWith("#") && !String(p.amount || "").startsWith("#"));
  }, [reconData]);

  // 1. Create Tab Action
  const handleCreateTab = async () => {
    if (!clientInfo?.reconSheetId && !clientInfo?.reconSheetUrl) {
      setCustomModal({
        title: "Configuration missing",
        message: "No Recon Sheet configured for this client in KeyInfo.",
        type: "error"
      });
      return;
    }
    setCreatingTab(true);
    setTabError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ensure_recon_tab",
          reconSheetId: clientInfo.reconSheetId,
          reconSheetUrl: clientInfo.reconSheetUrl,
          tabName: tabName,
          targetMonthKey: reconData?.targetMonthKey || effectiveMonthKey,
          targetDateInput: reconData?.targetMonthKey ? `${reconData.targetMonthKey}-01` : (effectiveMonthKey ? `${effectiveMonthKey}-01` : new Date().toISOString()),
          clientName: selectedClient
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to create tab");

      // Update local state immediately so warning banner and button disappear
      setLocalHasTargetTab(true);
      setCustomModal({
        title: "Recon tab created",
        message: `✓ Recon tab '${data.tabName}' has been successfully created from template.`,
        type: "success"
      });
      if (onTabCreated) onTabCreated(data.tabName);
      else if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Tab creation error:", err);
      setTabError(err.message);
      setCustomModal({
        title: "Tab creation failed",
        message: err.message,
        type: "error"
      });
    } finally {
      setCreatingTab(false);
    }
  };

  // 2. Fetch API Transactions (Xero / QuickBooks)
  const handleFetchApiTxns = async () => {
    if (!clientInfo?.masterSheetId) {
      setCustomModal({
        title: "Configuration missing",
        message: "Missing Master Sheet ID for client.",
        type: "error"
      });
      return;
    }
    setFetchingApi(true);
    setApiMsg("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch_api_bank_transactions",
          clientName: selectedClient,
          masterSheetId: clientInfo.masterSheetId,
          reconSheetId: clientInfo.reconSheetId,
          monthKey: reconData?.targetMonthKey || effectiveMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to fetch transactions");

      if (data.transactions && data.transactions.length > 0) {
        setBankTxns(data.transactions);
        setApiMsg(`✓ Fetched ${data.transactions.length} reconciled transactions via ${data.tool?.toUpperCase()} API for tracked accounts.`);
        // Automatically save to the Recon Sheet in the background
        triggerAutoSync(data.transactions, unreconItems);
      } else {
        setApiMsg(`ℹ️ Connected ${data.tool?.toUpperCase()} returned 0 transactions for the tracked accounts in this month.`);
      }
    } catch (err) {
      console.error("Error fetching API transactions:", err);
      setApiMsg(`⚠️ ${err.message}`);
      setCustomModal({
        title: "API download failed",
        message: err.message,
        type: "error"
      });
    } finally {
      setFetchingApi(false);
    }
  };

  // 3. Category Change Handler (Guaranteed single-row isolation)
  const handleCategoryChange = async (tx, newCategory, txIndex) => {
    const updated = bankTxns.map((t, idx) => {
      const isMatch = (txIndex != null && idx === txIndex) ||
        (tx.id && t.id && t.id === tx.id) ||
        (tx.rowNum != null && t.rowNum != null && t.rowNum === tx.rowNum) ||
        (tx.sourceId && t.sourceId && t.sourceId === tx.sourceId);
      if (isMatch) {
        return { ...t, category: newCategory, suggestedCategory: newCategory };
      }
      return t;
    });
    setBankTxns(updated);

    // If transaction has an active rowNum in the Recon sheet, update cell in Google Sheets
    if (tx.rowNum && clientInfo?.reconSheetId && tabName) {
      try {
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_recon_transaction_category",
            reconSheetId: clientInfo.reconSheetId,
            tabName,
            rowNum: tx.rowNum,
            category: newCategory,
            clientName: selectedClient,
            automationCommanderSheetId
          })
        });
      } catch (e) {
        console.warn("Failed background category cell update:", e);
      }
    } else {
      // If transactions haven't been written to sheet rows yet, debounced save
      triggerDebouncedAutoSync(updated, unreconItems);
    }
  };

  // 3b. Recategorise All Handler
  const [recategorising, setRecategorising] = useState(false);
  const handleRecategoriseAll = async () => {
    if (!bankTxns || bankTxns.length === 0) {
      setCustomModal({
        title: "No transactions",
        message: "There are no bank transactions loaded to recategorise.",
        type: "info"
      });
      return;
    }
    setRecategorising(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "recategorise_all_transactions",
          clientName: selectedClient,
          reconSheetId: clientInfo?.reconSheetId,
          transactions: bankTxns
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to recategorise transactions");

      const updated = (data.transactions || []).map((t, idx) => ({
        ...t,
        id: t.id || `recat_${Date.now()}_${idx}`
      }));
      setBankTxns(updated);
      setApiMsg(`✓ Recategorised ${updated.length} bank transactions using historical learning from past Recon Sheet tabs.`);
      triggerAutoSync(updated, unreconItems);
    } catch (err) {
      console.error("Recategorise all error:", err);
      setCustomModal({
        title: "Recategorisation failed",
        message: err.message,
        type: "error"
      });
    } finally {
      setRecategorising(false);
    }
  };

  // 4. File Upload & Parse (.xlsx, .xls, .csv)
  const processUploadedFile = async (file) => {
    if (!file) return;
    setPasteParsing(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "parse_unreconciled_items",
          rows,
          monthKey: reconData?.targetMonthKey || effectiveMonthKey
        })
      });
      const res = await resp.json();
      if (!res.success) throw new Error(res.error || "Failed to parse file");
      setParsedPreview(res);
      setParsedItems(res.items || []);
    } catch (err) {
      setCustomModal({
        title: "File upload failed",
        message: err.message,
        type: "error"
      });
    } finally {
      setPasteParsing(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) processUploadedFile(file);
  };

  const handleDropFile = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) processUploadedFile(file);
  };

  // 4b. Parse Unreconciled Text (Pasted)
  const handleParsePaste = async () => {
    if (!pasteRawText.trim()) return;
    setPasteParsing(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "parse_unreconciled_items",
          rawText: pasteRawText,
          monthKey: reconData?.targetMonthKey || effectiveMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Parse failed");
      setParsedPreview(data);
      setParsedItems(data.items || []);
    } catch (err) {
      setCustomModal({
        title: "Error parsing text",
        message: err.message,
        type: "error"
      });
    } finally {
      setPasteParsing(false);
    }
  };

  // Checkbox selection controls
  const handleToggleItem = (id) => {
    setParsedItems(prev => prev.map(item => item.id === id ? { ...item, selected: !item.selected } : item));
  };

  const handleSelectInMonth = () => {
    setParsedItems(prev => prev.map(item => ({ ...item, selected: Boolean(item.isInTargetMonth) })));
  };

  const handleSelectAll = () => {
    setParsedItems(prev => prev.map(item => ({ ...item, selected: true })));
  };

  const handleDeselectAll = () => {
    setParsedItems(prev => prev.map(item => ({ ...item, selected: false })));
  };

  const handleApplyUnreconciled = () => {
    const selectedItems = (parsedItems || []).filter(it => it.selected);
    if (selectedItems.length === 0) {
      setCustomModal({
        title: "No items selected",
        message: "Please select at least one transaction to add to the workbench register.",
        type: "info"
      });
      return;
    }
    const taggedItems = selectedItems.map(it => ({
      ...it,
      accountName: selectedUploadAccount || it.accountName || ""
    }));
    const nextUnrecon = [...unreconItems, ...taggedItems];
    const nextBankTxns = [...bankTxns, ...taggedItems];
    setUnreconItems(nextUnrecon);
    setBankTxns(nextBankTxns);

    // Automatically background-sync to Google Sheet
    triggerAutoSync(nextBankTxns, nextUnrecon);

    setShowPasteModal(false);
    setPasteRawText("");
    setParsedPreview(null);
    setParsedItems([]);
    setCustomModal({
      title: "Unreconciled items added",
      message: `✓ Added ${selectedItems.length} unreconciled statement line${selectedItems.length > 1 ? "s" : ""} to the workbench register and auto-saved to sheet.`,
      type: "success"
    });
  };

  // Sort parsed statement lines: in-month & selected items first, then date descending
  const sortedParsedItems = useMemo(() => {
    if (!parsedItems || parsedItems.length === 0) return [];
    return [...parsedItems].sort((a, b) => {
      // 1. In target month first
      if (a.isInTargetMonth && !b.isInTargetMonth) return -1;
      if (!a.isInTargetMonth && b.isInTargetMonth) return 1;
      // 2. Selected (checked) items first
      if (a.selected && !b.selected) return -1;
      if (!a.selected && b.selected) return 1;
      // 3. Stable date order descending
      return (b.date || "").localeCompare(a.date || "");
    });
  }, [parsedItems]);

  // Manual fallback sync if needed
  const handleSyncToRecon = async () => {
    if (!clientInfo?.reconSheetId || !tabName) return;
    setSyncing(true);
    try {
      await triggerAutoSync(bankTxns, unreconItems);
      setSyncMsg(`✓ Synchronized ${bankTxns.length} bank transactions to recon sheet '${tabName}'.`);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Sync error:", err);
      setSyncMsg(`⚠️ Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Distinct accounts discovered across tracked accounts & loaded transactions
  const distinctAccounts = useMemo(() => {
    const set = new Set();
    (reconData?.trackedBankAccounts || []).forEach(a => set.add(a));
    (bankTxns || []).forEach(t => {
      if (t.accountName) set.add(t.accountName);
    });
    return Array.from(set).filter(Boolean);
  }, [reconData, bankTxns]);

  // Filtered transactions for left pane
  const filteredTxns = useMemo(() => {
    const list = bankTxns.filter(tx => {
      // Account filter
      if (filterAccount !== "ALL") {
        if ((tx.accountName || "") !== filterAccount) return false;
      }
      // Category filter
      if (filterCategory !== "ALL") {
        if (filterCategory === "Unreconciled" && tx.isReconciled !== false) return false;
        if (filterCategory !== "Unreconciled" && (tx.category || tx.suggestedCategory) !== filterCategory) return false;
      }
      // Search filter
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const text = `${tx.payee || ""} ${tx.particulars || ""} ${tx.reference || ""} ${tx.date || ""} ${tx.accountName || ""}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });

    if (groupByAccount) {
      return [...list].sort((a, b) => {
        const accA = a.accountName || "Unassigned Account";
        const accB = b.accountName || "Unassigned Account";
        const accCmp = accA.localeCompare(accB);
        if (accCmp !== 0) return accCmp;
        return (a.date || "").localeCompare(b.date || "");
      });
    }

    return list;
  }, [bankTxns, filterAccount, filterCategory, searchTerm, groupByAccount]);

  // Dynamic Category Counts
  const catCounts = useMemo(() => {
    const counts = { ALL: bankTxns.length, Unreconciled: 0 };
    bankTxns.forEach(t => {
      const c = t.category || t.suggestedCategory || "Other";
      counts[c] = (counts[c] || 0) + 1;
      if (t.isReconciled === false) counts.Unreconciled = (counts.Unreconciled || 0) + 1;
    });
    return counts;
  }, [bankTxns]);

  return (
    <div style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Top Action Bar */}
      <div style={{
        padding: "12px 16px",
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
        {/* Left: Tab status */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {hasTargetTab ? (
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              background: "#dcfce7",
              color: "#166534",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
              border: "1px solid #86efac"
            }}>
              ✓ Tab &apos;{tabName}&apos; active
            </span>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{
                padding: "4px 10px",
                background: "#fef3c7",
                color: "#92400e",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: "600",
                border: "1px solid #fde68a"
              }}>
                ⚠️ Tab &apos;{tabName}&apos; missing
              </span>
              <button
                onClick={handleCreateTab}
                disabled={creatingTab}
                style={{
                  padding: "4px 12px",
                  background: "#0284c7",
                  color: "#ffffff",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: "600",
                  border: "none",
                  cursor: creatingTab ? "default" : "pointer"
                }}
              >
                {creatingTab ? <><Spinner /> Creating...</> : <>✨ Create tab &apos;{tabName}&apos; from template</>}
              </button>
            </div>
          )}
          <span style={{ fontSize: "12px", color: "#64748b" }}>
            Month: <strong>{reconData?.targetMonthLabel || eomMonthKey}</strong>
          </span>
        </div>

        {/* Right: Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            onClick={handleFetchApiTxns}
            disabled={fetchingApi}
            title="Fetch reconciled bank transactions from connected accounting tool"
            style={{
              padding: "6px 14px",
              background: "#0284c7",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: fetchingApi ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            {fetchingApi ? <Spinner /> : "📥"} Fetch API bank transactions
          </button>

          <button
            onClick={() => setShowPasteModal(true)}
            style={{
              padding: "6px 14px",
              background: "#f8fafc",
              color: "#334155",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            📋 Paste / upload unreconciled
          </button>

          <button
            onClick={handleRecategoriseAll}
            disabled={recategorising || bankTxns.length === 0}
            style={{
              padding: "6px 14px",
              background: "#f8fafc",
              color: "#334155",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: (recategorising || bankTxns.length === 0) ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              opacity: bankTxns.length === 0 ? 0.6 : 1
            }}
            title="Re-run historical learning and rule-based categorisation across all bank transactions"
          >
            {recategorising ? <Spinner size={12} /> : "⚡"} Recategorise all
          </button>

          {/* Auto-save status indicator */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 12px",
            borderRadius: "6px",
            background: autoSaveStatus === "saving" ? "#eff6ff" : autoSaveStatus === "error" ? "#fef2f2" : "#f0fdf4",
            border: `1px solid ${autoSaveStatus === "saving" ? "#bfdbfe" : autoSaveStatus === "error" ? "#fecaca" : "#bbf7d0"}`,
            fontSize: "12px",
            fontWeight: "600",
            color: autoSaveStatus === "saving" ? "#1d4ed8" : autoSaveStatus === "error" ? "#b91c1c" : "#15803d"
          }}>
            {autoSaveStatus === "saving" ? (
              <>
                <Spinner size={12} />
                <span>Auto-saving to sheet...</span>
              </>
            ) : autoSaveStatus === "error" ? (
              <>
                <span>⚠️ Auto-save failed</span>
                <button
                  onClick={() => triggerAutoSync(bankTxns, unreconItems)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#b91c1c",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: "11px",
                    padding: 0
                  }}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <span>✓ Auto-saved</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      {apiMsg && (
        <div style={{ padding: "8px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", fontSize: "12px", color: "#166534" }}>
          {apiMsg}
        </div>
      )}
      {syncMsg && (
        <div style={{ padding: "8px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", fontSize: "12px", color: "#166534" }}>
          {syncMsg}
        </div>
      )}
      {tabError && (
        <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", fontSize: "12px", color: "#991b1b" }}>
          ⚠️ {tabError}
        </div>
      )}

      {/* TWO-PANE WORKBENCH */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "14px",
        minHeight: "680px"
      }}>
        {/* ========================================================================= */}
        {/* LEFT PANE: Bank Transactions Feed & Categorisation                       */}
        {/* ========================================================================= */}
        <div style={{
          background: "#ffffff",
          borderRadius: "10px",
          border: "1px solid #cbd5e1",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
        }}>
          {/* Header */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ fontWeight: "700", fontSize: "13px", color: "#1e293b", display: "flex", alignItems: "center", gap: "6px" }}>
                <span>📋 Bank transactions</span>
                <span style={{ fontSize: "11px", padding: "1px 6px", background: "#e2e8f0", borderRadius: "10px", color: "#475569" }}>
                  {filteredTxns.length} / {bankTxns.length}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                {distinctAccounts.length > 0 && (
                  <select
                    value={filterAccount}
                    onChange={e => setFilterAccount(e.target.value)}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
                      fontWeight: "600",
                      borderRadius: "5px",
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      color: "#1e293b",
                      cursor: "pointer",
                      maxWidth: "180px"
                    }}
                  >
                    <option value="ALL">All accounts ({bankTxns.length})</option>
                    {distinctAccounts.map(acc => {
                      const count = bankTxns.filter(t => t.accountName === acc).length;
                      return (
                        <option key={acc} value={acc}>
                          🏦 {acc} ({count})
                        </option>
                      );
                    })}
                  </select>
                )}
                {distinctAccounts.length > 1 && filterAccount === "ALL" && (
                  <button
                    type="button"
                    onClick={() => setGroupByAccount(!groupByAccount)}
                    style={{
                      padding: "4px 8px",
                      fontSize: "10px",
                      fontWeight: "600",
                      borderRadius: "5px",
                      border: groupByAccount ? "1px solid #0284c7" : "1px solid #cbd5e1",
                      background: groupByAccount ? "#f0f9ff" : "#ffffff",
                      color: groupByAccount ? "#0284c7" : "#64748b",
                      cursor: "pointer"
                    }}
                    title="Divide and group bank transactions by account with sub-headers"
                  >
                    {groupByAccount ? "✓ Grouped by account" : "Group by account"}
                  </button>
                )}
                <input
                  type="text"
                  placeholder="Search payees, descriptions..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    fontSize: "11px",
                    borderRadius: "5px",
                    border: "1px solid #cbd5e1",
                    width: "160px"
                  }}
                />
              </div>
            </div>

            {/* Quick Filter Chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {["ALL", "Revenue", "Contractors", "Direct costs", "Outgoings", "Salaries", "Unreconciled"].map(cat => {
                const isSelected = filterCategory === cat;
                const count = catCounts[cat] || 0;
                return (
                  <button
                    key={cat}
                    onClick={() => setFilterCategory(cat)}
                    style={{
                      padding: "2px 7px",
                      fontSize: "10px",
                      fontWeight: isSelected ? "700" : "500",
                      borderRadius: "4px",
                      border: isSelected ? "1px solid #0284c7" : "1px solid #e2e8f0",
                      background: isSelected ? "#0284c7" : "#ffffff",
                      color: isSelected ? "#ffffff" : "#64748b",
                      cursor: "pointer"
                    }}
                  >
                    {cat} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Table */}
          <div style={{ flex: 1, overflowY: "auto", maxHeight: "640px" }}>
            {filteredTxns.length === 0 ? (
              <div style={{ textAlign: "center", padding: "50px 20px", color: "#94a3b8", fontSize: "12px" }}>
                No transactions match the selected filters.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead style={{ position: "sticky", top: 0, background: "#f1f5f9", zIndex: 1 }}>
                  <tr style={{ color: "#475569", borderBottom: "1px solid #cbd5e1" }}>
                    <th style={{ padding: "6px 8px", textAlign: "left", width: "75px" }}>Date</th>
                    <th style={{ padding: "6px 8px", textAlign: "left" }}>Payee & description</th>
                    <th style={{ padding: "6px 8px", textAlign: "right", width: "70px" }}>Out (£)</th>
                    <th style={{ padding: "6px 8px", textAlign: "right", width: "70px" }}>In (£)</th>
                    <th style={{ padding: "6px 8px", textAlign: "left", width: "115px" }}>Category</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTxns.map((tx, idx) => {
                    const currentCat = tx.category || tx.suggestedCategory || "Outgoings";
                    const catStyle = CATEGORY_COLORS[currentCat] || CATEGORY_COLORS.Outgoings;
                    const isUnrecon = tx.isReconciled === false;
                    const prevTx = idx > 0 ? filteredTxns[idx - 1] : null;
                    const showAccountHeader = groupByAccount && (idx === 0 || (tx.accountName || "Unassigned Account") !== (prevTx?.accountName || "Unassigned Account"));
                    const groupCount = groupByAccount ? filteredTxns.filter(t => (t.accountName || "Unassigned Account") === (tx.accountName || "Unassigned Account")).length : 0;

                    return (
                      <React.Fragment key={tx.rowNum || tx.id || tx.sourceId || idx}>
                        {showAccountHeader && (
                          <tr style={{ background: "#f8fafc", borderTop: idx > 0 ? "2px solid #cbd5e1" : "none", borderBottom: "1px solid #e2e8f0" }}>
                            <td colSpan={5} style={{ padding: "6px 10px", fontWeight: "700", fontSize: "11px", color: "#334155" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                <span>🏦 {tx.accountName || "Unassigned Account"}</span>
                                <span style={{ fontSize: "10px", fontWeight: "600", color: "#64748b", background: "#e2e8f0", padding: "1px 6px", borderRadius: "10px" }}>
                                  {groupCount} transaction{groupCount !== 1 ? "s" : ""}
                                </span>
                              </span>
                            </td>
                          </tr>
                        )}
                        <tr
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: isUnrecon ? "#fffbeb" : (idx % 2 === 0 ? "#ffffff" : "#fafbfc")
                          }}
                        >
                          <td style={{ padding: "6px 8px", color: "#64748b", whiteSpace: "nowrap" }}>
                            {tx.date || ""}
                          </td>
                          <td style={{ padding: "6px 8px", color: "#1e293b" }}>
                            <div style={{ fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }}>
                              {tx.payee || tx.particulars || "—"}
                            </div>
                            {tx.particulars && tx.particulars !== tx.payee && (
                              <div style={{ fontSize: "10px", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }}>
                                {tx.particulars}
                              </div>
                            )}
                            <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", marginTop: "2px" }}>
                              {tx.accountName && (
                                <span style={{ fontSize: "9px", padding: "1px 5px", background: "#f1f5f9", color: "#475569", borderRadius: "3px", border: "1px solid #cbd5e1", fontWeight: "600" }}>
                                  🏦 {tx.accountName}
                                </span>
                              )}
                              {isUnrecon && (
                                <span style={{ fontSize: "9px", padding: "1px 5px", background: "#fef3c7", color: "#b45309", borderRadius: "3px", fontWeight: "700", border: "1px solid #fde68a" }}>
                                  Unreconciled
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right", color: "#b91c1c", fontWeight: tx.outAmount ? "600" : "400" }}>
                            {tx.outAmount ? `£${tx.outAmount}` : ""}
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right", color: "#15803d", fontWeight: tx.inAmount ? "600" : "400" }}>
                            {tx.inAmount ? `£${tx.inAmount}` : ""}
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            <select
                              value={currentCat}
                              onChange={e => handleCategoryChange(tx, e.target.value, idx)}
                              style={{
                                padding: "2px 4px",
                                fontSize: "10px",
                                fontWeight: "600",
                                borderRadius: "4px",
                                background: catStyle.bg,
                                color: catStyle.color,
                                border: `1px solid ${catStyle.border}`,
                                cursor: "pointer",
                                width: "100%"
                              }}
                            >
                              {VALID_RECON_CATEGORIES.map(c => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ========================================================================= */}
        {/* RIGHT PANE: Breakdowns & Variance Workbench                              */}
        {/* ========================================================================= */}
        <div style={{
          background: "#ffffff",
          borderRadius: "10px",
          border: "1px solid #cbd5e1",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
        }}>
          {/* Tabs */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc", display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {[
              { id: "variance", label: "📊 Cashflow variance" },
              { id: "revenue", label: `💰 Revenue (${liveRevenueBankItems.length})` },
              { id: "contractors", label: `👷 Contractors (${liveContractorsBankItems.length})` },
              { id: "direct_costs", label: `📦 Direct costs (${liveDirectCostsBankItems.length})` },
              { id: "unreconciled", label: `📝 Unreconciled / P&L additions (${unreconItems.length})` }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveRightTab(tab.id)}
                style={{
                  padding: "5px 10px",
                  fontSize: "11px",
                  fontWeight: activeRightTab === tab.id ? "700" : "500",
                  borderRadius: "5px",
                  border: activeRightTab === tab.id ? "1px solid #0284c7" : "1px solid transparent",
                  background: activeRightTab === tab.id ? "#ffffff" : "transparent",
                  color: activeRightTab === tab.id ? "#0284c7" : "#64748b",
                  cursor: "pointer",
                  boxShadow: activeRightTab === tab.id ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, padding: "14px", overflowY: "auto", maxHeight: "640px" }}>
            {/* 1. Cashflow Variance */}
            {activeRightTab === "variance" && (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "12px", color: "#475569" }}>
                  Compares totals from the bank recon sheet against figures on the client&apos;s <strong>Cash!</strong> tab:
                </div>
                {(!reconData?.cashflowComparisons || reconData.cashflowComparisons.length === 0) ? (
                  <div style={{ textAlign: "center", padding: "40px 20px", color: "#94a3b8" }}>
                    No comparison data available for this tab. Ensure Recon Sheet tab is populated.
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1", color: "#475569" }}>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>Category</th>
                        <th style={{ padding: "8px 10px", textAlign: "right" }}>Cashflow forecast</th>
                        <th style={{ padding: "8px 10px", textAlign: "right" }}>Bank actual</th>
                        <th style={{ padding: "8px 10px", textAlign: "right" }}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconData.cashflowComparisons.map((c, i) => {
                        const liveVal = getLiveBankActual(c);
                        const hasLiveTxns = bankTxns && bankTxns.length > 0;

                        // Parse cashflow forecast value
                        const cashflowClean = String(c.cashflow || "").replace(/[£,\s]/g, "");
                        const cashflowNum = parseFloat(cashflowClean) || 0;

                        // Bank actual value: use live calculated total from workbench if bankTxns loaded, otherwise fall back to sheet value
                        let bankActualNum = 0;
                        let bankActualDisplay = c.bankRecon || "—";

                        if (hasLiveTxns && liveVal !== null) {
                          bankActualNum = liveVal;
                          bankActualDisplay = formatGBP(liveVal);
                        } else if (c.bankRecon && c.bankRecon !== "—") {
                          const sheetClean = String(c.bankRecon || "").replace(/[£,\s]/g, "");
                          bankActualNum = parseFloat(sheetClean) || 0;
                          bankActualDisplay = c.bankRecon;
                        }

                        // Difference: Bank actual vs Forecast
                        let diffNum = 0;
                        let diffDisplay = c.diff || "£0.00";
                        if ((hasLiveTxns && liveVal !== null) || (c.bankRecon && c.bankRecon !== "—")) {
                          diffNum = bankActualNum - cashflowNum;
                          diffDisplay = formatGBP(diffNum);
                        } else {
                          const diffClean = String(c.diff || "").replace(/[£,\s]/g, "");
                          diffNum = parseFloat(diffClean) || 0;
                        }

                        const isZero = Math.abs(diffNum) < 0.01;
                        const isHighlight = Math.abs(diffNum) > 0.01;

                        return (
                          <tr key={i} style={{ borderBottom: "1px solid #f1f5f9", background: isHighlight ? "#fffbeb" : "#ffffff" }}>
                            <td style={{ padding: "8px 10px", fontWeight: "600", color: "#1e293b" }}>{c.label}</td>
                            <td style={{ padding: "8px 10px", textAlign: "right", color: "#475569" }}>{c.cashflow || "—"}</td>
                            <td style={{ padding: "8px 10px", textAlign: "right", color: "#1e293b", fontWeight: "600" }}>{bankActualDisplay}</td>
                            <td style={{ padding: "8px 10px", textAlign: "right" }}>
                              <span style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: isZero ? "#dcfce7" : "#fee2e2",
                                color: isZero ? "#166534" : "#991b1b"
                              }}>
                                {diffDisplay}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* 2. Revenue Breakdown */}
            {activeRightTab === "revenue" && (
              <AlignedBreakdownView
                type="revenue"
                bankItems={liveRevenueBankItems}
                pulseItems={sanitizedPulseInvoices}
                title="Revenue matching"
                subtitle="Bank deposits tagged as Revenue vs paid invoices from Pulse Monthly! tab:"
              />
            )}

            {/* 3. Contractors Breakdown */}
            {activeRightTab === "contractors" && (
              <AlignedBreakdownView
                type="contractors"
                bankItems={liveContractorsBankItems}
                pulseItems={sanitizedPulseContractors}
                title="Contractors matching"
                subtitle="Bank debits tagged as Contractors vs Pulse contractor payments:"
              />
            )}

            {/* 4. Direct Costs Breakdown */}
            {activeRightTab === "direct_costs" && (
              <AlignedBreakdownView
                type="direct_costs"
                bankItems={liveDirectCostsBankItems}
                pulseItems={sanitizedPulseDirectCosts}
                title="Direct costs matching"
                subtitle="Bank debits tagged as Direct costs vs Pulse direct cost job items:"
              />
            )}

            {/* 5. Unreconciled Items & P&L Adds */}
            {activeRightTab === "unreconciled" && (
              <div>
                <div style={{ marginBottom: "12px", fontSize: "12px", color: "#475569" }}>
                  <strong>Unreconciled items & P&L additions:</strong> Assign P&L accounts to statement lines that have not yet been reconciled in Xero/QB:
                </div>

                {/* Summary of Totals to Add to P&L */}
                {reconData?.plAdds && reconData.plAdds.length > 0 && (
                  <div style={{ marginBottom: "14px", padding: "10px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                    <div style={{ fontWeight: "700", fontSize: "11px", color: "#334155", marginBottom: "6px" }}>
                      Active P&L additions by account:
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "6px" }}>
                      {reconData.plAdds.map((p, idx) => (
                        <div key={idx} style={{ padding: "4px 8px", background: "#ffffff", borderRadius: "4px", border: "1px solid #cbd5e1", fontSize: "11px", display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "#475569" }}>{p.accountName}</span>
                          <strong style={{ color: "#1e293b" }}>{p.amount}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Unreconciled Items Table */}
                {unreconItems.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "30px 20px", color: "#94a3b8", fontSize: "12px" }}>
                    No unreconciled items added yet. Click <strong>&quot;Paste / upload unreconciled&quot;</strong> above to import from Xero or QuickBooks.
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1", color: "#475569" }}>
                        <th style={{ padding: "6px 8px", textAlign: "left", width: "75px" }}>Date</th>
                        <th style={{ padding: "6px 8px", textAlign: "left" }}>Payee & particulars</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", width: "70px" }}>Amount</th>
                        <th style={{ padding: "6px 8px", textAlign: "left" }}>P&L Category (CM)</th>
                        <th style={{ padding: "6px 8px", textAlign: "center", width: "60px" }}>VAT?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unreconItems.map((u, idx) => (
                        <tr key={u.id || idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ padding: "6px 8px", color: "#64748b", whiteSpace: "nowrap" }}>{u.date}</td>
                          <td style={{ padding: "6px 8px", color: "#1e293b" }}>
                            <div style={{ fontWeight: "600" }}>{u.payee || u.particulars || "—"}</div>
                            {u.particulars && u.particulars !== u.payee && (
                              <div style={{ fontSize: "10px", color: "#64748b" }}>{u.particulars}</div>
                            )}
                            {u.accountName && (
                              <div style={{ marginTop: "2px" }}>
                                <span style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "3px",
                                  fontSize: "9px",
                                  fontWeight: "600",
                                  padding: "1px 5px",
                                  background: "#f1f5f9",
                                  color: "#475569",
                                  borderRadius: "3px",
                                  border: "1px solid #cbd5e1"
                                }}>
                                  🏦 {u.accountName}
                                </span>
                              </div>
                            )}
                          </td>
                          <td style={{
                            padding: "6px 8px",
                            textAlign: "right",
                            color: (u.isNegative || String(u.amount || "").startsWith("-") || String(u.amount || "").includes("-")) ? "#b91c1c" : "#15803d",
                            fontWeight: "600",
                            whiteSpace: "nowrap"
                          }}>
                            {formatAmountGBP(u.amount, u.isNegative)}
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            <select
                              value={u.category || ""}
                              onChange={e => {
                                const val = e.target.value;
                                const updated = unreconItems.map((item, i) => i === idx ? { ...item, category: val } : item);
                                setUnreconItems(updated);
                                triggerDebouncedAutoSync(bankTxns, updated);
                              }}
                              style={{
                                width: "100%",
                                padding: "3px 6px",
                                fontSize: "11px",
                                borderRadius: "4px",
                                border: "1px solid #cbd5e1",
                                background: u.category ? "#f0fdf4" : "#ffffff",
                                color: u.category ? "#166534" : "#334155",
                                fontWeight: u.category ? "600" : "400",
                                cursor: "pointer"
                              }}
                            >
                              <option value="">(Select P&L account...)</option>
                              {Array.from(new Set([...(reconData?.plAccountOptions || []), ...(u.category ? [u.category] : [])])).map(catOpt => (
                                <option key={catOpt} value={catOpt}>{catOpt}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "center" }}>
                            <button
                              onClick={() => {
                                setUnreconItems(prev => prev.map((item, i) => i === idx ? { ...item, vatApplies: item.vatApplies === "Yes" ? "No" : "Yes" } : item));
                              }}
                              style={{
                                padding: "2px 6px",
                                fontSize: "10px",
                                fontWeight: "700",
                                borderRadius: "3px",
                                border: "1px solid #cbd5e1",
                                background: u.vatApplies === "Yes" ? "#dcfce7" : "#f1f5f9",
                                color: u.vatApplies === "Yes" ? "#166534" : "#475569",
                                cursor: "pointer"
                              }}
                            >
                              {u.vatApplies || "No"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PASTE / UPLOAD MODAL */}
      {showPasteModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "14px",
            width: "1100px",
            maxWidth: "96vw",
            maxHeight: "92vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            overflow: "hidden"
          }}>
            {/* Modal Header */}
            <div style={{
              padding: "16px 22px",
              borderBottom: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}>
              <div>
                <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0f172a", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>📋</span> Ingest unreconciled statement lines
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                  Upload a Xero <strong>Bank Reconciliation Summary (.xlsx / .csv)</strong> report or paste statement rows for <strong>{reconData?.targetMonthLabel || eomMonthKey}</strong>.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowPasteModal(false);
                  setPasteRawText("");
                  setParsedPreview(null);
                  setParsedItems([]);
                  setShowSkippedAccordion(false);
                }}
                style={{ background: "none", border: "none", fontSize: "20px", color: "#94a3b8", cursor: "pointer", padding: "4px 8px" }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body (Scrollable) */}
            <div style={{ padding: "20px 22px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>
              {!parsedPreview ? (
                <>
                  {/* Mode switcher tabs & Account selector */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                    <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "3px", borderRadius: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setUploadMode("file")}
                        style={{
                          padding: "6px 16px",
                          border: "none",
                          borderRadius: "6px",
                          background: uploadMode === "file" ? "#ffffff" : "transparent",
                          color: uploadMode === "file" ? "#0284c7" : "#64748b",
                          fontWeight: uploadMode === "file" ? "700" : "500",
                          fontSize: "12px",
                          cursor: "pointer",
                          boxShadow: uploadMode === "file" ? "0 1px 2px rgba(0,0,0,0.06)" : "none"
                        }}
                      >
                        📁 Upload Excel / CSV (.xlsx, .csv)
                      </button>
                      <button
                        type="button"
                        onClick={() => setUploadMode("paste")}
                        style={{
                          padding: "6px 16px",
                          border: "none",
                          borderRadius: "6px",
                          background: uploadMode === "paste" ? "#ffffff" : "transparent",
                          color: uploadMode === "paste" ? "#0284c7" : "#64748b",
                          fontWeight: uploadMode === "paste" ? "700" : "500",
                          fontSize: "12px",
                          cursor: "pointer",
                          boxShadow: uploadMode === "paste" ? "0 1px 2px rgba(0,0,0,0.06)" : "none"
                        }}
                      >
                        ✍️ Copy & paste text
                      </button>
                    </div>

                    {/* Bank Account Selector */}
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "#f8fafc", padding: "4px 10px", borderRadius: "8px", border: "1px solid #cbd5e1" }}>
                      <span style={{ fontSize: "12px", fontWeight: "700", color: "#334155" }}>🏦 Target account:</span>
                      <select
                        value={selectedUploadAccount}
                        onChange={e => setSelectedUploadAccount(e.target.value)}
                        style={{
                          padding: "4px 8px",
                          fontSize: "11px",
                          fontWeight: "600",
                          borderRadius: "5px",
                          border: "1px solid #cbd5e1",
                          background: "#ffffff",
                          color: "#0f172a",
                          cursor: "pointer",
                          minWidth: "200px"
                        }}
                      >
                        <option value="">(All / unspecified account)</option>
                        {(reconData?.trackedBankAccounts || []).map(acc => (
                          <option key={acc} value={acc}>
                            🏦 {acc}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {uploadMode === "file" ? (
                    <div
                      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                      onDragLeave={() => setIsDragOver(false)}
                      onDrop={handleDropFile}
                      style={{
                        border: `2px dashed ${isDragOver ? "#0284c7" : "#cbd5e1"}`,
                        borderRadius: "10px",
                        padding: "40px 20px",
                        textAlign: "center",
                        background: isDragOver ? "#f0f9ff" : "#f8fafc",
                        cursor: "pointer",
                        transition: "all 0.15s"
                      }}
                      onClick={() => document.getElementById("recon-file-input")?.click()}
                    >
                      <input
                        id="recon-file-input"
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleFileUpload}
                        style={{ display: "none" }}
                      />
                      <div style={{ fontSize: "36px", marginBottom: "8px" }}>📊</div>
                      <div style={{ fontSize: "14px", fontWeight: "700", color: "#1e293b", marginBottom: "4px" }}>
                        Click to select or drag & drop your reconciliation file
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b" }}>
                        Supports <strong>.xlsx, .xls, .csv</strong> exported directly from Xero or QuickBooks.
                      </div>
                      {pasteParsing && (
                        <div style={{ marginTop: "14px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", color: "#0284c7", fontSize: "13px", fontWeight: "600" }}>
                          <Spinner size={16} color="#0284c7" /> Parsing spreadsheet...
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "6px" }}>
                        Paste raw copied text from your clipboard below:
                      </div>
                      <textarea
                        rows={9}
                        placeholder="Paste statement rows here (Date [tab] Description [tab] Reference [tab] Amount)..."
                        value={pasteRawText}
                        onChange={e => setPasteRawText(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "10px",
                          fontSize: "11px",
                          fontFamily: "monospace",
                          borderRadius: "8px",
                          border: "1px solid #cbd5e1",
                          boxSizing: "border-box"
                        }}
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
                        <button
                          onClick={handleParsePaste}
                          disabled={pasteParsing || !pasteRawText.trim()}
                          style={{
                            padding: "8px 18px",
                            background: "#0284c7",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            fontSize: "12px",
                            fontWeight: "600",
                            cursor: pasteParsing || !pasteRawText.trim() ? "default" : "pointer"
                          }}
                        >
                          {pasteParsing ? <><Spinner /> Parsing...</> : "Parse clipboard text"}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                /* PARSED RESULTS VIEW WITH CHECKBOXES AND DIAGNOSTICS */
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {/* Results Summary Bar */}
                  <div style={{
                    padding: "12px 16px",
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: "8px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "10px"
                  }}>
                    <div>
                      <div style={{ fontWeight: "700", fontSize: "13px", color: "#166534", display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>✓ Parsed {parsedItems.length} transactions</span>
                        <span style={{ fontSize: "12px", fontWeight: "600", color: "#15803d" }}>
                          ({parsedItems.filter(i => i.selected).length} selected to add)
                        </span>
                      </div>
                      <div style={{ fontSize: "11px", color: "#166534", marginTop: "2px" }}>
                        <strong>{parsedPreview.inMonthCount || 0}</strong> in target month ({reconData?.targetMonthLabel || eomMonthKey}) •{" "}
                        <strong>{parsedPreview.otherMonthCount || 0}</strong> outside month •{" "}
                        <strong>{parsedPreview.skippedSummaryCount || 0}</strong> summary/heading lines filtered
                      </div>
                    </div>

                    {/* Target Account Selector */}
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "#ffffff", padding: "4px 8px", borderRadius: "6px", border: "1px solid #86efac" }}>
                      <span style={{ fontSize: "11px", fontWeight: "700", color: "#166534" }}>🏦 Assign to:</span>
                      <select
                        value={selectedUploadAccount}
                        onChange={e => setSelectedUploadAccount(e.target.value)}
                        style={{
                          padding: "3px 6px",
                          fontSize: "11px",
                          fontWeight: "600",
                          borderRadius: "4px",
                          border: "1px solid #cbd5e1",
                          background: "#ffffff",
                          color: "#166534",
                          cursor: "pointer"
                        }}
                      >
                        <option value="">(All / unspecified account)</option>
                        {(reconData?.trackedBankAccounts || []).map(acc => (
                          <option key={acc} value={acc}>
                            🏦 {acc}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Quick Selection Buttons */}
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={handleSelectInMonth}
                        style={{
                          padding: "5px 10px",
                          background: "#ffffff",
                          border: "1px solid #86efac",
                          color: "#166534",
                          borderRadius: "5px",
                          fontSize: "11px",
                          fontWeight: "700",
                          cursor: "pointer"
                        }}
                      >
                        ✓ Select in-month only
                      </button>
                      <button
                        type="button"
                        onClick={handleSelectAll}
                        style={{
                          padding: "5px 10px",
                          background: "#ffffff",
                          border: "1px solid #cbd5e1",
                          color: "#475569",
                          borderRadius: "5px",
                          fontSize: "11px",
                          fontWeight: "600",
                          cursor: "pointer"
                        }}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={handleDeselectAll}
                        style={{
                          padding: "5px 10px",
                          background: "#ffffff",
                          border: "1px solid #cbd5e1",
                          color: "#475569",
                          borderRadius: "5px",
                          fontSize: "11px",
                          fontWeight: "600",
                          cursor: "pointer"
                        }}
                      >
                        Deselect all
                      </button>
                    </div>
                  </div>

                  {/* Interactive Transactions Table */}
                  <div style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: "8px",
                    overflow: "hidden",
                    maxHeight: "360px",
                    overflowY: "auto",
                    background: "#ffffff"
                  }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1, borderBottom: "1px solid #cbd5e1" }}>
                        <tr style={{ color: "#475569", textAlign: "left" }}>
                          <th style={{ padding: "8px 10px", width: "36px", textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={parsedItems.length > 0 && parsedItems.every(i => i.selected)}
                              onChange={(e) => e.target.checked ? handleSelectAll() : handleDeselectAll()}
                              style={{ cursor: "pointer" }}
                            />
                          </th>
                          <th style={{ padding: "8px 10px", width: "90px" }}>Date</th>
                          <th style={{ padding: "8px 10px", width: "95px" }}>Month</th>
                          <th style={{ padding: "8px 10px" }}>Payee / description</th>
                          <th style={{ padding: "8px 10px", width: "120px" }}>Reference</th>
                          <th style={{ padding: "8px 10px", width: "85px", textAlign: "center" }}>Type</th>
                          <th style={{ padding: "8px 10px", width: "90px", textAlign: "right" }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedParsedItems.map((item, idx) => (
                          <tr
                            key={item.id || idx}
                            onClick={() => handleToggleItem(item.id)}
                            style={{
                              borderBottom: "1px solid #f1f5f9",
                              background: item.selected ? (item.isInTargetMonth ? "#f0fdf4" : "#fffbeb") : "#ffffff",
                              cursor: "pointer",
                              transition: "background 0.1s"
                            }}
                          >
                            <td style={{ padding: "7px 10px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={Boolean(item.selected)}
                                onChange={() => handleToggleItem(item.id)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td style={{ padding: "7px 10px", color: "#334155", fontWeight: "600", whiteSpace: "nowrap" }}>
                              {item.displayDate || item.date}
                            </td>
                            <td style={{ padding: "7px 10px" }}>
                              <span style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: "700",
                                background: item.isInTargetMonth ? "#dcfce7" : "#fef3c7",
                                color: item.isInTargetMonth ? "#166534" : "#92400e",
                                border: `1px solid ${item.isInTargetMonth ? "#86efac" : "#fde68a"}`
                              }}>
                                {item.isInTargetMonth ? `✓ ${item.rowMonthLabel}` : item.rowMonthLabel}
                              </span>
                            </td>
                            <td style={{ padding: "7px 10px", color: "#1e293b", fontWeight: "500" }}>
                              {item.payee || item.particulars || "Transaction"}
                            </td>
                            <td style={{ padding: "7px 10px", color: "#64748b", fontSize: "11px" }}>
                              {item.reference || "—"}
                            </td>
                            <td style={{ padding: "7px 10px", textAlign: "center" }}>
                              <span style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: "700",
                                background: item.outAmount > 0 ? "#fee2e2" : "#dcfce7",
                                color: item.outAmount > 0 ? "#991b1b" : "#166534"
                              }}>
                                {item.outAmount > 0 ? "Spent" : "Received"}
                              </span>
                            </td>
                            <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: "700", color: item.outAmount > 0 ? "#b91c1c" : "#166534" }}>
                              £{typeof item.amount === "number" ? item.amount.toFixed(2) : item.amount}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* DIAGNOSTIC / DEBUG DETAILS ACCORDION */}
                  <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden" }}>
                    <button
                      type="button"
                      onClick={() => setShowSkippedAccordion(!showSkippedAccordion)}
                      style={{
                        width: "100%",
                        padding: "8px 14px",
                        background: "#f8fafc",
                        border: "none",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#475569",
                        cursor: "pointer"
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>🔍 Diagnostic details: filtered rows & headings</span>
                        <span style={{ padding: "1px 6px", background: "#e2e8f0", borderRadius: "10px", fontSize: "11px", fontWeight: "700" }}>
                          {parsedPreview.skippedLines?.length || 0}
                        </span>
                      </span>
                      <span>{showSkippedAccordion ? "▲ Hide" : "▼ Show details"}</span>
                    </button>

                    {showSkippedAccordion && (
                      <div style={{ padding: "10px 14px", background: "#ffffff", borderTop: "1px solid #e2e8f0", maxHeight: "200px", overflowY: "auto" }}>
                        {(!parsedPreview.skippedLines || parsedPreview.skippedLines.length === 0) ? (
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>No skipped lines recorded.</div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                            <thead>
                              <tr style={{ color: "#64748b", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                                <th style={{ padding: "4px 6px" }}>Line content</th>
                                <th style={{ padding: "4px 6px", width: "180px" }}>Filter reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {parsedPreview.skippedLines.map((s, sIdx) => (
                                <tr key={sIdx} style={{ borderBottom: "1px solid #f8fafc" }}>
                                  <td style={{ padding: "4px 6px", color: "#334155", fontFamily: "monospace", fontSize: "10px" }}>
                                    {s.line}
                                  </td>
                                  <td style={{ padding: "4px 6px", color: "#b45309", fontWeight: "600" }}>
                                    {s.reason}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{
              padding: "14px 22px",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}>
              <div>
                {parsedPreview && (
                  <button
                    type="button"
                    onClick={() => {
                      setParsedPreview(null);
                      setParsedItems([]);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#0284c7",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer",
                      padding: 0
                    }}
                  >
                    ← Upload or paste different file
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowPasteModal(false);
                    setPasteRawText("");
                    setParsedPreview(null);
                    setParsedItems([]);
                    setShowSkippedAccordion(false);
                  }}
                  style={{
                    padding: "7px 16px",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: "600",
                    color: "#475569",
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                {parsedPreview && (
                  <button
                    type="button"
                    onClick={handleApplyUnreconciled}
                    style={{
                      padding: "7px 18px",
                      background: "#166534",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: "700",
                      cursor: "pointer",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                    }}
                  >
                    ✓ Add selected ({parsedItems.filter(i => i.selected).length}) to transactions
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom PMA Dialog Modal */}
      {customModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.55)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "16px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "12px",
            width: "450px",
            maxWidth: "92vw",
            overflow: "hidden",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)"
          }}>
            <div style={{
              padding: "16px 20px",
              background: customModal.type === "error" ? "#fef2f2" : customModal.type === "success" ? "#f0fdf4" : "#f8fafc",
              borderBottom: `1px solid ${customModal.type === "error" ? "#fecaca" : customModal.type === "success" ? "#bbf7d0" : "#e2e8f0"}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "18px" }}>
                  {customModal.type === "error" ? "⚠️" : customModal.type === "success" ? "✓" : "ℹ️"}
                </span>
                <h4 style={{
                  margin: 0,
                  fontSize: "15px",
                  fontWeight: "700",
                  color: customModal.type === "error" ? "#991b1b" : customModal.type === "success" ? "#166534" : "#1e293b"
                }}>
                  {customModal.title}
                </h4>
              </div>
              <button
                onClick={() => setCustomModal(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "18px",
                  color: "#64748b",
                  cursor: "pointer",
                  padding: "2px 6px"
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "20px", fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
              {customModal.message}
            </div>

            <div style={{
              padding: "12px 20px",
              background: "#f8fafc",
              borderTop: "1px solid #e2e8f0",
              display: "flex",
              justifyContent: "flex-end"
            }}>
              <button
                onClick={() => setCustomModal(null)}
                style={{
                  padding: "7px 18px",
                  background: customModal.type === "error" ? "#ef4444" : "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
