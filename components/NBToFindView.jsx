import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import { useAuth } from "../hooks/useAuth";

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
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");

  // Client Selection State
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientSearch, setClientSearch] = useState("");

  // Data State
  const [nbData, setNbData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // FY Navigation
  const [selectedFyIdx, setSelectedFyIdx] = useState(0);

  // Settings State (Cells A12 & A21)
  const [budgetSetting, setBudgetSetting] = useState("No"); // "Yes" | "No"
  const [directCostsPct, setDirectCostsPct] = useState("0%");

  // Edit Monthly Targets (Row 3)
  const [editingTargets, setEditingTargets] = useState(false);
  const [targetInputs, setTargetInputs] = useState({}); // { [colLetter]: value }

  // Quick Single Cell Edit (Row 3 or Row 10)
  const [editingSingleCell, setEditingSingleCell] = useState(null); // { rowNum, colLetter, label, value, title }
  const [singleCellValue, setSingleCellValue] = useState("");

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
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === initialClient.toLowerCase()
      );
      if (match) {
        setSelectedClient(match);
        return;
      }
    }
    if (!selectedClient && allOutgoingsClients.length > 0) {
      const saved = typeof window !== "undefined" ? sessionStorage.getItem("pma_nbtofind_client") : null;
      const found = saved ? allOutgoingsClients.find((c) => c.clientName === saved) : null;
      setSelectedClient(found || allOutgoingsClients[0]);
    }
  }, [managedClient, initialClient, allOutgoingsClients, selectedClient]);

  // Fetch NBtoFind Data
  const fetchNBData = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.clientSheetId) return;
    setLoading(true);
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
      setBudgetSetting(data.settings?.useBudgetForIncomeTargets || "No");
      setDirectCostsPct(data.settings?.directCostsPercentage || "0%");
    } catch (err) {
      console.error("Failed to fetch NBtoFind:", err);
      setError(err.message || "Failed to load New Business to Find data");
    } finally {
      setLoading(false);
    }
  }, []);

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

  // ── SAVE SETTINGS (Cell A12 and/or Cell A21) ────────────────────────────────
  const handleSaveSettings = async (newBudget, newDirectPct) => {
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
          useBudgetForIncomeTargets: newBudget !== undefined ? newBudget : budgetSetting,
          directCostsPercentage: newDirectPct !== undefined ? newDirectPct : directCostsPct,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to save settings");
      showSuccess("Updated New Business configuration settings.");
      await fetchNBData(selectedClient, true);
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
      showSuccess(`Updated ${colLetter}25 to ${nextVal}.`);
      await fetchNBData(selectedClient, true);
    } catch (err) {
      console.error("Toggle month error:", err);
      setError(err.message || "Failed to update month status");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE ROW 3 TARGETS ─────────────────────────────────────────────────────
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
          sheetRow: 3,
          monthlyValues: targetInputs,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to save targets");
      setEditingTargets(false);
      showSuccess("Saved new business monthly targets successfully.");
      await fetchNBData(selectedClient, true);
    } catch (err) {
      console.error("Save targets error:", err);
      setError(err.message || "Failed to save targets");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE SINGLE CELL (Row 3 or Row 10) ────────────────────────────────────
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
    if (!currentFy || !nbData?.sections?.row3?.fyData?.[currentFy.id]) return;
    const months = nbData.sections.row3.fyData[currentFy.id].months;
    const initial = {};
    months.forEach((m) => {
      initial[m.colLetter] = m.value;
    });
    setTargetInputs(initial);
    setEditingTargets(true);
  };

  // Section data helpers for current FY
  const fyRow3 = nbData?.sections?.row3?.fyData?.[currentFy?.id];
  const fyRow10 = nbData?.sections?.row10?.fyData?.[currentFy?.id];
  const fyRow12 = nbData?.sections?.row12?.fyData?.[currentFy?.id];
  const fyRow14 = nbData?.sections?.row14?.fyData?.[currentFy?.id];
  const fyRow18 = nbData?.sections?.row18?.fyData?.[currentFy?.id];
  const fyRow20 = nbData?.sections?.row20?.fyData?.[currentFy?.id];
  const fyRow23 = nbData?.sections?.row23?.fyData?.[currentFy?.id];
  const fyRow25 = nbData?.sections?.row25?.fyData?.[currentFy?.id];

  return (
    <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
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
        <div>
          <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
            <span>New business to find</span>
            {nbData && (
              <span style={{ fontSize: "12px", background: "#f0fdf4", color: "#166534", padding: "2px 8px", borderRadius: "12px", fontWeight: 700, border: "1px solid #bbf7d0" }}>
                Target: {fyRow18?.total || "£0"}
              </span>
            )}
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
            Future revenue targets, budget alignment options, and monthly allocations (NBtoFind Tab)
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* Client Selector (if not managed) */}
          {!managedClient && (
            <div style={{ position: "relative" }}>
              <select
                value={selectedClient?.clientName || ""}
                onChange={(e) => {
                  const match = allOutgoingsClients.find((c) => c.clientName === e.target.value);
                  if (match) setSelectedClient(match);
                }}
                style={{
                  padding: "7px 12px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#1e293b",
                  fontWeight: 600,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                {filteredClients.map((c) => (
                  <option key={c.clientName} value={c.clientName}>
                    {c.clientName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {managedClient && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#1d4ed8",
              }}
            >
              <span>Managing: {managedClient.clientName}</span>
              <button
                type="button"
                onClick={onClearManagedClient}
                style={{
                  background: "none",
                  border: "none",
                  color: "#dc2626",
                  cursor: "pointer",
                  fontSize: "13px",
                  padding: "0 2px",
                }}
                title="Clear managed client"
              >
                ✕
              </button>
            </div>
          )}

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
                title="Previous Financial Year"
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
                title="Next Financial Year"
              >
                ▶
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => selectedClient && fetchNBData(selectedClient, true)}
            disabled={loading || saving}
            style={{
              padding: "7px 14px",
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: 600,
              color: "#334155",
              cursor: loading ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {loading ? <Spinner size={14} color="#0066cc" /> : "↻"} Refresh
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={startEditingAllTargets}
              disabled={loading || saving || !nbData}
              style={{
                padding: "7px 14px",
                background: "#0047AB",
                border: "1px solid #0047AB",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#ffffff",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
              }}
            >
              ✎ Edit Monthly Targets
            </button>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
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

      {saveSuccessMsg && (
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

      {loading && !nbData && (
        <div style={{ textAlign: "center", padding: "80px 20px" }}>
          <Spinner size={32} color="#0047AB" />
          <div style={{ marginTop: "14px", color: "#64748b", fontSize: "14px" }}>
            Loading New Business to Find model from Client Sheet...
          </div>
        </div>
      )}

      {nbData && currentFy && (
        <>
          {/* ── TOP CONFIGURATION CARDS (CELLS A12 & A21) ── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "16px",
              marginBottom: "20px",
            }}
          >
            {/* Card 1: Cell A12 - Use budget for income targets? */}
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
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Options Cell A12
                </div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginTop: "4px" }}>
                  Use budget for income targets?
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  When enabled, income targets are dynamically populated from the Budget tab (Row 26).
                </div>
              </div>

              <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px" }}>
                {isAdmin ? (
                  <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "3px", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setBudgetSetting("Yes");
                        handleSaveSettings("Yes", undefined);
                      }}
                      style={{
                        padding: "4px 14px",
                        fontSize: "12px",
                        fontWeight: 700,
                        borderRadius: "4px",
                        border: "none",
                        cursor: "pointer",
                        background: budgetSetting === "Yes" ? "#16a34a" : "transparent",
                        color: budgetSetting === "Yes" ? "#ffffff" : "#475569",
                        boxShadow: budgetSetting === "Yes" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                      }}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBudgetSetting("No");
                        handleSaveSettings("No", undefined);
                      }}
                      style={{
                        padding: "4px 14px",
                        fontSize: "12px",
                        fontWeight: 700,
                        borderRadius: "4px",
                        border: "none",
                        cursor: "pointer",
                        background: budgetSetting === "No" ? "#dc2626" : "transparent",
                        color: budgetSetting === "No" ? "#ffffff" : "#475569",
                        boxShadow: budgetSetting === "No" ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                      }}
                    >
                      No
                    </button>
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
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  {budgetSetting === "Yes" ? "✓ Budget active" : "Using manual targets"}
                </span>
              </div>
            </div>

            {/* Card 2: Cell A21 - Direct costs percentage */}
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
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Options Cell A21
                </div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginTop: "4px" }}>
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
                      onBlur={() => handleSaveSettings(undefined, directCostsPct)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveSettings(undefined, directCostsPct);
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
                      onClick={() => handleSaveSettings(undefined, directCostsPct)}
                      disabled={saving}
                      style={{
                        padding: "4px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: "#0047AB",
                        color: "#fff",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      Save
                    </button>
                    <div style={{ display: "flex", gap: "4px" }}>
                      {["0%", "10%", "15%", "20%"].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setDirectCostsPct(pct);
                            handleSaveSettings(undefined, pct);
                          }}
                          style={{
                            padding: "3px 6px",
                            fontSize: "11px",
                            borderRadius: "4px",
                            border: "1px solid #e2e8f0",
                            background: directCostsPct === pct ? "#eff6ff" : "#ffffff",
                            color: directCostsPct === pct ? "#0047AB" : "#64748b",
                            cursor: "pointer",
                            fontWeight: directCostsPct === pct ? 700 : 500,
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
                  <span style={{ fontSize: "12px", color: "#166534", fontWeight: 600 }}>Total NB to Find to Use:</span>
                  <span style={{ fontSize: "18px", fontWeight: 800, color: "#15803d" }}>{fyRow18?.total || "£0"}</span>
                </div>
                <div style={{ marginTop: "4px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: "12px", color: "#475569" }}>NB Direct Costs to Use:</span>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#dc2626" }}>{fyRow23?.total || "£0"}</span>
                </div>
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
                  {/* Row 3: New Business to Find Income (Manual Monthly Inputs) */}
                  {fyRow3 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "9px 14px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span>{fyRow3.label}</span>
                          <span style={{ fontSize: "10px", background: "#eff6ff", color: "#1d4ed8", padding: "1px 5px", borderRadius: "4px", fontWeight: 700 }}>
                            Editable (Row 3)
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
                                title: "New business to find income target",
                              });
                              setSingleCellValue(m.value);
                            }
                          }}
                          style={{
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
                          title={isAdmin ? `Click to edit ${m.monthLabel} target` : undefined}
                        >
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "9px 14px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff" }}>
                        {fyRow3.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 10: Total Income Target */}
                  {fyRow10 && (
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                      <td style={{ padding: "7px 14px", textAlign: "left", fontWeight: 600 }}>
                        {fyRow10.label}
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
                                title: "Total income target",
                              });
                              setSingleCellValue(m.value);
                            }
                          }}
                          style={{ padding: "7px 10px", cursor: isAdmin ? "pointer" : "default" }}
                          title={isAdmin ? `Click to edit ${m.monthLabel} total income target` : undefined}
                        >
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "7px 14px", fontWeight: 700, color: "#334155" }}>
                        {fyRow10.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 12: Budget Targets (Row 12) */}
                  {fyRow12 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                      <td style={{ padding: "7px 14px", textAlign: "left" }}>
                        <span>Budget target (Budget!Row 26)</span>
                        {budgetSetting !== "Yes" && (
                          <span style={{ fontSize: "10px", color: "#94a3b8", marginLeft: "6px" }}>(disabled via A12)</span>
                        )}
                      </td>
                      {fyRow12.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "7px 10px" }}>
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "7px 14px", fontWeight: 600 }}>
                        {fyRow12.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 14: NB to find figure based on target */}
                  {fyRow14 && (
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                      <td style={{ padding: "7px 14px", textAlign: "left" }}>
                        {fyRow14.label}
                      </td>
                      {fyRow14.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "7px 10px" }}>
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "7px 14px", fontWeight: 600 }}>
                        {fyRow14.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 18: NB to find figure to use (HERO ROW) */}
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
                          {m.value || "£0"}
                        </td>
                      ))}
                      <td style={{ padding: "10px 14px", fontWeight: 800, color: "#166534", background: "#dcfce7", fontSize: "14px" }}>
                        {fyRow18.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 20: NB direct costs calculation */}
                  {directCostsPct !== "0%" && fyRow20 && (
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                      <td style={{ padding: "7px 14px", textAlign: "left" }}>
                        {fyRow20.label} ({directCostsPct})
                      </td>
                      {fyRow20.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "7px 10px" }}>
                          {m.value || "-"}
                        </td>
                      ))}
                      <td style={{ padding: "7px 14px", fontWeight: 600 }}>
                        {fyRow20.total}
                      </td>
                    </tr>
                  )}

                  {/* Row 23: NB to find direct costs to use */}
                  {fyRow23 && (
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#991b1b" }}>
                      <td style={{ padding: "8px 14px", textAlign: "left", fontWeight: 600 }}>
                        {fyRow23.label}
                      </td>
                      {fyRow23.months.map((m) => (
                        <td key={m.colLetter} style={{ padding: "8px 10px", fontWeight: 600 }}>
                          {m.value || "£0"}
                        </td>
                      ))}
                      <td style={{ padding: "8px 14px", fontWeight: 700, color: "#991b1b" }}>
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
                        <td key={m.colLetter} style={{ padding: "8px 10px", textAlign: "center" }}>
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => handleToggleMonthActive(m.colLetter, m.value)}
                              disabled={saving}
                              style={{
                                padding: "4px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 700,
                                border: "1px solid",
                                borderColor: m.value === "Yes" ? "#86efac" : "#fca5a5",
                                background: m.value === "Yes" ? "#dcfce7" : "#fee2e2",
                                color: m.value === "Yes" ? "#166534" : "#991b1b",
                                cursor: "pointer",
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
                        Row 25
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
              Input monthly new business revenue targets (writes directly to NBtoFind!Row 3).
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
                    {m.label} ({m.colLetter}3)
                  </label>
                  <input
                    type="text"
                    value={targetInputs[m.colLetter] ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTargetInputs((prev) => ({ ...prev, [m.colLetter]: val }));
                    }}
                    placeholder="£0"
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

      {/* ── MODAL: EDIT SINGLE CELL (Row 3 or Row 10) ── */}
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
              Month: <strong>{editingSingleCell.label}</strong> (Row {editingSingleCell.rowNum}, Col {editingSingleCell.colLetter})
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                Target Amount (£)
              </label>
              <input
                type="text"
                value={singleCellValue}
                onChange={(e) => setSingleCellValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveSingleCell();
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
