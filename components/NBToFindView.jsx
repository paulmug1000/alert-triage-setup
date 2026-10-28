import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import CellNoteIndicator from "./CellNoteIndicator";
import EditClientSelector from "./EditClientSelector";
import { PmaNBToFindSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";

const formatCurrency = (val) => {
  if (val === null || val === undefined || val === "") return "£0";
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return "£0";
  if (s.startsWith("£") || s.startsWith("$") || s.startsWith("€")) return s;
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return "£" + Math.round(num).toLocaleString("en-GB");
};

export default function NBToFindView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");
  const isSysAdmin = Boolean(user?.isAdmin || user?.role === "Admin");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  // Client Selection State (synchronous initial selection from managedClient or initialClient to eliminate flash)
  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase();
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      ) || (typeof initialClient === "object" ? initialClient : null);
    }
    return null;
  });
  const [clientSearch, setClientSearch] = useState("");

  // Data State (instant initialization from memory cache if preloaded)
  const [nbData, setNbData] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    if (target?.clientSheetId) {
      const cached = getCachedClientData(target.clientSheetId, "nbtofind");
      if (cached?.data) return cached.data;
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // FY Navigation
  const [selectedFyIdx, setSelectedFyIdx] = useState(() => nbData?.defaultFyIndex ?? 0);

  // Settings State (Cells A9, A12 & A21)
  const [targetsSetting, setTargetsSetting] = useState(() => nbData?.settings?.useTargets || "No"); // "Yes" | "No" (Cell A9)
  const [budgetSetting, setBudgetSetting] = useState(() => nbData?.settings?.useBudgetForIncomeTargets || "No"); // "Yes" | "No" (Cell A12)
  const [directCostsPct, setDirectCostsPct] = useState(() => nbData?.settings?.directCostsPercentage || "0%"); // Cell A21

  // Edit Monthly Targets (Row 3 or Row 10)
  const [editingTargets, setEditingTargets] = useState(false);
  const [editingTargetsRow, setEditingTargetsRow] = useState(3); // 3 or 10
  const [targetInputs, setTargetInputs] = useState({}); // { [colLetter]: value }

  // Quick Single Cell Edit (Row 3, Row 5, or Row 10)
  const [editingSingleCell, setEditingSingleCell] = useState(null); // { rowNum, colLetter, label, value, title, note }
  const [singleCellValue, setSingleCellValue] = useState("");
  const [singleCellNoteValue, setSingleCellNoteValue] = useState("");

  // Resolve active client
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient(match);
      return;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase();
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      );
      if (match) {
        setSelectedClient(match);
        return;
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setNbData(null);
      onSelectClient?.(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_nbtofind_client");
      }
    }
  };

  // Fetch NBtoFind Data with caching
  const fetchNBData = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : client.clientSheetId;

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, "nbtofind") : null;
    if (cached?.data) {
      setNbData(cached.data);
      setSelectedFyIdx(cached.data.defaultFyIndex ?? 0);
      setTargetsSetting(cached.data.settings?.useTargets || "No");
      setBudgetSetting(cached.data.settings?.useBudgetForIncomeTargets || "No");
      setDirectCostsPct(cached.data.settings?.directCostsPercentage || "0%");
      setLoading(false);
      if (!cached.isStale) return;
    } else {
      setLoading(true);
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`nbtofind_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, "nbtofind");
          if (fresh?.data) {
            setNbData(fresh.data);
            setSelectedFyIdx(fresh.data.defaultFyIndex ?? 0);
            setTargetsSetting(fresh.data.settings?.useTargets || "No");
            setBudgetSetting(fresh.data.settings?.useBudgetForIncomeTargets || "No");
            setDirectCostsPct(fresh.data.settings?.directCostsPercentage || "0%");
            setLoading(false);
            return;
          }
        } catch {}
      }
    }

    setError(null);
    try {
      const res = await fetch(
        `/api/pma/nbtofind?clientName=${encodeURIComponent(client.clientName)}&clientSheetId=${encodeURIComponent(
          client.clientSheetId
        )}${bypassCache ? "&bypassCache=true" : ""}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load New Business to Find data");
      }
      setNbData(data);
      setSelectedFyIdx(data.defaultFyIndex ?? 0);
      setTargetsSetting(data.settings?.useTargets || "No");
      setBudgetSetting(data.settings?.useBudgetForIncomeTargets || "No");
      setDirectCostsPct(data.settings?.directCostsPercentage || "0%");
      setCachedClientData(client.clientSheetId, "nbtofind", data);
    } catch (err) {
      console.error("Failed to fetch NBtoFind:", err);
      setError(err.message || "Failed to load New Business to Find data");
    } finally {
      setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_nbtofind_client", selectedClient.clientName);
      }
      fetchNBData(selectedClient);
    }
  }, [selectedClient, fetchNBData]);

  const showSuccess = (msg) => {
    setSaveSuccessMsg(msg);
    setTimeout(() => setSaveSuccessMsg(""), 4000);
  };

  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return allOutgoingsClients;
    const q = clientSearch.toLowerCase().trim();
    return allOutgoingsClients.filter((c) => c.clientName?.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  const currentFy = nbData?.fyConfigs?.[selectedFyIdx] || null;
  const revenueFocus = nbData?.revenueFocus || nbData?.settings?.revenueFocus || "Revenue";
  const modeTerm = revenueFocus === "Income" ? "Income" : "Revenue";
  const modeTermLower = modeTerm.toLowerCase();
  const isRevenueMode = modeTerm === "Revenue";

  const rawSymbol = nbData?.currencySymbol || selectedClient?.currencySymbol || "£";
  const currencySymbol = rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;
  const thousandsSeparator = nbData?.thousandsSeparator || (currencySymbol === "€" ? "." : ",");

  const normalizeCurrency = (val) => {
    if (!val && val !== 0) return "";
    const s = String(val).trim();
    if (!s || s === "—" || s === "-") return "";
    const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
    if (isNaN(num)) return s;
    return `${currencySymbol}` + Math.round(num).toLocaleString(thousandsSeparator === "." ? "de-DE" : "en-GB");
  };

  // ── SAVE SETTINGS (Cell A9, Cell A12 and/or Cell A21) ───────────────────────
  const handleSaveSettings = async (newTargets, newBudget, newDirectPct) => {
    if (!selectedClient || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/nbtofind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_settings",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          useTargets: newTargets !== undefined ? newTargets : targetsSetting,
          useBudgetForIncomeTargets: newBudget !== undefined ? newBudget : budgetSetting,
          directCostsPercentage: newDirectPct !== undefined ? newDirectPct : directCostsPct,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to save settings");
      await fetchNBData(selectedClient, true);
      showSuccess("Updated New Business configuration settings.");
    } catch (err) {
      console.error("Save settings error:", err);
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE ROW 25 YES/NO DROPDOWN (Underneath Each Month) ───────────────────
  const handleToggleMonthActive = async (colLetter, currentVal) => {
    if (!selectedClient || !isAdmin) return;
    const nextVal = currentVal === "Yes" ? "No" : "Yes";
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/nbtofind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_monthly_values",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: 25,
          monthlyValues: {
            [colLetter]: nextVal,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to update month status");
      showSuccess(isSysAdmin ? `Updated ${colLetter}25 to ${nextVal}.` : `Updated month status to ${nextVal}.`);
      await fetchNBData(selectedClient, true);
    } catch (err) {
      console.error("Toggle month error:", err);
      setError(err.message || "Failed to update month status");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE ROW 3 OR ROW 10 TARGETS ───────────────────────────────────────────
  const handleSaveAllTargets = async () => {
    if (!selectedClient || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/nbtofind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_monthly_values",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: editingTargetsRow,
          monthlyValues: targetInputs,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to save targets");
      setEditingTargets(false);
      showSuccess(`Saved monthly ${modeTermLower} targets${isSysAdmin ? ` (Row ${editingTargetsRow})` : ""} successfully.`);
      await fetchNBData(selectedClient, true);
    } catch (err) {
      console.error("Save targets error:", err);
      setError(err.message || "Failed to save targets");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE SINGLE CELL (Row 3, Row 5, or Row 10) ────────────────────────────
  const handleSaveSingleCell = async () => {
    if (!selectedClient || !editingSingleCell || !isAdmin) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/nbtofind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_monthly_values",
          clientName: selectedClient.clientName,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: editingSingleCell.rowNum,
          monthlyValues: {
            [editingSingleCell.colLetter]: singleCellValue,
          },
          cellNotes: {
            [editingSingleCell.colLetter]: singleCellNoteValue,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to update value");
      setEditingSingleCell(null);
      showSuccess(`Updated ${editingSingleCell.label} amount.`);
      await fetchNBData(selectedClient, true);
    } catch (err) {
      console.error("Save single cell error:", err);
      setError(err.message || "Failed to update value");
    } finally {
      setSaving(false);
    }
  };

  // Open multi-month target editor for current FY
  const startEditingAllTargets = () => {
    if (!currentFy) return;
    const targetRow = targetsSetting === "Yes" && budgetSetting === "No" ? 10 : 3;
    const rowObj = targetRow === 10 ? nbData?.sections?.row10 : nbData?.sections?.row3;
    if (!rowObj?.fyData?.[currentFy.id]) return;
    const months = rowObj.fyData[currentFy.id].months;
    const initial = {};
    months.forEach((m) => {
      initial[m.colLetter] = normalizeCurrency(m.value);
    });
    setEditingTargetsRow(targetRow);
    setTargetInputs(initial);
    setEditingTargets(true);
  };

  // Section data helpers for current FY
  const fyRow3 = nbData?.sections?.row3?.fyData?.[currentFy?.id];
  const fyRow5 = nbData?.sections?.row5?.fyData?.[currentFy?.id];
  const fyRow10 = nbData?.sections?.row10?.fyData?.[currentFy?.id];
  const fyRow12 = nbData?.sections?.row12?.fyData?.[currentFy?.id];
  const fyRow14 = nbData?.sections?.row14?.fyData?.[currentFy?.id];
  const fyRow18 = nbData?.sections?.row18?.fyData?.[currentFy?.id];
  const fyRow20 = nbData?.sections?.row20?.fyData?.[currentFy?.id];
  const fyRow23 = nbData?.sections?.row23?.fyData?.[currentFy?.id];
  const fyRow25 = nbData?.sections?.row25?.fyData?.[currentFy?.id];

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
      {/* ── TOP HEADER / TOOLBAR ── */}
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
              <span>New business to find</span>
              {selectedClient && nbData && (
                <span style={{ fontSize: "12px", background: "#f0fdf4", color: "#166534", padding: "2px 8px", borderRadius: "12px", fontWeight: 700, border: "1px solid #bbf7d0" }}>
                  Target: {fyRow18?.total || `${currencySymbol}0`}
                </span>
              )}
            </h1>
            {selectedClient && (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            )}
          </div>
        </div>

        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {/* FY Navigator */}
            {nbData?.fyConfigs && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.max(0, prev - 1))}
                  disabled={selectedFyIdx <= 0}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx <= 0 ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx <= 0 ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Previous financial year"
                >
                  ◀
                </button>

                <select
                  value={selectedFyIdx}
                  onChange={(e) => setSelectedFyIdx(parseInt(e.target.value, 10))}
                  style={{
                    padding: "6px 10px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#fff",
                    fontSize: "13px",
                    fontWeight: 700,
                    color: "#0047AB",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {nbData.fyConfigs.map((fy, idx) => (
                    <option key={fy.id} value={idx}>
                      {fy.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.min(nbData.fyConfigs.length - 1, prev + 1))}
                  disabled={selectedFyIdx >= nbData.fyConfigs.length - 1}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx >= nbData.fyConfigs.length - 1 ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx >= nbData.fyConfigs.length - 1 ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Next financial year"
                >
                  ▶
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => selectedClient && fetchNBData(selectedClient, true)}
              disabled={loading || saving}
              title="Refresh data"
              style={{
                padding: "7px 14px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: loading || saving ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {loading ? (
                <Spinner size={13} color="#0066cc" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              )}
              <span>Refresh</span>
            </button>

            {isAdmin && (
              <button
                type="button"
                onClick={startEditingAllTargets}
                disabled={loading || saving || !nbData || (targetsSetting === "Yes" && budgetSetting === "Yes")}
                title={
                  targetsSetting === "Yes" && budgetSetting === "Yes"
                    ? (isSysAdmin ? "Targets are derived from Budget!Row 26" : "Targets are derived from the budget")
                    : targetsSetting === "Yes"
                    ? `Edit monthly total ${modeTermLower} targets${isSysAdmin ? " (Row 10)" : ""}`
                    : `Edit monthly new business ${modeTermLower} figures${isSysAdmin ? " (Row 3)" : ""}`
                }
                style={{
                  padding: "7px 14px",
                  background: targetsSetting === "Yes" && budgetSetting === "Yes" ? "#94a3b8" : "#0047AB",
                  border: `1px solid ${targetsSetting === "Yes" && budgetSetting === "Yes" ? "#94a3b8" : "#0047AB"}`,
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#ffffff",
                  cursor: targetsSetting === "Yes" && budgetSetting === "Yes" ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                <span>Edit monthly {targetsSetting === "Yes" ? `total ${modeTermLower} targets` : `${modeTermLower} targets`}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── CLIENT SELECTOR SCREEN (WHEN NO CLIENT SELECTED) ── */}
      {!selectedClient && !managedClient && (
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => {
            setSelectedClient(c);
            onSelectClient?.(c);
          }}
          loading={loading}
          title="Select a client to view and edit new business to find:"
        />
      )}

      {/* Notifications */}
      {selectedClient && error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {selectedClient && saveSuccessMsg && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#15803d",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          ✓ {saveSuccessMsg}
        </div>
      )}

      {selectedClient && (loading || !nbData) && !error && (
        <PmaNBToFindSkeleton />
      )}

      {selectedClient && nbData && currentFy && (
        <>
          {/* ── TOP CONFIGURATION CARDS (CELLS A9, A12 & A21) ── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "16px",
              marginBottom: "20px",
            }}
          >
            {/* Card 1: Target Settings (Cell A9: Use targets?, Cell A12: Use budget?) */}
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                padding: "14px 18px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                {/* Question 1: Use targets to determine NB to find amounts? */}
                <div>
                  {isSysAdmin && (
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                      Options Cell A9
                    </div>
                  )}
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginTop: isSysAdmin ? "4px" : 0 }}>
                    Use targets to determine NB to find amounts?
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                    {targetsSetting === "Yes"
                      ? "Target-driven forecasting mode is enabled."
                      : `Manual monthly ${modeTermLower} inputs entered directly${isSysAdmin ? " in Row 3" : ""}.`}
                  </div>
                </div>

                <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  {isAdmin ? (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "3px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                        <button
                          type="button"
                          disabled={saving || loading}
                          onClick={() => {
                            setTargetsSetting("Yes");
                            handleSaveSettings("Yes", undefined, undefined);
                          }}
                          style={{
                            padding: "4px 14px",
                            fontSize: "12px",
                            fontWeight: 700,
                            borderRadius: "4px",
                            border: "none",
                            cursor: saving || loading ? "not-allowed" : "pointer",
                            opacity: (saving || loading) && targetsSetting !== "Yes" ? 0.6 : 1,
                            background: targetsSetting === "Yes" ? "#16a34a" : "transparent",
                            color: targetsSetting === "Yes" ? "#ffffff" : "#475569",
                            boxShadow: targetsSetting === "Yes" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                          }}
                        >
                          {saving && targetsSetting === "Yes" && <Spinner size={12} color="#ffffff" />}
                          <span>Yes</span>
                        </button>
                        <button
                          type="button"
                          disabled={saving || loading}
                          onClick={() => {
                            setTargetsSetting("No");
                            handleSaveSettings("No", undefined, undefined);
                          }}
                          style={{
                            padding: "4px 14px",
                            fontSize: "12px",
                            fontWeight: 700,
                            borderRadius: "4px",
                            border: "none",
                            cursor: saving || loading ? "not-allowed" : "pointer",
                            opacity: (saving || loading) && targetsSetting !== "No" ? 0.6 : 1,
                            background: targetsSetting === "No" ? "#dc2626" : "transparent",
                            color: targetsSetting === "No" ? "#ffffff" : "#475569",
                            boxShadow: targetsSetting === "No" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                          }}
                        >
                          {saving && targetsSetting === "No" && <Spinner size={12} color="#ffffff" />}
                          <span>No</span>
                        </button>
                      </div>

                      {saving || loading ? (
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                            color: "#1d4ed8",
                            fontWeight: 600,
                            background: "#eff6ff",
                            border: "1px solid #bfdbfe",
                            padding: "3px 8px",
                            borderRadius: "4px",
                          }}
                        >
                          <Spinner size={12} color="#1d4ed8" />
                          <span>Updating data...</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: "11px", color: "#64748b" }}>
                          {targetsSetting === "Yes" ? "✓ Targets active" : `Manual ${modeTermLower} inputs`}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span
                      style={{
                        padding: "4px 12px",
                        borderRadius: "6px",
                        fontSize: "13px",
                        fontWeight: 700,
                        background: targetsSetting === "Yes" ? "#dcfce7" : "#fee2e2",
                        color: targetsSetting === "Yes" ? "#166534" : "#991b1b",
                      }}
                    >
                      {targetsSetting}
                    </span>
                  )}
                </div>

                {/* Question 2: If "Yes" is selected here, the "Use budget to determine targets?" question appears */}
                {targetsSetting === "Yes" && (
                  <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px dashed #cbd5e1" }}>
                    {isSysAdmin && (
                      <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                        Options Cell A12
                      </div>
                    )}
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginTop: isSysAdmin ? "4px" : 0 }}>
                      Use budget to determine targets?
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                      {budgetSetting === "Yes"
                        ? `Targets dynamically populated from Budget${isSysAdmin ? " tab (Row 26)" : ""}.`
                        : `Manual total ${modeTermLower} targets entered${isSysAdmin ? " in Row 10" : ""}.`}
                    </div>

                    <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      {isAdmin ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                          <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "3px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                            <button
                              type="button"
                              disabled={saving || loading}
                              onClick={() => {
                                setBudgetSetting("Yes");
                                handleSaveSettings(undefined, "Yes", undefined);
                              }}
                              style={{
                                padding: "4px 14px",
                                fontSize: "12px",
                                fontWeight: 700,
                                borderRadius: "4px",
                                border: "none",
                                cursor: saving || loading ? "not-allowed" : "pointer",
                                opacity: (saving || loading) && budgetSetting !== "Yes" ? 0.6 : 1,
                                background: budgetSetting === "Yes" ? "#16a34a" : "transparent",
                                color: budgetSetting === "Yes" ? "#ffffff" : "#475569",
                                boxShadow: budgetSetting === "Yes" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                              }}
                            >
                              {saving && budgetSetting === "Yes" && <Spinner size={12} color="#ffffff" />}
                              <span>Yes</span>
                            </button>
                            <button
                              type="button"
                              disabled={saving || loading}
                              onClick={() => {
                                setBudgetSetting("No");
                                handleSaveSettings(undefined, "No", undefined);
                              }}
                              style={{
                                padding: "4px 14px",
                                fontSize: "12px",
                                fontWeight: 700,
                                borderRadius: "4px",
                                border: "none",
                                cursor: saving || loading ? "not-allowed" : "pointer",
                                opacity: (saving || loading) && budgetSetting !== "No" ? 0.6 : 1,
                                background: budgetSetting === "No" ? "#dc2626" : "transparent",
                                color: budgetSetting === "No" ? "#ffffff" : "#475569",
                                boxShadow: budgetSetting === "No" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                              }}
                            >
                              {saving && budgetSetting === "No" && <Spinner size={12} color="#ffffff" />}
                              <span>No</span>
                            </button>
                          </div>

                          {saving || loading ? (
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                fontSize: "12px",
                                color: "#1d4ed8",
                                fontWeight: 600,
                                background: "#eff6ff",
                                border: "1px solid #bfdbfe",
                                padding: "3px 8px",
                                borderRadius: "4px",
                              }}
                            >
                              <Spinner size={12} color="#1d4ed8" />
                              <span>Updating data...</span>
                            </div>
                          ) : (
                            <span style={{ fontSize: "11px", color: "#64748b" }}>
                              {budgetSetting === "Yes" ? "✓ Budget active" : `Manual ${modeTermLower} targets`}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span
                          style={{
                            padding: "4px 12px",
                            borderRadius: "6px",
                            fontSize: "13px",
                            fontWeight: 700,
                            background: budgetSetting === "Yes" ? "#dcfce7" : "#fee2e2",
                            color: budgetSetting === "Yes" ? "#166534" : "#991b1b",
                          }}
                        >
                          {budgetSetting}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Card 2: Cell A21 - Direct costs percentage (Only present if in Revenue mode) */}
            {isRevenueMode && (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "8px",
                  padding: "14px 18px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  {isSysAdmin && (
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                      Options Cell A21
                    </div>
                  )}
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginTop: isSysAdmin ? "4px" : 0 }}>
                    NB direct costs as a percentage?
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                    When 0%, no direct costs are deducted. Set a custom % to apply direct cost allocations.
                  </div>
                </div>

                <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px" }}>
                  {isAdmin ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="text"
                        value={directCostsPct}
                        onChange={(e) => setDirectCostsPct(e.target.value)}
                        onBlur={() => handleSaveSettings(undefined, undefined, directCostsPct)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveSettings(undefined, undefined, directCostsPct);
                        }}
                        style={{
                          width: "60px",
                          padding: "4px 8px",
                          fontSize: "13px",
                          fontWeight: 700,
                          borderRadius: "4px",
                          border: "1px solid #cbd5e1",
                          textAlign: "center",
                          outline: "none",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveSettings(undefined, undefined, directCostsPct)}
                        disabled={saving || loading}
                        style={{
                          padding: "4px 10px",
                          fontSize: "12px",
                          fontWeight: 600,
                          background: "#0047AB",
                          color: "#fff",
                          border: "none",
                          borderRadius: "4px",
                          cursor: saving || loading ? "not-allowed" : "pointer",
                          opacity: saving || loading ? 0.7 : 1,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        {saving && <Spinner size={12} color="#ffffff" />}
                        <span>Save</span>
                      </button>
                      <div style={{ display: "flex", gap: "4px" }}>
                        {["0%", "10%", "15%", "20%"].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            disabled={saving || loading}
                            onClick={() => {
                              setDirectCostsPct(pct);
                              handleSaveSettings(undefined, undefined, pct);
                            }}
                            style={{
                              padding: "3px 6px",
                              fontSize: "11px",
                              borderRadius: "4px",
                              border: "1px solid #e2e8f0",
                              background: directCostsPct === pct ? "#eff6ff" : "#ffffff",
                              color: directCostsPct === pct ? "#0047AB" : "#64748b",
                              cursor: saving || loading ? "not-allowed" : "pointer",
                              fontWeight: directCostsPct === pct ? 700 : 500,
                              opacity: saving || loading ? 0.6 : 1,
                            }}
                          >
                            {pct}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b" }}>{directCostsPct}</span>
                  )}
                </div>
              </div>
            )}

            {/* Card 3: Summary Highlights */}
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "8px",
                padding: "14px 18px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {currentFy.label} Annual Forecast Summary
                </div>
                <div style={{ marginTop: "6px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: "12px", color: "#166534", fontWeight: 600 }}>Total NB to find {modeTermLower} to use:</span>
                  <span style={{ fontSize: "18px", fontWeight: 800, color: "#15803d" }}>{fyRow18?.total || `${currencySymbol}0`}</span>
                </div>
                {isRevenueMode && (
                  <div style={{ marginTop: "4px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: "12px", color: "#475569" }}>NB Direct Costs to Use:</span>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#dc2626" }}>{fyRow23?.total || `${currencySymbol}0`}</span>
                  </div>
                )}
              </div>
              <div style={{ fontSize: "11px", color: "#15803d", fontStyle: "italic", marginTop: "8px" }}>
                Active months contributing: {(fyRow25?.months || []).filter((m) => m.value === "Yes").length} of 12
              </div>
            </div>
          </div>

          {/* ── MAIN BREAKDOWN TABLE ── */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              overflow: "hidden",
              position: "relative",
              opacity: saving ? 0.75 : 1,
              pointerEvents: saving ? "none" : "auto",
              transition: "opacity 0.2s ease",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "right" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "#475569", minWidth: "250px" }}>
                      Metric / Calculation Step
                    </th>
                    {currentFy.monthCols.map((m) => (
                      <th key={m.colLetter} style={{ padding: "10px 10px", fontWeight: 700, color: "#475569", minWidth: "75px" }}>
                        {m.label}
                      </th>
                    ))}
                    <th style={{ padding: "10px 14px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff", minWidth: "95px" }}>
                      {currentFy.label} Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* Row 3: New Business to Find Income/Revenue (Visible & Editable when "Use targets?" is "No") */}
                  {targetsSetting === "No" && fyRow3 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>{fyRow3.label}</span>
                          <span style={{ fontSize: "10px", background: "#eff6ff", color: "#1d4ed8", padding: "1px 5px", borderRadius: "4px", fontWeight: 700 }}>
                            {isSysAdmin ? "Editable (Row 3)" : "Editable"}
                          </span>
                        </div>
                      </td>
                      {fyRow3.months.map((m) => (
                        <td
                          key={m.colLetter}
                          onClick={() => {
                            if (isAdmin) {
                              setEditingSingleCell({
                                rowNum: 3,
                                colLetter: m.colLetter,
                                label: m.monthLabel,
                                value: m.value,
                                title: `New business to find ${modeTermLower} target`,
                                note: m.note || "",
                              });
                              setSingleCellValue(normalizeCurrency(m.value));
                              setSingleCellNoteValue(m.note || "");
                            }
                          }}
                          style={{
                            position: "relative",
                            padding: "9px 10px",
                            color: "#0f172a",
                            fontWeight: 600,
                            cursor: isAdmin ? "pointer" : "default",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "#eff6ff";
                          }}
                          onMouseLeave={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "transparent";
                          }}
                          title={isAdmin ? `Click to edit ${m.monthLabel} target & note` : undefined}
                        >
                          <CellNoteIndicator note={m.note} />
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff" }}>
                        {fyRow3.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 10: Total Income/Revenue Target (Visible & Editable when "Use targets?" is "Yes" and "Use budget?" is "No") */}
                  {targetsSetting === "Yes" && budgetSetting === "No" && fyRow10 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>{fyRow10.label}</span>
                          <span style={{ fontSize: "10px", background: "#eff6ff", color: "#1d4ed8", padding: "1px 5px", borderRadius: "4px", fontWeight: 700 }}>
                            {isSysAdmin ? "Editable (Row 10)" : "Editable"}
                          </span>
                        </div>
                      </td>
                      {fyRow10.months.map((m) => (
                        <td
                          key={m.colLetter}
                          onClick={() => {
                            if (isAdmin) {
                              setEditingSingleCell({
                                rowNum: 10,
                                colLetter: m.colLetter,
                                label: m.monthLabel,
                                value: m.value,
                                title: `Total ${modeTermLower} target`,
                                note: m.note || "",
                              });
                              setSingleCellValue(normalizeCurrency(m.value));
                              setSingleCellNoteValue(m.note || "");
                            }
                          }}
                          style={{
                            position: "relative",
                            padding: "9px 10px",
                            color: "#0f172a",
                            fontWeight: 600,
                            cursor: isAdmin ? "pointer" : "default",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "#eff6ff";
                          }}
                          onMouseLeave={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "transparent";
                          }}
                          title={isAdmin ? `Click to edit ${m.monthLabel} total ${modeTermLower} target & note` : undefined}
                        >
                          <CellNoteIndicator note={m.note} />
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff" }}>
                        {fyRow10.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 12: Budget Targets (Visible when "Use targets?" is "Yes" and "Use budget?" is "Yes") */}
                  {targetsSetting === "Yes" && budgetSetting === "Yes" && fyRow12 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>Budget {modeTermLower} target</span>
                          {isSysAdmin && (
                            <span style={{ fontSize: "10px", background: "#f1f5f9", color: "#64748b", padding: "1px 5px", borderRadius: "4px", fontWeight: 600 }}>
                              Budget!Row 26
                            </span>
                          )}
                        </div>
                      </td>
                      {fyRow12.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "9px 10px", color: "#334155", fontWeight: 500 }}>
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 700, color: "#334155", background: "#f8fafc" }}>
                        {fyRow12.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 14: NB to find figure based on target (Visible when "Use targets?" is "Yes") */}
                  {targetsSetting === "Yes" && fyRow14 && (
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600 }}>
                        <span>{fyRow14.label}</span>
                      </td>
                      {fyRow14.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "9px 10px", color: "#334155", fontWeight: 500 }}>
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 700, color: "#334155", background: "#f1f5f9" }}>
                        {fyRow14.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 5: NB to find direct costs (Visible & Editable in all modes ONLY IF in Revenue mode) */}
                  {isRevenueMode && fyRow5 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>NB to find direct costs</span>
                          <span style={{ fontSize: "10px", background: "#eff6ff", color: "#1d4ed8", padding: "1px 5px", borderRadius: "4px", fontWeight: 700 }}>
                            {isSysAdmin ? "Editable (Row 5)" : "Editable"}
                          </span>
                        </div>
                      </td>
                      {fyRow5.months.map((m) => (
                        <td
                          key={m.colLetter}
                          onClick={() => {
                            if (isAdmin) {
                              setEditingSingleCell({
                                rowNum: 5,
                                colLetter: m.colLetter,
                                label: m.monthLabel,
                                value: m.value,
                                title: "NB to find direct costs",
                                note: m.note || "",
                              });
                              setSingleCellValue(normalizeCurrency(m.value));
                              setSingleCellNoteValue(m.note || "");
                            }
                          }}
                          style={{
                            position: "relative",
                            padding: "9px 10px",
                            color: "#0f172a",
                            fontWeight: 600,
                            cursor: isAdmin ? "pointer" : "default",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "#eff6ff";
                          }}
                          onMouseLeave={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "transparent";
                          }}
                          title={isAdmin ? `Click to edit ${m.monthLabel} direct costs & note` : undefined}
                        >
                          <CellNoteIndicator note={m.note} />
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 800, color: "#dc2626", background: "#fef2f2" }}>
                        {fyRow5.total || `${currencySymbol}0`}
                      </td>
                    </tr>
                  )}

                  {/* ── GAP ROW: Distinct visual separator between editable inputs and calculation outputs ── */}
                  <tr style={{ background: "#f8fafc", borderTop: "2px dashed #cbd5e1", borderBottom: "1px solid #cbd5e1" }}>
                    <td
                      colSpan={currentFy.monthCols.length + 2}
                      style={{
                        padding: "8px 14px",
                        textAlign: "left",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#64748b",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        background: "#f8fafc",
                      }}
                    >
                      ↓ Figures to use in calculations (Non-editable calculated outputs)
                    </td>
                  </tr>

                  {/* Row 18: NB to find figure to use (HERO ROW - Present in all modes) */}
                  {fyRow18 && (
                    <tr style={{ background: "#f0fdf4", borderTop: "2px solid #bbf7d0", borderBottom: "2px solid #bbf7d0" }}>
                      <td style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "#166534" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#16a34a" }} />
                          <span>{fyRow18.label}</span>
                        </div>
                      </td>
                      {fyRow18.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "10px 10px", fontWeight: 700, color: "#15803d", fontSize: "13px" }}>
                          {m.value || `${currencySymbol}0`}
                        </td>
                      ))}
                      <td style={{ padding: "10px 14px", fontWeight: 800, color: "#166534", background: "#dcfce7", fontSize: "14px" }}>
                        {fyRow18.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 23: NB to find direct costs to use (Present only in Revenue mode) */}
                  {isRevenueMode && fyRow23 && (
                    <tr style={{ background: "#fef2f2", borderBottom: "1px solid #fecaca", color: "#991b1b" }}>
                      <td style={{ padding: "8px 14px", textAlign: "left", fontWeight: 600 }}>
                        {fyRow23.label}
                      </td>
                      {fyRow23.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "8px 10px", fontWeight: 600 }}>
                          {m.value || `${currencySymbol}0`}
                        </td>
                      ))}
                      <td style={{ padding: "8px 14px", fontWeight: 700, color: "#991b1b", background: "#fee2e2" }}>
                        {fyRow23.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 25: "Use NB to find?" Yes/No dropdown underneath each month */}
                  {fyRow25 && (
                    <tr style={{ background: "#ffffff", borderTop: "2px solid #cbd5e1" }}>
                      <td style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "#1e293b" }}>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <span>{fyRow25.label}</span>
                          <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 400 }}>
                            Toggle Yes/No per month to include/exclude
                          </span>
                        </div>
                      </td>
                      {fyRow25.months.map((m) => (
                        <td key={m.colLetter} style={{ position: "relative", padding: "8px 10px", textAlign: "center" }}>
                          <CellNoteIndicator note={m.note} />
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => handleToggleMonthActive(m.colLetter, m.value)}
                              disabled={saving || loading}
                              style={{
                                padding: "4px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 700,
                                border: "1px solid",
                                borderColor: m.value === "Yes" ? "#86efac" : "#fca5a5",
                                background: m.value === "Yes" ? "#dcfce7" : "#fee2e2",
                                color: m.value === "Yes" ? "#166534" : "#991b1b",
                                cursor: saving || loading ? "not-allowed" : "pointer",
                                opacity: saving || loading ? 0.7 : 1,
                                width: "50px",
                                transition: "all 0.1s",
                              }}
                              title={`Click to set ${m.monthLabel} to ${m.value === "Yes" ? "No" : "Yes"}`}
                            >
                              {m.value}
                            </button>
                          ) : (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 700,
                                background: m.value === "Yes" ? "#dcfce7" : "#fee2e2",
                                color: m.value === "Yes" ? "#166534" : "#991b1b",
                              }}
                            >
                              {m.value}
                            </span>
                          )}
                        </td>
                      ))}
                      <td style={{ padding: "10px 14px", textAlign: "center", color: "#64748b", fontSize: "11px" }}>
                        {isSysAdmin ? "Row 25" : ""}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── MODAL: EDIT ALL MONTHLY TARGETS (ROW 3) ── */}
      {editingTargets && currentFy && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "16px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              padding: "24px",
              borderRadius: "8px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: "680px",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 700, color: "#1e293b" }}>
              Edit monthly targets ({currentFy.label})
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#64748b" }}>
              Input monthly {modeTermLower} targets{isSysAdmin ? ` (writes directly to NBtoFind!Row ${editingTargetsRow})` : ""}.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: "12px",
                marginBottom: "20px",
              }}
            >
              {currentFy.monthCols.map((m) => (
                <div key={m.colLetter}>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#475569", marginBottom: "4px" }}>
                    {m.label}{isSysAdmin ? ` (${m.colLetter}${editingTargetsRow})` : ""}
                  </label>
                  <input
                    type="text"
                    value={targetInputs[m.colLetter] ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTargetInputs((prev) => ({ ...prev, [m.colLetter]: val }));
                    }}
                    placeholder={`${currencySymbol}0`}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "13px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setEditingTargets(false)}
                style={{
                  padding: "8px 14px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAllTargets}
                disabled={saving}
                style={{
                  padding: "8px 18px",
                  background: "#0047AB",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {saving ? "Saving..." : "Save All Targets"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: EDIT SINGLE CELL (Row 3, Row 5, or Row 10) ── */}
      {editingSingleCell && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              padding: "20px 24px",
              borderRadius: "8px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: "360px",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
              Edit {editingSingleCell.title}
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748b" }}>
              Month: <strong>{editingSingleCell.label}</strong>{isSysAdmin ? ` (Row ${editingSingleCell.rowNum}, Col ${editingSingleCell.colLetter})` : ""}
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                {editingSingleCell.rowNum === 5 ? "Direct costs amount" : `${modeTerm} target amount`} ({currencySymbol})
              </label>
              <input
                type="text"
                value={singleCellValue}
                onChange={(e) => setSingleCellValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) handleSaveSingleCell();
                  if (e.key === "Escape") setEditingSingleCell(null);
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                {isSysAdmin ? "Cell note" : "Note"}
              </label>
              <textarea
                value={singleCellNoteValue}
                onChange={(e) => setSingleCellNoteValue(e.target.value)}
                placeholder="Add note..."
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setEditingSingleCell(null)}
                style={{
                  padding: "6px 12px",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSingleCell}
                disabled={saving}
                style={{
                  padding: "6px 14px",
                  background: "#0047AB",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
