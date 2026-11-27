import React, { useState, useEffect, useCallback } from "react";
import Spinner from "../Spinner";
import { formatCurrency } from "../../utils/helpers";

export default function MatchCrmPipelineModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onApplied,
  isAdmin = false,
}) {
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [scanData, setScanData] = useState(null);

  // Selected projectCode -> pipelineRow mapping (clearMatches pre-checked; possibleMatches unchecked)
  const [selectedMap, setSelectedMap] = useState({});

  const hydrateScan = useCallback((data) => {
    setScanData(data);
    const nextMap = {};
    for (const m of data?.clearMatches || []) {
      const code = m?.crmDeal?.projectCode;
      const rowNum = m?.pipelineRow?.rowNum ?? m?.pipelineRow?.lineId;
      if (code && rowNum) nextMap[code] = rowNum;
    }
    setSelectedMap(nextMap);
  }, []);

  const loadScan = useCallback(async () => {
    if (!clientName) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/setup/match-crm-pipeline?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Could not scan CRM and pipeline matches.");
      }
      hydrateScan(data);
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [clientName, masterSheetId, hydrateScan]);

  useEffect(() => {
    if (isOpen && clientName) {
      loadScan();
    }
  }, [isOpen, clientName, loadScan]);

  if (!isOpen) return null;

  const handlePullAndScan = async () => {
    setPulling(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/match-crm-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull_and_scan", clientName, masterSheetId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Could not pull CRM data.");
      }
      hydrateScan(data);
      setFeedback({
        type: "success",
        message: data.pulledFresh
          ? "Pulled latest CRM data and refreshed match candidates."
          : "Refreshed match candidates from current CRM staging data.",
      });
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setPulling(false);
    }
  };

  const toggleMatch = (code, rowNum) => {
    setSelectedMap((prev) => {
      const next = { ...prev };
      if (next[code]) delete next[code];
      else if (rowNum) next[code] = rowNum;
      return next;
    });
  };

  const setCandidateTargetRow = (code, rowNum) => {
    setSelectedMap((prev) => {
      const next = { ...prev };
      if (!rowNum) delete next[code];
      else next[code] = Number(rowNum);
      return next;
    });
  };

  const selectedList = Object.entries(selectedMap).map(([projectCode, pipelineRow]) => ({
    projectCode,
    pipelineRow: Number(pipelineRow),
  }));

  const handleApply = async () => {
    if (selectedList.length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/match-crm-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          clientName,
          masterSheetId,
          matches: selectedList,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to link selected jobs.");
      }
      if (onApplied) onApplied(data);
      onClose();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const formatDealMeta = (d) => {
    const parts = [];
    if (d?.revenue !== null && d?.revenue !== undefined) parts.push(formatCurrency(d.revenue));
    if (d?.startDate) parts.push(`Starts ${d.startDate}`);
    if (d?.likelihood !== null && d?.likelihood !== undefined) parts.push(`${Math.round(d.likelihood * 100)}%`);
    return parts.join(" · ") || "No financial details";
  };

  const clearMatches = scanData?.clearMatches || [];
  const possibleMatches = scanData?.possibleMatches || [];
  const unmatchedCrm = scanData?.unmatchedCrmDeals || [];
  const blankOptions = scanData?.blankCodePipelineOptions || [];

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving && !pulling) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "960px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#F8FAFC",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
              {isAdmin ? "Match CRM deals to existing Pipeline jobs" : "Match CRM deals to existing pipeline jobs"}
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748B" }}>
              Links unlinked CRM records to existing jobs that do not yet have a Project code so duplicates are not created.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving || pulling}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              cursor: saving || pulling ? "not-allowed" : "pointer",
              color: "#94A3B8",
              padding: "4px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: "50px 0", textAlign: "center" }}>
              <Spinner size={32} color="#023f98" />
              <p style={{ marginTop: "12px", fontSize: "13px", color: "#64748B" }}>
                Scanning CRM deals and existing pipeline jobs...
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              {feedback && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    fontSize: "13px",
                    backgroundColor: feedback.type === "error" ? "#FEF2F2" : "#F0FDF4",
                    color: feedback.type === "error" ? "#B91C1C" : "#15803D",
                    border: `1px solid ${feedback.type === "error" ? "#FECACA" : "#BBF7D0"}`,
                  }}
                >
                  {feedback.message}
                </div>
              )}

              {/* Summary Bar */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "12px" }}>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", background: "#F1F5F9", color: "#334155", fontWeight: "600" }}>
                    CRM deals: {scanData?.crmDealsCount ?? 0}
                  </span>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", background: "#EFF6FF", color: "#1D4ED8", fontWeight: "600" }}>
                    Unlinked existing jobs: {scanData?.blankCodePipelineCount ?? 0}
                  </span>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", background: "#DCFCE7", color: "#15803D", fontWeight: "600" }}>
                    Clear matches: {clearMatches.length}
                  </span>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", background: "#FEF3C7", color: "#B45309", fontWeight: "600" }}>
                    Needs review: {possibleMatches.length}
                  </span>
                  <span style={{ padding: "4px 10px", borderRadius: "999px", background: "#F8FAFC", color: "#64748B", fontWeight: "600" }}>
                    Already linked: {scanData?.alreadyLinkedCount ?? 0}
                  </span>
                </div>

                {scanData?.masterMode === "supabase" && (
                  <button
                    type="button"
                    onClick={handlePullAndScan}
                    disabled={pulling || saving}
                    style={{
                      padding: "7px 14px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      background: "#FFFFFF",
                      color: "#0F172A",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: pulling ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    {pulling && <Spinner size={12} />}
                    <span>{pulling ? "Pulling CRM..." : "Pull fresh CRM data"}</span>
                  </button>
                )}
              </div>

              {clearMatches.length === 0 && possibleMatches.length === 0 && (
                <div style={{ padding: "20px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", fontSize: "13px", color: "#475569" }}>
                  No unlinked matches found between your CRM deals and existing jobs without a Project code.
                  {unmatchedCrm.length > 0 && ` ${unmatchedCrm.length} CRM deal(s) have no existing match and will be added on the next CRM sync.`}
                </div>
              )}

              {/* Clear Matches */}
              {clearMatches.length > 0 && (
                <div>
                  <h4 style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                    Clear matches (ready to link)
                  </h4>
                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "10px", overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", textAlign: "left", color: "#475569" }}>
                          <th style={{ padding: "10px 12px", width: "36px" }}>Link</th>
                          <th style={{ padding: "10px 12px" }}>CRM deal</th>
                          <th style={{ padding: "10px 12px" }}>Existing pipeline job</th>
                          <th style={{ padding: "10px 12px" }}>Match signals</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clearMatches.map((m) => {
                          const code = m.crmDeal.projectCode;
                          const checked = Boolean(selectedMap[code]);
                          return (
                            <tr key={code} style={{ borderBottom: "1px solid #F1F5F9", background: checked ? "#F0FDF4" : "#FFFFFF" }}>
                              <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMatch(code, m.pipelineRow?.rowNum ?? m.pipelineRow?.lineId)}
                                />
                              </td>
                              <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                                <div style={{ fontWeight: "600", color: "#0F172A" }}>
                                  {m.crmDeal.client} — {m.crmDeal.job}
                                </div>
                                <div style={{ color: "#64748B", marginTop: "2px" }}>{formatDealMeta(m.crmDeal)}</div>
                                {isAdmin && (
                                  <div style={{ color: "#94A3B8", fontSize: "11px", marginTop: "2px", fontFamily: "monospace" }}>
                                    {code}
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                                <div style={{ fontWeight: "600", color: "#0F172A" }}>
                                  {m.pipelineRow.client} — {m.pipelineRow.job}
                                  {isAdmin && m.pipelineRow.rowNum ? ` (Row ${m.pipelineRow.rowNum})` : ""}
                                </div>
                                <div style={{ color: "#64748B", marginTop: "2px" }}>{formatDealMeta(m.pipelineRow)}</div>
                              </td>
                              <td style={{ padding: "10px 12px", verticalAlign: "top", color: "#15803D", fontWeight: "600" }}>
                                {(m.reasons || []).join(", ")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Possible / Ambiguous Matches */}
              {possibleMatches.length > 0 && (
                <div>
                  <h4 style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: "700", color: "#92400E" }}>
                    Possible matches (review before linking)
                  </h4>
                  <div style={{ border: "1px solid #FDE68A", borderRadius: "10px", overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ background: "#FFFBEB", borderBottom: "1px solid #FDE68A", textAlign: "left", color: "#78350F" }}>
                          <th style={{ padding: "10px 12px" }}>CRM deal</th>
                          <th style={{ padding: "10px 12px" }}>Target existing job</th>
                          <th style={{ padding: "10px 12px" }}>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {possibleMatches.map((m) => {
                          const code = m.crmDeal.projectCode;
                          const selectedRow = selectedMap[code] || "";
                          return (
                            <tr key={code} style={{ borderBottom: "1px solid #FEF3C7" }}>
                              <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                                <div style={{ fontWeight: "600", color: "#0F172A" }}>
                                  {m.crmDeal.client} — {m.crmDeal.job}
                                </div>
                                <div style={{ color: "#64748B", marginTop: "2px" }}>{formatDealMeta(m.crmDeal)}</div>
                              </td>
                              <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                                <select
                                  value={selectedRow}
                                  onChange={(e) => setCandidateTargetRow(code, e.target.value)}
                                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                                >
                                  <option value="">Do not link (add as new on next sync)</option>
                                  {blankOptions.map((opt) => {
                                    const optRowId = opt.rowNum ?? opt.lineId;
                                    return (
                                      <option key={optRowId} value={optRowId}>
                                        {opt.client} — {opt.job} ({formatDealMeta(opt)}){isAdmin && opt.rowNum ? ` [Row ${opt.rowNum}]` : ""}
                                      </option>
                                    );
                                  })}
                                </select>
                              </td>
                              <td style={{ padding: "10px 12px", verticalAlign: "top", color: "#B45309" }}>
                                {(m.reasons || []).join(", ")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Net New */}
              {unmatchedCrm.length > 0 && (
                <div style={{ fontSize: "12px", color: "#64748B" }}>
                  Net new CRM deals with no existing match ({unmatchedCrm.length}):{" "}
                  {unmatchedCrm.map((d) => `${d.client} — ${d.job}`).join("; ")}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #E2E8F0",
            background: "#F8FAFC",
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving || pulling}
            style={{
              padding: "9px 18px",
              borderRadius: "8px",
              border: "1px solid #CBD5E1",
              background: "#FFFFFF",
              color: "#475569",
              fontSize: "13px",
              fontWeight: "600",
              cursor: saving || pulling ? "not-allowed" : "pointer",
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={loading || saving || pulling || selectedList.length === 0}
            style={{
              padding: "9px 20px",
              borderRadius: "8px",
              border: "none",
              background: selectedList.length === 0 ? "#94A3B8" : "#023f98",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: "600",
              cursor: loading || saving || pulling || selectedList.length === 0 ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {saving && <Spinner size={14} color="#FFFFFF" />}
            <span>{saving ? "Applying..." : `Apply selected links (${selectedList.length})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
